import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../src/application/canonical.js";
import type { RecallItem, RecallResult } from "../../src/domain/contracts.js";
import type { CodeRecall } from "../../src/ports/index.js";

const execFileAsync = promisify(execFile);
const CODEGRAPH_TIMEOUT_MS = 3_000;
const LEXICAL_TIMEOUT_MS = 1_000;
const LEXICAL_MAX_FILES = 256;
const LEXICAL_MAX_BYTES = 8 * 1024 * 1024;
const LEXICAL_MAX_RESULTS = 20;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const EXCLUDED = /(^|[\\/])(?:\.git|\.alphion|\.codegraph|\.trellis|\.desktop-runtime|\.cache|node_modules|dist|build|coverage|release|out|target|vendor)(?:[\\/]|$)|\.env(?:\.|$)/iu;

type CodeGraphExecutor = (request: Readonly<{ root: string; query: string; limit: number; signal: AbortSignal; timeoutMs: number }>) => Promise<string>;
type LexicalCandidate = Readonly<{ path: string; size: number }>;
type LexicalOutcome = Readonly<{ items: readonly RecallItem[]; diagnostics: readonly string[]; cacheable: boolean }>;

const executeCodeGraphCli: CodeGraphExecutor = async ({ root, query, limit, signal, timeoutMs }) => {
  const { stdout } = await execFileAsync("codegraph", ["explore", query, "-p", root, "--max-files", String(limit)], {
    cwd: root, signal, timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024, encoding: "utf8",
  });
  return stdout;
};

