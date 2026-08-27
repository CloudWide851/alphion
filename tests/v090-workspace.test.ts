import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceController } from "../adapters/project/active-project-controller.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import type { AgentApplication, ProjectManager } from "../src/ports/index.js";
import type { AgentSessionRecord, ProjectRecord } from "../src/domain/contracts.js";

test("Workspace keeps a busy Project alive, pauses its Scheduler, and evicts it when idle", async () => {
  const first = project("project_first", "First");
  const second = project("project_second", "Second");
  const manager = projectManager(first, second);
  const applications = new Map<string, FakeApplication>();
  const workspace = new WorkspaceController(manager, undefined, 3, async (options) => {
    const id = options.projectId ?? "unowned";
    const application = new FakeApplication(id);
    applications.set(id, application);
    return application as unknown as AgentApplication;
  });
  try {
    const opened = await workspace.openCurrentOrDefault();
    const firstApplication = applications.get(first.id)!;
    firstApplication.running = true;
    await workspace.activate(second.id);
    assert.equal(opened.application, firstApplication as unknown as AgentApplication);
    assert.equal(firstApplication.suspended, 1);
    assert.equal(firstApplication.closed, 0);
    assert.deepEqual((await workspace.backgroundRuns()).map((run) => run.projectId), [first.id]);
    firstApplication.running = false;
    await waitFor(() => firstApplication.closed === 1);
    assert.deepEqual(await workspace.backgroundRuns(), []);
  } finally { await workspace.close(); }
});

test("Workspace reuses a busy background application and rejects capacity overflow", async () => {
  const first = project("project_first", "First"); const second = project("project_second", "Second"); const third = project("project_third", "Third");
  const manager = projectManager(first, second, third); const applications = new Map<string, FakeApplication>();
  const workspace = new WorkspaceController(manager, undefined, 2, async (options) => { const application = new FakeApplication(options.projectId ?? "unowned"); applications.set(options.projectId ?? "unowned", application); return application as unknown as AgentApplication; });
  try {
    await workspace.openCurrentOrDefault(); applications.get(first.id)!.running = true;
    await workspace.activate(second.id); applications.get(second.id)!.running = true;
    await assert.rejects(workspace.activate(third.id), /limit/iu);
    const reused = await workspace.activate(first.id);
    assert.equal(reused.application, applications.get(first.id) as unknown as AgentApplication);
    assert.equal(applications.get(first.id)!.started, 2);
    assert.equal(applications.get(second.id)!.suspended, 1);
  } finally { await workspace.close(); }
});

test("Workspace retains pre-lease sends and durable follow-ups until work becomes idle", async () => {
  const first = project("project_first", "First"); const second = project("project_second", "Second");
  const applications = new Map<string, FakeApplication>();
  const workspace = new WorkspaceController(projectManager(first, second), undefined, 3, async (options) => {
    const application = new FakeApplication(options.projectId ?? "unowned"); applications.set(options.projectId ?? "unowned", application); return application as unknown as AgentApplication;
  });
  try {
    await workspace.openCurrentOrDefault();
    const firstApplication = applications.get(first.id)!;
    firstApplication.inFlight = true;
    await workspace.activate(second.id);
    assert.equal(firstApplication.closed, 0);
    firstApplication.inFlight = false; firstApplication.pendingFollowUp = true;
    await new Promise((resolveValue) => setTimeout(resolveValue, 300));
    assert.equal(firstApplication.closed, 0);
    firstApplication.pendingFollowUp = false;
    await waitFor(() => firstApplication.closed === 1);
  } finally { await workspace.close(); }
});

test("SQLite activity probe includes Run leases and durable follow-ups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-workspace-activity-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  try {
    const created = await store.createSession({ title: "Activity", idempotencyKey: "workspace_activity_create" });
    assert.equal(await store.hasActiveSessionWork(), false);
    const leased = await store.acquireRunLease(created.id, "run-activity", created.revision);
    assert.equal(await store.hasActiveSessionWork(), true);
    const idle = await store.releaseRunLease(created.id, "run-activity");
    const queued = await store.enqueuePending(created.id, "follow-up", { schemaVersion: 1, kind: "user", id: "message-activity", createdAt: new Date(0).toISOString(), content: "next" }, { expectedRevision: idle.revision, idempotencyKey: "workspace_activity_follow" });
    assert.equal(await store.hasActiveSessionWork(), true);
    const batch = await store.drainPending(created.id, "follow-up", "run-follow-up");
    await store.acknowledgePending(created.id, "follow-up", "run-follow-up", batch.map((item) => item.id));
    assert.equal(queued.revision > idle.revision, true); assert.equal(await store.hasActiveSessionWork(), false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

class FakeApplication {
  running = false; inFlight = false; pendingFollowUp = false; closed = 0; suspended = 0; started = 0;
  constructor(readonly projectId: string) {}
  readonly sessions = { list: () => Promise.resolve(this.running ? [session(this.projectId)] : []), hasActiveWork: () => Promise.resolve(this.running || this.inFlight || this.pendingFollowUp), subscribeActivity: () => ({ async *[Symbol.asyncIterator]() { /* polling owns eviction in this test */ } }) };
  readonly schedules = { suspend: () => { this.suspended += 1; }, start: () => { this.started += 1; } };
  close(): Promise<void> { this.closed += 1; return Promise.resolve(); }
}

function project(id: string, name: string): ProjectRecord { return Object.freeze({ schemaVersion: 1, id, name, root: `C:\\${name}`, statePath: `C:\\${name}\\.alphion\\alphion.sqlite3`, domainId: `domain_${id}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }); }
function session(projectId: string): AgentSessionRecord { return Object.freeze({ schemaVersion: 3, id: `session_${projectId}`, domainId: `domain_${projectId}`, projectId, title: "Background", revision: 2, status: "running", activeRunId: `run_${projectId}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", auditOnly: false, shapeStatus: "shaped", shapeRevision: 1, shapeDigest: "a".repeat(64) }); }
function projectManager(...projects: readonly ProjectRecord[]): ProjectManager { let current = projects[0]; return { register: () => Promise.reject(new Error("unused")), create: () => Promise.reject(new Error("unused")), open: () => Promise.reject(new Error("unused")), list: () => Promise.resolve(projects), get: (id) => Promise.resolve(projects.find((item) => item.id === id)), activate: (id) => { const selected = projects.find((item) => item.id === id); if (!selected) return Promise.reject(new Error("missing")); current = selected; return Promise.resolve(selected); }, remove: () => Promise.resolve(false), current: () => Promise.resolve(current) }; }
async function waitFor(predicate: () => boolean): Promise<void> { const deadline = Date.now() + 2_000; while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for Workspace eviction."); await new Promise((resolveValue) => setTimeout(resolveValue, 25)); } }
