import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "../../src/application/canonical.js";
import type { AgentResource, ResourceKind, ResourceLoadRequest, ResourceLoadResult } from "../../src/domain/contracts.js";
import type { ResourceLoader } from "../../src/ports/index.js";

const DEFAULT_PATHS: readonly Readonly<{ id: string; kind: ResourceKind; path: string }>[] = Object.freeze([
  { id: "agents", kind: "context", path: "AGENTS.md" },
  { id: "readme", kind: "context", path: "README.md" },
  { id: "trellis-guides", kind: "skill", path: ".trellis/spec/guides/index.md" },
]);
const EXCLUDED = /(^|[\\/])(?:\.git|\.alphion|node_modules|dist)(?:[\\/]|$)|(?:^|[._-])(?:secret|credential|private[-_]?key)(?:[._-]|$)|\.env(?:\.|$)/iu;

export class LocalResourceLoader implements ResourceLoader {
  async load(request: ResourceLoadRequest, signal?: AbortSignal): Promise<ResourceLoadResult> {
    const root = await realpath(resolve(request.projectRoot));
    const disabled = new Set(request.disabledIds ?? []);
    const limit = request.maxResources ?? 64;
    const maxBytes = request.maxBytes ?? 512 * 1024;
    const candidates = [...DEFAULT_PATHS, ...(request.additionalSafePaths ?? []).map((path, index) => ({ id: `extra-${index + 1}`, kind: "context" as const, path }))];
    const resources: AgentResource[] = [];
    const diagnostics: string[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Resource loading cancelled.", "AbortError");
      if (disabled.has(candidate.id)) continue;
      if (resources.length >= limit) { diagnostics.push("resource-count-truncated"); break; }
      const override = request.overrides?.[candidate.id];
      if (override !== undefined) {
        const overrideBytes = Buffer.byteLength(override);
        if (bytes + overrideBytes > maxBytes) { diagnostics.push(`oversize:${candidate.id}`); continue; }
        bytes += overrideBytes;
        resources.push(Object.freeze({ id: candidate.id, kind: candidate.kind, source: "override", content: override, digest: sha256(override) }));
        continue;
      }
      const requested = isAbsolute(candidate.path) ? resolve(candidate.path) : resolve(root, candidate.path);
      const rel = relative(root, requested);
      if (rel.startsWith("..") || isAbsolute(rel) || EXCLUDED.test(rel)) { diagnostics.push(`rejected:${candidate.id}`); continue; }
      let canonical: string;
      try { canonical = await realpath(requested); } catch { diagnostics.push(`missing:${candidate.id}`); continue; }
      const canonicalRel = relative(root, canonical);
      if (canonicalRel.startsWith("..") || EXCLUDED.test(canonicalRel)) { diagnostics.push(`rejected:${candidate.id}`); continue; }
      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size > maxBytes || bytes + metadata.size > maxBytes) { diagnostics.push(`oversize:${candidate.id}`); continue; }
      const content = await readFile(canonical, "utf8");
      bytes += Buffer.byteLength(content);
      resources.push(Object.freeze({ id: candidate.id, kind: candidate.kind, source: canonicalRel.replaceAll("\\", "/"), content, digest: sha256(content) }));
    }
    for (const [id, content] of Object.entries(request.overrides ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (disabled.has(id) || resources.some((item) => item.id === id) || resources.length >= limit) continue;
      if (bytes + Buffer.byteLength(content) > maxBytes) { diagnostics.push(`oversize:${id}`); continue; }
      bytes += Buffer.byteLength(content);
      resources.push(Object.freeze({ id, kind: "prompt", source: "override", content, digest: sha256(content) }));
    }
    resources.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const frozen = Object.freeze(resources);
    return Object.freeze({ resources: frozen, diagnostics: Object.freeze(diagnostics), digest: sha256(canonicalJson(frozen.map(({ id, kind, digest }) => ({ id, kind, digest })))) });
  }
}
