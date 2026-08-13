import type { AgentMessage, AgentSessionRecord, AgentShape, SessionEntry, SessionForkEntryMapping, SessionForkProvenance, SessionForkReceipt, SessionForkRequest } from "../../src/domain/contracts.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { reidentifySystemPromptPlan } from "../../src/application/system-prompt.js";
import type { SqliteDatabase } from "./database.js";
import { decodeSession, decodeSessionEntry, optionalRow, parseAgentShape, readString, requiredRow, validateIdempotencyKey } from "./sqlite-codecs.js";

export function forkStoredSession(database: SqliteDatabase, request: SessionForkRequest): SessionForkReceipt {
  validateRequest(request);
  const requestDigest = sha256(canonicalJson(request));
  const replay = optionalRow(database.prepare("SELECT * FROM session_forks WHERE idempotency_key = ?").get(request.idempotencyKey));
  if (replay) return replayFork(database, replay, requestDigest);
  const source = requireSession(database, request.sourceSessionId);
  assertForkable(source, request.expectedRevision);
  const sourceEntries = branchTo(database, source, request.sourceEntryId);
  const selectedSourceEntryId = sourceEntries.at(-1)?.id;
  const branchDigest = sha256(canonicalJson({ sourceSessionId: source.id, sourceRevision: source.revision, selectedSourceEntryId: selectedSourceEntryId ?? null, entries: sourceEntries.map((entry) => ({ id: entry.id, parentId: entry.parentId ?? null, messageDigest: sha256(canonicalJson(entry.message)) })) }));
  const sourceShape = requireShape(database, source);
  const targetSessionId = createId("session");
  const targetShape = reidentifyShape(sourceShape, targetSessionId);
  const now = new Date().toISOString();
  const provenance: SessionForkProvenance = Object.freeze({ schemaVersion: 1, sourceSessionId: source.id, ...(selectedSourceEntryId ? { sourceEntryId: selectedSourceEntryId } : {}), sourceRevision: source.revision, branchDigest, forkedAt: now });
  database.prepare(`INSERT INTO sessions
    (id, title, current_leaf_id, revision, status, active_run_id, lease_owner, lease_expires_at, provider_id, created_at, updated_at, audit_only, shape_status, shape_revision, shape_digest, domain_id, project_id, fork_source_session_id, fork_source_entry_id, fork_source_revision, fork_branch_digest, forked_at)
    VALUES (?, ?, NULL, 1, 'idle', NULL, NULL, NULL, ?, ?, ?, 0, 'shaped', 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(targetSessionId, cleanTitle(request.title, source.title), source.providerId ?? null, now, now, targetShape.digest, source.domainId, source.projectId ?? null, source.id, selectedSourceEntryId ?? null, source.revision, branchDigest, now);
  database.prepare("INSERT INTO session_shapes (session_id, shape_revision, shape_digest, shape_json, created_at, command_key) VALUES (?, 1, ?, ?, ?, ?)")
    .run(targetSessionId, targetShape.digest, canonicalJson(targetShape), now, request.idempotencyKey);
  const entryMapping = copyEntries(database, sourceEntries, targetSessionId);
  const targetLeafId = entryMapping.at(-1)?.targetEntryId;
  const auditEntryId = createId("entry");
  const auditMessage: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "system-event", id: createId("message"), createdAt: now, eventKind: "session.forked", content: `Forked from ${source.id} at revision ${source.revision}; provenance ${branchDigest}.` });
  database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)").run(auditEntryId, targetLeafId ?? null, targetSessionId, now, canonicalJson(auditMessage));
  database.prepare("UPDATE sessions SET current_leaf_id = ? WHERE id = ?").run(auditEntryId, targetSessionId);
  database.prepare("INSERT INTO session_forks (target_session_id, source_session_id, source_entry_id, source_revision, branch_digest, request_digest, idempotency_key, forked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(targetSessionId, source.id, selectedSourceEntryId ?? null, source.revision, branchDigest, requestDigest, request.idempotencyKey, now);
  const insertMapping = database.prepare("INSERT INTO session_fork_entries (target_session_id, ordinal, source_entry_id, target_entry_id) VALUES (?, ?, ?, ?)");
  entryMapping.forEach((item, ordinal) => insertMapping.run(targetSessionId, ordinal, item.sourceEntryId, item.targetEntryId));
  return Object.freeze({ session: requireSession(database, targetSessionId), provenance, entryMapping: Object.freeze(entryMapping), replayed: false });
}

function branchTo(database: SqliteDatabase, source: AgentSessionRecord, selectedEntryId: string | undefined): SessionEntry[] {
  const currentBranchIds = new Set<string>();
  let current = source.currentLeafId;
  while (current) {
    if (currentBranchIds.has(current)) throw new AlphionError("integrity-failed", "Session entry tree contains a cycle.", { stage: "database" });
    currentBranchIds.add(current);
    const row = optionalRow(database.prepare("SELECT parent_id FROM session_entries WHERE session_id = ? AND id = ?").get(source.id, current));
    if (!row) throw new AlphionError("integrity-failed", "Session current branch references a missing entry.", { stage: "database" });
    const parent = row.parent_id;
    current = typeof parent === "string" ? parent : undefined;
  }
  const leaf = selectedEntryId ?? source.currentLeafId;
  if (leaf && !currentBranchIds.has(leaf)) throw new AlphionError("validation", "Fork entry must belong to the current Session branch.", { stage: "session" });
  const reversed: SessionEntry[] = [];
  current = leaf;
  while (current) {
    const row = optionalRow(database.prepare("SELECT * FROM session_entries WHERE session_id = ? AND id = ?").get(source.id, current));
    if (!row) throw new AlphionError("integrity-failed", "Fork branch references a missing entry.", { stage: "database" });
    const entry = decodeSessionEntry(row);
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}

function copyEntries(database: SqliteDatabase, entries: readonly SessionEntry[], targetSessionId: string): SessionForkEntryMapping[] {
  const mapping = new Map(entries.map((entry) => [entry.id, createId("entry")]));
  const messageIds = new Map(entries.map((entry) => [entry.message.id, createId("message")]));
  const insert = database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)");
  const result: SessionForkEntryMapping[] = [];
  for (const entry of entries) {
    const targetEntryId = mapping.get(entry.id)!;
    const parentId = entry.parentId ? mapping.get(entry.parentId) : undefined;
    if (entry.parentId && !parentId) throw new AlphionError("integrity-failed", "Fork branch parent mapping is incomplete.", { stage: "database" });
    const message = remapMessage(entry.message, messageIds.get(entry.message.id)!, mapping);
    insert.run(targetEntryId, parentId ?? null, targetSessionId, entry.timestamp, canonicalJson(message));
    result.push(Object.freeze({ sourceEntryId: entry.id, targetEntryId }));
  }
  return result;
}

function remapMessage(message: AgentMessage, id: string, entries: ReadonlyMap<string, string>): AgentMessage {
  if (message.kind !== "memory") return Object.freeze({ ...message, id });
  const sourceEntryIds = message.sourceEntryIds.map((sourceId) => {
    const targetId = entries.get(sourceId);
    if (!targetId) throw new AlphionError("integrity-failed", "Memory references an entry outside the forked branch.", { stage: "database" });
    return targetId;
  });
  const base = { ...message, id, sourceEntryIds: Object.freeze(sourceEntryIds) };
  return Object.freeze({ ...base, digest: sha256(canonicalJson({ sourceEntryIds, summary: base.content })) });
}

function reidentifyShape(source: AgentShape, targetSessionId: string): AgentShape {
  const base = { ...source, sessionId: targetSessionId, revision: 1, systemPromptPlan: reidentifySystemPromptPlan(source.systemPromptPlan, targetSessionId) };
  const { digest: _digest, ...content } = base;
  return Object.freeze({ ...content, digest: sha256(canonicalJson(content)) });
}

function replayFork(database: SqliteDatabase, row: Readonly<Record<string, unknown>>, requestDigest: string): SessionForkReceipt {
  if (readString(row, "request_digest") !== requestDigest) throw new AlphionError("conflict", "Fork idempotency key was used with a different request.", { stage: "session" });
  const targetSessionId = readString(row, "target_session_id");
  const session = requireSession(database, targetSessionId);
  if (!session.forkProvenance) throw new AlphionError("integrity-failed", "Fork target is missing provenance.", { stage: "database" });
  const mapping = database.prepare("SELECT source_entry_id, target_entry_id FROM session_fork_entries WHERE target_session_id = ? ORDER BY ordinal").all(targetSessionId).map((value) => {
    const item = requiredRow(value);
    return Object.freeze({ sourceEntryId: readString(item, "source_entry_id"), targetEntryId: readString(item, "target_entry_id") });
  });
  return Object.freeze({ session, provenance: session.forkProvenance, entryMapping: Object.freeze(mapping), replayed: true });
}

function requireSession(database: SqliteDatabase, sessionId: string): AgentSessionRecord {
  const row = optionalRow(database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
  if (!row) throw new AlphionError("validation", `Unknown session: ${sessionId}`, { stage: "session" });
  return decodeSession(row);
}

function requireShape(database: SqliteDatabase, session: AgentSessionRecord): AgentShape {
  if (!session.shapeRevision || !session.shapeDigest) throw new AlphionError("integrity-failed", "Fork source is missing its shape identity.", { stage: "database" });
  const row = optionalRow(database.prepare("SELECT shape_json FROM session_shapes WHERE session_id = ? AND shape_revision = ? AND shape_digest = ?").get(session.id, session.shapeRevision, session.shapeDigest));
  if (!row) throw new AlphionError("integrity-failed", "Fork source shape cannot be resolved.", { stage: "database" });
  return parseAgentShape(readString(row, "shape_json"));
}

function assertForkable(source: AgentSessionRecord, expectedRevision: number): void {
  if (source.revision !== expectedRevision) throw new AlphionError("conflict", `Session revision changed; expected ${expectedRevision}, current ${source.revision}.`, { stage: "session" });
  if (source.auditOnly || source.status === "legacy-audit") throw new AlphionError("forbidden", "Legacy audit Sessions cannot be forked.", { stage: "session" });
  if (source.status !== "idle" || source.activeRunId) throw new AlphionError("conflict", "A Session can be forked only while idle.", { stage: "session" });
  if (source.shapeStatus !== "shaped") throw new AlphionError("conflict", "A Session must be shaped before it can be forked.", { stage: "shape" });
}

function validateRequest(request: SessionForkRequest): void {
  validateIdempotencyKey(request.idempotencyKey);
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new AlphionError("validation", "Expected revision must be a non-negative safe integer.", { stage: "session" });
  if (!request.sourceSessionId) throw new AlphionError("validation", "Fork source Session is required.", { stage: "session" });
  if (request.title !== undefined && (request.title.includes("\0") || request.title.length > 200)) throw new AlphionError("validation", "Fork title must be at most 200 safe characters.", { stage: "session" });
}

function cleanTitle(requested: string | undefined, source: string): string {
  return requested?.trim() || `${source}（分支）`;
}