export class ProjectCodeRecall implements CodeRecall {
  readonly #cache = new Map<string, RecallResult>();
  constructor(private readonly executeCodeGraph: CodeGraphExecutor = executeCodeGraphCli, private readonly now: () => number = Date.now) {}
  clear(): void { this.#cache.clear(); }

  async recall(request: Readonly<{ projectRoot: string; projectRevision: string; query: string; scope?: readonly string[]; limit?: number }>, signal: AbortSignal): Promise<RecallResult> {
    throwIfAborted(signal);
    const root = await realpath(resolve(request.projectRoot));
    throwIfAborted(signal);
    const limit = Math.max(1, Math.min(LEXICAL_MAX_RESULTS, request.limit ?? LEXICAL_MAX_RESULTS));
    const scope = normalizeScope(root, request.scope ?? ["."]);
    const key = sha256(JSON.stringify({ root, revision: request.projectRevision, query: request.query, scope, limit, adapter: "project-code-recall-v3" }));
    const cached = this.#cache.get(key);
    if (cached) return cached;

    let codeGraphDiagnostic = "codegraph-scope-unsupported:lexical-fallback";
    if (scope.length === 1 && scope[0] === ".") {
      try {
        const stdout = await this.executeCodeGraph({ root, query: request.query, limit, signal, timeoutMs: CODEGRAPH_TIMEOUT_MS });
        throwIfAborted(signal);
        const item: RecallItem = Object.freeze({ source: "codegraph", path: ".codegraph", excerpt: stdout.slice(0, 32_000), confidence: 0.9, evidence: sha256(stdout) });
        const result: RecallResult = Object.freeze({ items: Object.freeze([item]), degraded: false, diagnostics: Object.freeze([]) });
        this.#cache.set(key, result);
        return result;
      } catch (error) {
        throwIfAborted(signal);
        codeGraphDiagnostic = classifyCodeGraphFailure(error);
      }
    }

    const lexical = await lexicalRecall(root, request.query, scope, limit, signal, this.now);
    throwIfAborted(signal);
    const result: RecallResult = Object.freeze({ items: lexical.items, degraded: true, diagnostics: Object.freeze([codeGraphDiagnostic, ...lexical.diagnostics]) });
    if (lexical.cacheable) this.#cache.set(key, result);
    return result;
  }
}

async function lexicalRecall(root: string, query: string, scope: readonly string[], limit: number, signal: AbortSignal, now: () => number): Promise<LexicalOutcome> {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return Object.freeze({ items: Object.freeze([]), diagnostics: Object.freeze(["lexical-query-has-no-searchable-terms"]), cacheable: true });
  const deadline = AbortSignal.timeout(LEXICAL_TIMEOUT_MS);
  const boundedSignal = AbortSignal.any([signal, deadline]);
  const startedAt = now();
  const items: RecallItem[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  let filesRead = 0;
  let bytesRead = 0;
  try {
    for (const entry of scope) {
      for await (const candidate of walk(resolve(root, entry), root, boundedSignal)) {
        if (seen.has(candidate.path)) continue;
        seen.add(candidate.path);
        if (now() - startedAt >= LEXICAL_TIMEOUT_MS) throw new DOMException("Lexical recall timed out.", "TimeoutError");
        if (filesRead >= LEXICAL_MAX_FILES) { diagnostics.push("lexical-file-budget-exhausted"); return lexicalOutcome(items, diagnostics, true); }
        if (bytesRead + candidate.size > LEXICAL_MAX_BYTES) { diagnostics.push("lexical-byte-budget-exhausted"); return lexicalOutcome(items, diagnostics, true); }
        filesRead += 1;
        bytesRead += candidate.size;
        const content = await readFile(candidate.path, { encoding: "utf8", signal: boundedSignal }).catch((error: unknown) => {
          if (boundedSignal.aborted) throw boundedSignal.reason ?? error;
          return "";
        });
        if (now() - startedAt >= LEXICAL_TIMEOUT_MS) throw new DOMException("Lexical recall timed out.", "TimeoutError");
        const lines = content.split(/\r?\n/u);
        const index = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
        if (index < 0) continue;
        const excerpt = lines.slice(Math.max(0, index - 1), index + 3).join("\n").slice(0, 4000);
        items.push(Object.freeze({ source: "lexical", path: relative(root, candidate.path).replaceAll("\\", "/"), excerpt, confidence: 0.5, evidence: sha256(excerpt) }));
        if (items.length >= limit) { diagnostics.push("lexical-result-budget-exhausted"); return lexicalOutcome(items, diagnostics, true); }
      }
    }
  } catch (error) {
    throwIfAborted(signal);
    if (deadline.aborted || isTimeout(error)) return lexicalOutcome([], ["lexical-time-budget-exhausted"], false);
    throw error;
  }
  return lexicalOutcome(items, diagnostics, true);
}

async function* walk(path: string, root: string, signal: AbortSignal): AsyncGenerator<LexicalCandidate> {
  throwIfAborted(signal);
  const rel = relative(root, path);
  if (rel.startsWith("..") || EXCLUDED.test(rel)) return;
  const linkMetadata = await optionalFileOperation(lstat(path), signal);
  if (!linkMetadata || linkMetadata.isSymbolicLink()) return;
  const canonical = await optionalFileOperation(realpath(path), signal);
  if (!canonical) return;
  const canonicalRel = relative(root, canonical);
  if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel) || EXCLUDED.test(canonicalRel)) return;
  const metadata = await optionalFileOperation(stat(canonical), signal);
  if (!metadata) return;
  if (metadata.isFile()) { if (metadata.size <= MAX_TEXT_FILE_BYTES) yield Object.freeze({ path: canonical, size: metadata.size }); return; }
  if (!metadata.isDirectory()) return;
  const entries = await abortable(readdir(canonical, { withFileTypes: true }), signal);
  entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  for (const entry of entries) yield* walk(resolve(canonical, entry.name), root, signal);
}

function normalizeScope(root: string, requested: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const entry of requested) {
    if (!entry.trim()) continue;
    const absolute = resolve(root, entry);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel) || EXCLUDED.test(rel)) continue;
    normalized.add(rel ? rel.replaceAll("\\", "/") : ".");
  }
  return Object.freeze([...normalized].sort());
}

function classifyCodeGraphFailure(error: unknown): string {
  const failure = error && typeof error === "object" ? error as Readonly<{ code?: unknown; killed?: unknown; name?: unknown }> : undefined;
  if (failure?.name === "TimeoutError" || failure?.code === "ETIMEDOUT" || failure?.killed === true) return "codegraph-timeout:lexical-fallback";
  if (failure?.code === "ENOENT") return "codegraph-missing:lexical-fallback";
  return "codegraph-failed:lexical-fallback";
}

function lexicalOutcome(items: readonly RecallItem[], diagnostics: readonly string[], cacheable: boolean): LexicalOutcome {
  return Object.freeze({ items: Object.freeze([...items]), diagnostics: Object.freeze([...diagnostics]), cacheable });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Recall cancelled.", "AbortError");
}

async function optionalFileOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  try { return await abortable(operation, signal); }
  catch (error) { throwIfAborted(signal); return undefined; }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Recall cancelled.", "AbortError"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason ?? new DOMException("Recall cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); rejectPromise(error); },
    );
  });
}
