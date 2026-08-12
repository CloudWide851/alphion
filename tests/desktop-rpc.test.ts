import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createDesktopHost, StdioJsonlTransport, type DesktopTransport } from "../desktop/index.js";
import { decodeRpcLine, DESKTOP_RPC_MAX_LINE_BYTES, type RpcOutbound } from "../desktop/protocol.js";
import type { AgentApplication } from "../src/ports/index.js";

test("RPC decoder rejects unknown schema, fields, commands and credential operations", () => {
  assert.throws(() => decodeRpcLine("{"), /valid JSON/iu);
  assert.throws(() => decodeRpcLine(JSON.stringify({ schemaVersion: 2, type: "rpc.hello", requestId: "hello", supportedVersions: [1] })), /unsupported/iu);
  assert.throws(() => decodeRpcLine(JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "vault", kind: "vault.unlock", payload: { password: "secret" } })), /unknown RPC command/iu);
  assert.throws(() => decodeRpcLine(JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "provider", kind: "provider.list", payload: { apiKey: "secret" } })), /unknown RPC field/iu);
  assert.throws(() => decodeRpcLine(JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "shape", kind: "session.reshape", payload: { goal: "x", behavior: { steering: "yes" } } })), /steering must be boolean/iu);
  assert.throws(() => decodeRpcLine(JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "approval", kind: "approval.decide", payload: { requestId: "one", actionDigest: "bad", approved: true } })), /SHA-256/iu);
  assert.throws(() => decodeRpcLine("x".repeat(DESKTOP_RPC_MAX_LINE_BYTES + 1)), /maximum size/iu);
});

test("stdio transport isolates oversized input and preserves JSONL output order", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const transport = new StdioJsonlTransport(input, output);
  input.end(`${"x".repeat(DESKTOP_RPC_MAX_LINE_BYTES + 1)}\n{\"schemaVersion\":1}\n`);
  const lines: string[] = [];
  for await (const line of transport) lines.push(line);
  assert.deepEqual(lines, ["{", '{"schemaVersion":1}']);
  await Promise.all([
    transport.send({ schemaVersion: 1, type: "rpc.response", requestId: "one", status: "ok" }),
    transport.send({ schemaVersion: 1, type: "rpc.response", requestId: "two", status: "ok" }),
  ]);
  await transport.close();
  assert.deepEqual(Buffer.concat(chunks).toString("utf8").trim().split("\n").map((line) => JSON.parse(line).requestId), ["one", "two"]);
});

test("Desktop host requires hello and routes non-sensitive project commands", async () => {
  const transport = new MemoryTransport([
    JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "before", kind: "diagnose", payload: {} }),
    JSON.stringify({ schemaVersion: 1, type: "rpc.hello", requestId: "hello", supportedVersions: [1] }),
    JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "diagnose", kind: "diagnose", payload: {} }),
    JSON.stringify({ schemaVersion: 1, type: "rpc.request", requestId: "shutdown", kind: "rpc.shutdown", payload: {} }),
  ]);
  let closed = false;
  const application = { diagnose: () => Promise.resolve({ schemaVersion: 1 as const, projectRoot: "project", overall: "healthy" as const, checks: [] }), close: () => { closed = true; return Promise.resolve(); } } as unknown as AgentApplication;
  await createDesktopHost({ application, transport }).run();
  assert.equal(transport.sent[0]?.type, "rpc.response");
  assert.equal(transport.sent[0] && "status" in transport.sent[0] ? transport.sent[0].status : undefined, "error");
  assert.equal(transport.sent.some((message) => message.type === "rpc.response" && message.requestId === "hello" && message.status === "ok"), true);
  assert.equal(transport.sent.some((message) => message.type === "rpc.response" && message.requestId === "diagnose" && message.status === "ok"), true);
  assert.equal(closed, true);
});

class MemoryTransport implements DesktopTransport {
  readonly sent: RpcOutbound[] = [];
  constructor(private readonly lines: readonly string[]) {}
  async *[Symbol.asyncIterator](): AsyncIterator<string> { yield* this.lines; }
  send(message: RpcOutbound): Promise<void> { this.sent.push(message); return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}
