import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const runtime = resolve(root, ".desktop-runtime");
const install = process.argv.includes("--install");
const sourcePackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const runtimePackage = { ...sourcePackage, main: "./dist/desktop/main.js", scripts: {} };

assertRoot(runtime);
mkdirSync(runtime, { recursive: true });
writeFileSync(resolve(runtime, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`, "utf8");
cpSync(resolve(root, "package-lock.json"), resolve(runtime, "package-lock.json"));
for (const relative of ["dist", "alphion-icon.svg"]) {
  const source = resolve(root, relative);
  if (!existsSync(source)) throw new Error(`Desktop runtime source is missing: ${relative}`);
  const target = resolve(runtime, relative);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}
if (install) {
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--prefix", runtime], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  execFileSync(resolve(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"), ["install-app-deps", "--projectDir", runtime], { cwd: root, stdio: "inherit" });
}
process.stdout.write(`desktop runtime ${install ? "installed" : "synchronized"}: ${runtime}\n`);

function assertRoot(path) {
  if (dirname(path) !== root || !path.endsWith(".desktop-runtime")) throw new Error("Refusing unexpected Desktop runtime path.");
}
