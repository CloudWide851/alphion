import type {
  GoalCreateRequest, GoalProgressRequest, GoalRecord, GoalRevision, GoalRootUpdateRequest, GoalWriteReceipt,
  ScheduleClaim, ScheduleCreateRequest, ScheduleExecution, ScheduleExecutionStatus, ScheduleRecord, ScheduleStatus, ScheduleWriteOptions,
} from "../../src/domain/automation-contracts.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import type { SqliteDatabase } from "./database.js";
import { optionalRow, readNullableString, readNumber, readString, requiredRow, validateIdempotencyKey } from "./sqlite-codecs.js";

export interface AutomationIdentity { readonly projectId?: string; readonly domainId: string; }

export function createStoredGoal(database: SqliteDatabase, identity: AutomationIdentity, request: GoalCreateRequest): GoalWriteReceipt {
  const projectId = requireProject(identity);
  validateIdempotencyKey(request.idempotencyKey);
  const requestDigest = digestRequest(request);
  const replay = replayGoalCommand(database, request.idempotencyKey, requestDigest);
  if (replay) return replay;
  validateGoalRoot(request.rootGoal, request.acceptanceCriteria, request.safetyConstraints ?? []);
  const active = readNumber(requiredRow(database.prepare("SELECT COUNT(*) AS count FROM goals WHERE project_id = ? AND status = 'active'").get(projectId)), "count");
  if (active >= 64) throw new AlphionError("budget-exceeded", "A Project can have at most 64 active Goals.", { stage: "goal" });
  const now = new Date().toISOString();
  const goalId = createId("goal");
  const sessionId = createId("session");
  const title = boundedText(request.title, 1, 160, "Goal title");
  database.prepare("INSERT INTO sessions (id, title, current_leaf_id, revision, status, active_run_id, provider_id, created_at, updated_at, audit_only, domain_id, project_id) VALUES (?, ?, NULL, 0, 'idle', NULL, ?, ?, ?, 0, ?, ?)")
    .run(sessionId, `Goal · ${title}`.slice(0, 200), request.providerId ?? null, now, now, identity.domainId, projectId);
  const revision = makeGoalRevision({ goalId, revision: 1, actor: "user", rootGoal: request.rootGoal, acceptanceCriteria: request.acceptanceCriteria, safetyConstraints: request.safetyConstraints ?? [], progress: "", subgoals: [], blockers: [], evidenceIds: [], completionSuggested: false, createdAt: now });
  database.prepare("INSERT INTO goals (id, project_id, domain_id, session_id, title, status, current_revision, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)")
    .run(goalId, projectId, identity.domainId, sessionId, title, now, now);
  database.prepare("INSERT INTO goal_revisions (goal_id, revision, parent_revision, actor, revision_json, digest, created_at, command_key) VALUES (?, 1, NULL, 'user', ?, ?, ?, ?)")
    .run(goalId, canonicalJson(revision), revision.digest, now, request.idempotencyKey);
  const receipt = Object.freeze({ goal: requireGoal(database, goalId), replayed: false });
  recordGoalCommand(database, request.idempotencyKey, goalId, requestDigest, receipt);
  return receipt;
}

export function listStoredGoals(database: SqliteDatabase, identity: AutomationIdentity, includeArchived = false): readonly GoalRecord[] {
  const projectId = requireProject(identity);
  const sql = `SELECT g.*, r.revision_json FROM goals g JOIN goal_revisions r ON r.goal_id = g.id AND r.revision = g.current_revision WHERE g.project_id = ?${includeArchived ? "" : " AND g.status != 'archived'"} ORDER BY g.updated_at DESC, g.id`;
  return Object.freeze(database.prepare(sql).all(projectId).map((row) => decodeGoalRow(requiredRow(row))));
}

export function getStoredGoal(database: SqliteDatabase, goalId: string): GoalRecord | undefined {
  const row = optionalRow(database.prepare("SELECT g.*, r.revision_json FROM goals g JOIN goal_revisions r ON r.goal_id = g.id AND r.revision = g.current_revision WHERE g.id = ?").get(goalId));
  return row ? decodeGoalRow(row) : undefined;
}

