import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteRuntimeStore } from "../adapters/store/sqlite-runtime-store.js";
import { DefaultGoalManager } from "../src/application/goal-manager.js";
import { DefaultScheduleManager } from "../src/application/schedule-manager.js";
import { assertScheduleCadence, latestDueOccurrence, nextScheduleOccurrence } from "../src/application/schedule-time.js";
import type { AgentRunHandle, AgentSessionContract, SessionManager } from "../src/ports/index.js";

test("Goal revisions enforce authority, evidence, idle roots, replay, and user completion", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "goal.sqlite3");
    const store = new SqliteRuntimeStore({ path, projectId: "project_a", domainId: "domain_a" });
    try {
      const goals = new DefaultGoalManager(store, () => undefined);
      const request = { title: "Release", rootGoal: "Ship v0.8", acceptanceCriteria: ["All gates pass"], safetyConstraints: ["No push"], idempotencyKey: "goal_create_release" };
      const created = await goals.create(request);
      const replay = await goals.create(request);
      assert.equal(replay.replayed, true);
      assert.equal(replay.goal.id, created.goal.id);
      assert.equal((await store.getSession(created.goal.sessionId))?.title, "Goal · Release");

      const updated = await goals.updateRoot({ goalId: created.goal.id, rootGoal: "Ship audited v0.8", acceptanceCriteria: ["All gates pass", "Evidence recorded"], safetyConstraints: ["No push"], expectedRevision: 1, idempotencyKey: "goal_root_2" });
      await assert.rejects(goals.updateRoot({ goalId: created.goal.id, rootGoal: "stale", acceptanceCriteria: ["x"], safetyConstraints: [], expectedRevision: 1, idempotencyKey: "goal_root_stale" }), /revision changed/iu);

      setGoalSession(path, created.goal.sessionId, "running", "run_goal");
      await assert.rejects(goals.updateRoot({ goalId: created.goal.id, rootGoal: "busy", acceptanceCriteria: ["x"], safetyConstraints: [], expectedRevision: updated.goal.revision, idempotencyKey: "goal_root_busy" }), /idle/iu);
      appendEvidence(path, created.goal.sessionId, "run_goal", "evidence_goal_1");
      const progress = await goals.appendProgress({ goalId: created.goal.id, progress: "Migration verified", nextStep: "Run release gate", blockers: [], evidenceIds: ["evidence_goal_1"], completionSuggested: true, expectedRevision: updated.goal.revision, idempotencyKey: "goal_agent_progress", actor: "agent", actorSessionId: created.goal.sessionId, actorRunId: "run_goal" });
      assert.equal(progress.goal.current.completionSuggested, true);
      assert.deepEqual(progress.goal.current.evidenceIds, ["evidence_goal_1"]);
      await assert.rejects(goals.appendProgress({ goalId: created.goal.id, progress: "forged", evidenceIds: ["missing"], expectedRevision: progress.goal.revision, idempotencyKey: "goal_agent_forged", actor: "agent", actorSessionId: created.goal.sessionId, actorRunId: "run_goal" }), /Evidence/iu);
      setGoalSession(path, created.goal.sessionId, "idle");

      const restored = await goals.restoreRevision(created.goal.id, 1, progress.goal.revision, "goal_restore_1");
      assert.equal(restored.goal.current.rootGoal, "Ship v0.8");
      assert.equal(restored.goal.current.actor, "restore");
      assert.equal(restored.goal.revision, progress.goal.revision + 1);
      const completed = await goals.confirmCompletion(created.goal.id, restored.goal.revision, "goal_confirm");
      assert.equal(completed.goal.status, "completed");
      await assert.rejects(goals.updateRoot({ goalId: created.goal.id, rootGoal: "after", acceptanceCriteria: ["x"], safetyConstraints: [], expectedRevision: completed.goal.revision, idempotencyKey: "goal_after_complete" }), /active Goal/iu);
      const archived = await goals.archive(created.goal.id, completed.goal.revision, "goal_archive");
      assert.equal(archived.goal.status, "archived");
      assert.equal((await goals.list()).length, 0);
      assert.equal((await goals.list(true)).length, 1);
    } finally { store.close(); }
  });
});

