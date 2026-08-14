import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const runtime = resolve(root, ".desktop-runtime");
const manifest = resolve(root, "desktop", "runtime");
const install = process.argv.includes("--install");

assertRoot(runtime);
mkdirSync(runtime, { recursive: true });
copyFileSync(resolve(manifest, "package.json"), resolve(runtime, "package.json"));
copyFileSync(resolve(manifest, "package-lock.json"), resolve(runtime, "package-lock.json"));
for (const relative of install ? ["assets"] : ["dist", "assets"]) {
  const source = resolve(root, relative);
  if (!existsSync(source)) throw new Error(`Desktop runtime source is missing: ${relative}`);
  const target = resolve(runtime, relative);
  rmSync(target, { recursive: true, force: true });
  copyDirectory(source, target);
}
if (install) {
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefix", runtime], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  const electronVersion = JSON.parse(readFileSync(resolve(root, "node_modules", "electron", "package.json"), "utf8")).version;
  execFileSync("npm", ["rebuild", "better-sqlite3", "--build-from-source"], {
    cwd: runtime,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, npm_config_runtime: "electron", npm_config_target: electronVersion, npm_config_disturl: "https://electronjs.org/headers", npm_config_arch: process.arch },
  });
  const binding = resolve(runtime, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!existsSync(binding)) throw new Error("Desktop native dependency rebuild did not produce better_sqlite3.node.");
  const savedBinding = resolve(runtime, "better_sqlite3.node.tmp");
  copyFileSync(binding, savedBinding);
  rmSync(resolve(runtime, "node_modules", "better-sqlite3", "build"), { recursive: true, force: true });
  mkdirSync(dirname(binding), { recursive: true });
  copyFileSync(savedBinding, binding);
  rmSync(savedBinding, { force: true });
}
process.stdout.write(`desktop runtime ${install ? "installed" : "synchronized"}: ${runtime}\n`);

function assertRoot(path) {
  if (dirname(path) !== root || !path.endsWith(".desktop-runtime")) throw new Error("Refusing unexpected Desktop runtime path.");
}

function copyDirectory(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`Desktop runtime source contains an unsupported entry: ${from}`);
  }
}