export function updateStoredGoalRoot(database: SqliteDatabase, request: GoalRootUpdateRequest): GoalWriteReceipt {
  validateIdempotencyKey(request.idempotencyKey);
  const requestDigest = digestRequest(request);
  const replay = replayGoalCommand(database, request.idempotencyKey, requestDigest);
  if (replay) return replay;
  validateGoalRoot(request.rootGoal, request.acceptanceCriteria, request.safetyConstraints);
  const goal = requireGoal(database, request.goalId);
  assertGoalWritable(database, goal, request.expectedRevision);
  if (goal.status !== "active") throw new AlphionError("conflict", "Only an active Goal can change its root contract.", { stage: "goal" });
  const now = new Date().toISOString();
  const next = makeGoalRevision({ ...goal.current, revision: goal.revision + 1, parentRevision: goal.revision, actor: "user", rootGoal: request.rootGoal, acceptanceCriteria: request.acceptanceCriteria, safetyConstraints: request.safetyConstraints, createdAt: now });
  appendGoalRevision(database, goal, next, request.idempotencyKey, now);
  const receipt = Object.freeze({ goal: requireGoal(database, goal.id), replayed: false });
  recordGoalCommand(database, request.idempotencyKey, goal.id, requestDigest, receipt);
  return receipt;
}

export function appendStoredGoalProgress(database: SqliteDatabase, request: GoalProgressRequest): GoalWriteReceipt {
  validateIdempotencyKey(request.idempotencyKey);
  const requestDigest = digestRequest(request);
  const replay = replayGoalCommand(database, request.idempotencyKey, requestDigest);
  if (replay) return replay;
  const goal = requireGoal(database, request.goalId);
  assertGoalRevision(goal, request.expectedRevision);
  if (goal.status !== "active") throw new AlphionError("conflict", "Only an active Goal can receive progress.", { stage: "goal" });
  const evidenceIds = stringList(request.evidenceIds, 64, 200, "Evidence IDs");
  if (request.actor === "agent") assertAgentGoalUpdate(database, goal, request.actorSessionId, request.actorRunId, evidenceIds);
  const now = new Date().toISOString();
  const next = makeGoalRevision({
    ...goal.current,
    revision: goal.revision + 1,
    parentRevision: goal.revision,
    actor: request.actor,
    progress: boundedText(request.progress, 1, 8_000, "Goal progress"),
    subgoals: request.subgoals ?? goal.current.subgoals,
    ...(request.nextStep === undefined ? {} : { nextStep: request.nextStep }),
    blockers: request.blockers ?? goal.current.blockers,
    evidenceIds: Object.freeze([...new Set([...goal.current.evidenceIds, ...evidenceIds])]),
    completionSuggested: request.completionSuggested ?? goal.current.completionSuggested,
    createdAt: now,
  });
  appendGoalRevision(database, goal, next, request.idempotencyKey, now);
  const receipt = Object.freeze({ goal: requireGoal(database, goal.id), replayed: false });
  recordGoalCommand(database, request.idempotencyKey, goal.id, requestDigest, receipt);
  return receipt;
}

export function setStoredGoalStatus(database: SqliteDatabase, goalId: string, status: "completed" | "archived" | "active", expectedRevision: number, idempotencyKey: string): GoalWriteReceipt {
  validateIdempotencyKey(idempotencyKey);
  const requestDigest = sha256(canonicalJson({ goalId, status, expectedRevision }));
  const replay = replayGoalCommand(database, idempotencyKey, requestDigest);
  if (replay) return replay;
  const goal = requireGoal(database, goalId);
  assertGoalWritable(database, goal, expectedRevision);
  if (status === "completed" && goal.status !== "active") throw new AlphionError("conflict", "Only an active Goal can be confirmed complete.", { stage: "goal" });
  if (status === "archived" && goal.status === "archived") throw new AlphionError("conflict", "Goal is already archived.", { stage: "goal" });
  if (status === "active" && goal.status !== "archived") throw new AlphionError("conflict", "Only an archived Goal can be reactivated.", { stage: "goal" });
  const now = new Date().toISOString();
  const next = makeGoalRevision({ ...goal.current, revision: goal.revision + 1, parentRevision: goal.revision, actor: "user", createdAt: now });
  database.prepare("INSERT INTO goal_revisions (goal_id, revision, parent_revision, actor, revision_json, digest, created_at, command_key) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)")
    .run(goal.id, next.revision, goal.revision, canonicalJson(next), next.digest, now, idempotencyKey);
  database.prepare("UPDATE goals SET status = ?, current_revision = ?, updated_at = ?, archived_at = ? WHERE id = ?")
    .run(status, next.revision, now, status === "archived" ? now : null, goal.id);
  const receipt = Object.freeze({ goal: requireGoal(database, goal.id), replayed: false });
  recordGoalCommand(database, idempotencyKey, goal.id, requestDigest, receipt);
  return receipt;
}

