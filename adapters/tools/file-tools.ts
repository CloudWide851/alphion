import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import type { ToolExecutor } from "../../src/ports/index.js";
import { normalizeRequestedPath, rejectExcludedOrSecret, resolveSafePath } from "./path-safety.js";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_GREP_FILES = 5000;

export class ReadTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "read",
    description: "Read a UTF-8 text file inside the project. Secret, generated, dependency, and internal-state paths are denied.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1048576 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    risk: "read",
    cachePolicy: "content",
    executionMode: "parallel-safe",
    sideEffect: "none",
    idempotent: true,
    approval: "never",
    timeoutMs: 30_000,
  } as const);

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const safe = await resolveSafePath(context.projectRoot, normalizeRequestedPath(input.path), { mustExist: true });
    const metadata = await stat(safe.absolutePath);
    if (metadata.size > MAX_TEXT_BYTES) throw new AlphionError("budget-exceeded", "File exceeds the read size limit.", { stage: "tool:read" });
    const content = await readText(safe.absolutePath);
    const offset = integerInput(input.offset, 0, 0, content.length, "offset");
    const limit = integerInput(input.limit, Math.min(content.length, MAX_TEXT_BYTES), 1, MAX_TEXT_BYTES, "limit");
    const selected = content.slice(offset, offset + limit);
    const digest = sha256(content);
    return {
      content: selected,
      evidence: {
        id: createId("evidence"),
        kind: "file" as const,
        digest,
        summary: `${safe.relativePath} sha256:${digest}`,
      },
      isError: false,
    };
  }
}

export class GrepTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "grep",
    description: "Search project UTF-8 text files for a literal query with bounded files, matches, and output.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        path: { type: "string" },
        caseSensitive: { type: "boolean" },
        maxMatches: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    risk: "read",
    cachePolicy: "content",
    executionMode: "parallel-safe",
    sideEffect: "none",
    idempotent: true,
    approval: "never",
    timeoutMs: 30_000,
  } as const);

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const query = stringInput(input.query, "query");
    if (query.length > 4096) throw new AlphionError("validation", "Search query is too long.", { stage: "tool:grep" });
    const requestedPath = input.path === undefined ? "." : normalizeRequestedPath(input.path);
    const safe = await resolveSafePath(context.projectRoot, requestedPath, { mustExist: true, allowDirectory: true });
    const caseSensitive = booleanInput(input.caseSensitive, true, "caseSensitive");
    const maxMatches = integerInput(input.maxMatches, 200, 1, 500, "maxMatches");
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: string[] = [];
    const digestParts: string[] = [];
    let filesVisited = 0;
    for await (const file of walkTextCandidates(safe.absolutePath, context.signal)) {
      filesVisited += 1;
      if (filesVisited > MAX_GREP_FILES) break;
      const projectRelative = relative(safe.projectRoot, file);
      try {
        rejectExcludedOrSecret(projectRelative);
        const metadata = await stat(file);
        if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) continue;
        const content = await readText(file);
        digestParts.push(`${projectRelative}:${sha256(content)}`);
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (haystack.includes(needle)) {
            matches.push(`${projectRelative}:${index + 1}:${line.slice(0, 500)}`);
            if (matches.length >= maxMatches) break;
          }
        }
      } catch (error) {
        if (error instanceof AlphionError && (error.code === "forbidden" || error.code === "validation")) continue;
        throw error;
      }
      if (matches.length >= maxMatches) break;
    }
    const digest = sha256(digestParts.sort().join("\n"));
    return {
      content: matches.length > 0 ? matches.join("\n") : "No matches found.",
      evidence: {
        id: createId("evidence"),
        kind: "search" as const,
        digest,
        summary: `${matches.length} match(es) for a literal query under ${safe.relativePath || "."}`,
      },
      isError: false,
    };
  }
}

