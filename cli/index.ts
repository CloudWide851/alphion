#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, opendir, realpath, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { AgentRuntime } from "../src/application/agent-runtime.js";
import { sha256 } from "../src/application/canonical.js";
import { TieredCache } from "../src/application/cache.js";
import { AlphionError, normalizeError } from "../src/application/errors.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from "../src/ports/index.js";
import { MemoryLruCache } from "../adapters/cache/memory-cache.js";
import { OpenAICompatibleProvider } from "../adapters/model/openai-compatible.js";
import { EnvironmentSecretResolver } from "../adapters/secrets/environment-secret.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { EditTool, GrepTool, ReadTool, ShellTool, WriteTool } from "../adapters/tools/index.js";

const execFileAsync = promisify(execFile);
const REVISION_EXCLUDED = new Set([
  ".git",
  ".alphion",
  ".trellis",
  ".codegraph",
  ".agents",
  ".codex",
  ".cache",
  ".next",
  ".pnpm",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  const [group, command] = parsed.positionals;
  if (!group || group === "help" || hasFlag(parsed, "help")) {
    printHelp();
    return 0;
  }
  const projectRoot = await realpath(resolve(flagValue(parsed, "project-root") ?? process.cwd()));
  const statePath = resolve(flagValue(parsed, "state") ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
  const store = new SqliteStore({ path: statePath });
  try {
    if (group === "provider") return await providerCommand(store, command, parsed);
    if (group === "policy" && command === "shell") return await shellPolicyCommand(store, parsed);
    if (group === "cache") return await cacheCommand(store, command, parsed);
    if (group === "run") return await runCommand(store, parsed, projectRoot);
    throw new AlphionError("validation", `Unknown command: ${[group, command].filter(Boolean).join(" ")}`, { stage: "cli" });
  } finally {
    store.close();
  }
}

async function providerCommand(store: SqliteStore, command: string | undefined, parsed: ParsedArguments): Promise<number> {
  if (command === "set") {
    const id = requiredFlag(parsed, "id");
    const authEnvironment = flagValue(parsed, "auth-env");
    const protocol = requiredFlag(parsed, "protocol");
    if (protocol !== "chat-completions" && protocol !== "responses") {
      throw new AlphionError("validation", "--protocol must be chat-completions or responses.", { stage: "cli" });
    }
    const profile = await store.upsertProfile({
      schemaVersion: 1,
      id,
      name: flagValue(parsed, "name") ?? id,
      baseUrl: requiredFlag(parsed, "base-url"),
      model: requiredFlag(parsed, "model"),
      protocol,
      auth: authEnvironment ? { mode: "bearer-env", environmentVariable: authEnvironment } : { mode: "none" },
      capabilities: {
        streaming: booleanFlag(parsed, "streaming", true),
        tools: booleanFlag(parsed, "tools", true),
        promptCaching: booleanFlag(parsed, "prompt-caching", false),
      },
      active: hasFlag(parsed, "active"),
    });
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return 0;
  }
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(await store.listProfiles(), null, 2)}\n`);
    return 0;
  }
  if (command === "activate") {
    const idOrName = parsed.positionals[2];
    if (!idOrName) throw new AlphionError("validation", "provider activate requires an id or name.", { stage: "cli" });
    process.stdout.write(`${JSON.stringify(await store.activateProfile(idOrName), null, 2)}\n`);
    return 0;
  }
  throw new AlphionError("validation", "provider command must be set, list, or activate.", { stage: "cli" });
}

async function shellPolicyCommand(store: SqliteStore, parsed: ParsedArguments): Promise<number> {
  const action = parsed.positionals[2];
  if (action === "allow") {
    const requestedExecutable = resolve(requiredFlag(parsed, "executable"));
    const executablePath = await realpath(requestedExecutable);
    const metadata = await stat(executablePath);
    if (!metadata.isFile()) throw new AlphionError("validation", "Allowlisted executable must be a regular file.", { stage: "cli" });
    const executableDigest = sha256(await readFile(executablePath));
    const rule = await store.addShellRule({
      executablePath,
      executableDigest,
      argumentPrefix: parsed.flags.get("arg-prefix") ?? [],
    });
    process.stdout.write(`${JSON.stringify(rule, null, 2)}\n`);
    return 0;
  }
  if (action === "list") {
    process.stdout.write(`${JSON.stringify(store.listShellRules(), null, 2)}\n`);
    return 0;
  }
  if (action === "remove") {
    const id = parsed.positionals[3];
    if (!id) throw new AlphionError("validation", "policy shell remove requires a rule id.", { stage: "cli" });
    const removed = await store.removeShellRule(id);
    process.stdout.write(`${removed ? "removed" : "not found"}\n`);
    return removed ? 0 : 1;
  }
  throw new AlphionError("validation", "policy shell command must be allow, list, or remove.", { stage: "cli" });
}

async function cacheCommand(store: SqliteStore, command: string | undefined, parsed: ParsedArguments): Promise<number> {
  if (command === "stats") {
    process.stdout.write(`${JSON.stringify(await store.stats(), null, 2)}\n`);
    return 0;
  }
  if (command === "clear") {
    const namespace = flagValue(parsed, "namespace");
    const deleted = await store.delete(namespace);
    process.stdout.write(`Deleted ${deleted} cache entr${deleted === 1 ? "y" : "ies"}.\n`);
    return 0;
  }
  throw new AlphionError("validation", "cache command must be stats or clear.", { stage: "cli" });
}

async function runCommand(store: SqliteStore, parsed: ParsedArguments, projectRoot: string): Promise<number> {
  const prompt = requiredFlag(parsed, "prompt");
  const selected = flagValue(parsed, "provider");
  const profile = selected ? await store.getProfile(selected) : await store.getActiveProfile();
  if (!profile) {
    throw new AlphionError("validation", selected ? `Unknown provider profile: ${selected}` : "No active provider profile is configured.", {
      stage: "cli",
    });
  }
  const provider = new OpenAICompatibleProvider(profile, new EnvironmentSecretResolver());
  const cache = new TieredCache(new MemoryLruCache(), store);
  const tools = new ToolRegistry([new ReadTool(), new GrepTool(), new EditTool(), new WriteTool(), new ShellTool(store)]);
  const runtime = new AgentRuntime({
    provider,
    cache,
    tools,
    eventStore: store,
    approval: new CliApprovalPort(),
  });
  const handle = runtime.start({
    prompt,
    projectRoot,
    projectRevision: await projectRevision(projectRoot),
    cacheResponses: !hasFlag(parsed, "no-cache"),
  });
  const render = (async () => {
    for await (const event of handle.events) {
      if (event.kind === "model.delta") {
        const delta = event.payload.delta;
        if (typeof delta === "string") process.stdout.write(delta);
      } else if (event.kind === "provider.degraded" || event.kind === "run.failed" || event.kind === "run.cancelled") {
        process.stderr.write(`\n[${event.kind}] ${safeEventMessage(event.payload)}\n`);
      }
    }
  })();
  const result = await handle.result;
  await render;
  process.stdout.write(`\n\nrun=${result.runId} status=${result.status} turns=${result.turns} tools=${result.toolCalls}\n`);
  process.stdout.write(`evidence referenced=${result.grounding.referencedEvidenceIds.length} missing=${result.grounding.missingEvidenceIds.length}\n`);
  return result.status === "completed" ? 0 : 1;
}

class CliApprovalPort implements ApprovalPort {
  readonly revision = "cli-per-call-approval-v1";

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return { approved: false, reason: "No interactive TTY is available for per-call approval." };
    }
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\nApproval required\ntool: ${request.toolName}\ndigest: ${request.actionDigest}\naction: ${request.summary}\n`);
      const answer = await reader.question("Approve this exact action? [y/N] ", { signal });
      return /^y(?:es)?$/i.test(answer.trim())
        ? { approved: true, reason: "Approved interactively for this invocation." }
        : { approved: false, reason: "Declined interactively." };
    } finally {
      reader.close();
    }
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals >= 0 ? equals : undefined);
    let value = equals >= 0 ? token.slice(equals + 1) : "true";
    const next = argv[index + 1];
    if (equals < 0 && next && !next.startsWith("--")) {
      value = next;
      index += 1;
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
  }
  return { positionals, flags };
}

