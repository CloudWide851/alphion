import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import type { ShellPolicyStore, ToolExecutor } from "../../src/ports/index.js";
import { resolveSafePath } from "./path-safety.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export class ShellTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "shell",
    description: "Execute an allowlisted absolute executable with bounded arguments, project cwd, environment, time, and output.",
    inputSchema: {
      type: "object",
      properties: {
        executable: { type: "string" },
        args: { type: "array", items: { type: "string" }, maxItems: 128 },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
      },
      required: ["executable", "args"],
      additionalProperties: false,
    },
    risk: "process",
    cachePolicy: "none",
    executionMode: "serial",
    sideEffect: "process",
    idempotent: false,
    approval: "policy",
    timeoutMs: 120_000,
  } as const);
  readonly #policy: ShellPolicyStore;

  constructor(policy: ShellPolicyStore) {
    this.#policy = policy;
  }

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const executable = input.executable;
    if (typeof executable !== "string" || !isAbsolute(executable)) {
      throw new AlphionError("validation", "shell executable must be an absolute path.", { stage: "tool:shell" });
    }
    const resolvedExecutable = await realpath(resolve(executable));
    const executableMetadata = await stat(resolvedExecutable);
    if (!executableMetadata.isFile()) throw new AlphionError("validation", "shell executable must be a regular file.", { stage: "tool:shell" });
    const args = decodeArguments(input.args);
    const rule = await this.#policy.findAllowed(resolvedExecutable, args);
    if (!rule) throw new AlphionError("forbidden", "Executable and argument prefix are not allowlisted.", { stage: "tool:shell" });
    if (rule.executableDigest) {
      const currentDigest = sha256(await readFile(resolvedExecutable));
      if (currentDigest !== rule.executableDigest) {
        throw new AlphionError("forbidden", "Allowlisted executable digest no longer matches.", { stage: "tool:shell" });
      }
    }
    const cwdValue = input.cwd === undefined ? "." : input.cwd;
    if (typeof cwdValue !== "string") throw new AlphionError("validation", "cwd must be a string.", { stage: "tool:shell" });
    const cwd = await resolveSafePath(context.projectRoot, cwdValue, { mustExist: true, allowDirectory: true });
    const timeoutMs = decodeTimeout(input.timeoutMs);
    const result = await runProcess(resolvedExecutable, args, cwd.absolutePath, timeoutMs, context.signal);
    const digest = sha256(`${result.exitCode}\0${result.stdout}\0${result.stderr}`);
    return {
      content: `exit=${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      evidence: {
        id: createId("evidence"),
        kind: "process" as const,
        digest,
        summary: `${resolvedExecutable} exited ${result.exitCode}`,
      },
      isError: result.exitCode !== 0,
    };
  }
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: minimalEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.kill();
      rejectPromise(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finishError(new AlphionError("budget-exceeded", "Process output exceeded the configured limit.", { stage: "tool:shell" }));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", finishError);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (timedOut) {
        rejectPromise(new AlphionError("timeout", "Process execution timed out.", { stage: "tool:shell" }));
        return;
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const abort = () => finishError(signal.reason ?? new DOMException("Cancelled.", "AbortError"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function decodeArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every((argument) => typeof argument === "string" && !argument.includes("\0"))) {
    throw new AlphionError("validation", "args must be an array of at most 128 strings without null bytes.", { stage: "tool:shell" });
  }
  return value;
}

function decodeTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new AlphionError("validation", "timeoutMs must be an integer from 100 through 120000.", { stage: "tool:shell" });
  }
  return value;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}
