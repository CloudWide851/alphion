import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const packagePath = resolve(root, "package.json");
const output = resolve(root, "dist");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

if (packageJson.name !== "alphion" || dirname(output) !== root || output === root) {
  throw new Error("Refusing to clean an unexpected build output path.");
}
if (existsSync(output)) rmSync(output, { recursive: true, force: true });
process.stdout.write("cleaned generated dist output\n");