export function restoreStoredGoalRevision(database: SqliteDatabase, goalId: string, sourceRevision: number, expectedRevision: number, idempotencyKey: string): GoalWriteReceipt {
  validateIdempotencyKey(idempotencyKey);
  const requestDigest = sha256(canonicalJson({ goalId, sourceRevision, expectedRevision }));
  const replay = replayGoalCommand(database, idempotencyKey, requestDigest);
  if (replay) return replay;
  const goal = requireGoal(database, goalId);
  assertGoalWritable(database, goal, expectedRevision);
  const sourceRow = optionalRow(database.prepare("SELECT revision_json FROM goal_revisions WHERE goal_id = ? AND revision = ?").get(goalId, sourceRevision));
  if (!sourceRow) throw new AlphionError("validation", "Goal revision to restore does not exist.", { stage: "goal" });
  const source = decodeGoalRevision(JSON.parse(readString(sourceRow, "revision_json")));
  const now = new Date().toISOString();
  const next = makeGoalRevision({ ...source, revision: goal.revision + 1, parentRevision: goal.revision, actor: "restore", createdAt: now });
  appendGoalRevision(database, goal, next, idempotencyKey, now);
  const receipt = Object.freeze({ goal: requireGoal(database, goal.id), replayed: false });
  recordGoalCommand(database, idempotencyKey, goal.id, requestDigest, receipt);
  return receipt;
}

export function createStoredSchedule(database: SqliteDatabase, identity: AutomationIdentity, request: ScheduleCreateRequest, nextRunAt: string): ScheduleRecord {
  const projectId = requireProject(identity);
  validateIdempotencyKey(request.idempotencyKey);
  const requestDigest = digestRequest({ request, nextRunAt });
  const replay = replayScheduleCommand(database, request.idempotencyKey, requestDigest);
  if (replay) return replay;
  const count = readNumber(requiredRow(database.prepare("SELECT COUNT(*) AS count FROM schedules WHERE project_id = ?").get(projectId)), "count");
  if (count >= 128) throw new AlphionError("budget-exceeded", "A Project can have at most 128 schedules.", { stage: "scheduler" });
  const now = new Date().toISOString();
  const id = createId("schedule");
  database.prepare("INSERT INTO schedules (id, project_id, domain_id, title, expression_json, timezone, payload_json, status, revision, next_run_at, last_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, NULL, ?, ?)")
    .run(id, projectId, identity.domainId, boundedText(request.title, 1, 160, "Schedule title"), canonicalJson(request.expression), request.timezone, canonicalJson(request.payload), nextRunAt, now, now);
  const result = requireSchedule(database, id);
  recordScheduleCommand(database, request.idempotencyKey, id, requestDigest, result);
  return result;
}

export function listStoredSchedules(database: SqliteDatabase, identity: AutomationIdentity): readonly ScheduleRecord[] { const projectId = requireProject(identity); return Object.freeze(database.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId).map((row) => decodeSchedule(requiredRow(row)))); }
export function getStoredSchedule(database: SqliteDatabase, scheduleId: string): ScheduleRecord | undefined { const row = optionalRow(database.prepare("SELECT * FROM schedules WHERE id = ?").get(scheduleId)); return row ? decodeSchedule(row) : undefined; }

