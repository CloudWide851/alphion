import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const modules = await Promise.all([
  import(pathToFileURL(resolve(root, "dist/src/index.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/runtime.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/providers.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/resources.js")).href),
  import(pathToFileURL(resolve(root, "dist/desktop/index.js")).href),
]);
if (!modules[0].ALPHION_BRAND || !modules[1].Agent || !modules[2].DeterministicRoutingPolicy || !modules[3].SystemPromptComposer || !modules[4].createDesktopHost) throw new Error("A public v0.4.0 subpath export is missing.");

const directory = await mkdtemp(join(tmpdir(), "alphion-desktop-smoke-"));
try {
  const child = spawn(process.execPath, [resolve(root, "dist/cli/index.js"), "desktop", "--project-root", directory, "--state", join(directory, "state.sqlite3")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end([
    JSON.stringify({ schemaVersion: 1, type: "rpc.hello", requestId: "hello", supportedVersions: [1] }),
    JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "shutdown", kind: "rpc.shutdown", payload: {} }),
    "",
  ].join("\n"));
  const exitCode = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
  if (exitCode !== 0) throw new Error(`Desktop Host smoke exited ${String(exitCode)}: ${Buffer.concat(stderr).toString("utf8")}`);
  const messages = Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (messages.length !== 2 || messages[0]?.requestId !== "hello" || messages[0]?.status !== "ok" || messages[1]?.requestId !== "shutdown" || messages[1]?.status !== "ok") throw new Error("Desktop Host stdout did not contain the exact RPC handshake/shutdown sequence.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write("built subpath and Desktop JSONL smoke passed\n");
