import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectManager } from "../adapters/project/project-manager.js";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { canonicalJson, sha256 } from "../src/application/canonical.js";
import type { AgentShape, HarnessPlan } from "../src/domain/contracts.js";

test("Project registry enforces case-insensitive names and realpath uniqueness without deleting roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v050-projects-"));
  const registry = join(directory, "config", "projects.json");
  const firstRoot = join(directory, "first");
  const secondRoot = join(directory, "second");
  const manager = new LocalProjectManager(registry);
  try {
    const first = await manager.create({ name: "Alphion", root: firstRoot });
    assert.equal(first.schemaVersion, 1);
    assert.match(first.domainId, /^domain_[a-f0-9]{32}$/u);
    await assert.rejects(manager.create({ name: "alphion", root: secondRoot }), /name already exists/iu);
    assert.equal((await manager.register({ name: "Duplicate Root", root: firstRoot })).id, first.id);
    assert.equal((await manager.open({ root: firstRoot })).id, first.id);
    assert.equal((await manager.activate(first.id)).id, first.id);
    assert.equal((await manager.current())?.id, first.id);
    assert.equal(await manager.remove(first.id), true);
    assert.equal(existsSync(firstRoot), true);
    assert.equal(await manager.current(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Project quick open creates missing roots, defaults the name and requires explicit conflict resolution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v090-project-open-"));
  const manager = new LocalProjectManager(join(directory, "config", "projects.json"));
  try {
    const first = await manager.open({ root: join(directory, "workspace", "demo"), create: true });
    assert.equal(first.name, "demo"); assert.equal((await manager.current())?.id, first.id);
    assert.equal((await manager.open({ root: first.root })).id, first.id);
    await assert.rejects(manager.open({ root: join(directory, "other", "demo"), create: true }), /name already exists/iu);
    const second = await manager.open({ root: join(directory, "other", "demo"), name: "Demo Two", create: true });
    assert.equal(second.name, "Demo Two"); assert.equal((await manager.current())?.id, second.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SQLite v5 records domain identity and creates a recoverable v4 backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v050-migrate-"));
  const path = join(directory, "state.sqlite3");
  try {
    let store = new SqliteStore({ path, domainId: "domain_project", projectId: "project-1" });
    const fresh = await store.createSession({ title: "v5", idempotencyKey: "create:v050:0001" });
    assert.equal(fresh.schemaVersion, 3);
    assert.equal(fresh.domainId, "domain_project");
    assert.equal(fresh.projectId, "project-1");
    store.close();
    const database = openSqliteDatabase(path);
    database.exec("DROP TABLE schedule_commands; DROP TABLE schedule_executions; DROP TABLE schedules; DROP TABLE goal_commands; DROP TABLE goal_revisions; DROP TABLE goals; DROP TABLE compaction_records; DROP TABLE project_credential_migrations; DROP TABLE project_credentials; DROP TABLE vault_legacy_state; DROP TABLE device_vault_secrets; DROP TABLE device_vault_metadata; DROP TABLE collaboration_run_budgets; DROP TABLE collaboration_messages; DROP INDEX sessions_domain; ALTER TABLE sessions DROP COLUMN project_id; ALTER TABLE sessions DROP COLUMN domain_id; PRAGMA user_version = 4;");
    database.close();
    store = new SqliteStore({ path, domainId: "domain_project", projectId: "project-1" });
    try {
      assert.equal(existsSync(`${path}.v4-backup`), true);
      assert.equal((await store.getSession(fresh.id))?.domainId, "domain_project");
      const backup = openSqliteDatabase(`${path}.v4-backup`, { readOnly: true });
      try { assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4); }
      finally { backup.close(); }
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Session collaboration is durable, idempotent, bounded and isolated by domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v050-collaboration-"));
  const sourceStore = new SqliteStore({ path: join(directory, "project.sqlite3"), domainId: "domain_same" });
  const otherStore = new SqliteStore({ path: join(directory, "other.sqlite3"), domainId: "domain_other" });
  try {
    const source = await shapedSession(sourceStore, "source", "source:v050:0001");
    const target = await shapedSession(sourceStore, "target", "target:v050:0001");
    const leased = await sourceStore.acquireRunLease(source.id, "run-source", source.revision);
    const request = { sourceSessionId: source.id, sourceRunId: "run-source", targetSessionId: target.id, domainId: "domain_same", shapeDigest: leased.shapeDigest ?? "", idempotencyKey: "deliver:v050:0001", correlationId: "correlation-v050", hop: 1, content: "Please inspect the migration." } as const;
    const first = await sourceStore.deliverSessionMessage(request);
    const replay = await sourceStore.deliverSessionMessage(request);
    assert.equal(first.delivery, "follow-up");
    assert.equal(replay.replayed, true);
    assert.equal(replay.targetRevision, first.targetRevision);
    const pending = await sourceStore.drainPending(target.id, "follow-up", "run-target");
    assert.equal(pending[0]?.message.kind, "agent");
    assert.equal(pending[0]?.message.schemaVersion, 2);
    const other = await shapedSession(otherStore, "other", "other:v050:0001");
    await assert.rejects(sourceStore.deliverSessionMessage({ ...request, targetSessionId: other.id, idempotencyKey: "deliver:v050:cross" }), /Unknown session|different Project domains/iu);
    await assert.rejects(sourceStore.deliverSessionMessage({ ...request, idempotencyKey: "deliver:v050:hop9", hop: 9 }), /hop budget/iu);
    for (let index = 2; index <= 4; index += 1) await sourceStore.deliverSessionMessage({ ...request, idempotencyKey: `deliver:v050:000${index}`, content: `message ${index}` });
    await assert.rejects(sourceStore.deliverSessionMessage({ ...request, idempotencyKey: "deliver:v050:0005", content: "fifth" }), /Per-Run/iu);
  } finally { sourceStore.close(); otherStore.close(); await rm(directory, { recursive: true, force: true }); }
});

async function shapedSession(store: SqliteStore, title: string, key: string) {
  const session = await store.createSession({ title, idempotencyKey: `create:${key}` });
  const receipt = await store.reshapeSession(session.id, testShape(session.id), { expectedRevision: session.revision, idempotencyKey: `reshape:${key}` });
  return { ...session, revision: receipt.revision, shapeDigest: receipt.shapeDigest };
}

function testShape(sessionId: string): AgentShape {
  const systemPromptPlan = { schemaVersion: 1 as const, sections: [], omissions: [], budgetTokens: 2048, estimatedTokens: 1, rendered: "test", digest: "prompt" };
  const harnessPlan: HarnessPlan = { schemaVersion: 1, task: "implement", taskLabels: ["implement"], risk: "low", capabilities: ["session.collaborate"], reasons: [], permissions: ["session:send"], budgets: {}, evaluator: "test", omissions: [], digest: "plan" };
  const base = { schemaVersion: 1 as const, sessionId, revision: 1, goal: "collaborate", identity: { id: "alphion", name: "Alphion", description: "Agent" }, systemPromptPlan, resources: [], resourceIds: [], resourceDigest: "resources", toolIds: ["session.send"], capabilities: ["session.collaborate"], policies: ["same-domain-session-collaboration"], behavior: { compaction: "hybrid" as const, steering: true, followUps: true }, requiredProviderCapabilities: ["tools" as const], harnessPlan, omissions: [], diagnostics: [] };
  return { ...base, digest: sha256(canonicalJson(base)) };
}
