#!/usr/bin/env node
import { realpath, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { sha256 } from "../src/application/canonical.js";
import { AlphionError, normalizeError } from "../src/application/errors.js";
import type { DiagnosticReport, ProjectProfile, ResourceScope } from "../src/domain/contracts.js";
import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from "../src/ports/index.js";
import type { LocalAlphionApplication } from "../adapters/local/local-application.js";
import type { SqliteStore } from "../adapters/store/sqlite-store.js";

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
  if (group === "_launcher") return launcherCommand(command, parsed);
  const requestedRoot = resolve(flagValue(parsed, "project-root") ?? process.cwd());
  const requestedState = flagValue(parsed, "state");
  if (group === "doctor") {
    const { diagnoseLocalProject } = await import("../adapters/local/local-application.js");
    const report = await diagnoseLocalProject({
      projectRoot: requestedRoot,
      ...(requestedState ? { statePath: resolve(requestedState) } : {}),
    });
    renderDiagnosticReport(report, hasFlag(parsed, "json"));
    return report.overall === "unhealthy" ? 1 : 0;
  }
  const projectRoot = await realpath(requestedRoot);
  const statePath = resolve(requestedState ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
  if (group === "tui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AlphionError("validation", "The Alphion TUI requires an interactive terminal.", { stage: "tui" });
    }
    const { runTui } = await import("../tui/index.js");
    const sessionId = flagValue(parsed, "session");
    return runTui({ projectRoot, statePath, ...(sessionId ? { sessionId } : {}) });
  }
  if (group === "web") { const { runWebUi } = await import("../webui/main.js"); await runWebUi({ ...(flagValue(parsed, "port") ? { port: Number(flagValue(parsed, "port")) } : {}) }); return 0; }
  if (group === "project") {
    if (command === "inspect") return projectInspectCommand(projectRoot, statePath, parsed);
    return projectRegistryCommand(command, parsed);
  }
  if (group === "session") return sessionCommand(command, parsed, projectRoot, statePath);
  if (group === "resource") return resourceCommand(command, parsed, projectRoot, statePath);
  if (group === "goal" || group === "schedule" || group === "context") return automationCliCommand(group, command, parsed, projectRoot, statePath);
  if (group === "desktop") { const { launchDesktop } = await import("../desktop/launcher.js"); await launchDesktop(); return 0; }
  if (group === "harness" && command === "plan") return harnessPlanCommand(parsed, projectRoot, statePath);
  if (group === "run") return runCommand(parsed, projectRoot, statePath);
  if (group === "provider" && command === "test") return providerTestCommand(projectRoot, statePath, parsed);
  const { SqliteStore: Store } = await import("../adapters/store/sqlite-store.js");
  const store = new Store({ path: statePath });
  try {
    if (group === "provider") return await providerCommand(store, command, parsed);
    if (group === "policy" && command === "shell") return await shellPolicyCommand(store, parsed);
    if (group === "cache") return await cacheCommand(store, command, parsed);
    throw new AlphionError("validation", `Unknown command: ${[group, command].filter(Boolean).join(" ")}`, { stage: "cli" });
  } finally {
    store.close();
  }
}

async function providerTestCommand(projectRoot: string, statePath: string, parsed: ParsedArguments): Promise<number> {
  const application = await openApplication(projectRoot, statePath);
  try {
    if (hasFlag(parsed, "all")) {
      const results = await application.providerTests.testAll();
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return results.every((item) => item.status === "success") ? 0 : 1;
    }
    const result = await application.providerTests.test(parsed.positionals[2] ?? "");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === "success" ? 0 : 1;
  } finally { await application.close(); }
}

