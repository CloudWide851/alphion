import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
assert(packageJson.version === "0.5.0", "package.json must be version 0.5.0");
assert(lock.version === packageJson.version, "package-lock top-level version must match package.json");
assert(lock.packages?.[""]?.version === packageJson.version, "package-lock root package version must match package.json");
assert(packageJson.engines?.node === ">=22.13", "Node engine must be >=22.13");
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
for (const dependency of ["better-sqlite3", "ink", "katex", "openai", "react", "react-dom"]) {
  assert(runtimeDependencies.includes(dependency), `required runtime dependency is missing: ${dependency}`);
}

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
execFileSync("git", ["check-ignore", "-q", "--no-index", ".impeccable.md"], { cwd: root, stdio: "ignore" });

const tuiFiles = files.filter((file) => file.startsWith("tui/") && /\.tsx?$/u.test(file));
for (const file of tuiFiles) {
  const content = readFileSync(resolve(root, file), "utf8");
  assert(!/from\s+["'][^"']*adapters\/(?:model|store|tools|cache)[^"']*["']/.test(content), `TUI adapter boundary violation in ${file}`);
}

const sourceFiles = files.filter((file) => file.startsWith("src/") && file.endsWith(".ts"));
for (const file of sourceFiles) {
  const content = readFileSync(resolve(root, file), "utf8");
  assert(!/from\s+["'][^"']*(?:adapters|cli|tui|webui|openai)[^"']*["']/.test(content), `core dependency boundary violation in ${file}`);
}

const desktopFiles = files.filter((file) => file.startsWith("desktop/") && /\.c?ts$/u.test(file) && existsSync(resolve(root, file)));
for (const file of desktopFiles) {
  const content = readFileSync(resolve(root, file), "utf8");
  assert(!/vault\.(?:unlock|initialize)|masterPassword|apiKey\s*:/iu.test(content), `sensitive Desktop IPC surface in ${file}`);
}

const adapterImports = sourceFiles.flatMap((file) => [...readFileSync(resolve(root, file), "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((match) => ({ file, target: match[1] })));
assert(adapterImports.every(({ target }) => !target?.includes("desktop") && !target?.includes("cli") && !target?.includes("tui") && !target?.includes("adapters")), "core must not reverse-depend on adapter surfaces");
for (const desktopPath of ["desktop/main.ts", "desktop/preload.cts", "desktop/contracts.ts", "electron-builder.yml", "scripts/electron-abi-smoke.cjs", "scripts/node-abi-smoke.mjs", "scripts/prepare-desktop-runtime.mjs"]) assert(existsSync(resolve(root, desktopPath)), `Desktop Electron file must exist: ${desktopPath}`);
const electronBuilder = readFileSync(resolve(root, "electron-builder.yml"), "utf8");
assert(/app:\s*\.desktop-runtime/u.test(electronBuilder), "Electron packaging must use the isolated Desktop runtime tree");
assert(/nsis:\s*[\s\S]*?artifactName:\s*Alphion-\$\{version\}-\$\{arch\}-setup\.\$\{ext\}/u.test(electronBuilder), "NSIS artifact must have a setup-specific name");
assert(/portable:\s*[\s\S]*?artifactName:\s*Alphion-\$\{version\}-\$\{arch\}-portable\.\$\{ext\}/u.test(electronBuilder), "portable artifact must have a portable-specific name");
for (const removedRpc of ["desktop/host.ts", "desktop/protocol.ts", "desktop/stdio.ts", "tests/desktop-rpc.test.ts"]) assert(!existsSync(resolve(root, removedRpc)), `removed Desktop JSONL file remains: ${removedRpc}`);
assert(packageJson.scripts?.["desktop:deps"]?.includes("prepare-desktop-runtime.mjs --install"), "Desktop native dependencies must be installed in the isolated runtime tree");
assert(!packageJson.scripts?.["desktop:deps"]?.startsWith("electron-builder"), "Desktop dependency preparation must not rebuild root node_modules");
for (const script of ["clean-dist.mjs", "verify-built.mjs"]) assert(existsSync(resolve(root, "scripts", script)), `build verification script must exist: ${script}`);

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
