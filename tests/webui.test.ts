import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebUiServer } from "../webui/server.js";
import type { ImageAttachmentRef } from "../src/index.js";
import { decodeUiCommandEnvelope, type UiAttachmentClient, type UiCommandClient, type UiCommandEnvelope, type UiCommandResult, type UiEventFrame } from "../ui/contracts.js";

const IMAGE_REF: ImageAttachmentRef = Object.freeze({ schemaVersion: 1, id: "attachment_web_0001", domainId: "domain_web_0001", projectId: "project_web_0001", digest: "a".repeat(64), mediaType: "image/png", byteSize: 8, width: 1, height: 1, fileName: "sample.png" });

test("shared UI decoder rejects unknown envelope and command fields", () => {
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0000", command: { kind: "session.list", secret: "must-not-pass" } }), /unknown/ui);
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0000", command: { kind: "session.list" }, extra: true }), /unknown/ui);
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0004", command: { kind: "surface.snapshot", selectedSessionId: "session_0001" } }).command, { kind: "surface.snapshot", selectedSessionId: "session_0001" });
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0005", command: { kind: "project.create", root: "C:\\work space\\demo", name: "Demo" } }).command, { kind: "project.create", root: "C:\\work space\\demo", name: "Demo" });
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0006", command: { kind: "provider.test", profileId: "deepseek" } }).command, { kind: "provider.test", profileId: "deepseek" });
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0007", command: { kind: "provider.test-all" } }).command, { kind: "provider.test-all" });
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0008", command: { kind: "session.send", sessionId: "session_web_0001", message: { schemaVersion: 1, attachments: [IMAGE_REF] }, expectedRevision: 0, idempotencyKey: "command_web_0001" } }).command, { kind: "session.send", sessionId: "session_web_0001", message: { schemaVersion: 1, attachments: [IMAGE_REF] }, expectedRevision: 0, idempotencyKey: "command_web_0001" });
});