function flagValue(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

function requiredFlag(parsed: ParsedArguments, name: string): string {
  const value = flagValue(parsed, name);
  if (!value || value === "true") throw new AlphionError("validation", `--${name} is required.`, { stage: "cli" });
  return value;
}

function hasFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.has(name);
}

function booleanFlag(parsed: ParsedArguments, name: string, fallback: boolean): boolean {
  const value = flagValue(parsed, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AlphionError("validation", `--${name} must be true or false.`, { stage: "cli" });
}

async function projectRevision(projectRoot: string): Promise<string> {
  try {
    const [head, statusValue, worktreeDiff, indexDiff, untracked] = await Promise.all([
      execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { windowsHide: true, maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", projectRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", projectRoot, "diff", "--no-ext-diff", "--binary", "--", "."], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", projectRoot, "diff", "--cached", "--no-ext-diff", "--binary", "--", "."], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", projectRoot, "ls-files", "--others", "--exclude-standard", "-z"], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }),
    ]);
    const untrackedDigests: string[] = [];
    for (const relativePath of untracked.stdout.split("\0").filter(Boolean).slice(0, 5000)) {
      const path = resolve(projectRoot, relativePath);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        untrackedDigests.push(`${relativePath}:symlink`);
      } else if (metadata.isFile() && metadata.size <= 1024 * 1024) {
        untrackedDigests.push(`${relativePath}:${sha256(await readFile(path))}`);
      } else {
        untrackedDigests.push(`${relativePath}:${metadata.size}:${metadata.mtimeMs}`);
      }
    }
    return sha256(
      `${head.stdout.trim()}\0${statusValue.stdout}\0${worktreeDiff.stdout}\0${indexDiff.stdout}\0${untrackedDigests.sort().join("\n")}`,
    );
  } catch {
    return filesystemProjectRevision(projectRoot);
  }
}