test("Goal active limit counts only active records", async () => {
  await temporary(async (directory) => {
    const store = new SqliteRuntimeStore({ path: join(directory, "limit.sqlite3"), projectId: "project_limit", domainId: "domain_limit" });
    try {
      const goals = new DefaultGoalManager(store, () => undefined);
      const values = [];
      for (let index = 0; index < 64; index += 1) values.push(await goals.create({ title: `Goal ${index}`, rootGoal: `Deliver ${index}`, acceptanceCriteria: ["verified"], idempotencyKey: `goal_limit_${index}` }));
      await assert.rejects(goals.create({ title: "Overflow", rootGoal: "Overflow", acceptanceCriteria: ["never"], idempotencyKey: "goal_limit_overflow" }), /64 active Goals/u);
      const completed = await goals.confirmCompletion(values[0]!.goal.id, values[0]!.goal.revision, "goal_limit_complete");
      assert.equal(completed.goal.status, "completed");
      await goals.create({ title: "Replacement", rootGoal: "Replacement", acceptanceCriteria: ["verified"], idempotencyKey: "goal_limit_replacement" });
    } finally { store.close(); }

    const unowned = new SqliteRuntimeStore({ path: join(directory, "unowned.sqlite3"), domainId: "domain_unowned" });
    try { await assert.rejects(unowned.createGoal({ title: "Denied", rootGoal: "Denied", acceptanceCriteria: ["denied"], idempotencyKey: "goal_unowned" }), /active Project/u); }
    finally { unowned.close(); }
  });
});

