import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AlphionError } from "../../src/application/errors.js";

const EXCLUDED_SEGMENTS = new Set([
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
  "node_modules",
  "dist",
  "out",
  "vendor",
]);

export interface SafePath {
  readonly projectRoot: string;
  readonly absolutePath: string;
  readonly relativePath: string;
}

export async function resolveSafePath(
  projectRoot: string,
  requestedPath: string,
  options: Readonly<{ mustExist: boolean; allowDirectory?: boolean }>,
): Promise<SafePath> {
  if (requestedPath.includes("\0") || requestedPath.trim().length === 0) {
    throw new AlphionError("validation", "Path must be non-empty and contain no null bytes.", { stage: "path" });
  }
  const root = await realpath(resolve(projectRoot));
  const lexicalTarget = resolve(root, requestedPath);
  ensureInside(root, lexicalTarget);
  const lexicalRelative = relative(root, lexicalTarget);
  rejectExcludedOrSecret(lexicalRelative);

  let target: string;
  if (options.mustExist) {
    target = await realpath(lexicalTarget).catch((error: unknown) => {
      throw new AlphionError("validation", `Path does not exist: ${requestedPath}`, { stage: "path", cause: error });
    });
    ensureInside(root, target);
    const metadata = await stat(target);
    if (!options.allowDirectory && !metadata.isFile()) {
      throw new AlphionError("validation", "Path must refer to a regular file.", { stage: "path" });
    }
  } else {
    const parent = await realpath(dirname(lexicalTarget)).catch((error: unknown) => {
      throw new AlphionError("validation", "The destination parent directory must already exist.", { stage: "path", cause: error });
    });
    ensureInside(root, parent);
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory()) {
      throw new AlphionError("validation", "The destination parent must be a directory.", { stage: "path" });
    }
    target = resolve(parent, basename(lexicalTarget));
    ensureInside(root, target);
  }
  const safeRelative = relative(root, target);
  rejectExcludedOrSecret(safeRelative);
  return { projectRoot: root, absolutePath: target, relativePath: safeRelative };
}

export function ensureInside(root: string, target: string): void {
  const comparisonRoot = pathKey(resolve(root));
  const comparisonTarget = pathKey(resolve(target));
  if (comparisonTarget !== comparisonRoot && !comparisonTarget.startsWith(`${comparisonRoot}${sep}`)) {
    throw new AlphionError("forbidden", "Path escapes the project root.", { stage: "path" });
  }
}

export function rejectExcludedOrSecret(relativePath: string): void {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new AlphionError("forbidden", "The requested path is excluded by the project tool policy.", { stage: "path" });
  }
  const name = (segments.at(-1) ?? "").toLowerCase();
  const isEnvironmentSecret = name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
  const isKey =
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /^(?:id_rsa|id_ed25519|credentials|secrets?|auth\.json|\.npmrc|\.pypirc|\.netrc)$/.test(name) ||
    /^service-account.*\.json$/.test(name);
  if (isEnvironmentSecret || isKey) {
    throw new AlphionError("forbidden", "Potential secret files are not available to Agent tools.", { stage: "path" });
  }
}

export function normalizeRequestedPath(value: unknown, field = "path"): string {
  if (typeof value !== "string") {
    throw new AlphionError("validation", `${field} must be a string.`, { stage: "tool-input" });
  }
  return isAbsolute(value) ? resolve(value) : value;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
