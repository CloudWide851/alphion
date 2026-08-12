import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Starts Electron without importing its privileged API into the ordinary CLI process. */
export async function launchDesktop(): Promise<void> {
  const require = createRequire(import.meta.url);
  const electronPath = require("electron") as string;
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));
  const child = spawn(electronPath, [entry], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", reject); });
}
