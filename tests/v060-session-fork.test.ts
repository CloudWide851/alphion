import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson, sha256 } from "../src/application/canonical.js";
import type { AgentMessage, AgentShape, HarnessPlan } from "../src/domain/contracts.js";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";

test("transactional fork clones one visible branch with independent identities and provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v060-fork-"));
  const path = join(directory, "state.sqlite3");
  const store = new SqliteStore({ path, domainId: "domain-v060", projectId: "project-v060" });
  try {
    const created = await store.createSession({ title: "source", providerId: "provider-a", idempotencyKey: "create:v060:fork:0001" });
    const shaped = await store.reshapeSession(created.id, shape(created.id), { expectedRevision: created.revision, idempotencyKey: "reshape:v060:fork:0001" });
    const first = await store.appendSessionEntry(created.id, user("inspect"), { expectedRevision: shaped.revision, idempotencyKey: "append:v060:fork:0001" }, "old-run");
    const observed = await store.appendSessionEntry(created.id, observation(), { expectedRevision: first.revision, idempotencyKey: "append:v060:fork:0002" }, "old-run");
    const memoryMessage = memory(first.entryId!);
    const memoryReceipt = await store.appendSessionEntry(created.id, memoryMessage, { expectedRevision: observed.revision, idempotencyKey: "append:v060:fork:0003" });
    const request = { sourceSessionId: created.id, title: "forked", expectedRevision: memoryReceipt.revision, idempotencyKey: "fork:v060:fork:0001" } as const;
    const receipt = await store.forkSession(request);
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.session.schemaVersion, 3);
    assert.equal(receipt.session.revision, 1);
    assert.equal(receipt.session.shapeRevision, 1);
    assert.equal(receipt.session.domainId, created.domainId);
    assert.equal(receipt.session.projectId, created.projectId);
    assert.notEqual(receipt.session.shapeDigest, shaped.shapeDigest);
    const forkShape = await store.getSessionShape(receipt.session.id);
    assert.equal(forkShape?.sessionId, receipt.session.id);
    assert.equal(forkShape?.revision, 1);
    assert.equal(forkShape?.systemPromptPlan.sections.find((item) => item.id === "session")?.provenance.includes(`session:${receipt.session.id}`), true);
    assert.equal(receipt.provenance.sourceRevision, memoryReceipt.revision);
    assert.match(receipt.provenance.branchDigest, /^[a-f0-9]{64}$/u);
    const sourceView = await store.getSessionView(created.id);
    const targetView = await store.getSessionView(receipt.session.id);
    assert.equal(receipt.entryMapping.length, sourceView?.entries.length);
    assert.equal(targetView?.entries.length, (sourceView?.entries.length ?? 0) + 1);
    assert.ok(targetView?.entries.every((entry) => entry.runId === undefined));
    assert.equal(targetView?.entries.at(-1)?.message.kind, "system-event");
    const copiedObservation = targetView?.entries.find((entry) => entry.message.kind === "observation")?.message;
    assert.equal(copiedObservation?.kind === "observation" ? copiedObservation.evidence?.id : undefined, "evidence-v060");
    const copiedMemory = targetView?.entries.find((entry) => entry.message.kind === "memory")?.message;
    assert.equal(copiedMemory?.kind === "memory" ? copiedMemory.sourceEntryIds[0] : undefined, receipt.entryMapping.find((item) => item.sourceEntryId === first.entryId)?.targetEntryId);
    assert.notEqual(copiedMemory?.id, memoryMessage.id);
    const replay = await store.forkSession(request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.session.id, receipt.session.id);
    await assert.rejects(store.forkSession({ ...request, title: "changed" }), /different request/iu);
    const partial = await store.forkSession({ sourceSessionId: created.id, ...(first.entryId ? { sourceEntryId: first.entryId } : {}), expectedRevision: memoryReceipt.revision, idempotencyKey: "fork:v060:fork:0002" });
    assert.equal(partial.entryMapping.length, 2);
    assert.equal((await store.getSessionView(partial.session.id))?.entries.length, 3);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("fork rejects active, unshaped, stale and off-branch sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v060-fork-reject-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  try {
    const unshaped = await store.createSession({ title: "unshaped", idempotencyKey: "create:v060:reject:0001" });
    await assert.rejects(store.forkSession({ sourceSessionId: unshaped.id, expectedRevision: 0, idempotencyKey: "fork:v060:reject:0001" }), /must be shaped/iu);
    const shaped = await store.reshapeSession(unshaped.id, shape(unshaped.id), { expectedRevision: 0, idempotencyKey: "reshape:v060:reject:0001" });
    await assert.rejects(store.forkSession({ sourceSessionId: unshaped.id, sourceEntryId: "entry-missing", expectedRevision: shaped.revision, idempotencyKey: "fork:v060:reject:0002" }), /current Session branch/iu);
    const running = await store.acquireRunLease(unshaped.id, "run-v060", shaped.revision);
    await assert.rejects(store.forkSession({ sourceSessionId: unshaped.id, expectedRevision: running.revision, idempotencyKey: "fork:v060:reject:0003" }), /only while idle/iu);
    await store.releaseRunLease(unshaped.id, "run-v060");
    await assert.rejects(store.forkSession({ sourceSessionId: unshaped.id, expectedRevision: shaped.revision, idempotencyKey: "fork:v060:reject:0004" }), /revision changed/iu);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite v5 migrates through verified backup and enforces same-Session parents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v060-migrate-"));
  const path = join(directory, "state.sqlite3");
  let store = new SqliteStore({ path });
  const left = await store.createSession({ title: "left", idempotencyKey: "create:v060:migrate:0001" });
  const leftEntry = await store.appendSessionEntry(left.id, user("left"), { expectedRevision: 0, idempotencyKey: "append:v060:migrate:0001" });
  const right = await store.createSession({ title: "right", idempotencyKey: "create:v060:migrate:0002" });
  store.close();
  const downgrade = openSqliteDatabase(path);
  downgrade.exec("PRAGMA user_version = 5");
  downgrade.close();
  store = new SqliteStore({ path });
  try {
    assert.equal(existsSync(`${path}.v5-backup`), true);
    const backup = openSqliteDatabase(`${path}.v5-backup`, { readOnly: true });
    try { assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5); }
    finally { backup.close(); }
  } finally { store.close(); }
  const raw = openSqliteDatabase(path);
  try {
    raw.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => raw.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)").run("entry-cross", leftEntry.entryId, right.id, new Date().toISOString(), canonicalJson(user("cross"))), /foreign key/iu);
    assert.throws(() => raw.prepare("UPDATE sessions SET current_leaf_id = ? WHERE id = ?").run(leftEntry.entryId, right.id), /current-leaf-ownership/iu);
  } finally { raw.close(); await rm(directory, { recursive: true, force: true }); }
});

