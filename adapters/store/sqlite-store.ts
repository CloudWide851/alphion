import type {
  AgentMessage, AgentSessionRecord, AgentShape, AgentShapeReceipt, PendingMessageKind,
  PendingSessionMessage, SessionForkReceipt, SessionForkRequest, SessionMessageReceipt, SessionMessageRequest, SessionView,
  SessionWriteOptions, SessionWriteReceipt,
} from "../../src/domain/contracts.js";
import type { SessionStore } from "../../src/ports/index.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { forkStoredSession } from "./sqlite-session-fork.js";
import {
  decodeCollaborationReceipt, decodePendingMessage, decodeSession, decodeSessionEntry,
  optionalRow, parseAgentShape, readNullableString, readNumber, readString, requiredRow,
  validateAgentMessage, validateAgentShape, validateIdempotencyKey,
} from "./sqlite-codecs.js";

export type { SqliteStoreOptions } from "./sqlite-store-base.js";

export class SqliteStore extends SqliteEventStore implements SessionStore {
  async forkSession(request: SessionForkRequest): Promise<SessionForkReceipt> {
    return this.transaction(() => forkStoredSession(this.database, request));
  }

  async createSession(input: Readonly<{ title: string; providerId?: string; idempotencyKey: string }>): Promise<AgentSessionRecord> {
    return this.transaction(() => {
      validateIdempotencyKey(input.idempotencyKey);
      const replay = optionalRow(this.database.prepare("SELECT result_json FROM session_commands WHERE idempotency_key = ?").get(input.idempotencyKey));
      if (replay) return decodeSession(requiredRow(JSON.parse(readString(replay, "result_json"))));
      const id = createId("session");
      const now = new Date().toISOString();
      this.database.prepare(
        "INSERT INTO sessions (id, title, current_leaf_id, revision, status, active_run_id, provider_id, created_at, updated_at, audit_only, domain_id, project_id) VALUES (?, ?, NULL, 0, 'idle', NULL, ?, ?, ?, 0, ?, ?)",
      ).run(id, input.title.trim() || "新会话", input.providerId ?? null, now, now, this.domainId, this.projectId ?? null);
      const session = this.requireSession(id);
      this.recordSessionCommand(input.idempotencyKey, id, session);
      return session;
    });
  }