test("WebUI binds loopback and enforces Origin, HttpOnly session, and CSRF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-webui-"));
  const client = new FakeClient();
  const server = await createWebUiServer({ client, assetsRoot: directory });
  try {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const rejected = await fetch(`${server.origin}/api/bootstrap`, { method: "POST", headers: { origin: "http://attacker.invalid" } });
    assert.equal(rejected.status, 400);
    const boot = await fetch(`${server.origin}/api/bootstrap`, { method: "POST", headers: { origin: server.origin } });
    assert.equal(boot.status, 200);
    const cookie = boot.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/iu); assert.match(cookie, /SameSite=Strict/iu);
    const { csrf } = await boot.json() as { csrf: string };
    const envelope = { schemaVersion: 1, requestId: "request_web_0001", command: { kind: "session.list" } };
    const missing = await fetch(`${server.origin}/api/command`, { method: "POST", headers: { origin: server.origin, cookie, "content-type": "application/json" }, body: JSON.stringify(envelope) });
    assert.equal(missing.status, 400);
    const accepted = await fetch(`${server.origin}/api/command`, { method: "POST", headers: { origin: server.origin, cookie, "content-type": "application/json", "x-alphion-csrf": csrf }, body: JSON.stringify(envelope) });
    assert.equal(accepted.status, 200);
    assert.equal(client.executed.length, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebUI rejects malformed command fields and oversized bodies without stopping the server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-webui-input-"));
  const server = await createWebUiServer({ client: new FakeClient(), assetsRoot: directory });
  try {
    const boot = await fetch(`${server.origin}/api/bootstrap`, { method: "POST", headers: { origin: server.origin } });
    const cookie = boot.headers.get("set-cookie") ?? ""; const { csrf } = await boot.json() as { csrf: string };
    const headers = { origin: server.origin, cookie, "content-type": "application/json", "x-alphion-csrf": csrf };
    const malformed = await fetch(`${server.origin}/api/command`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, requestId: "request_web_0002", command: { kind: "session.list", secret: "no" } }) });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(`${server.origin}/api/command`, { method: "POST", headers, body: JSON.stringify({ value: "x".repeat(300_000) }) });
    assert.equal(oversized.status, 400);
    const healthy = await fetch(`${server.origin}/api/command`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, requestId: "request_web_0003", command: { kind: "session.list" } }) });
    assert.equal(healthy.status, 200);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebUI imports credentials only through the dedicated CSRF-bound endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-webui-secret-"));
  const client = new FakeClient();
  const server = await createWebUiServer({ client, assetsRoot: directory });
  try {
    const boot = await fetch(`${server.origin}/api/bootstrap`, { method: "POST", headers: { origin: server.origin } });
    const cookie = boot.headers.get("set-cookie") ?? ""; const { csrf } = await boot.json() as { csrf: string };
    const headers = { origin: server.origin, cookie, "content-type": "application/json", "x-alphion-csrf": csrf };
    const invalid = await fetch(`${server.origin}/api/secret/provider/profile_0001`, { method: "POST", headers, body: JSON.stringify({ secret: "temporary", persist: true }) });
    assert.equal(invalid.status, 400); assert.deepEqual(client.credentials, []);
    const accepted = await fetch(`${server.origin}/api/secret/provider/profile_0001`, { method: "POST", headers, body: JSON.stringify({ secret: "temporary" }) });
    assert.equal(accepted.status, 200); assert.deepEqual(client.credentials, [{ profileId: "profile_0001", secret: "temporary" }]);
    assert.doesNotMatch(JSON.stringify(client.executed), /temporary/u);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("WebUI attachment transport is Origin and CSRF bound, bounded, and separately authorized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-webui-attachment-"));
  const client = new FakeClient(); const attachments = new FakeAttachments();
  const server = await createWebUiServer({ client, attachments, assetsRoot: directory });
  try {
    const boot = await fetch(`${server.origin}/api/bootstrap`, { method: "POST", headers: { origin: server.origin } });
    const cookie = boot.headers.get("set-cookie") ?? ""; const { csrf } = await boot.json() as { csrf: string };
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const baseHeaders = { cookie, "content-type": "image/png", "x-alphion-file-name": encodeURIComponent("sample.png") };
    const wrongOrigin = await fetch(`${server.origin}/api/attachment`, { method: "POST", headers: { ...baseHeaders, origin: "http://attacker.invalid", "x-alphion-csrf": csrf }, body: bytes });
    assert.equal(wrongOrigin.status, 400); assert.equal(attachments.imported.length, 0);
    const wrongCsrf = await fetch(`${server.origin}/api/attachment`, { method: "POST", headers: { ...baseHeaders, origin: server.origin, "x-alphion-csrf": "wrong" }, body: bytes });
    assert.equal(wrongCsrf.status, 400); assert.equal(attachments.imported.length, 0);
    const accepted = await fetch(`${server.origin}/api/attachment`, { method: "POST", headers: { ...baseHeaders, origin: server.origin, "x-alphion-csrf": csrf }, body: bytes });
    assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), IMAGE_REF); assert.deepEqual(attachments.imported, [{ fileName: "sample.png", bytes: [...bytes] }]);
    const deniedRead = await fetch(`${server.origin}/api/attachment/${IMAGE_REF.id}`); assert.equal(deniedRead.status, 403);
    const read = await fetch(`${server.origin}/api/attachment/${IMAGE_REF.id}`, { headers: { cookie } });
    assert.equal(read.status, 200); assert.equal(read.headers.get("content-type"), "image/png"); assert.deepEqual([...new Uint8Array(await read.arrayBuffer())], [...bytes]);
    const oversized = await fetch(`${server.origin}/api/attachment`, { method: "POST", headers: { ...baseHeaders, origin: server.origin, "x-alphion-csrf": csrf }, body: new Uint8Array((20 * 1024 * 1024) + 1) });
    assert.equal(oversized.status, 400); assert.equal(attachments.imported.length, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

class FakeClient implements UiCommandClient {
  readonly executed: UiCommandEnvelope[] = [];
  readonly credentials: Array<{ profileId: string; secret: string }> = [];
  execute(envelope: UiCommandEnvelope): Promise<UiCommandResult> { this.executed.push(envelope); return Promise.resolve({ schemaVersion: 1, requestId: envelope.requestId, status: "ok", result: [] }); }
  async *subscribe(): AsyncIterable<UiEventFrame> { /* no events */ }
  importProviderCredential(profileId: string, secret: string): Promise<void> { this.credentials.push({ profileId, secret }); return Promise.resolve(); }
  decideApproval(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}

class FakeAttachments implements UiAttachmentClient {
  readonly imported: Array<{ fileName: string; bytes: number[] }> = [];
  #bytes = new Uint8Array();
  importAttachment(input: Readonly<{ fileName: string; bytes: Uint8Array }>): Promise<ImageAttachmentRef> { this.#bytes = Uint8Array.from(input.bytes); this.imported.push({ fileName: input.fileName, bytes: [...input.bytes] }); return Promise.resolve(IMAGE_REF); }
  readAttachment(attachmentId: string): Promise<Readonly<{ ref: ImageAttachmentRef; bytes: Uint8Array }>> { assert.equal(attachmentId, IMAGE_REF.id); return Promise.resolve(Object.freeze({ ref: IMAGE_REF, bytes: Uint8Array.from(this.#bytes) })); }
}