async function providerCommand(store: SqliteStore, command: string | undefined, parsed: ParsedArguments): Promise<number> {
  if (command === "set") {
    const id = requiredFlag(parsed, "id");
    const authEnvironment = flagValue(parsed, "auth-env");
    const presetId = flagValue(parsed, "preset") ?? "deepseek";
    const { providerPreset } = await import("../adapters/model/provider-catalog.js");
    const preset = providerPreset(presetId);
    if (!preset.requiresBaseUrl && flagValue(parsed, "base-url") !== undefined) {
      throw new AlphionError("validation", "Built-in Provider presets do not accept --base-url.", { stage: "config" });
    }
    const kindValue = preset.kind;
    const protocol = flagValue(parsed, "protocol") ?? preset.protocol;
    if (protocol !== "chat-completions" && protocol !== "responses") {
      throw new AlphionError("validation", "--protocol must be chat-completions or responses.", { stage: "cli" });
    }
    const model = requiredFlag(parsed, "model");
    const rawContextWindow = flagValue(parsed, "context-window");
    const contextWindowTokens = rawContextWindow === undefined ? undefined : Number(rawContextWindow);
    if (contextWindowTokens !== undefined && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 4_096 || contextWindowTokens > 4_194_304)) throw new AlphionError("validation", "--context-window must be an integer between 4096 and 4194304.", { stage: "cli" });
    const common = {
      schemaVersion: 3,
      id,
      name: flagValue(parsed, "name") ?? id,
      kind: kindValue,
      model,
      protocol,
      auth: authEnvironment ? { mode: "bearer-env" as const, environmentVariable: authEnvironment } : { mode: "none" as const },
      capabilities: {
        streaming: booleanFlag(parsed, "streaming", true),
        tools: booleanFlag(parsed, "tools", true),
        promptCaching: booleanFlag(parsed, "prompt-caching", false),
        reasoning: booleanFlag(parsed, "reasoning", kindValue === "deepseek" && model === "deepseek-reasoner"),
        vision: booleanFlag(parsed, "vision", preset.visionModels?.includes(model) ?? false),
        ...(hasFlag(parsed, "allow-unlisted-model") ? { unlistedModel: true } : {}),
      },
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      active: hasFlag(parsed, "active"),
    } as const;
    const profile = await store.upsertProfile(kindValue === "custom-openai-compatible"
      ? { ...common, kind: kindValue, baseUrl: requiredFlag(parsed, "base-url") }
      : { ...common, kind: kindValue, presetId });
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
  throw new AlphionError("validation", "provider command must be set, list, activate, or test.", { stage: "cli" });
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

async function runCommand(parsed: ParsedArguments, projectRoot: string, statePath: string): Promise<number> {
  const prompt = requiredFlag(parsed, "prompt");
  const selected = flagValue(parsed, "provider");
  const application = await openApplication(projectRoot, statePath);
  try {
    const session = await application.sessions.create({ title: prompt.slice(0, 80), ...(selected ? { providerId: selected } : {}) });
    const record = await session.get();
    const handle = await session.send(prompt, { expectedRevision: record.revision, idempotencyKey: createCliKey("send") }, new CliApprovalPort());
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
  } finally {
    await application.close();
  }
}

async function sessionCommand(command: string | undefined, parsed: ParsedArguments, projectRoot: string, statePath: string): Promise<number> {
  const application = await openApplication(projectRoot, statePath);
  try {
    if (command === "create") {
      const providerId = flagValue(parsed, "provider");
      const session = await application.sessions.create({ title: flagValue(parsed, "title") ?? "新会话", ...(providerId ? { providerId } : {}) });
      process.stdout.write(`${JSON.stringify(await session.get(), null, 2)}\n`); return 0;
    }
    if (command === "list") { process.stdout.write(`${JSON.stringify(await application.sessions.list(), null, 2)}\n`); return 0; }
    const id = parsed.positionals[2];
    if (!id) throw new AlphionError("validation", `session ${command ?? "command"} requires SESSION_ID.`, { stage: "cli" });
    const session = await application.sessions.get(id);
    if (command === "show") { process.stdout.write(`${JSON.stringify(await session.view(), null, 2)}\n`); return 0; }
    if (command === "shape") { process.stdout.write(`${JSON.stringify(await session.getShape(), null, 2)}\n`); return 0; }
    const record = await session.get();
    const options = { expectedRevision: Number(flagValue(parsed, "revision") ?? record.revision), idempotencyKey: flagValue(parsed, "idempotency-key") ?? createCliKey(command) };
    if (command === "fork") { const sourceEntryId = flagValue(parsed, "entry"); const title = flagValue(parsed, "title"); process.stdout.write(`${JSON.stringify(await session.fork({ ...(sourceEntryId ? { sourceEntryId } : {}), ...(title ? { title } : {}), ...options }), null, 2)}\n`); return 0; }
    if (command === "checkout") { process.stdout.write(`${JSON.stringify(await session.checkout(flagValue(parsed, "entry"), options), null, 2)}\n`); return 0; }
    if (command === "steer") { process.stdout.write(`${JSON.stringify(await session.steer(requiredFlag(parsed, "message"), options), null, 2)}\n`); return 0; }
    if (command === "follow-up") { process.stdout.write(`${JSON.stringify(await session.followUp(requiredFlag(parsed, "message"), options, new CliApprovalPort()), null, 2)}\n`); return 0; }
    if (command === "reshape") { const providerId = flagValue(parsed, "provider"); process.stdout.write(`${JSON.stringify(await session.reshape({ goal: requiredFlag(parsed, "goal"), ...(providerId ? { providerId } : {}) }, options), null, 2)}\n`); return 0; }
    if (command === "send") {
      const handle = await session.send(requiredFlag(parsed, "message"), options, new CliApprovalPort());
      for await (const event of handle.events) if (event.kind === "model.delta" && typeof event.payload.delta === "string") process.stdout.write(event.payload.delta);
      const result = await handle.result; process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`); return result.status === "completed" ? 0 : 1;
    }
    throw new AlphionError("validation", "session command must be create, list, show, shape, reshape, fork, checkout, send, steer, or follow-up.", { stage: "cli" });
  } finally { await application.close(); }
}

async function resourceCommand(command: string | undefined, parsed: ParsedArguments, projectRoot: string, statePath: string): Promise<number> {
  if (command !== "list" && command !== "doctor") throw new AlphionError("validation", "resource command must be list or doctor.", { stage: "cli" });
  const application = await openApplication(projectRoot, statePath);
  try {
    const resolution = await application.loadResources({ ...(parsed.flags.has("disable-scope") ? { disabledScopes: resourceScopes(parsed.flags.get("disable-scope") ?? []) } : {}), ...(parsed.flags.has("disable-id") ? { disabledIds: parsed.flags.get("disable-id") ?? [] } : {}) });
    process.stdout.write(`${JSON.stringify(command === "list" ? resolution.resources : resolution, null, 2)}\n`);
    return resolution.diagnostics.some((item) => item.severity === "error") ? 1 : 0;
  } finally { await application.close(); }
}

async function harnessPlanCommand(parsed: ParsedArguments, projectRoot: string, statePath: string): Promise<number> {
  const application = await openApplication(projectRoot, statePath);
  try { process.stdout.write(`${JSON.stringify(await application.planHarness(requiredFlag(parsed, "prompt")), null, 2)}\n`); return 0; }
  finally { await application.close(); }
}

async function automationCliCommand(group: string, command: string | undefined, parsed: ParsedArguments, projectRoot: string, statePath: string): Promise<number> {
  const application = await openApplication(projectRoot, statePath);
  try { const { automationCommand } = await import("./automation.js"); return await automationCommand(group, command, parsed, application); }
  finally { await application.close(); }
}

function createCliKey(action: string | undefined): string { return `cli:${action ?? "command"}:${process.pid}:${Date.now()}`; }

async function openApplication(projectRoot: string, statePath: string): Promise<LocalAlphionApplication> {
  const { openLocalAlphionApplication } = await import("../adapters/local/local-application.js");
  const { LocalProjectManager } = await import("../adapters/project/project-manager.js");
  const project = await new LocalProjectManager().open({ root: projectRoot });
  return openLocalAlphionApplication({ projectRoot: project.root, statePath, projectId: project.id, domainId: project.domainId });
}

async function projectInspectCommand(projectRoot: string, statePath: string, parsed: ParsedArguments): Promise<number> {
  const application = await openApplication(projectRoot, statePath);
  try {
    const profile = await application.inspectProject({ ...(hasFlag(parsed, "refresh") ? { refresh: true } : {}) });
    if (hasFlag(parsed, "json")) process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    else renderProjectProfile(profile);
    return 0;
  } finally {
    await application.close();
  }
}

async function projectRegistryCommand(command: string | undefined, parsed: ParsedArguments): Promise<number> {
  const { LocalProjectManager } = await import("../adapters/project/project-manager.js");
  const manager = new LocalProjectManager(flagValue(parsed, "registry"));
  if (command === "list") { process.stdout.write(`${JSON.stringify(await manager.list(), null, 2)}\n`); return 0; }
  if (command === "current") { process.stdout.write(`${JSON.stringify(await manager.current() ?? null, null, 2)}\n`); return 0; }
  if (command === "register") {
    const input = { name: requiredFlag(parsed, "name"), root: flagValue(parsed, "root") ?? parsed.positionals[2] };
    if (!input.root) throw new AlphionError("validation", "project register requires ROOT or --root.", { stage: "cli" });
    process.stdout.write(`${JSON.stringify(await manager.register({ name: input.name, root: input.root }), null, 2)}\n`); return 0;
  }
  if (command === "create") {
    const root = flagValue(parsed, "root") ?? parsed.positionals[2];
    if (!root) throw new AlphionError("validation", "project create requires ROOT or --root.", { stage: "cli" });
    const name = flagValue(parsed, "name"); const project = await manager.open({ root, create: true, ...(name ? { name } : {}) });
    process.stdout.write(`${JSON.stringify(project, null, 2)}\n`); return 0;
  }
  if (command === "open") {
    const target = parsed.positionals[2] ?? flagValue(parsed, "root");
    if (!target) throw new AlphionError("validation", "project open requires PROJECT_ID or ROOT.", { stage: "cli" });
    const byId = await manager.get(target); const name = flagValue(parsed, "name");
    const project = byId ? await manager.activate(byId.id) : await manager.open({ root: target, ...(name ? { name } : {}) });
    process.stdout.write(`${JSON.stringify(project, null, 2)}\n`); return 0;
  }
  const projectId = parsed.positionals[2];
  if (!projectId) throw new AlphionError("validation", `project ${command ?? "command"} requires PROJECT_ID.`, { stage: "cli" });
  if (command === "activate") { process.stdout.write(`${JSON.stringify(await manager.activate(projectId), null, 2)}\n`); return 0; }
  if (command === "remove") { const removed = await manager.remove(projectId); process.stdout.write(`${removed ? "removed" : "not found"}\n`); return removed ? 0 : 1; }
  throw new AlphionError("validation", "project command must be inspect, register, create, open, list, current, activate, or remove.", { stage: "cli" });
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

function resourceScopes(values: readonly string[]): readonly ResourceScope[] {
  const scopes = new Set<ResourceScope>(["builtin", "user", "project", "session"]);
  if (values.some((value) => !scopes.has(value as ResourceScope))) throw new AlphionError("validation", "--disable-scope must be builtin, user, project, or session.", { stage: "cli" });
  return values as readonly ResourceScope[];
}

function safeEventMessage(payload: Readonly<Record<string, unknown>>): string {
  const message = payload.message ?? payload.reason ?? payload.code;
  return typeof message === "string" ? message : "See the local audit event for details.";
}

function printHelp(): void {
  process.stdout.write(`Alphion v0.10.0\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  provider set --id ID --preset deepseek|deepseek-international|kimi|kimi-international|qwen|qwen-international|glm|glm-international|custom-openai-compatible --model MODEL [--context-window 4096..4194304] [--vision true|false] [--allow-unlisted-model] [--base-url URL for custom only] [--protocol chat-completions|responses] [--auth-env NAME] [--active]\n`);
  process.stdout.write(`  provider list\n  provider activate ID\n  provider test ID | provider test --all  # 真实请求，可能产生费用\n`);
  process.stdout.write(`  policy shell allow --executable ABSOLUTE_PATH [--arg-prefix VALUE ...]\n`);
  process.stdout.write(`  policy shell list\n  policy shell remove ID\n`);
  process.stdout.write(`  cache stats\n  cache clear [--namespace NAME]\n`);
  process.stdout.write(`  doctor [--json] [--project-root PATH] [--state PATH]\n`);
  process.stdout.write(`  project inspect [--refresh] [--json] [--project-root PATH]\n  project create ROOT [--name NAME] | project open PROJECT_ID|ROOT [--name NAME]\n  project register --name NAME --root PATH | project list|current|activate|remove ...\n`);
  process.stdout.write(`  run --prompt TEXT [--provider ID] [--project-root PATH] [--no-cache]\n\n`);
  process.stdout.write(`  session create|list|show|shape|reshape|fork|checkout|send|steer|follow-up ...\n  harness plan --prompt TEXT\n`);
  process.stdout.write(`  resource list|doctor [--disable-scope SCOPE] [--disable-id ID]\n  web [--port PORT]\n  desktop\n`);
  process.stdout.write(`  context list SESSION_ID [--limit N] | context show SESSION_ID COMPACTION_ID\n`);
  process.stdout.write(`  goal create|list|show|update|progress|confirm|archive|restore ...\n`);
  process.stdout.write(`  schedule create|list|show|pause|resume|run-now|executions ...\n`);
  process.stdout.write(`    goal create --title TEXT --root TEXT --acceptance TEXT [--acceptance TEXT]\n`);
  process.stdout.write(`    goal progress GOAL_ID --progress TEXT [--evidence ID] [--next TEXT] [--blocker TEXT]\n`);
  process.stdout.write(`    schedule create --title TEXT (--once ISO|--interval-minutes N|--cron EXPR) --timezone IANA (--goal ID|--session ID --prompt TEXT)\n`);
  process.stdout.write(`  tui [--session SESSION_ID] [--project-root PATH] [--state PATH]\n\n`);
  process.stdout.write(`Global options: --state PATH --project-root PATH\n`);
}

function launcherCommand(command: string | undefined, parsed: ParsedArguments): number {
  if (command === "menu") {
    process.stdout.write(`\n  ALPHION 0.10.0\n  ==============\n\n`);
    process.stdout.write(`  1. 启动 Alphion\n  2. 启动 doctor\n  3. 查看命令帮助\n  4. 退出\n\n`);
    return 0;
  }
  if (command === "result") {
    const action = flagValue(parsed, "action") ?? "操作";
    const code = flagValue(parsed, "code") ?? "1";
    process.stdout.write(`[提示] ${sanitizeLauncherLabel(action)}已结束，退出码：${sanitizeLauncherLabel(code)}\n`);
    return 0;
  }
  throw new AlphionError("validation", "Unknown internal launcher command.", { stage: "cli" });
}

function sanitizeLauncherLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 32);
}

function renderProjectProfile(profile: ProjectProfile): void {
  process.stdout.write(`项目类型: ${profile.projectType}\nrevision: ${profile.projectRevision}\n扫描路径: ${profile.scannedPaths}${profile.truncated ? "（已截断）" : ""}\n`);
  for (const fact of profile.facts) process.stdout.write(`  ✓ ${fact.category} · ${fact.name}: ${fact.value}\n`);
  for (const diagnostic of profile.diagnostics) process.stdout.write(`  ${diagnostic.severity === "warning" ? "!" : "·"} ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}\n`);
}

function renderDiagnosticReport(report: DiagnosticReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Alphion 只读诊断 · ${report.overall}\n`);
  for (const check of report.checks) {
    const symbol = check.status === "pass" ? "✓" : check.status === "warning" || check.status === "unknown" ? "!" : "✗";
    process.stdout.write(`${symbol} ${check.label}: ${check.summary}\n`);
    if (check.remediation) process.stdout.write(`  修复: ${check.remediation}\n`);
  }
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
