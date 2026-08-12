import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../src/application/canonical.js";

const execFileAsync = promisify(execFile);
export const PROJECT_SCAN_LIMIT = 20_000;
export const PROJECT_FILE_DIGEST_LIMIT = 1024 * 1024;
export const PROJECT_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".alphion", ".trellis", ".codegraph", ".agents", ".codex", ".cache", ".next",
  ".pnpm", ".yarn", "build", "coverage", "dist", "node_modules", "out", "vendor",
]);

export async function projectRevision(projectRoot: string): Promise<string> {
  try {
    const head = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const [statusValue, worktreeDiff, indexDiff, untracked] = await Promise.all([
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
    const paths = untracked.stdout.split("\0").filter(Boolean).sort().slice(0, PROJECT_SCAN_LIMIT);
    for (const relativePath of paths) {
      const path = resolve(projectRoot, relativePath);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) untrackedDigests.push(`${normalizePath(relativePath)}:symlink`);
      else if (metadata.isFile() && metadata.size <= PROJECT_FILE_DIGEST_LIMIT) {
        untrackedDigests.push(`${normalizePath(relativePath)}:${sha256(await readFile(path))}`);
      } else untrackedDigests.push(`${normalizePath(relativePath)}:oversize:${metadata.size}`);
    }
    if (untracked.stdout.split("\0").filter(Boolean).length > PROJECT_SCAN_LIMIT) {
      untrackedDigests.push(`overflow:${PROJECT_SCAN_LIMIT}`);
    }
    return sha256(
      `${head.stdout.trim()}\0${statusValue.stdout}\0${worktreeDiff.stdout}\0${indexDiff.stdout}\0${untrackedDigests.join("\n")}`,
    );
  } catch {
    return filesystemProjectRevision(projectRoot);
  }
}

async function filesystemProjectRevision(projectRoot: string): Promise<string> {
  const pending = [resolve(projectRoot)];
  const parts: string[] = [];
  let visited = 0;
  let truncated = false;
  while (pending.length > 0 && visited < PROJECT_SCAN_LIMIT) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (PROJECT_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const path = join(directory, entry.name);
      const relativePath = normalizePath(relative(projectRoot, path));
      const metadata = await lstat(path);
      visited += 1;
      if (metadata.isSymbolicLink()) {
        parts.push(`${relativePath}:symlink`);
      } else if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        parts.push(
          metadata.size <= PROJECT_FILE_DIGEST_LIMIT
            ? `${relativePath}:${sha256(await readFile(path))}`
            : `${relativePath}:oversize:${metadata.size}`,
        );
      }
      if (visited >= PROJECT_SCAN_LIMIT) {
        truncated = true;
        break;
      }
    }
  }
  if (pending.length > 0) truncated = true;
  if (truncated) parts.push(`overflow:${PROJECT_SCAN_LIMIT}`);
  return sha256(parts.sort().join("\n"));
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
