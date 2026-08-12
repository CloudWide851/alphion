import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../src/application/canonical.js";
import type { RecallItem, RecallResult } from "../../src/domain/contracts.js";
import type { CodeRecall } from "../../src/ports/index.js";

const execFileAsync = promisify(execFile);
const EXCLUDED = /(^|[\\/])(?:\.git|\.alphion|node_modules|dist|coverage)(?:[\\/]|$)|\.env(?:\.|$)/iu;

export class ProjectCodeRecall implements CodeRecall {
  readonly #cache = new Map<string, RecallResult>();
  clear(): void { this.#cache.clear(); }

  async recall(request: Readonly<{ projectRoot: string; projectRevision: string; query: string; scope?: readonly string[]; limit?: number }>, signal: AbortSignal): Promise<RecallResult> {
    const root = await realpath(resolve(request.projectRoot));
    const limit = Math.max(1, Math.min(50, request.limit ?? 20));
    const scope = normalizeScope(root, request.scope ?? ["."]);
    const key = sha256(JSON.stringify({ root, revision: request.projectRevision, query: request.query, scope, limit, adapter: "project-code-recall-v2" }));
    const cached = this.#cache.get(key);
    if (cached) return cached;
    try {
      // CodeGraph currently exposes project-level ranking only. Scoped requests
      // fail over before ranking so results can never escape the caller scope.
      if (scope.length !== 1 || scope[0] !== ".") throw new Error("scoped-lexical-required");
      const { stdout } = await execFileAsync("codegraph", ["explore", request.query, "-p", root, "--max-files", String(limit)], { cwd: root, signal, timeout: 8_000, windowsHide: true, maxBuffer: 512 * 1024 });
      const item: RecallItem = Object.freeze({ source: "codegraph", path: ".codegraph", excerpt: stdout.slice(0, 32_000), confidence: 0.9, evidence: sha256(stdout) });
      const result: RecallResult = Object.freeze({ items: Object.freeze([item]), degraded: false, diagnostics: Object.freeze([]) });
      this.#cache.set(key, result); return result;
    } catch {
      const items = await lexicalRecall(root, request.query, scope, limit, signal);
      const diagnostic = scope.length === 1 && scope[0] === "." ? "codegraph-unavailable:lexical-fallback" : "codegraph-scope-unsupported:lexical-fallback";
      const result: RecallResult = Object.freeze({ items, degraded: true, diagnostics: Object.freeze([diagnostic]) });
      this.#cache.set(key, result); return result;
    }
  }
}

async function lexicalRecall(root: string, query: string, scope: readonly string[], limit: number, signal: AbortSignal): Promise<readonly RecallItem[]> {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  const items: RecallItem[] = [];
  for (const entry of scope) {
    for await (const path of walk(resolve(root, entry), root, signal)) {
      if (items.length >= limit) break;
      const content = await readFile(path, "utf8").catch(() => "");
      const lines = content.split(/\r?\n/u);
      const index = lines.findIndex((line) => terms.some((term) => line.toLowerCase().includes(term)));
      if (index < 0) continue;
      const excerpt = lines.slice(Math.max(0, index - 1), index + 3).join("\n").slice(0, 4000);
      items.push(Object.freeze({ source: "lexical", path: relative(root, path).replaceAll("\\", "/"), excerpt, confidence: 0.5, evidence: sha256(excerpt) }));
    }
  }
  return Object.freeze(items);
}

async function* walk(path: string, root: string, signal: AbortSignal): AsyncGenerator<string> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Recall cancelled.", "AbortError");
  const rel = relative(root, path);
  if (rel.startsWith("..") || EXCLUDED.test(rel)) return;
  const linkMetadata = await lstat(path).catch(() => undefined);
  if (!linkMetadata || linkMetadata.isSymbolicLink()) return;
  const canonical = await realpath(path).catch(() => undefined);
  if (!canonical) return;
  const canonicalRel = relative(root, canonical);
  if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel) || EXCLUDED.test(canonicalRel)) return;
  const metadata = await stat(canonical).catch(() => undefined);
  if (!metadata) return;
  if (metadata.isFile()) { if (metadata.size <= 1024 * 1024) yield path; return; }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) yield* walk(resolve(path, entry.name), root, signal);
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