  async listSessions(): Promise<readonly AgentSessionRecord[]> {
    return this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id").all().map((row) => decodeSession(requiredRow(row)));
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | undefined> {
    const row = optionalRow(this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
    return row ? decodeSession(row) : undefined;
  }

  async getSessionView(sessionId: string): Promise<SessionView | undefined> {
    const session = await this.getSession(sessionId);
    if (!session) return undefined;
    const reversed: SessionEntry[] = [];
    let entryId = session.currentLeafId;
    const seen = new Set<string>();
    while (entryId) {
      if (seen.has(entryId)) throw new AlphionError("integrity-failed", "Session entry tree contains a cycle.", { stage: "database" });
      seen.add(entryId);
      const row = optionalRow(this.database.prepare("SELECT * FROM session_entries WHERE id = ? AND session_id = ?").get(entryId, sessionId));
      if (!row) throw new AlphionError("integrity-failed", "Session leaf references a missing entry.", { stage: "database" });
      const entry = decodeSessionEntry(row);
      reversed.push(entry);
      entryId = entry.parentId;
    }
    return { session, entries: Object.freeze(reversed.reverse()) };
  }

  async getSessionShape(sessionId: string): Promise<AgentShape | undefined> {
    const session = this.requireSession(sessionId);
    if (!session.shapeRevision) return undefined;
    const row = optionalRow(this.database.prepare("SELECT shape_json FROM session_shapes WHERE session_id = ? AND shape_revision = ?").get(sessionId, session.shapeRevision));
    if (!row) throw new AlphionError("integrity-failed", "Session shape pointer references a missing shape.", { stage: "database" });
    return parseAgentShape(readString(row, "shape_json"));
  }

  async reshapeSession(sessionId: string, shape: AgentShape, options: SessionWriteOptions): Promise<AgentShapeReceipt> {
    return this.transaction(() => {
      validateIdempotencyKey(options.idempotencyKey);
      const replay = optionalRow(this.database.prepare("SELECT session_id, result_json FROM session_commands WHERE idempotency_key = ?").get(options.idempotencyKey));
      if (replay) {
        if (readString(replay, "session_id") !== sessionId) throw new AlphionError("conflict", "Idempotency key belongs to another session.", { stage: "session" });
        const result = requiredRow(JSON.parse(readString(replay, "result_json")));
        return { sessionId, revision: readNumber(result, "revision"), shapeRevision: readNumber(result, "shapeRevision"), shapeDigest: readString(result, "shapeDigest"), replayed: true };
      }
      const session = this.requireSession(sessionId);
      this.assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A Session can be reshaped only while idle.", { stage: "session" });
      validateAgentShape(shape);
      const expectedShapeRevision = (session.shapeRevision ?? 0) + 1;
      if (shape.sessionId !== sessionId || shape.revision !== expectedShapeRevision) throw new AlphionError("conflict", "Agent shape revision does not match the next Session shape revision.", { stage: "session" });
      const now = new Date().toISOString();
      this.database.prepare("INSERT INTO session_shapes (session_id, shape_revision, shape_digest, shape_json, created_at, command_key) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, shape.revision, shape.digest, canonicalJson(shape), now, options.idempotencyKey);
      const auditId = createId("entry");
      const auditMessage: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "system-event", id: createId("message"), createdAt: now, eventKind: "session.reshaped", content: `Agent shape revision ${shape.revision} selected (${shape.digest}).` });
      this.database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)")
        .run(auditId, session.currentLeafId ?? null, sessionId, now, canonicalJson(auditMessage));
      const revision = session.revision + 1;
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, shape_status = 'shaped', shape_revision = ?, shape_digest = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(auditId, shape.revision, shape.digest, revision, now, sessionId);
      const receipt: AgentShapeReceipt = { sessionId, revision, shapeRevision: shape.revision, shapeDigest: shape.digest, replayed: false };
      this.recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async appendSessionEntry(sessionId: string, message: AgentMessage, options: SessionWriteOptions, runId?: string): Promise<SessionWriteReceipt> {
    return this.transaction(() => {
      const replay = this.replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.requireSession(sessionId);
      this.assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      validateAgentMessage(message);
      const id = createId("entry");
      const timestamp = new Date().toISOString();
      this.database.prepare(
        "INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, session.currentLeafId ?? null, sessionId, runId ?? null, timestamp, canonicalJson(message));
      const revision = session.revision + 1;
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(id, revision, timestamp, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, entryId: id, replayed: false };
      this.recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async beginShapedSessionRun(sessionId: string, runId: string, message: Extract<AgentMessage, { readonly kind: "user" }>, initialShape: AgentShape | undefined, options: SessionWriteOptions): Promise<Readonly<{ receipt: SessionWriteReceipt; session: AgentSessionRecord; shape: AgentShape }>> {
    return this.transaction(() => {
      this.recoverExpiredLeases();
      const replay = this.replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) {
        const replayedSession = this.requireSession(sessionId);
        const replayedShape = this.requireSessionShape(replayedSession);
        return Object.freeze({ receipt: replay, session: replayedSession, shape: replayedShape });
      }
      const session = this.requireSession(sessionId);
      this.assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A run is already active for this session.", { stage: "session" });
      if (session.shapeStatus === "legacy-unshaped") throw new AlphionError("conflict", "This migrated Session must be explicitly reshaped before it can run.", { stage: "shape" });
      let shape: AgentShape;
      if (session.shapeStatus === "unshaped") {
        if (!initialShape) throw new AlphionError("validation", "Initial Agent shape is required for the first send.", { stage: "shape" });
        validateAgentShape(initialShape);
        if (initialShape.sessionId !== sessionId || initialShape.revision !== 1) throw new AlphionError("conflict", "Initial Agent shape identity is invalid.", { stage: "shape" });
        this.database.prepare("INSERT INTO session_shapes (session_id, shape_revision, shape_digest, shape_json, created_at, command_key) VALUES (?, 1, ?, ?, ?, ?)")
          .run(sessionId, initialShape.digest, canonicalJson(initialShape), new Date().toISOString(), options.idempotencyKey);
        shape = initialShape;
      } else {
        if (initialShape) throw new AlphionError("conflict", "A shaped Session cannot replace its shape during send.", { stage: "shape" });
        shape = this.requireSessionShape(session);
      }
      validateAgentMessage(message);
      const entryId = createId("entry");
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.runLeaseMs).toISOString();
      this.database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entryId, session.currentLeafId ?? null, sessionId, runId, now, canonicalJson(message));
      const revision = session.revision + 1;
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, status = 'running', active_run_id = ?, lease_owner = ?, lease_expires_at = ?, shape_status = 'shaped', shape_revision = ?, shape_digest = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(entryId, runId, this.ownerId, expiresAt, shape.revision, shape.digest, revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, entryId, replayed: false };
      this.recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return Object.freeze({ receipt, session: this.requireSession(sessionId), shape });
    });
  }

  async checkoutSession(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    return this.transaction(() => {
      const replay = this.replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.requireSession(sessionId);
      this.assertRevision(session, options.expectedRevision);
      if (session.status === "running" || session.auditOnly) throw new AlphionError("conflict", "This session cannot be checked out now.", { stage: "session" });
      if (entryId && !this.database.prepare("SELECT 1 FROM session_entries WHERE id = ? AND session_id = ?").get(entryId, sessionId)) {
        throw new AlphionError("validation", "Checkout entry does not belong to the session.", { stage: "session" });
      }
      const revision = session.revision + 1;
      const now = new Date().toISOString();
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(entryId ?? null, revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, ...(entryId ? { entryId } : {}), replayed: false };
      this.recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async enqueuePending(sessionId: string, kind: PendingMessageKind, message: Extract<AgentMessage, { readonly kind: "user" | "agent" }>, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    return this.transaction(() => {
      const replay = this.replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.requireSession(sessionId);
      this.assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (kind === "steer" && session.status !== "running") throw new AlphionError("conflict", "Steering requires an active run.", { stage: "session" });
      validateAgentMessage(message);
      const countRow = requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE session_id = ? AND kind = ?").get(sessionId, kind));
      if (readNumber(countRow, "count") >= 64) throw new AlphionError("budget-exceeded", `${kind} queue is full.`, { stage: "session" });
      const id = createId("pending");
      const now = new Date().toISOString();
      this.database.prepare("INSERT INTO pending_messages (id, session_id, kind, message_json, idempotency_key, created_at, claimed_run_id, claimed_at, claim_owner) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
        .run(id, sessionId, kind, canonicalJson(message), options.idempotencyKey, now);
      const revision = session.revision + 1;
      this.database.prepare("UPDATE sessions SET revision = ?, updated_at = ? WHERE id = ?").run(revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, pendingMessageId: id, replayed: false };
      this.recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async deliverSessionMessage(request: SessionMessageRequest): Promise<SessionMessageReceipt> {
    return this.transaction(() => {
      validateIdempotencyKey(request.idempotencyKey);
      const replay = optionalRow(this.database.prepare("SELECT * FROM collaboration_messages WHERE idempotency_key = ?").get(request.idempotencyKey));
      if (replay) return decodeCollaborationReceipt(replay, true);
      const source = this.requireSession(request.sourceSessionId);
      const target = this.requireSession(request.targetSessionId);
      if (source.domainId !== request.domainId || target.domainId !== request.domainId || request.domainId !== this.domainId) throw new AlphionError("forbidden", "Sessions in different Project domains cannot collaborate.", { stage: "session" });
      if (source.id === target.id) throw new AlphionError("validation", "Session collaboration target must be different from the source.", { stage: "session" });
      if (source.activeRunId !== request.sourceRunId || source.status !== "running") throw new AlphionError("conflict", "Source Run no longer owns its Session lease.", { stage: "session" });
      if (source.shapeDigest !== request.shapeDigest) throw new AlphionError("conflict", "Source shape identity changed.", { stage: "session" });
      if (target.auditOnly || target.shapeStatus !== "shaped") throw new AlphionError("forbidden", "Target Session is not available for collaboration.", { stage: "session" });
      if (!Number.isSafeInteger(request.hop) || request.hop < 1 || request.hop > 8) throw new AlphionError("budget-exceeded", "Session collaboration hop budget exceeded.", { stage: "session" });
      const content = request.content.trim();
      if (!content || content.length > 16_384) throw new AlphionError("validation", "Collaboration message must contain 1-16384 characters.", { stage: "session" });
      const budget = optionalRow(this.database.prepare("SELECT sent_count FROM collaboration_run_budgets WHERE source_run_id = ?").get(request.sourceRunId));
      const sentCount = budget ? readNumber(budget, "sent_count") : 0;
      if (sentCount >= 4) throw new AlphionError("budget-exceeded", "Per-Run Session collaboration budget exceeded.", { stage: "session" });
      const delivery = target.status === "running" ? "steer" : "follow-up";
      const queued = requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE session_id = ? AND kind = ?").get(target.id, delivery));
      if (readNumber(queued, "count") >= 64) throw new AlphionError("budget-exceeded", `${delivery} queue is full.`, { stage: "session" });
      const messageId = createId("agent-message");
      const now = new Date().toISOString();
      const message: Extract<AgentMessage, { readonly schemaVersion: 2; readonly kind: "agent" }> = Object.freeze({ schemaVersion: 2, kind: "agent", id: messageId, createdAt: now, sourceSessionId: source.id, targetSessionId: target.id, domainId: request.domainId, idempotencyKey: request.idempotencyKey, correlationId: request.correlationId, ...(request.causationId ? { causationId: request.causationId } : {}), hop: request.hop, delivery, content });
      validateAgentMessage(message);
      const sourceEntryId = createId("entry");
      this.database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)").run(sourceEntryId, source.currentLeafId ?? null, source.id, request.sourceRunId, now, canonicalJson(message));
      const sourceRevision = source.revision + 1;
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(sourceEntryId, sourceRevision, now, source.id);
      const targetEntryId = createId("entry");
      this.database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)").run(targetEntryId, target.currentLeafId ?? null, target.id, now, canonicalJson(message));
      const targetRevision = target.revision + 1;
      this.database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(targetEntryId, targetRevision, now, target.id);
      const pendingId = createId("pending");
      this.database.prepare("INSERT INTO pending_messages (id, session_id, kind, message_json, idempotency_key, created_at, claimed_run_id, claimed_at, claim_owner) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)").run(pendingId, target.id, delivery, canonicalJson(message), `delivery:${sha256(request.idempotencyKey)}`, now);
      this.database.prepare("INSERT INTO collaboration_messages (message_id, source_session_id, source_run_id, target_session_id, target_revision, domain_id, shape_digest, idempotency_key, correlation_id, causation_id, hop, delivery, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(messageId, source.id, request.sourceRunId, target.id, targetRevision, request.domainId, request.shapeDigest, request.idempotencyKey, request.correlationId, request.causationId ?? null, request.hop, delivery, sha256(content), now);
      this.database.prepare("INSERT INTO collaboration_run_budgets (source_run_id, sent_count) VALUES (?, 1) ON CONFLICT(source_run_id) DO UPDATE SET sent_count = sent_count + 1").run(request.sourceRunId);
      return Object.freeze({ messageId, sourceSessionId: source.id, targetSessionId: target.id, targetRevision, delivery, hop: request.hop, replayed: false });
    });
  }

  async drainPending(sessionId: string, kind: PendingMessageKind, runId: string): Promise<readonly PendingSessionMessage[]> {
    return this.transaction(() => {
      this.recoverExpiredLeases();
      this.requireSession(sessionId);
      const rows = this.database.prepare("SELECT * FROM pending_messages WHERE session_id = ? AND kind = ? AND claimed_run_id IS NULL ORDER BY created_at, id").all(sessionId, kind).map(requiredRow);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => readString(row, "id"));
      const now = new Date().toISOString();
      const update = this.database.prepare("UPDATE pending_messages SET claimed_run_id = ?, claimed_at = ?, claim_owner = ? WHERE id = ? AND claimed_run_id IS NULL");
      for (const id of ids) update.run(runId, now, this.ownerId, id);
      return Object.freeze(rows.map(decodePendingMessage));
    });
  }

  async acknowledgePending(sessionId: string, kind: PendingMessageKind, runId: string, pendingIds: readonly string[]): Promise<void> {
    this.transaction(() => {
      this.requireSession(sessionId);
      const remove = this.database.prepare("DELETE FROM pending_messages WHERE id = ? AND session_id = ? AND kind = ? AND claimed_run_id = ?");
      for (const id of pendingIds) {
        const result = remove.run(id, sessionId, kind, runId);
        if (Number(result.changes) !== 1) throw new AlphionError("conflict", "Pending-message claim is no longer owned by this run.", { stage: "session" });
      }
    });
  }

  async releasePendingClaims(sessionId: string, kind: PendingMessageKind, runId: string): Promise<void> {
    this.transaction(() => {
      this.requireSession(sessionId);
      this.database.prepare("UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL WHERE session_id = ? AND kind = ? AND claimed_run_id = ?").run(sessionId, kind, runId);
    });
  }

  async acquireRunLease(sessionId: string, runId: string, expectedRevision: number): Promise<AgentSessionRecord> {
    return this.transaction(() => {
      this.recoverExpiredLeases();
      const session = this.requireSession(sessionId);
      this.assertRevision(session, expectedRevision);
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A run is already active for this session.", { stage: "session" });
      if (session.shapeStatus !== "shaped") throw new AlphionError("conflict", "Session must be shaped before a queued follow-up can run.", { stage: "shape" });
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.runLeaseMs).toISOString();
      this.database.prepare("UPDATE sessions SET status = 'running', active_run_id = ?, lease_owner = ?, lease_expires_at = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(runId, this.ownerId, expiresAt, session.revision + 1, now, sessionId);
      return this.requireSession(sessionId);
    });
  }

  async releaseRunLease(sessionId: string, runId: string): Promise<AgentSessionRecord> {
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.activeRunId !== runId) throw new AlphionError("conflict", "Run lease does not match the active run.", { stage: "session" });
      const now = new Date().toISOString();
      this.database.prepare("UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, revision = ?, updated_at = ? WHERE id = ?")
        .run(session.revision + 1, now, sessionId);
      return this.requireSession(sessionId);
    });
  }

  private requireSession(sessionId: string): AgentSessionRecord {
    const row = optionalRow(this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
    if (!row) throw new AlphionError("validation", `Unknown session: ${sessionId}`, { stage: "session" });
    return decodeSession(row);
  }

  private requireSessionShape(session: AgentSessionRecord): AgentShape {
    if (!session.shapeRevision || !session.shapeDigest) throw new AlphionError("integrity-failed", "Shaped Session is missing its shape identity.", { stage: "database" });
    const row = optionalRow(this.database.prepare("SELECT shape_json FROM session_shapes WHERE session_id = ? AND shape_revision = ? AND shape_digest = ?").get(session.id, session.shapeRevision, session.shapeDigest));
    if (!row) throw new AlphionError("integrity-failed", "Session shape identity has no matching stored shape.", { stage: "database" });
    return parseAgentShape(readString(row, "shape_json"));
  }

  private assertRevision(session: AgentSessionRecord, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AlphionError("validation", "Expected revision must be a non-negative safe integer.", { stage: "session" });
    if (session.revision !== expectedRevision) throw new AlphionError("conflict", `Session revision changed; expected ${expectedRevision}, current ${session.revision}.`, { stage: "session" });
  }

  private recordSessionCommand(idempotencyKey: string, sessionId: string, result: unknown): void {
    validateIdempotencyKey(idempotencyKey);
    this.database.prepare("INSERT INTO session_commands (idempotency_key, session_id, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(idempotencyKey, sessionId, canonicalJson(result), new Date().toISOString());
  }

  private replayedReceipt(idempotencyKey: string, sessionId: string): SessionWriteReceipt | undefined {
    validateIdempotencyKey(idempotencyKey);
    const row = optionalRow(this.database.prepare("SELECT session_id, result_json FROM session_commands WHERE idempotency_key = ?").get(idempotencyKey));
    if (!row) return undefined;
    if (readString(row, "session_id") !== sessionId) throw new AlphionError("conflict", "Idempotency key belongs to another session.", { stage: "session" });
    const result = requiredRow(JSON.parse(readString(row, "result_json")));
    const revision = readNumber(result, "revision");
    const entryId = readNullableString(result, "entryId");
    const pendingMessageId = readNullableString(result, "pendingMessageId");
    return { sessionId, revision, ...(entryId ? { entryId } : {}), ...(pendingMessageId ? { pendingMessageId } : {}), replayed: true };
  }

}