export function setStoredScheduleStatus(database: SqliteDatabase, scheduleId: string, status: "active" | "paused", options: ScheduleWriteOptions, nextRunAt?: string): ScheduleRecord {
  validateIdempotencyKey(options.idempotencyKey);
  const requestDigest = digestRequest({ scheduleId, status, expectedRevision: options.expectedRevision, nextRunAt });
  const replay = replayScheduleCommand(database, options.idempotencyKey, requestDigest);
  if (replay) return replay;
  const schedule = requireSchedule(database, scheduleId);
  assertScheduleRevision(schedule, options.expectedRevision);
  const now = new Date().toISOString();
  database.prepare("UPDATE schedules SET status = ?, revision = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(status, schedule.revision + 1, status === "active" ? nextRunAt ?? schedule.nextRunAt ?? null : schedule.nextRunAt ?? null, now, schedule.id);
  const result = requireSchedule(database, schedule.id);
  recordScheduleCommand(database, options.idempotencyKey, schedule.id, requestDigest, result);
  return result;
}

export function claimStoredSchedule(database: SqliteDatabase, scheduleId: string, dueAt: string, nextRunAt: string | undefined, missedCount: number, owner: string, leaseExpiresAt: string, expectedRevision: number): ScheduleClaim | undefined {
  const schedule = requireSchedule(database, scheduleId);
  assertScheduleRevision(schedule, expectedRevision);
  if (schedule.status !== "active") return undefined;
  const duplicate = optionalRow(database.prepare("SELECT * FROM schedule_executions WHERE schedule_id = ? AND due_at = ?").get(scheduleId, dueAt));
  if (duplicate) return undefined;
  const overlap = optionalRow(database.prepare("SELECT id FROM schedule_executions WHERE schedule_id = ? AND status IN ('claimed','running','queued') AND lease_expires_at > ? LIMIT 1").get(scheduleId, dueAt));
  const now = new Date().toISOString();
  if (overlap) {
    database.prepare("INSERT INTO schedule_executions (id, schedule_id, due_at, status, lease_owner, lease_expires_at, run_id, missed_count, reason, created_at, updated_at) VALUES (?, ?, ?, 'skipped', NULL, NULL, NULL, ?, 'overlap', ?, ?)")
      .run(createId("schedule_execution"), scheduleId, dueAt, missedCount, now, now);
    advanceSchedule(database, schedule, dueAt, nextRunAt, now);
    return undefined;
  }
  const executionId = createId("schedule_execution");
  database.prepare("INSERT INTO schedule_executions (id, schedule_id, due_at, status, lease_owner, lease_expires_at, run_id, missed_count, reason, created_at, updated_at) VALUES (?, ?, ?, 'claimed', ?, ?, NULL, ?, NULL, ?, ?)")
    .run(executionId, scheduleId, dueAt, owner, leaseExpiresAt, missedCount, now, now);
  advanceSchedule(database, schedule, dueAt, nextRunAt, now);
  return Object.freeze({ schedule: requireSchedule(database, scheduleId), execution: requireExecution(database, executionId), replayed: false });
}

export function claimStoredScheduleNow(database: SqliteDatabase, scheduleId: string, owner: string, leaseExpiresAt: string, options: ScheduleWriteOptions): ScheduleClaim {
  validateIdempotencyKey(options.idempotencyKey);
  const requestDigest = digestRequest({ scheduleId, expectedRevision: options.expectedRevision });
  const replay = replayScheduleClaimCommand(database, options.idempotencyKey, requestDigest);
  if (replay) return replay;
  const schedule = requireSchedule(database, scheduleId);
  assertScheduleRevision(schedule, options.expectedRevision);
  const dueAt = new Date().toISOString();
  const claim = claimStoredSchedule(database, scheduleId, dueAt, schedule.nextRunAt, 0, owner, leaseExpiresAt, schedule.revision);
  if (!claim) throw new AlphionError("conflict", "Schedule already has overlapping work.", { stage: "scheduler" });
  recordScheduleCommand(database, options.idempotencyKey, scheduleId, requestDigest, claim);
  return claim;
}

export function updateStoredScheduleExecution(database: SqliteDatabase, executionId: string, status: ScheduleExecutionStatus, details?: Readonly<{ runId?: string; reason?: string }>): ScheduleExecution {
  const current = requireExecution(database, executionId);
  if (["completed", "failed", "skipped"].includes(current.status)) return current;
  const now = new Date().toISOString();
  database.prepare("UPDATE schedule_executions SET status = ?, run_id = COALESCE(?, run_id), reason = ?, updated_at = ? WHERE id = ?")
    .run(status, details?.runId ?? null, details?.reason?.slice(0, 500) ?? null, now, executionId);
  return requireExecution(database, executionId);
}

export function listStoredScheduleExecutions(database: SqliteDatabase, scheduleId: string, limit = 50): readonly ScheduleExecution[] { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AlphionError("validation", "Schedule execution limit must be 1-500.", { stage: "scheduler" }); return Object.freeze(database.prepare("SELECT * FROM schedule_executions WHERE schedule_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(scheduleId, limit).map((row) => decodeExecution(requiredRow(row)))); }

function appendGoalRevision(database: SqliteDatabase, goal: GoalRecord, revision: GoalRevision, key: string, now: string): void { database.prepare("INSERT INTO goal_revisions (goal_id, revision, parent_revision, actor, revision_json, digest, created_at, command_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(goal.id, revision.revision, revision.parentRevision ?? null, revision.actor, canonicalJson(revision), revision.digest, now, key); database.prepare("UPDATE goals SET current_revision = ?, updated_at = ? WHERE id = ?").run(revision.revision, now, goal.id); }
function advanceSchedule(database: SqliteDatabase, schedule: ScheduleRecord, dueAt: string, nextRunAt: string | undefined, now: string): void { database.prepare("UPDATE schedules SET revision = ?, next_run_at = ?, last_run_at = ?, status = ?, updated_at = ? WHERE id = ?").run(schedule.revision + 1, nextRunAt ?? null, dueAt, nextRunAt ? schedule.status : "completed", now, schedule.id); }
function assertGoalWritable(database: SqliteDatabase, goal: GoalRecord, expected: number): void { assertGoalRevision(goal, expected); const row = requiredRow(database.prepare("SELECT status, active_run_id FROM sessions WHERE id = ?").get(goal.sessionId)); if (readString(row, "status") !== "idle" || readNullableString(row, "active_run_id")) throw new AlphionError("conflict", "Goal root changes require an idle Goal Session.", { stage: "goal" }); }
function assertGoalRevision(goal: GoalRecord, expected: number): void { if (goal.revision !== expected) throw new AlphionError("conflict", `Goal revision changed; expected ${expected}, current ${goal.revision}.`, { stage: "goal" }); }
function assertScheduleRevision(schedule: ScheduleRecord, expected: number): void { if (schedule.revision !== expected) throw new AlphionError("conflict", `Schedule revision changed; expected ${expected}, current ${schedule.revision}.`, { stage: "scheduler" }); }
function assertAgentGoalUpdate(database: SqliteDatabase, goal: GoalRecord, sessionId: string | undefined, runId: string | undefined, evidenceIds: readonly string[]): void { if (!sessionId || sessionId !== goal.sessionId || !runId) throw new AlphionError("forbidden", "Agent Goal progress must originate from the dedicated Goal Session.", { stage: "goal" }); const session = requiredRow(database.prepare("SELECT status, active_run_id FROM sessions WHERE id = ?").get(goal.sessionId)); if (readString(session, "status") !== "running" || readNullableString(session, "active_run_id") !== runId) throw new AlphionError("conflict", "Agent Goal progress requires the active Goal Run lease.", { stage: "goal" }); const available = collectEvidence(database, goal.sessionId); if (evidenceIds.length === 0 || evidenceIds.some((id) => !available.has(id))) throw new AlphionError("forbidden", "Agent Goal progress must cite stored Evidence from its Goal Session.", { stage: "goal" }); }
function collectEvidence(database: SqliteDatabase, sessionId: string): Set<string> { const values = new Set<string>(); for (const row of database.prepare("SELECT message_json FROM session_entries WHERE session_id = ?").all(sessionId).map(requiredRow)) { const value: unknown = JSON.parse(readString(row, "message_json")); if (!value || typeof value !== "object") continue; const item = value as Record<string, unknown>; if (item.kind === "observation" && item.evidence && typeof item.evidence === "object" && typeof (item.evidence as { id?: unknown }).id === "string") values.add((item.evidence as { id: string }).id); if (item.kind === "assistant" && Array.isArray(item.evidenceIds)) for (const id of item.evidenceIds) if (typeof id === "string") values.add(id); } return values; }

function makeGoalRevision(input: Omit<GoalRevision, "schemaVersion" | "digest">): GoalRevision { const base = { schemaVersion: 1 as const, ...input, acceptanceCriteria: stringList(input.acceptanceCriteria, 64, 2_000, "Acceptance criteria"), safetyConstraints: stringList(input.safetyConstraints, 64, 2_000, "Safety constraints"), subgoals: stringList(input.subgoals, 64, 2_000, "Subgoals"), blockers: stringList(input.blockers, 64, 2_000, "Blockers"), evidenceIds: stringList(input.evidenceIds, 128, 200, "Evidence IDs"), ...(input.nextStep ? { nextStep: boundedText(input.nextStep, 1, 4_000, "Next step") } : {}) }; return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) }); }
function validateGoalRoot(root: string, acceptance: readonly string[], safety: readonly string[]): void { boundedText(root, 1, 8_000, "Root Goal"); if (stringList(acceptance, 64, 2_000, "Acceptance criteria").length === 0) throw new AlphionError("validation", "A Goal requires at least one acceptance criterion.", { stage: "goal" }); stringList(safety, 64, 2_000, "Safety constraints"); }
function boundedText(value: string, minimum: number, maximum: number, label: string): string { const result = value.trim(); if (result.length < minimum || result.length > maximum || /\0/u.test(result)) throw new AlphionError("validation", `${label} must contain ${minimum}-${maximum} characters.`, { stage: "automation" }); return result; }
function stringList(value: readonly string[], limit: number, itemLimit: number, label: string): readonly string[] { if (!Array.isArray(value) || value.length > limit) throw new AlphionError("validation", `${label} exceeds its item limit.`, { stage: "automation" }); return Object.freeze(value.map((item) => boundedText(item, 1, itemLimit, label))); }
function requireProject(identity: AutomationIdentity): string { if (!identity.projectId) throw new AlphionError("forbidden", "Goals and schedules require an active Project.", { stage: "automation" }); return identity.projectId; }
function requireGoal(database: SqliteDatabase, id: string): GoalRecord { const value = getStoredGoal(database, id); if (!value) throw new AlphionError("validation", "Unknown Goal.", { stage: "goal" }); return value; }
function requireSchedule(database: SqliteDatabase, id: string): ScheduleRecord { const value = getStoredSchedule(database, id); if (!value) throw new AlphionError("validation", "Unknown schedule.", { stage: "scheduler" }); return value; }
function requireExecution(database: SqliteDatabase, id: string): ScheduleExecution { const row = optionalRow(database.prepare("SELECT * FROM schedule_executions WHERE id = ?").get(id)); if (!row) throw new AlphionError("validation", "Unknown schedule execution.", { stage: "scheduler" }); return decodeExecution(row); }
function decodeGoalRow(row: Record<string, unknown>): GoalRecord { const current = decodeGoalRevision(JSON.parse(readString(row, "revision_json"))); return Object.freeze({ schemaVersion: 1, id: readString(row, "id"), projectId: readString(row, "project_id"), domainId: readString(row, "domain_id"), sessionId: readString(row, "session_id"), title: readString(row, "title"), status: status(readString(row, "status"), ["active", "completed", "archived"], "Goal") as GoalRecord["status"], revision: readNumber(row, "current_revision"), current, createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at"), ...(readNullableString(row, "archived_at") ? { archivedAt: readString(row, "archived_at") } : {}) }); }
function decodeGoalRevision(value: unknown): GoalRevision { if (!value || typeof value !== "object" || Array.isArray(value)) throw corrupt("Goal revision"); const item = value as GoalRevision; if (item.schemaVersion !== 1 || typeof item.goalId !== "string" || !Number.isSafeInteger(item.revision) || typeof item.digest !== "string") throw corrupt("Goal revision"); return Object.freeze({ ...item, acceptanceCriteria: Object.freeze([...item.acceptanceCriteria]), safetyConstraints: Object.freeze([...item.safetyConstraints]), subgoals: Object.freeze([...item.subgoals]), blockers: Object.freeze([...item.blockers]), evidenceIds: Object.freeze([...item.evidenceIds]) }); }
function decodeSchedule(row: Record<string, unknown>): ScheduleRecord { const expression = JSON.parse(readString(row, "expression_json")) as ScheduleRecord["expression"]; const payload = JSON.parse(readString(row, "payload_json")) as ScheduleRecord["payload"]; return Object.freeze({ schemaVersion: 1, id: readString(row, "id"), projectId: readString(row, "project_id"), domainId: readString(row, "domain_id"), title: readString(row, "title"), expression, timezone: readString(row, "timezone"), payload, status: status(readString(row, "status"), ["active", "paused", "completed"], "Schedule") as ScheduleStatus, revision: readNumber(row, "revision"), ...(readNullableString(row, "next_run_at") ? { nextRunAt: readString(row, "next_run_at") } : {}), ...(readNullableString(row, "last_run_at") ? { lastRunAt: readString(row, "last_run_at") } : {}), createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at") }); }
function decodeExecution(row: Record<string, unknown>): ScheduleExecution { return Object.freeze({ schemaVersion: 1, id: readString(row, "id"), scheduleId: readString(row, "schedule_id"), dueAt: readString(row, "due_at"), status: status(readString(row, "status"), ["claimed", "running", "queued", "completed", "failed", "skipped"], "Schedule execution") as ScheduleExecutionStatus, ...(readNullableString(row, "lease_owner") ? { leaseOwner: readString(row, "lease_owner") } : {}), ...(readNullableString(row, "lease_expires_at") ? { leaseExpiresAt: readString(row, "lease_expires_at") } : {}), ...(readNullableString(row, "run_id") ? { runId: readString(row, "run_id") } : {}), missedCount: readNumber(row, "missed_count"), ...(readNullableString(row, "reason") ? { reason: readString(row, "reason") } : {}), createdAt: readString(row, "created_at"), updatedAt: readString(row, "updated_at") }); }
function status(value: string, allowed: readonly string[], label: string): string { if (!allowed.includes(value)) throw corrupt(`${label} status`); return value; }
function digestRequest(value: unknown): string { return sha256(canonicalJson(value)); }
function replayGoalCommand(database: SqliteDatabase, key: string, digest: string): GoalWriteReceipt | undefined { const row = optionalRow(database.prepare("SELECT request_digest, result_json FROM goal_commands WHERE idempotency_key = ?").get(key)); if (!row) return undefined; if (readString(row, "request_digest") !== digest) throw new AlphionError("conflict", "Goal idempotency key was reused with different input.", { stage: "goal" }); const result = JSON.parse(readString(row, "result_json")) as GoalWriteReceipt; return Object.freeze({ goal: result.goal, replayed: true }); }
function recordGoalCommand(database: SqliteDatabase, key: string, goalId: string, digest: string, result: unknown): void { database.prepare("INSERT INTO goal_commands (idempotency_key, goal_id, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)").run(key, goalId, digest, canonicalJson(result), new Date().toISOString()); }
function replayScheduleCommand(database: SqliteDatabase, key: string, digest: string): ScheduleRecord | undefined { const row = optionalRow(database.prepare("SELECT request_digest, result_json FROM schedule_commands WHERE idempotency_key = ?").get(key)); if (!row) return undefined; if (readString(row, "request_digest") !== digest) throw new AlphionError("conflict", "Schedule idempotency key was reused with different input.", { stage: "scheduler" }); const value = JSON.parse(readString(row, "result_json")) as ScheduleRecord | ScheduleClaim; return "schedule" in value ? value.schedule : value; }
function replayScheduleClaimCommand(database: SqliteDatabase, key: string, digest: string): ScheduleClaim | undefined { const row = optionalRow(database.prepare("SELECT request_digest, result_json FROM schedule_commands WHERE idempotency_key = ?").get(key)); if (!row) return undefined; if (readString(row, "request_digest") !== digest) throw new AlphionError("conflict", "Schedule idempotency key was reused with different input.", { stage: "scheduler" }); const value = JSON.parse(readString(row, "result_json")) as ScheduleClaim; return Object.freeze({ ...value, replayed: true }); }
function recordScheduleCommand(database: SqliteDatabase, key: string, id: string, digest: string, result: unknown): void { database.prepare("INSERT INTO schedule_commands (idempotency_key, schedule_id, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)").run(key, id, digest, canonicalJson(result), new Date().toISOString()); }
function corrupt(label: string): AlphionError { return new AlphionError("integrity-failed", `Stored ${label} is invalid.`, { stage: "database" }); }
