import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("compiled CLI configures a provider, runs through a fake endpoint, and denies non-TTY writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-cli-"));
  const server = createServer((request, response) => void handleRequest(request, response));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  const state = join(directory, "state.sqlite3");
  try {
    const configured = await runCli([
      "provider",
      "set",
      "--id",
      "fake",
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--model",
      "fake-model",
      "--protocol",
      "chat-completions",
      "--active",
      "--state",
      state,
      "--project-root",
      directory,
    ]);
    assert.equal(configured.code, 0, configured.stderr);
    assert.match(configured.stdout, /"active": true/);

    const listed = await runCli(["provider", "list", "--state", state, "--project-root", directory]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /fake-model/);

    const completed = await runCli(["run", "--prompt", "hello", "--state", state, "--project-root", directory]);
    assert.equal(completed.code, 0, completed.stderr);
    assert.match(completed.stdout, /hello from cli/);
    assert.match(completed.stdout, /status=completed/);

    const denied = await runCli(["run", "--prompt", "please write", "--state", state, "--project-root", directory]);
    assert.equal(denied.code, 0, denied.stderr);
    assert.match(denied.stdout, /write was denied/);
    await assert.rejects(readFile(join(directory, "denied-cli.txt")), /ENOENT/);

    const stats = await runCli(["cache", "stats", "--state", state, "--project-root", directory]);
    assert.equal(stats.code, 0, stats.stderr);
    assert.match(stats.stdout, /"entries"/);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiled live smoke is guarded and Windows batch launcher shows help", async (context) => {
  const guarded = await runNode([resolve("dist/cli/live-smoke.js")]);
  assert.equal(guarded.code, 2);
  assert.match(guarded.stderr, /disabled/i);
  if (process.platform !== "win32") {
    context.skip("Windows batch launcher applies only on Windows.");
    return;
  }
  const launched = await runExecutable("cmd.exe", ["/d", "/c", "alphion.bat", "help"]);
  assert.equal(launched.code, 0, launched.stderr);
  assert.match(launched.stdout, /Alphion v0\.2\.1/);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(request)) as { messages: Array<{ role: string; content?: string }> };
  const last = body.messages.at(-1);
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (last?.role === "tool") {
    writeSse(response, chunk({ content: "write was denied" }, null));
    writeSse(response, chunk({}, "stop"));
  } else if (last?.content?.includes("write")) {
    writeSse(response, chunk({ tool_calls: [{ index: 0, id: "write_cli", type: "function", function: { name: "write", arguments: '{"path":"denied-cli.txt","content":"no","mode":"create"}' } }] }, null));
    writeSse(response, chunk({}, "tool_calls"));
  } else {
    writeSse(response, chunk({ content: "hello from cli" }, null));
    writeSse(response, chunk({}, "stop"));
  }
  writeSse(response, { id: "cli", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  response.end("data: [DONE]\n\n");
}

function chunk(delta: object, finishReason: string | null) {
  return { id: "cli", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }] };
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function runCli(args: readonly string[]) {
  return runNode([resolve("dist/cli/index.js"), ...args]);
}

async function runNode(args: readonly string[]) {
  return runExecutable(process.execPath, args);
}

async function runExecutable(executable: string, args: readonly string[]) {
  return new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>((done, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.on("error", reject);
    child.on("close", (code) => done({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}
