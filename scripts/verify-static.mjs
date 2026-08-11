import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
assert(packageJson.version === "0.2.1", "package.json must be version 0.2.1");
assert(lock.version === packageJson.version, "package-lock top-level version must match package.json");
assert(lock.packages?.[""]?.version === packageJson.version, "package-lock root package version must match package.json");
assert(packageJson.engines?.node === ">=22.13", "Node engine must be >=22.13");
assert(JSON.stringify(Object.keys(packageJson.dependencies ?? {})) === JSON.stringify(["openai"]), "openai must be the only runtime dependency");

const fileOutput = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
const files = fileOutput.split(/\r?\n/).filter(Boolean);
for (const file of files) {
  if (/(^|\/)(?:node_modules|dist|\.alphion)(?:\/|$)/.test(file)) continue;
  const absolute = resolve(root, file);
  if (!existsSync(absolute) || ![".ts", ".js", ".mjs", ".json", ".md", ".bat"].includes(extname(file).toLowerCase())) continue;
  const content = readFileSync(absolute, "utf8");
  assert(!/\bsk-[A-Za-z0-9_-]{16,}\b/.test(content), `possible API key in ${file}`);
}

for (const localPath of ["docs", ".trellis", ".codegraph", ".agents", ".codex", ".alphion", "dist"]) {
  execFileSync("git", ["check-ignore", "-q", "--no-index", `${localPath}/.ignore-probe`], {
    cwd: root,
    stdio: "ignore",
  });
}

const sourceFiles = files.filter((file) => file.startsWith("src/") && file.endsWith(".ts"));
for (const file of sourceFiles) {
  const content = readFileSync(resolve(root, file), "utf8");
  assert(!/from\s+["'][^"']*(?:adapters|cli|tui|webui|openai)[^"']*["']/.test(content), `core dependency boundary violation in ${file}`);
}

const markdownFiles = [...files.filter((file) => file.endsWith(".md")), ...listMarkdown(resolve(root, "docs"))];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const absolute = resolve(root, file);
  const content = readFileSync(absolute, "utf8");
  for (const match of content.matchAll(linkPattern)) {
    const raw = match[1]?.trim();
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.replace(/^<|>$/g, "").split(/[?#]/, 1)[0] ?? "");
    if (!target) continue;
    assert(existsSync(resolve(dirname(absolute), target)), `broken relative Markdown link in ${file}: ${raw}`);
  }
}

for (const svg of ["alphion-logo.svg", "alphion-icon.svg", "alphion-wordmark.svg"]) {
  const content = readFileSync(resolve(root, svg), "utf8").trim();
  assert(/<svg\b/i.test(content) && /<\/svg>$/i.test(content), `${svg} is not a complete SVG document`);
}

assert(existsSync(resolve(root, "alphion.bat")), "alphion.bat must exist");
process.stdout.write(`static verification passed: ${markdownFiles.length} Markdown files, ${sourceFiles.length} core files\n`);

function listMarkdown(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(relative(root, path).replaceAll("\\", "/"));
  }
  return found;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