test("scheduler validates timezones and cadence, catches up only the latest occurrence", () => {
  const now = new Date("2026-03-08T06:55:00.000Z");
  assert.throws(() => assertScheduleCadence({ kind: "interval", everyMinutes: 4 }, "UTC", now), /five minutes/u);
  assert.throws(() => assertScheduleCadence({ kind: "cron", expression: "* * * * *" }, "UTC", now), /five minutes/u);
  assert.throws(() => nextScheduleOccurrence({ kind: "cron", expression: "0 9 * * *" }, "Invalid/Timezone", now), /timezone/u);
  const dst = nextScheduleOccurrence({ kind: "cron", expression: "0 9 * * *" }, "America/New_York", now);
  assert.ok(dst);
  const localHour = new Intl.DateTimeFormat("en", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(dst);
  assert.equal(localHour, "09");
  const schedule = { schemaVersion: 1 as const, id: "schedule", projectId: "project", domainId: "domain", title: "review", expression: { kind: "interval" as const, everyMinutes: 5 }, timezone: "UTC", payload: { kind: "session.prompt" as const, sessionId: "session", prompt: "review" }, status: "active" as const, revision: 1, nextRunAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(latestDueOccurrence(schedule, new Date("2026-01-01T00:18:00.000Z")), { dueAt: "2026-01-01T00:15:00.000Z", nextRunAt: "2026-01-01T00:20:00.000Z", missedCount: 3 });
});

test("run-now is idempotent, busy Sessions queue durable follow-up, and overlap skips", async () => {
  await temporary(async (directory) => {
    const store = new SqliteRuntimeStore({ path: join(directory, "schedule.sqlite3"), projectId: "project_schedule", domainId: "domain_schedule" });
    const session = await store.createSession({ title: "Scheduled", idempotencyKey: "schedule_session" });
    const fake = fakeSessions(store, session.id, false, false);
    const goals = new DefaultGoalManager(store, () => undefined);
    const schedules = new DefaultScheduleManager({ store, sessions: fake.manager, goals, assertOpen: () => undefined, enabled: false, now: () => new Date("2026-01-01T00:00:00.000Z") });
    try {
      const schedule = await schedules.create({ title: "Prompt", expression: { kind: "interval", everyMinutes: 5 }, timezone: "UTC", payload: { kind: "session.prompt", sessionId: session.id, prompt: "Review now" }, idempotencyKey: "schedule_create" });
      const first = await schedules.runNow(schedule.id, { expectedRevision: schedule.revision, idempotencyKey: "schedule_run_once" });
      const replay = await schedules.runNow(schedule.id, { expectedRevision: schedule.revision, idempotencyKey: "schedule_run_once" });
      assert.equal(replay.id, first.id);
      await eventually(async () => (await schedules.executions(schedule.id))[0]?.status === "completed");
      assert.equal(fake.sent(), 1);

      fake.setBusy(true);
      const current = await schedules.get(schedule.id);
      const queued = await schedules.runNow(schedule.id, { expectedRevision: current.revision, idempotencyKey: "schedule_run_busy" });
      await eventually(async () => (await schedules.executions(schedule.id)).find((item) => item.id === queued.id)?.status === "queued");
      assert.equal(fake.followed(), 1);
      const afterQueued = await schedules.get(schedule.id);
      const overlap = await store.claimSchedule(schedule.id, "2026-01-01T00:05:00.000Z", "2026-01-01T00:10:00.000Z", 0, "other", "2099-01-01T00:00:00.000Z", afterQueued.revision);
      assert.equal(overlap, undefined);
      assert.ok((await schedules.executions(schedule.id)).some((item) => item.status === "skipped" && item.reason === "overlap"));
    } finally { await schedules.close(); store.close(); }
  });
});

test("scheduler close cancels its active Run before store shutdown", async () => {
  await temporary(async (directory) => {
    const store = new SqliteRuntimeStore({ path: join(directory, "close.sqlite3"), projectId: "project_close", domainId: "domain_close" });
    const session = await store.createSession({ title: "Cancelable", idempotencyKey: "cancel_session" });
    const fake = fakeSessions(store, session.id, false, true);
    const schedules = new DefaultScheduleManager({ store, sessions: fake.manager, goals: new DefaultGoalManager(store, () => undefined), assertOpen: () => undefined, enabled: false });
    const schedule = await schedules.create({ title: "Cancelable", expression: { kind: "interval", everyMinutes: 5 }, timezone: "UTC", payload: { kind: "session.prompt", sessionId: session.id, prompt: "Wait" }, idempotencyKey: "cancel_schedule" });
    await schedules.runNow(schedule.id, { expectedRevision: schedule.revision, idempotencyKey: "cancel_run" });
    await eventually(async () => fake.sent() === 1);
    await schedules.close();
    assert.equal(fake.cancelled(), 1);
    assert.equal((await schedules.executions(schedule.id))[0]?.status, "failed");
    store.close();
  });
});

function fakeSessions(store: SqliteRuntimeStore, sessionId: string, initialBusy: boolean, cancellable: boolean) {
  let busy = initialBusy; let sent = 0; let followed = 0; let cancelled = 0;
  const session = {
    id: sessionId,
    async get() { const record = await store.getSession(sessionId); if (!record) throw new Error("missing session"); return { ...record, status: busy ? "running" as const : "idle" as const, ...(busy ? { activeRunId: "run_busy" } : {}) }; },
    async send() { sent += 1; return runHandle(sessionId, cancellable, () => { cancelled += 1; }); },
    async followUp() { followed += 1; const record = await store.getSession(sessionId); if (!record) throw new Error("missing session"); return { sessionId, revision: record.revision + 1, replayed: false }; },
  } as unknown as AgentSessionContract;
  const manager = { async get(id: string) { if (id !== sessionId) throw new Error("unknown session"); return session; } } as unknown as SessionManager;
  return { manager, setBusy(value: boolean) { busy = value; }, sent: () => sent, followed: () => followed, cancelled: () => cancelled };
}

function runHandle(sessionId: string, cancellable: boolean, onCancel: () => void): AgentRunHandle {
  const runId = `run_schedule_${++runCounter}`;
  let resolve!: (value: Awaited<AgentRunHandle["result"]>) => void;
  const waiting = new Promise<Awaited<AgentRunHandle["result"]>>((done) => { resolve = done; });
  const resultValue = (status: "completed" | "cancelled") => ({ runId, sessionId, status, finalText: status === "completed" ? "done" : "", turns: 1, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, grounding: { availableEvidenceIds: [], referencedEvidenceIds: [], missingEvidenceIds: [], unreferencedEvidenceIds: [] } });
  if (!cancellable) resolve(resultValue("completed"));
  return { runId, sessionId, events: { async *[Symbol.asyncIterator]() { /* no live events */ } }, result: waiting, cancel() { onCancel(); resolve(resultValue("cancelled")); } };
}

let runCounter = 0;

function setGoalSession(path: string, sessionId: string, status: "idle" | "running", runId?: string): void {
  const database = openSqliteDatabase(path);
  try { database.prepare("UPDATE sessions SET status = ?, active_run_id = ? WHERE id = ?").run(status, runId ?? null, sessionId); }
  finally { database.close(); }
}

function appendEvidence(path: string, sessionId: string, runId: string, evidenceId: string): void {
  const database = openSqliteDatabase(path);
  try {
    const message = { schemaVersion: 1, kind: "observation", id: "message_goal_evidence", createdAt: "2026-01-01T00:00:00.000Z", toolCallId: "call_goal", toolName: "read", content: "verified", evidence: { id: evidenceId, kind: "search", digest: "a".repeat(64), summary: "verified" }, isError: false };
    database.prepare("INSERT INTO session_entries (session_id, id, parent_id, run_id, timestamp, message_json) VALUES (?, ?, NULL, ?, ?, ?)").run(sessionId, "entry_goal_evidence", runId, message.createdAt, JSON.stringify(message));
  } finally { database.close(); }
}

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("condition was not reached before timeout");
}

async function temporary(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v080-automation-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