async function filesystemProjectRevision(projectRoot: string): Promise<string> {
  const pending = [projectRoot];
  const parts: string[] = [];
  let visited = 0;
  while (pending.length > 0 && visited < 5000) {
    const directory = pending.pop();
    if (!directory) break;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (isRevisionExcluded(entry.name)) continue;
      const path = join(directory, entry.name);
      const relativePath = path.slice(projectRoot.length + 1).replaceAll("\\", "/");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        parts.push(`${relativePath}:symlink`);
      } else if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile()) {
        visited += 1;
        parts.push(
          metadata.size <= 1024 * 1024
            ? `${relativePath}:${sha256(await readFile(path))}`
            : `${relativePath}:${metadata.size}:${metadata.mtimeMs}`,
        );
      }
      if (visited >= 5000) break;
    }
  }
  if (visited >= 5000 || pending.length > 0) parts.push(`overflow:${Date.now()}`);
  return sha256(parts.sort().join("\n"));
}

function isRevisionExcluded(name: string): boolean {
  return REVISION_EXCLUDED.has(name.toLowerCase());
}

function safeEventMessage(payload: Readonly<Record<string, unknown>>): string {
  const message = payload.message ?? payload.reason ?? payload.code;
  return typeof message === "string" ? message : "See the local audit event for details.";
}

function printHelp(): void {
  process.stdout.write(`Alphion v0.2.1\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  provider set --id ID --base-url URL --model MODEL --protocol chat-completions|responses [--auth-env NAME] [--active]\n`);
  process.stdout.write(`  provider list\n  provider activate ID\n`);
  process.stdout.write(`  policy shell allow --executable ABSOLUTE_PATH [--arg-prefix VALUE ...]\n`);
  process.stdout.write(`  policy shell list\n  policy shell remove ID\n`);
  process.stdout.write(`  cache stats\n  cache clear [--namespace NAME]\n`);
  process.stdout.write(`  run --prompt TEXT [--provider ID] [--project-root PATH] [--no-cache]\n\n`);
  process.stdout.write(`Global options: --state PATH --project-root PATH\n`);
}

async function runAsProgram(): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (error) {
    const normalized = normalizeError(error, "cli");
    process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) void runAsProgram();
