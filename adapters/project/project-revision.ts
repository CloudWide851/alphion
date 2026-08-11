import { execFile } from "node:child_process";
import { lstat, opendir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../src/application/canonical.js";

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

export async function projectRevision(projectRoot: string): Promise<string> {
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
      if (metadata.isSymbolicLink()) untrackedDigests.push(`${relativePath}:symlink`);
      else if (metadata.isFile() && metadata.size <= 1024 * 1024) {
        untrackedDigests.push(`${relativePath}:${sha256(await readFile(path))}`);
      } else untrackedDigests.push(`${relativePath}:${metadata.size}:${metadata.mtimeMs}`);
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
      if (REVISION_EXCLUDED.has(entry.name.toLowerCase())) continue;
      const path = join(directory, entry.name);
      const relativePath = path.slice(projectRoot.length + 1).replaceAll("\\", "/");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) parts.push(`${relativePath}:symlink`);
      else if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
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