function user(content: string): AgentMessage { return Object.freeze({ schemaVersion: 1, kind: "user", id: `message-${content}`, createdAt: new Date(0).toISOString(), content }); }
function observation(): AgentMessage { return Object.freeze({ schemaVersion: 1, kind: "observation", id: "message-observation", createdAt: new Date(1).toISOString(), toolCallId: "call-v060", toolName: "read", content: "fact", evidence: { id: "evidence-v060", kind: "file" as const, summary: "verified", digest: "a".repeat(64) }, isError: false }); }
function memory(sourceEntryId: string): Extract<AgentMessage, { readonly kind: "memory" }> { const content = "remember"; const sourceEntryIds = [sourceEntryId]; return Object.freeze({ schemaVersion: 1, kind: "memory", id: "message-memory", createdAt: new Date(2).toISOString(), content, sourceEntryIds, digest: sha256(canonicalJson({ sourceEntryIds, summary: content })) }); }
function shape(sessionId: string): AgentShape {
  const systemBase = { schemaVersion: 1 as const, sections: [{ id: "session", kind: "session" as const, authority: "session" as const, content: "goal", required: true, provenance: ["session-shape", `session:${sessionId}`], estimatedTokens: 1, digest: sha256("goal") }], omissions: [], budgetTokens: 2048, estimatedTokens: 1, rendered: "goal" };
  const systemPromptPlan = { ...systemBase, digest: sha256(canonicalJson({ ...systemBase, sections: systemBase.sections.map(({ content: _content, ...metadata }) => metadata), renderedDigest: sha256(systemBase.rendered) })) };
  const harnessPlan: HarnessPlan = { schemaVersion: 1, task: "implement", taskLabels: ["implement"], risk: "low", capabilities: [], reasons: [], permissions: [], budgets: {}, evaluator: "test", omissions: [], digest: "plan" };
  const base = { schemaVersion: 1 as const, sessionId, revision: 1, goal: "fork", identity: { id: "alphion", name: "Alphion", description: "Agent" }, systemPromptPlan, resources: [], resourceIds: [], resourceDigest: "resources", toolIds: [], capabilities: [], policies: ["default-deny"], behavior: { compaction: "hybrid" as const, steering: true, followUps: true }, requiredProviderCapabilities: [], harnessPlan, omissions: [], diagnostics: [] };
  return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) });
}
