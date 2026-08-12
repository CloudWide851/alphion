import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebUiServer } from "../webui/server.js";
import { decodeUiCommandEnvelope, type UiCommandClient, type UiCommandEnvelope, type UiCommandResult, type UiEventEnvelope } from "../ui/contracts.js";

test("shared UI decoder rejects unknown envelope and command fields", () => {
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0000", command: { kind: "session.list", secret: "must-not-pass" } }), /unknown/ui);
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_web_0000", command: { kind: "session.list" }, extra: true }), /unknown/ui);
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

class FakeClient implements UiCommandClient {
  readonly executed: UiCommandEnvelope[] = [];
  readonly credentials: Array<{ profileId: string; secret: string }> = [];
  execute(envelope: UiCommandEnvelope): Promise<UiCommandResult> { this.executed.push(envelope); return Promise.resolve({ schemaVersion: 1, requestId: envelope.requestId, status: "ok", result: [] }); }
  async *subscribe(): AsyncIterable<UiEventEnvelope> { /* no events */ }
  importProviderCredential(profileId: string, secret: string): Promise<void> { this.credentials.push({ profileId, secret }); return Promise.resolve(); }
  decideApproval(): void {}
  close(): Promise<void> { return Promise.resolve(); }
}