export class EditTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "edit",
    description: "Replace exactly one text occurrence in a project file after verifying its SHA-256 digest.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
      },
      required: ["path", "expectedSha256", "oldText", "newText"],
      additionalProperties: false,
    },
    risk: "write",
    cachePolicy: "none",
    executionMode: "serial",
    sideEffect: "write",
    idempotent: false,
    approval: "policy",
    timeoutMs: 30_000,
  } as const);

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const safe = await resolveSafePath(context.projectRoot, normalizeRequestedPath(input.path), { mustExist: true });
    const expectedDigest = digestInput(input.expectedSha256);
    const oldText = stringInput(input.oldText, "oldText");
    const newText = stringInput(input.newText, "newText", true);
    const content = await readText(safe.absolutePath);
    if (sha256(content) !== expectedDigest) throw new AlphionError("conflict", "File changed since the proposed edit was created.", { stage: "tool:edit" });
    const first = content.indexOf(oldText);
    if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new AlphionError("conflict", "oldText must match exactly one occurrence.", { stage: "tool:edit" });
    }
    const updated = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
    ensureTextSize(updated);
    await atomicWrite(safe.absolutePath, updated);
    const digest = sha256(updated);
    return {
      content: `Updated ${safe.relativePath}.`,
      evidence: { id: createId("evidence"), kind: "change" as const, digest, summary: `${safe.relativePath} sha256:${digest}` },
      isError: false,
    };
  }
}

export class WriteTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "write",
    description: "Create or atomically overwrite a bounded UTF-8 project file with explicit mode and revision checks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", maxLength: 1048576 },
        mode: { enum: ["create", "overwrite"] },
        expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["path", "content", "mode"],
      additionalProperties: false,
    },
    risk: "write",
    cachePolicy: "none",
    executionMode: "serial",
    sideEffect: "write",
    idempotent: false,
    approval: "policy",
    timeoutMs: 30_000,
  } as const);

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const requested = normalizeRequestedPath(input.path);
    const content = stringInput(input.content, "content", true);
    ensureTextSize(content);
    const mode = input.mode;
    if (mode !== "create" && mode !== "overwrite") {
      throw new AlphionError("validation", "mode must be create or overwrite.", { stage: "tool:write" });
    }
    const exists = await resolveSafePath(context.projectRoot, requested, { mustExist: true }).then(() => true, () => false);
    if (mode === "create" && exists) throw new AlphionError("conflict", "Create mode refuses to overwrite an existing file.", { stage: "tool:write" });
    if (mode === "overwrite" && !exists) throw new AlphionError("conflict", "Overwrite mode requires an existing file.", { stage: "tool:write" });
    const safe = await resolveSafePath(context.projectRoot, requested, { mustExist: mode === "overwrite" });
    if (mode === "overwrite") {
      const expectedDigest = digestInput(input.expectedSha256);
      const current = await readText(safe.absolutePath);
      if (sha256(current) !== expectedDigest) throw new AlphionError("conflict", "File changed since the proposed write was created.", { stage: "tool:write" });
    }
    await atomicWrite(safe.absolutePath, content);
    const digest = sha256(content);
    return {
      content: `${mode === "create" ? "Created" : "Overwrote"} ${safe.relativePath}.`,
      evidence: { id: createId("evidence"), kind: "change" as const, digest, summary: `${safe.relativePath} sha256:${digest}` },
      isError: false,
    };
  }
}

async function readText(path: string): Promise<string> {
  const value = await readFile(path);
  if (value.includes(0)) throw new AlphionError("validation", "Binary files are not available to text tools.", { stage: "tool" });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new AlphionError("validation", "File is not valid UTF-8 text.", { stage: "tool", cause: error });
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${createId("tmp")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function* walkTextCandidates(root: string, signal: AbortSignal): AsyncGenerator<string> {
  const metadata = await stat(root);
  if (metadata.isFile()) {
    yield root;
    return;
  }
  const { opendir } = await import("node:fs/promises");
  const pending = [root];
  while (pending.length > 0) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
    const directory = pending.pop();
    if (!directory) break;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try {
          rejectExcludedOrSecret(relative(root, path));
          pending.push(path);
        } catch (error) {
          if (!(error instanceof AlphionError && error.code === "forbidden")) throw error;
        }
      } else if (entry.isFile()) yield path;
    }
  }
}

function stringInput(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new AlphionError("validation", `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`, { stage: "tool-input" });
  }
  return value;
}

function digestInput(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AlphionError("validation", "expectedSha256 must be a lowercase SHA-256 digest.", { stage: "tool-input" });
  }
  return value;
}

function integerInput(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AlphionError("validation", `${field} must be an integer between ${min} and ${max}.`, { stage: "tool-input" });
  }
  return value;
}

function booleanInput(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AlphionError("validation", `${field} must be boolean.`, { stage: "tool-input" });
  return value;
}

function ensureTextSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) {
    throw new AlphionError("budget-exceeded", "Text exceeds the file tool size limit.", { stage: "tool" });
  }
}
