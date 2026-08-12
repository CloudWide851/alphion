import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./database.js";
import type { AgentMessage, AgentSessionRecord, AgentShape, AgentShapeReceipt, PendingMessageKind, PendingSessionMessage, ProviderProfile, ProviderProfileInput, SessionEntry, SessionMessageReceipt, SessionMessageRequest, SessionView, SessionWriteOptions, SessionWriteReceipt, ShellRule, VaultStatus } from "../../src/domain/contracts.js";
import type {
  CacheEntry,
  CacheStats,
  CacheStore,
  EventStore,
  ProviderProfileStore,
  SecretVault,
  SessionStore,
  ShellPolicyStore,
} from "../../src/ports/index.js";
import type { AgentEvent, AgentEventDraft } from "../../src/protocol/events.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret, sanitizeRecord } from "../../src/application/sensitive-data.js";
import { resolveProviderEndpoint, validateProviderPreset } from "../model/provider-catalog.js";

const SCHEMA_VERSION = 5;
const VAULT_SCHEMA_VERSION = 1;
const VAULT_AUTO_LOCK_MS = 15 * 60 * 1000;
const VAULT_VERIFIER = "alphion-vault-verifier-v1";
const SCRYPT_OPTIONS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const OPEN_DATABASES = new Set<string>();
const DEFAULT_RUN_LEASE_MS = 2 * 60 * 1000;

export interface SqliteStoreOptions {
  readonly path: string;
  readonly domainId?: string;
  readonly projectId?: string;
  readonly vaultAutoLockMs?: number;
  readonly runLeaseMs?: number;
}

export class SqliteStore
  implements EventStore, CacheStore, ProviderProfileStore, SecretVault, ShellPolicyStore, SessionStore
{
  readonly #database: SqliteDatabase;
  readonly #databaseKey: string;
  readonly #databasePath: string;
  readonly #ownerId = createId("store");
  readonly #runLeaseMs: number;
  readonly #domainId: string;
  readonly #projectId: string | undefined;
  #leaseHeartbeat: NodeJS.Timeout | undefined;
  #closed = false;
  #vaultKey: Buffer | undefined;
  #vaultLastActivity = 0;
  #vaultLockTimer: NodeJS.Timeout | undefined;
  readonly #vaultAutoLockMs: number;

  constructor(options: SqliteStoreOptions) {
    const databasePath = resolve(options.path);
    this.#databasePath = databasePath;
    this.#databaseKey = pathKey(databasePath);
    this.#domainId = options.domainId ?? `domain_${sha256(pathKey(databasePath)).slice(0, 32)}`;
    this.#projectId = options.projectId;
    this.#vaultAutoLockMs = options.vaultAutoLockMs ?? VAULT_AUTO_LOCK_MS;
    this.#runLeaseMs = options.runLeaseMs ?? DEFAULT_RUN_LEASE_MS;
    if (!Number.isSafeInteger(this.#vaultAutoLockMs) || this.#vaultAutoLockMs <= 0) {
      throw new AlphionError("validation", "Vault auto-lock duration must be a positive safe integer.", { stage: "vault" });
    }
    if (!Number.isSafeInteger(this.#runLeaseMs) || this.#runLeaseMs < 1_000 || this.#runLeaseMs > 24 * 60 * 60 * 1000) {
      throw new AlphionError("validation", "Run lease duration must be between one second and 24 hours.", { stage: "session" });
    }
    if (OPEN_DATABASES.has(this.#databaseKey)) {
      throw new AlphionError("conflict", "This process already has a writer open for the SQLite state file.", {
        stage: "database",
      });
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    let database: SqliteDatabase | undefined;
    OPEN_DATABASES.add(this.#databaseKey);
    try {
      database = openSqliteDatabase(databasePath);
      this.#database = database;
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      this.#assertIntegrity();
      this.#migrate();
      this.#reconcileSessionSchemaV5();
      this.#registerOwnerAndRecover();
      this.#leaseHeartbeat = setInterval(() => this.#heartbeatOwner(), Math.max(500, Math.floor(this.#runLeaseMs / 3)));
      this.#leaseHeartbeat.unref();
    } catch (error) {
      database?.close();
      OPEN_DATABASES.delete(this.#databaseKey);
      if (error instanceof AlphionError) throw error;
      throw new AlphionError("integrity-failed", "SQLite state could not be opened or validated.", {
        stage: "database",
        cause: error,
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#leaseHeartbeat) clearInterval(this.#leaseHeartbeat);
    this.#leaseHeartbeat = undefined;
    try { this.#retireOwner(); } catch { /* Closing still releases the local handle. Expiry remains the crash fallback. */ }
    try { this.#database.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* Checkpoint is maintenance-only; close still releases the handle. */ }
    this.lock();
    this.#database.close();
    OPEN_DATABASES.delete(this.#databaseKey);
  }

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    const event = this.#transaction(() => {
      const safePayload = sanitizeRecord(draft.payload);
      const previousRow = this.#database
        .prepare("SELECT sequence, digest FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(draft.runId);
      const previous = optionalRow(previousRow);
      const sequence = previous ? readNumber(previous, "sequence") + 1 : 1;
      const sessionRow = requiredRow(this.#database.prepare("SELECT COALESCE(MAX(session_sequence), 0) AS sequence FROM events WHERE session_id = ?").get(draft.sessionId));
      const sessionSequence = readNumber(sessionRow, "sequence") + 1;
      const previousDigest = previous ? readString(previous, "digest") : "0".repeat(64);
      const eventId = createId("event");
      const timestamp = new Date().toISOString();
      const digest = sha256(
        canonicalJson({
          schemaVersion: 2,
          eventId,
          sequence,
          sessionSequence,
          runId: draft.runId,
          sessionId: draft.sessionId,
          correlationId: draft.correlationId,
          ...(draft.causationId ? { causationId: draft.causationId } : {}),
          timestamp,
          kind: draft.kind,
          payload: safePayload,
          previousDigest,
        }),
      );
      const event: AgentEvent = {
        schemaVersion: 2,
        eventId,
        sequence,
        sessionSequence,
        runId: draft.runId,
        sessionId: draft.sessionId,
        correlationId: draft.correlationId,
        ...(draft.causationId ? { causationId: draft.causationId } : {}),
        timestamp,
        kind: draft.kind,
        payload: safePayload,
        previousDigest,
        digest,
      };
      if (event.kind === "run.started") {
        const shapeRevision = typeof safePayload.shapeRevision === "number" ? safePayload.shapeRevision : null;
        const shapeDigest = typeof safePayload.shapeDigest === "string" ? safePayload.shapeDigest : null;
        this.#database
          .prepare(
            "INSERT INTO runs (run_id, session_id, status, created_at, updated_at, shape_revision, shape_digest) VALUES (?, ?, 'running', ?, ?, ?, ?)",
          )
          .run(event.runId, event.sessionId, event.timestamp, event.timestamp, shapeRevision, shapeDigest);
      }
      this.#database
        .prepare(
          `INSERT INTO events
           (run_id, sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
        )
        .run(
          event.runId,
          event.sequence,
          event.eventId,
          event.sessionId,
          event.correlationId,
          event.causationId ?? null,
          event.timestamp,
          event.kind,
          JSON.stringify(event.payload),
          event.previousDigest,
          event.digest,
          event.sessionSequence ?? 0,
        );
      if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.cancelled") {
        const status = event.kind.slice("run.".length);
        this.#database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, event.timestamp, event.runId);
      }
      return event;
    });
    return event;
  }

  async verifyRun(runId: string): Promise<boolean> {
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence
         FROM events WHERE run_id = ? ORDER BY sequence`,
      )
      .all(runId);
    let expectedSequence = 1;
    let previousDigest = "0".repeat(64);
    for (const value of rows) {
      const row = requiredRow(value);
      const sequence = readNumber(row, "sequence");
      if (sequence !== expectedSequence || readString(row, "previous_digest") !== previousDigest) return false;
      const payload = parseRecord(readString(row, "payload_json"));
      const schemaVersion = readNumber(row, "schema_version");
      const eventShape = {
        schemaVersion,
        eventId: readString(row, "event_id"),
        sequence,
        ...(schemaVersion === 2 ? { sessionSequence: readNumber(row, "session_sequence") } : {}),
        runId,
        sessionId: readString(row, "session_id"),
        correlationId: readString(row, "correlation_id"),
        ...(readNullableString(row, "causation_id") ? { causationId: readNullableString(row, "causation_id") } : {}),
        timestamp: readString(row, "timestamp"),
        kind: readString(row, "kind"),
        payload,
        previousDigest,
      };
      const digest = sha256(canonicalJson(eventShape));
      if (digest !== readString(row, "digest")) return false;
      previousDigest = digest;
      expectedSequence += 1;
    }
    return rows.length > 0;
  }

  async listSessionEvents(sessionId: string, afterSessionSequence = 0): Promise<readonly AgentEvent[]> {
    if (!Number.isSafeInteger(afterSessionSequence) || afterSessionSequence < 0) throw new AlphionError("validation", "Event replay cursor must be a non-negative safe integer.", { stage: "events" });
    const rows = this.#database.prepare(
      `SELECT run_id, sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence
       FROM events WHERE session_id = ? AND (session_sequence IS NULL OR session_sequence > ?) ORDER BY COALESCE(session_sequence, 0), timestamp, run_id, sequence`,
    ).all(sessionId, afterSessionSequence).map(requiredRow);
    return Object.freeze(rows.map(decodeAgentEvent));
  }

  async createSession(input: Readonly<{ title: string; providerId?: string; idempotencyKey: string }>): Promise<AgentSessionRecord> {
    return this.#transaction(() => {
      validateIdempotencyKey(input.idempotencyKey);
      const replay = optionalRow(this.#database.prepare("SELECT result_json FROM session_commands WHERE idempotency_key = ?").get(input.idempotencyKey));
      if (replay) return decodeSession(requiredRow(JSON.parse(readString(replay, "result_json"))));
      const id = createId("session");
      const now = new Date().toISOString();
      this.#database.prepare(
        "INSERT INTO sessions (id, title, current_leaf_id, revision, status, active_run_id, provider_id, created_at, updated_at, audit_only, domain_id, project_id) VALUES (?, ?, NULL, 0, 'idle', NULL, ?, ?, ?, 0, ?, ?)",
      ).run(id, input.title.trim() || "新会话", input.providerId ?? null, now, now, this.#domainId, this.#projectId ?? null);
      const session = this.#requireSession(id);
      this.#recordSessionCommand(input.idempotencyKey, id, session);
      return session;
    });
  }

  async listSessions(): Promise<readonly AgentSessionRecord[]> {
    return this.#database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id").all().map((row) => decodeSession(requiredRow(row)));
  }

  async getSession(sessionId: string): Promise<AgentSessionRecord | undefined> {
    const row = optionalRow(this.#database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
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
      const row = optionalRow(this.#database.prepare("SELECT * FROM session_entries WHERE id = ? AND session_id = ?").get(entryId, sessionId));
      if (!row) throw new AlphionError("integrity-failed", "Session leaf references a missing entry.", { stage: "database" });
      const entry = decodeSessionEntry(row);
      reversed.push(entry);
      entryId = entry.parentId;
    }
    return { session, entries: Object.freeze(reversed.reverse()) };
  }

  async getSessionShape(sessionId: string): Promise<AgentShape | undefined> {
    const session = this.#requireSession(sessionId);
    if (!session.shapeRevision) return undefined;
    const row = optionalRow(this.#database.prepare("SELECT shape_json FROM session_shapes WHERE session_id = ? AND shape_revision = ?").get(sessionId, session.shapeRevision));
    if (!row) throw new AlphionError("integrity-failed", "Session shape pointer references a missing shape.", { stage: "database" });
    return parseAgentShape(readString(row, "shape_json"));
  }

  async reshapeSession(sessionId: string, shape: AgentShape, options: SessionWriteOptions): Promise<AgentShapeReceipt> {
    return this.#transaction(() => {
      validateIdempotencyKey(options.idempotencyKey);
      const replay = optionalRow(this.#database.prepare("SELECT session_id, result_json FROM session_commands WHERE idempotency_key = ?").get(options.idempotencyKey));
      if (replay) {
        if (readString(replay, "session_id") !== sessionId) throw new AlphionError("conflict", "Idempotency key belongs to another session.", { stage: "session" });
        const result = requiredRow(JSON.parse(readString(replay, "result_json")));
        return { sessionId, revision: readNumber(result, "revision"), shapeRevision: readNumber(result, "shapeRevision"), shapeDigest: readString(result, "shapeDigest"), replayed: true };
      }
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A Session can be reshaped only while idle.", { stage: "session" });
      validateAgentShape(shape);
      const expectedShapeRevision = (session.shapeRevision ?? 0) + 1;
      if (shape.sessionId !== sessionId || shape.revision !== expectedShapeRevision) throw new AlphionError("conflict", "Agent shape revision does not match the next Session shape revision.", { stage: "session" });
      const now = new Date().toISOString();
      this.#database.prepare("INSERT INTO session_shapes (session_id, shape_revision, shape_digest, shape_json, created_at, command_key) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, shape.revision, shape.digest, canonicalJson(shape), now, options.idempotencyKey);
      const auditId = createId("entry");
      const auditMessage: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "system-event", id: createId("message"), createdAt: now, eventKind: "session.reshaped", content: `Agent shape revision ${shape.revision} selected (${shape.digest}).` });
      this.#database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)")
        .run(auditId, session.currentLeafId ?? null, sessionId, now, canonicalJson(auditMessage));
      const revision = session.revision + 1;
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, shape_status = 'shaped', shape_revision = ?, shape_digest = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(auditId, shape.revision, shape.digest, revision, now, sessionId);
      const receipt: AgentShapeReceipt = { sessionId, revision, shapeRevision: shape.revision, shapeDigest: shape.digest, replayed: false };
      this.#recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async appendSessionEntry(sessionId: string, message: AgentMessage, options: SessionWriteOptions, runId?: string): Promise<SessionWriteReceipt> {
    return this.#transaction(() => {
      const replay = this.#replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      validateAgentMessage(message);
      const id = createId("entry");
      const timestamp = new Date().toISOString();
      this.#database.prepare(
        "INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, session.currentLeafId ?? null, sessionId, runId ?? null, timestamp, canonicalJson(message));
      const revision = session.revision + 1;
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(id, revision, timestamp, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, entryId: id, replayed: false };
      this.#recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async beginShapedSessionRun(sessionId: string, runId: string, message: Extract<AgentMessage, { readonly kind: "user" }>, initialShape: AgentShape | undefined, options: SessionWriteOptions): Promise<Readonly<{ receipt: SessionWriteReceipt; session: AgentSessionRecord; shape: AgentShape }>> {
    return this.#transaction(() => {
      this.#recoverExpiredLeases();
      const replay = this.#replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) {
        const replayedSession = this.#requireSession(sessionId);
        const replayedShape = this.#requireSessionShape(replayedSession);
        return Object.freeze({ receipt: replay, session: replayedSession, shape: replayedShape });
      }
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A run is already active for this session.", { stage: "session" });
      if (session.shapeStatus === "legacy-unshaped") throw new AlphionError("conflict", "This migrated Session must be explicitly reshaped before it can run.", { stage: "shape" });
      let shape: AgentShape;
      if (session.shapeStatus === "unshaped") {
        if (!initialShape) throw new AlphionError("validation", "Initial Agent shape is required for the first send.", { stage: "shape" });
        validateAgentShape(initialShape);
        if (initialShape.sessionId !== sessionId || initialShape.revision !== 1) throw new AlphionError("conflict", "Initial Agent shape identity is invalid.", { stage: "shape" });
        this.#database.prepare("INSERT INTO session_shapes (session_id, shape_revision, shape_digest, shape_json, created_at, command_key) VALUES (?, 1, ?, ?, ?, ?)")
          .run(sessionId, initialShape.digest, canonicalJson(initialShape), new Date().toISOString(), options.idempotencyKey);
        shape = initialShape;
      } else {
        if (initialShape) throw new AlphionError("conflict", "A shaped Session cannot replace its shape during send.", { stage: "shape" });
        shape = this.#requireSessionShape(session);
      }
      validateAgentMessage(message);
      const entryId = createId("entry");
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.#runLeaseMs).toISOString();
      this.#database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(entryId, session.currentLeafId ?? null, sessionId, runId, now, canonicalJson(message));
      const revision = session.revision + 1;
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, status = 'running', active_run_id = ?, lease_owner = ?, lease_expires_at = ?, shape_status = 'shaped', shape_revision = ?, shape_digest = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(entryId, runId, this.#ownerId, expiresAt, shape.revision, shape.digest, revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, entryId, replayed: false };
      this.#recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return Object.freeze({ receipt, session: this.#requireSession(sessionId), shape });
    });
  }

  async checkoutSession(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    return this.#transaction(() => {
      const replay = this.#replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, options.expectedRevision);
      if (session.status === "running" || session.auditOnly) throw new AlphionError("conflict", "This session cannot be checked out now.", { stage: "session" });
      if (entryId && !this.#database.prepare("SELECT 1 FROM session_entries WHERE id = ? AND session_id = ?").get(entryId, sessionId)) {
        throw new AlphionError("validation", "Checkout entry does not belong to the session.", { stage: "session" });
      }
      const revision = session.revision + 1;
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(entryId ?? null, revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, ...(entryId ? { entryId } : {}), replayed: false };
      this.#recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async enqueuePending(sessionId: string, kind: PendingMessageKind, message: Extract<AgentMessage, { readonly kind: "user" | "agent" }>, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    return this.#transaction(() => {
      const replay = this.#replayedReceipt(options.idempotencyKey, sessionId);
      if (replay) return replay;
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, options.expectedRevision);
      if (session.auditOnly) throw new AlphionError("forbidden", "Legacy audit sessions are read-only.", { stage: "session" });
      if (kind === "steer" && session.status !== "running") throw new AlphionError("conflict", "Steering requires an active run.", { stage: "session" });
      validateAgentMessage(message);
      const countRow = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE session_id = ? AND kind = ?").get(sessionId, kind));
      if (readNumber(countRow, "count") >= 64) throw new AlphionError("budget-exceeded", `${kind} queue is full.`, { stage: "session" });
      const id = createId("pending");
      const now = new Date().toISOString();
      this.#database.prepare("INSERT INTO pending_messages (id, session_id, kind, message_json, idempotency_key, created_at, claimed_run_id, claimed_at, claim_owner) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
        .run(id, sessionId, kind, canonicalJson(message), options.idempotencyKey, now);
      const revision = session.revision + 1;
      this.#database.prepare("UPDATE sessions SET revision = ?, updated_at = ? WHERE id = ?").run(revision, now, sessionId);
      const receipt: SessionWriteReceipt = { sessionId, revision, pendingMessageId: id, replayed: false };
      this.#recordSessionCommand(options.idempotencyKey, sessionId, receipt);
      return receipt;
    });
  }

  async deliverSessionMessage(request: SessionMessageRequest): Promise<SessionMessageReceipt> {
    return this.#transaction(() => {
      validateIdempotencyKey(request.idempotencyKey);
      const replay = optionalRow(this.#database.prepare("SELECT * FROM collaboration_messages WHERE idempotency_key = ?").get(request.idempotencyKey));
      if (replay) return decodeCollaborationReceipt(replay, true);
      const source = this.#requireSession(request.sourceSessionId);
      const target = this.#requireSession(request.targetSessionId);
      if (source.domainId !== request.domainId || target.domainId !== request.domainId || request.domainId !== this.#domainId) throw new AlphionError("forbidden", "Sessions in different Project domains cannot collaborate.", { stage: "session" });
      if (source.id === target.id) throw new AlphionError("validation", "Session collaboration target must be different from the source.", { stage: "session" });
      if (source.activeRunId !== request.sourceRunId || source.status !== "running") throw new AlphionError("conflict", "Source Run no longer owns its Session lease.", { stage: "session" });
      if (source.shapeDigest !== request.shapeDigest) throw new AlphionError("conflict", "Source shape identity changed.", { stage: "session" });
      if (target.auditOnly || target.shapeStatus !== "shaped") throw new AlphionError("forbidden", "Target Session is not available for collaboration.", { stage: "session" });
      if (!Number.isSafeInteger(request.hop) || request.hop < 1 || request.hop > 8) throw new AlphionError("budget-exceeded", "Session collaboration hop budget exceeded.", { stage: "session" });
      const content = request.content.trim();
      if (!content || content.length > 16_384) throw new AlphionError("validation", "Collaboration message must contain 1-16384 characters.", { stage: "session" });
      const budget = optionalRow(this.#database.prepare("SELECT sent_count FROM collaboration_run_budgets WHERE source_run_id = ?").get(request.sourceRunId));
      const sentCount = budget ? readNumber(budget, "sent_count") : 0;
      if (sentCount >= 4) throw new AlphionError("budget-exceeded", "Per-Run Session collaboration budget exceeded.", { stage: "session" });
      const delivery = target.status === "running" ? "steer" : "follow-up";
      const queued = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE session_id = ? AND kind = ?").get(target.id, delivery));
      if (readNumber(queued, "count") >= 64) throw new AlphionError("budget-exceeded", `${delivery} queue is full.`, { stage: "session" });
      const messageId = createId("agent-message");
      const now = new Date().toISOString();
      const message: Extract<AgentMessage, { readonly schemaVersion: 2; readonly kind: "agent" }> = Object.freeze({ schemaVersion: 2, kind: "agent", id: messageId, createdAt: now, sourceSessionId: source.id, targetSessionId: target.id, domainId: request.domainId, idempotencyKey: request.idempotencyKey, correlationId: request.correlationId, ...(request.causationId ? { causationId: request.causationId } : {}), hop: request.hop, delivery, content });
      validateAgentMessage(message);
      const sourceEntryId = createId("entry");
      this.#database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, ?, ?, ?)").run(sourceEntryId, source.currentLeafId ?? null, source.id, request.sourceRunId, now, canonicalJson(message));
      const sourceRevision = source.revision + 1;
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(sourceEntryId, sourceRevision, now, source.id);
      const targetEntryId = createId("entry");
      this.#database.prepare("INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json) VALUES (?, ?, ?, NULL, ?, ?)").run(targetEntryId, target.currentLeafId ?? null, target.id, now, canonicalJson(message));
      const targetRevision = target.revision + 1;
      this.#database.prepare("UPDATE sessions SET current_leaf_id = ?, revision = ?, updated_at = ? WHERE id = ?").run(targetEntryId, targetRevision, now, target.id);
      const pendingId = createId("pending");
      this.#database.prepare("INSERT INTO pending_messages (id, session_id, kind, message_json, idempotency_key, created_at, claimed_run_id, claimed_at, claim_owner) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)").run(pendingId, target.id, delivery, canonicalJson(message), `delivery:${sha256(request.idempotencyKey)}`, now);
      this.#database.prepare("INSERT INTO collaboration_messages (message_id, source_session_id, source_run_id, target_session_id, target_revision, domain_id, shape_digest, idempotency_key, correlation_id, causation_id, hop, delivery, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(messageId, source.id, request.sourceRunId, target.id, targetRevision, request.domainId, request.shapeDigest, request.idempotencyKey, request.correlationId, request.causationId ?? null, request.hop, delivery, sha256(content), now);
      this.#database.prepare("INSERT INTO collaboration_run_budgets (source_run_id, sent_count) VALUES (?, 1) ON CONFLICT(source_run_id) DO UPDATE SET sent_count = sent_count + 1").run(request.sourceRunId);
      return Object.freeze({ messageId, sourceSessionId: source.id, targetSessionId: target.id, targetRevision, delivery, hop: request.hop, replayed: false });
    });
  }

  async drainPending(sessionId: string, kind: PendingMessageKind, runId: string): Promise<readonly PendingSessionMessage[]> {
    return this.#transaction(() => {
      this.#recoverExpiredLeases();
      this.#requireSession(sessionId);
      const rows = this.#database.prepare("SELECT * FROM pending_messages WHERE session_id = ? AND kind = ? AND claimed_run_id IS NULL ORDER BY created_at, id").all(sessionId, kind).map(requiredRow);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => readString(row, "id"));
      const now = new Date().toISOString();
      const update = this.#database.prepare("UPDATE pending_messages SET claimed_run_id = ?, claimed_at = ?, claim_owner = ? WHERE id = ? AND claimed_run_id IS NULL");
      for (const id of ids) update.run(runId, now, this.#ownerId, id);
      return Object.freeze(rows.map(decodePendingMessage));
    });
  }

  async acknowledgePending(sessionId: string, kind: PendingMessageKind, runId: string, pendingIds: readonly string[]): Promise<void> {
    this.#transaction(() => {
      this.#requireSession(sessionId);
      const remove = this.#database.prepare("DELETE FROM pending_messages WHERE id = ? AND session_id = ? AND kind = ? AND claimed_run_id = ?");
      for (const id of pendingIds) {
        const result = remove.run(id, sessionId, kind, runId);
        if (Number(result.changes) !== 1) throw new AlphionError("conflict", "Pending-message claim is no longer owned by this run.", { stage: "session" });
      }
    });
  }

  async releasePendingClaims(sessionId: string, kind: PendingMessageKind, runId: string): Promise<void> {
    this.#transaction(() => {
      this.#requireSession(sessionId);
      this.#database.prepare("UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL WHERE session_id = ? AND kind = ? AND claimed_run_id = ?").run(sessionId, kind, runId);
    });
  }

  async acquireRunLease(sessionId: string, runId: string, expectedRevision: number): Promise<AgentSessionRecord> {
    return this.#transaction(() => {
      this.#recoverExpiredLeases();
      const session = this.#requireSession(sessionId);
      this.#assertRevision(session, expectedRevision);
      if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A run is already active for this session.", { stage: "session" });
      if (session.shapeStatus !== "shaped") throw new AlphionError("conflict", "Session must be shaped before a queued follow-up can run.", { stage: "shape" });
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.#runLeaseMs).toISOString();
      this.#database.prepare("UPDATE sessions SET status = 'running', active_run_id = ?, lease_owner = ?, lease_expires_at = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(runId, this.#ownerId, expiresAt, session.revision + 1, now, sessionId);
      return this.#requireSession(sessionId);
    });
  }

  async releaseRunLease(sessionId: string, runId: string): Promise<AgentSessionRecord> {
    return this.#transaction(() => {
      const session = this.#requireSession(sessionId);
      if (session.activeRunId !== runId) throw new AlphionError("conflict", "Run lease does not match the active run.", { stage: "session" });
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, revision = ?, updated_at = ? WHERE id = ?")
        .run(session.revision + 1, now, sessionId);
      return this.#requireSession(sessionId);
    });
  }

  async upsertProfile(
    input: ProviderProfileInput,
  ): Promise<ProviderProfile> {
    const normalized = validateProviderProfile(input);
    const profile = this.#transaction(() => {
      const existing = optionalRow(this.#database.prepare("SELECT revision, active FROM provider_profiles WHERE id = ?").get(input.id));
      const revision = existing ? readNumber(existing, "revision") + 1 : 1;
      const active = input.active ?? (existing ? readNumber(existing, "active") === 1 : false);
      if (input.auth.mode === "encrypted-sqlite") {
        const secret = optionalRow(
          this.#database
            .prepare("SELECT profile_id FROM vault_secrets WHERE secret_id = ?")
            .get(input.auth.secretId),
        );
        if (!secret || readString(secret, "profile_id") !== input.id) {
          throw new AlphionError("validation", "Vault credential reference does not belong to this profile.", {
            stage: "config",
          });
        }
      }
      if (active) this.#database.exec("UPDATE provider_profiles SET active = 0");
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO provider_profiles
           (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             provider_kind = excluded.provider_kind,
             base_url = excluded.base_url,
             model = excluded.model,
             protocol = excluded.protocol,
             auth_mode = excluded.auth_mode,
             auth_environment_variable = excluded.auth_environment_variable,
             auth_secret_id = excluded.auth_secret_id,
             capabilities_json = excluded.capabilities_json,
             revision = excluded.revision,
             active = excluded.active,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.name,
          input.kind,
          normalized.baseUrl,
          input.model,
          input.protocol,
          input.auth.mode,
          input.auth.mode === "bearer-env" ? input.auth.environmentVariable : null,
          input.auth.mode === "encrypted-sqlite" ? input.auth.secretId : null,
          JSON.stringify(input.capabilities),
          revision,
          active ? 1 : 0,
          now,
          now,
        );
      return this.#getProfile(input.id);
    });
    return profile;
  }

  async listProfiles(): Promise<readonly ProviderProfile[]> {
    const rows = this.#database.prepare("SELECT * FROM provider_profiles ORDER BY active DESC, name").all();
    return rows.map((row) => decodeProviderProfile(requiredRow(row)));
  }

  async getProfile(idOrName: string): Promise<ProviderProfile | undefined> {
    const row = optionalRow(
      this.#database.prepare("SELECT * FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
    );
    return row ? decodeProviderProfile(row) : undefined;
  }

  async getActiveProfile(): Promise<ProviderProfile | undefined> {
    const row = optionalRow(this.#database.prepare("SELECT * FROM provider_profiles WHERE active = 1 LIMIT 1").get());
    return row ? decodeProviderProfile(row) : undefined;
  }

  async activateProfile(idOrName: string): Promise<ProviderProfile> {
    const profile = this.#transaction(() => {
      const found = optionalRow(
        this.#database.prepare("SELECT id FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
      );
      if (!found) throw new AlphionError("validation", `Unknown provider profile: ${idOrName}`, { stage: "config" });
      const id = readString(found, "id");
      this.#database.exec("UPDATE provider_profiles SET active = 0");
      this.#database.prepare("UPDATE provider_profiles SET active = 1, revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return this.#getProfile(id);
    });
    return profile;
  }

  async status(): Promise<VaultStatus> {
    this.#expireVaultIfNeeded();
    const initialized = optionalRow(this.#database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get()) !== undefined;
    const count = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    return {
      initialized,
      locked: this.#vaultKey === undefined,
      secretCount: readNumber(count, "count"),
      autoLockMs: this.#vaultAutoLockMs,
    };
  }

  async initialize(masterPassword: string): Promise<void> {
    validateMasterPassword(masterPassword);
    if (optionalRow(this.#database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get())) {
      throw new AlphionError("conflict", "Credential vault is already initialized.", { stage: "vault" });
    }
    const salt = randomBytes(16);
    const key = deriveVaultKey(masterPassword, salt);
    const verifier = encryptValue(key, Buffer.from(VAULT_VERIFIER), vaultVerifierAad());
    try {
      this.#transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO vault_metadata
             (id, schema_version, kdf, salt, work_factor, block_size, parallelism, verifier_nonce, verifier_ciphertext, verifier_tag, created_at, updated_at)
             VALUES (1, ?, 'scrypt', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            VAULT_SCHEMA_VERSION,
            salt,
            SCRYPT_OPTIONS.N,
            SCRYPT_OPTIONS.r,
            SCRYPT_OPTIONS.p,
            verifier.nonce,
            verifier.ciphertext,
            verifier.authTag,
            new Date().toISOString(),
            new Date().toISOString(),
          );
      });
      this.#setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  async unlock(masterPassword: string): Promise<void> {
    const metadata = this.#readVaultMetadata();
    const key = deriveVaultKey(masterPassword, metadata.salt);
    try {
      const verifier = decryptValue(
        key,
        metadata.verifierNonce,
        metadata.verifierCiphertext,
        metadata.verifierTag,
        vaultVerifierAad(),
      );
      if (verifier.toString("utf8") !== VAULT_VERIFIER) {
        throw new Error("Vault verifier mismatch.");
      }
      this.#setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw new AlphionError("forbidden", "Credential vault could not be unlocked.", { stage: "vault", cause: error });
    }
  }

  lock(): void {
    if (this.#vaultLockTimer) clearTimeout(this.#vaultLockTimer);
    this.#vaultLockTimer = undefined;
    this.#vaultLastActivity = 0;
    this.#vaultKey?.fill(0);
    this.#vaultKey = undefined;
  }

  async resolve(reference: string): Promise<string | undefined> {
    if (!/^vault_[A-Za-z0-9_-]{8,}$/.test(reference)) return undefined;
    const key = this.#requireVaultKey();
    const row = optionalRow(
      this.#database
        .prepare("SELECT secret_id, profile_id, revision, nonce, ciphertext, auth_tag FROM vault_secrets WHERE secret_id = ?")
        .get(reference),
    );
    if (!row) return undefined;
    try {
      const plaintext = decryptValue(
        key,
        readBuffer(row, "nonce"),
        readBuffer(row, "ciphertext"),
        readBuffer(row, "auth_tag"),
        secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
      );
      this.#touchVault();
      return plaintext.toString("utf8");
    } catch (error) {
      throw new AlphionError("integrity-failed", "Encrypted credential failed authentication.", {
        stage: "vault",
        cause: error,
      });
    }
  }

  async importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    if (secret.length === 0 || secret.length > 16_384 || secret.includes("\0")) {
      throw new AlphionError("validation", "Credential must be between 1 and 16384 characters.", { stage: "vault" });
    }
    const key = this.#requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    const existing = optionalRow(
      this.#database.prepare("SELECT secret_id, revision FROM vault_secrets WHERE profile_id = ?").get(profile.id),
    );
    const secretId = existing ? readString(existing, "secret_id") : createId("vault");
    const secretRevision = existing ? readNumber(existing, "revision") + 1 : 1;
    const encrypted = encryptValue(
      key,
      Buffer.from(secret, "utf8"),
      secretAad(secretId, profile.id, secretRevision),
    );
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database
        .prepare(
          `INSERT INTO vault_secrets
           (secret_id, profile_id, revision, nonce, ciphertext, auth_tag, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET
             secret_id = excluded.secret_id,
             revision = excluded.revision,
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             auth_tag = excluded.auth_tag,
             updated_at = excluded.updated_at`,
        )
        .run(secretId, profile.id, secretRevision, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, now);
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'encrypted-sqlite', auth_environment_variable = NULL, auth_secret_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(secretId, now, profile.id);
    });
    this.#touchVault();
    return this.#getProfile(profile.id);
  }

  async removeCredential(profileId: string): Promise<ProviderProfile> {
    this.#requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM vault_secrets WHERE profile_id = ?").run(profile.id);
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), profile.id);
    });
    this.#touchVault();
    return this.#getProfile(profile.id);
  }

  async rotateMasterPassword(currentPassword: string, nextPassword: string): Promise<void> {
    validateMasterPassword(nextPassword);
    const metadata = this.#readVaultMetadata();
    const currentKey = deriveVaultKey(currentPassword, metadata.salt);
    const rows = this.#database
      .prepare("SELECT secret_id, profile_id, revision, nonce, ciphertext, auth_tag FROM vault_secrets ORDER BY secret_id")
      .all()
      .map(requiredRow);
    try {
      const verifier = decryptValue(
        currentKey,
        metadata.verifierNonce,
        metadata.verifierCiphertext,
        metadata.verifierTag,
        vaultVerifierAad(),
      );
      if (verifier.toString("utf8") !== VAULT_VERIFIER) throw new Error("Vault verifier mismatch.");
      const plaintext = rows.map((row) => ({
        row,
        value: decryptValue(
          currentKey,
          readBuffer(row, "nonce"),
          readBuffer(row, "ciphertext"),
          readBuffer(row, "auth_tag"),
          secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
        ),
      }));
      const nextSalt = randomBytes(16);
      const nextKey = deriveVaultKey(nextPassword, nextSalt);
      try {
        const nextVerifier = encryptValue(nextKey, Buffer.from(VAULT_VERIFIER), vaultVerifierAad());
        const encrypted = plaintext.map(({ row, value }) => ({
          secretId: readString(row, "secret_id"),
          value: encryptValue(
            nextKey,
            value,
            secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
          ),
        }));
        this.#transaction(() => {
          this.#database
            .prepare(
              `UPDATE vault_metadata
               SET salt = ?, work_factor = ?, block_size = ?, parallelism = ?, verifier_nonce = ?, verifier_ciphertext = ?, verifier_tag = ?, updated_at = ?
               WHERE id = 1`,
            )
            .run(
              nextSalt,
              SCRYPT_OPTIONS.N,
              SCRYPT_OPTIONS.r,
              SCRYPT_OPTIONS.p,
              nextVerifier.nonce,
              nextVerifier.ciphertext,
              nextVerifier.authTag,
              new Date().toISOString(),
            );
          const update = this.#database.prepare(
            "UPDATE vault_secrets SET nonce = ?, ciphertext = ?, auth_tag = ?, updated_at = ? WHERE secret_id = ?",
          );
          for (const item of encrypted) {
            update.run(item.value.nonce, item.value.ciphertext, item.value.authTag, new Date().toISOString(), item.secretId);
          }
        });
        this.#setVaultKey(nextKey);
      } catch (error) {
        nextKey.fill(0);
        throw error;
      } finally {
        for (const item of plaintext) item.value.fill(0);
      }
    } catch (error) {
      throw error instanceof AlphionError
        ? error
        : new AlphionError("forbidden", "Credential vault password rotation failed.", { stage: "vault", cause: error });
    } finally {
      currentKey.fill(0);
    }
  }

  async reset(): Promise<number> {
    const count = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    const deleted = readNumber(count, "count");
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare("DELETE FROM vault_secrets").run();
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE auth_mode = 'encrypted-sqlite'`,
        )
        .run(now);
      this.#database.prepare("DELETE FROM vault_metadata WHERE id = 1").run();
    });
    this.lock();
    return deleted;
  }

  async get(namespace: string, key: string): Promise<CacheEntry | undefined> {
    const row = optionalRow(
      this.#database.prepare("SELECT * FROM cache_entries WHERE namespace = ? AND cache_key = ?").get(namespace, key),
    );
    if (!row || Date.parse(readString(row, "expires_at")) <= Date.now()) {
      if (row) this.#database.prepare("DELETE FROM cache_entries WHERE namespace = ? AND cache_key = ?").run(namespace, key);
      this.#database.prepare("UPDATE cache_metrics SET misses = misses + 1 WHERE id = 1").run();
      return undefined;
    }
    this.#database
      .prepare("UPDATE cache_entries SET hit_count = hit_count + 1, last_accessed_at = ? WHERE namespace = ? AND cache_key = ?")
      .run(new Date().toISOString(), namespace, key);
    this.#database.prepare("UPDATE cache_metrics SET hits = hits + 1 WHERE id = 1").run();
    return decodeCacheEntry(row);
  }

  async set(entry: CacheEntry): Promise<void> {
    if (containsPotentialSecret(entry.value) || containsPotentialSecret(entry.provenance)) {
      throw new AlphionError("forbidden", "Potential secrets cannot be written to persistent cache.", { stage: "cache" });
    }
    const bytes = Buffer.byteLength(entry.value) + Buffer.byteLength(entry.provenance);
    this.#database
      .prepare(
        `INSERT INTO cache_entries
         (namespace, cache_key, value_text, created_at, expires_at, provenance, size_bytes, hit_count, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(namespace, cache_key) DO UPDATE SET
           value_text = excluded.value_text,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           provenance = excluded.provenance,
           size_bytes = excluded.size_bytes,
           hit_count = 0,
           last_accessed_at = excluded.last_accessed_at`,
      )
      .run(
        entry.namespace,
        entry.key,
        entry.value,
        entry.createdAt,
        entry.expiresAt,
        entry.provenance,
        bytes,
        entry.createdAt,
      );
    this.#pruneCache();
  }

  async delete(namespace?: string): Promise<number> {
    const result = namespace
      ? this.#database.prepare("DELETE FROM cache_entries WHERE namespace = ?").run(namespace)
      : this.#database.prepare("DELETE FROM cache_entries").run();
    return Number(result.changes);
  }

  async stats(): Promise<CacheStats> {
    const aggregate = requiredRow(
      this.#database.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get(),
    );
    const metrics = requiredRow(this.#database.prepare("SELECT hits, misses FROM cache_metrics WHERE id = 1").get());
    return {
      entries: readNumber(aggregate, "entries"),
      bytes: readNumber(aggregate, "bytes"),
      hits: readNumber(metrics, "hits"),
      misses: readNumber(metrics, "misses"),
    };
  }

  async addShellRule(input: Omit<ShellRule, "schemaVersion" | "id" | "enabled">): Promise<ShellRule> {
    if (!isAbsolute(input.executablePath)) {
      throw new AlphionError("validation", "Shell policy executable paths must be absolute.", { stage: "config" });
    }
    if (
      input.argumentPrefix.length > 128 ||
      !input.argumentPrefix.every((argument) => typeof argument === "string" && !argument.includes("\0")) ||
      (input.executableDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.executableDigest))
    ) {
      throw new AlphionError("validation", "Shell policy digest or argument prefix is invalid.", { stage: "config" });
    }
    const executablePath = await realpath(resolve(input.executablePath)).catch((error: unknown) => {
      throw new AlphionError("validation", "Shell policy executable does not exist.", { stage: "config", cause: error });
    });
    if (!(await stat(executablePath)).isFile()) {
      throw new AlphionError("validation", "Shell policy executable must be a regular file.", { stage: "config" });
    }
    const id = createId("shell_rule");
    this.#database
      .prepare(
        `INSERT INTO shell_rules
         (id, executable_path, executable_key, executable_digest, argument_prefix_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        executablePath,
        pathKey(executablePath),
        input.executableDigest ?? null,
        JSON.stringify(input.argumentPrefix),
        new Date().toISOString(),
      );
    return { schemaVersion: 1, id, executablePath, ...(input.executableDigest ? { executableDigest: input.executableDigest } : {}), argumentPrefix: input.argumentPrefix, enabled: true };
  }

  listShellRules(): readonly ShellRule[] {
    return this.#database.prepare("SELECT * FROM shell_rules ORDER BY created_at").all().map((row) => decodeShellRule(requiredRow(row)));
  }

  async removeShellRule(id: string): Promise<boolean> {
    const result = this.#database.prepare("DELETE FROM shell_rules WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async findAllowed(executablePath: string, args: readonly string[]): Promise<ShellRule | undefined> {
    const resolvedExecutable = await realpath(resolve(executablePath)).catch(() => undefined);
    if (!resolvedExecutable) return undefined;
    const rows = this.#database
      .prepare("SELECT * FROM shell_rules WHERE executable_key = ? AND enabled = 1 ORDER BY created_at")
      .all(pathKey(resolvedExecutable));
    for (const row of rows) {
      const rule = decodeShellRule(requiredRow(row));
      if (rule.argumentPrefix.every((argument, index) => args[index] === argument)) return rule;
    }
    return undefined;
  }

  #getProfile(id: string): ProviderProfile {
    const row = optionalRow(this.#database.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id));
    if (!row) throw new AlphionError("internal", "Provider profile disappeared during transaction.", { stage: "database" });
    return decodeProviderProfile(row);
  }

  #readVaultMetadata(): VaultMetadata {
    const row = optionalRow(this.#database.prepare("SELECT * FROM vault_metadata WHERE id = 1").get());
    if (!row) throw new AlphionError("conflict", "Credential vault is not initialized.", { stage: "vault" });
    if (
      readNumber(row, "schema_version") !== VAULT_SCHEMA_VERSION ||
      readString(row, "kdf") !== "scrypt" ||
      readNumber(row, "work_factor") !== SCRYPT_OPTIONS.N ||
      readNumber(row, "block_size") !== SCRYPT_OPTIONS.r ||
      readNumber(row, "parallelism") !== SCRYPT_OPTIONS.p
    ) {
      throw new AlphionError("incompatible-schema", "Credential vault parameters are unsupported.", { stage: "vault" });
    }
    return {
      salt: readBuffer(row, "salt"),
      verifierNonce: readBuffer(row, "verifier_nonce"),
      verifierCiphertext: readBuffer(row, "verifier_ciphertext"),
      verifierTag: readBuffer(row, "verifier_tag"),
    };
  }

  #requireVaultKey(): Buffer {
    this.#expireVaultIfNeeded();
    if (!this.#vaultKey) {
      throw new AlphionError("forbidden", "Credential vault is locked.", { stage: "vault" });
    }
    this.#touchVault();
    return this.#vaultKey;
  }

  #setVaultKey(key: Buffer): void {
    this.lock();
    this.#vaultKey = key;
    this.#touchVault();
  }

  #touchVault(): void {
    if (!this.#vaultKey) return;
    this.#vaultLastActivity = Date.now();
    if (this.#vaultLockTimer) clearTimeout(this.#vaultLockTimer);
    this.#vaultLockTimer = setTimeout(() => this.lock(), this.#vaultAutoLockMs);
    this.#vaultLockTimer.unref();
  }

  #expireVaultIfNeeded(): void {
    if (this.#vaultKey && Date.now() - this.#vaultLastActivity >= this.#vaultAutoLockMs) this.lock();
  }

  #migrate(): void {
    const row = requiredRow(this.#database.prepare("PRAGMA user_version").get());
    const current = readNumber(row, "user_version");
    if (current > SCHEMA_VERSION) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} is newer than supported ${SCHEMA_VERSION}.`, {
        stage: "database",
      });
    }
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      this.#transaction(() => {
        this.#createSchemaV2();
        this.#createSessionSchemaV3();
        this.#createShapeSchemaV4(false);
        this.#createProjectSessionSchemaV5();
      });
      return;
    }
    if (current === 2) {
      this.#backupV2();
      this.#transaction(() => { this.#createSessionSchemaV3(); this.#createShapeSchemaV4(false); this.#createProjectSessionSchemaV5(); });
      return;
    }
    if (current === 3) {
      this.#backupV3();
      this.#transaction(() => { this.#createShapeSchemaV4(true); this.#createProjectSessionSchemaV5(); });
      return;
    }
    if (current === 4) {
      this.#backupSchema(4, `${this.#databasePath}.v4-backup`);
      this.#transaction(() => this.#createProjectSessionSchemaV5());
      return;
    }
    if (current !== 1) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} cannot be migrated.`, { stage: "database" });
    }
    this.#transaction(() => {
      this.#database.exec(`
        DROP INDEX provider_profiles_one_active;
        ALTER TABLE provider_profiles RENAME TO provider_profiles_v1;
      `);
      this.#createProviderProfilesV2();
      const rows = this.#database.prepare("SELECT * FROM provider_profiles_v1 ORDER BY id").all().map(requiredRow);
      const insert = this.#database.prepare(
        `INSERT INTO provider_profiles
         (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
         VALUES (?, ?, 'custom-openai-compatible', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const capabilities = parseRecord(readString(row, "capabilities_json"));
        insert.run(
          readString(row, "id"),
          readString(row, "name"),
          readString(row, "base_url"),
          readString(row, "model"),
          readString(row, "protocol"),
          readString(row, "auth_mode"),
          readNullableString(row, "auth_environment_variable") ?? null,
          JSON.stringify({
            streaming: readBoolean(capabilities, "streaming"),
            tools: readBoolean(capabilities, "tools"),
            promptCaching: readBoolean(capabilities, "promptCaching"),
            reasoning: false,
          }),
          readNumber(row, "revision"),
          readNumber(row, "active"),
          readString(row, "created_at"),
          readString(row, "updated_at"),
        );
      }
      this.#database.exec("DROP TABLE provider_profiles_v1");
      this.#createVaultTables();
      this.#database.exec("PRAGMA user_version = 2");
      this.#createSessionSchemaV3();
      this.#createShapeSchemaV4(false);
      this.#createProjectSessionSchemaV5();
    });
  }

  #createSchemaV2(): void {
    this.#createProviderProfilesV2();
    this.#database.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_digest TEXT NOT NULL,
          digest TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
        CREATE TABLE cache_entries (
          namespace TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          value_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          provenance TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          hit_count INTEGER NOT NULL,
          last_accessed_at TEXT NOT NULL,
          PRIMARY KEY (namespace, cache_key)
        );
        CREATE INDEX cache_entries_lru ON cache_entries(last_accessed_at);
        CREATE TABLE cache_metrics (id INTEGER PRIMARY KEY CHECK (id = 1), hits INTEGER NOT NULL, misses INTEGER NOT NULL);
        INSERT INTO cache_metrics (id, hits, misses) VALUES (1, 0, 0);
        CREATE TABLE shell_rules (
          id TEXT PRIMARY KEY,
          executable_path TEXT NOT NULL,
          executable_key TEXT NOT NULL,
          executable_digest TEXT,
          argument_prefix_json TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL
        );
        CREATE INDEX shell_rules_lookup ON shell_rules(executable_key, enabled);
    `);
    this.#createVaultTables();
    this.#database.exec("PRAGMA user_version = 2");
  }

  #backupV2(): void {
    if (this.#databasePath === ":memory:") return;
    const backupPath = `${this.#databasePath}.v2-backup`;
    const sourceDigest = logicalDatabaseDigest(this.#database);
    if (existsSync(backupPath)) {
      const existing = openSqliteDatabase(backupPath, { readOnly: true });
      try {
        assertDatabaseHealthy(existing, "Existing v2 backup failed its integrity check.");
        const row = requiredRow(existing.prepare("PRAGMA user_version").get());
        if (readNumber(row, "user_version") !== 2) throw new AlphionError("conflict", "Existing v2 backup is not a schema-v2 database.", { stage: "database" });
        if (logicalDatabaseDigest(existing) !== sourceDigest) throw new AlphionError("conflict", "Existing v2 backup does not match the database being migrated.", { stage: "database" });
      } finally {
        existing.close();
      }
      return;
    }
    this.#database.exec("PRAGMA wal_checkpoint(FULL)");
    this.#database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    const backup = openSqliteDatabase(backupPath, { readOnly: true });
    try {
      assertDatabaseHealthy(backup, "Created v2 backup failed its integrity check.");
      const version = readNumber(requiredRow(backup.prepare("PRAGMA user_version").get()), "user_version");
      if (version !== 2 || logicalDatabaseDigest(backup) !== sourceDigest) throw new AlphionError("integrity-failed", "Created v2 backup is not a recoverable logical snapshot.", { stage: "database" });
    } finally { backup.close(); }
  }

  #backupV3(): void { this.#backupSchema(3, `${this.#databasePath}.v3-backup`); }

  #backupSchema(version: number, backupPath: string): void {
    if (this.#databasePath === ":memory:") return;
    const sourceDigest = logicalDatabaseDigest(this.#database);
    if (existsSync(backupPath)) {
      const existing = openSqliteDatabase(backupPath, { readOnly: true });
      try {
        assertDatabaseHealthy(existing, `Existing v${version} backup failed its integrity check.`);
        if (readNumber(requiredRow(existing.prepare("PRAGMA user_version").get()), "user_version") !== version || logicalDatabaseDigest(existing) !== sourceDigest) throw new AlphionError("conflict", `Existing v${version} backup does not match the database being migrated.`, { stage: "database" });
      } finally { existing.close(); }
      return;
    }
    this.#database.exec("PRAGMA wal_checkpoint(FULL)");
    this.#database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    const backup = openSqliteDatabase(backupPath, { readOnly: true });
    try {
      assertDatabaseHealthy(backup, `Created v${version} backup failed its integrity check.`);
      if (readNumber(requiredRow(backup.prepare("PRAGMA user_version").get()), "user_version") !== version || logicalDatabaseDigest(backup) !== sourceDigest) throw new AlphionError("integrity-failed", `Created v${version} backup is not a recoverable snapshot.`, { stage: "database" });
    } finally { backup.close(); }
  }

  #createSessionSchemaV3(): void {
    this.#database.exec(`
      ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE events ADD COLUMN session_sequence INTEGER;
      CREATE UNIQUE INDEX events_session_sequence ON events(session_id, session_sequence) WHERE session_sequence IS NOT NULL;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        current_leaf_id TEXT,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'legacy-audit')),
        active_run_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        provider_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        audit_only INTEGER NOT NULL CHECK (audit_only IN (0, 1))
      );
      CREATE TABLE session_entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES session_entries(id),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        message_json TEXT NOT NULL
      );
      CREATE INDEX session_entries_session ON session_entries(session_id, timestamp, id);
      CREATE TABLE pending_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow-up')),
        message_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        claimed_run_id TEXT
        ,claimed_at TEXT
        ,claim_owner TEXT
      );
      CREATE INDEX pending_messages_fifo ON pending_messages(session_id, kind, created_at, id);
      CREATE TABLE session_commands (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE session_owners (
        owner_id TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      INSERT INTO sessions (id, title, current_leaf_id, revision, status, active_run_id, provider_id, created_at, updated_at, audit_only)
      SELECT DISTINCT session_id, '旧版审计 ' || substr(session_id, 1, 12), NULL, 0, 'legacy-audit', NULL, NULL,
        MIN(timestamp), MAX(timestamp), 1 FROM events GROUP BY session_id;
      PRAGMA user_version = 3;
    `);
  }

  #createShapeSchemaV4(migratingV3: boolean): void {
    this.#database.exec(`
      ALTER TABLE sessions ADD COLUMN shape_status TEXT NOT NULL DEFAULT '${migratingV3 ? "legacy-unshaped" : "unshaped"}' CHECK (shape_status IN ('unshaped', 'shaped', 'legacy-unshaped'));
      ALTER TABLE sessions ADD COLUMN shape_revision INTEGER;
      ALTER TABLE sessions ADD COLUMN shape_digest TEXT;
      ALTER TABLE runs ADD COLUMN shape_revision INTEGER;
      ALTER TABLE runs ADD COLUMN shape_digest TEXT;
      CREATE TABLE session_shapes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        shape_revision INTEGER NOT NULL,
        shape_digest TEXT NOT NULL,
        shape_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        command_key TEXT NOT NULL UNIQUE,
        PRIMARY KEY (session_id, shape_revision),
        UNIQUE (session_id, shape_digest)
      );
      CREATE INDEX session_shapes_digest ON session_shapes(shape_digest);
      UPDATE sessions SET shape_status = 'legacy-unshaped' WHERE audit_only = 1;
      PRAGMA user_version = 4;
    `);
  }

  #createProjectSessionSchemaV5(): void {
    this.#migrateProviderProfilesV5();
    const sessionColumns = tableColumns(this.#database, "sessions");
    if (!sessionColumns.has("domain_id")) this.#database.exec("ALTER TABLE sessions ADD COLUMN domain_id TEXT");
    if (!sessionColumns.has("project_id")) this.#database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
    this.#database.prepare("UPDATE sessions SET domain_id = ? WHERE domain_id IS NULL").run(this.#domainId);
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS sessions_domain ON sessions(domain_id, updated_at, id);
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL REFERENCES sessions(id),
        source_run_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL REFERENCES sessions(id),
        target_revision INTEGER NOT NULL,
        domain_id TEXT NOT NULL,
        shape_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        hop INTEGER NOT NULL CHECK (hop BETWEEN 1 AND 8),
        delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'follow-up')),
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collaboration_target ON collaboration_messages(target_session_id, created_at, message_id);
      CREATE TABLE IF NOT EXISTS collaboration_run_budgets (
        source_run_id TEXT PRIMARY KEY,
        sent_count INTEGER NOT NULL CHECK (sent_count BETWEEN 0 AND 4)
      );
      PRAGMA user_version = 5;
    `);
  }

  #migrateProviderProfilesV5(): void {
    const schemaRow = optionalRow(this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'provider_profiles'").get());
    const sql = schemaRow ? readString(schemaRow, "sql") : "";
    if (sql.includes("custom-openai-compatible") && sql.includes("kimi") && sql.includes("qwen") && sql.includes("glm")) return;
    this.#database.exec(`
      DROP INDEX IF EXISTS provider_profiles_one_active;
      ALTER TABLE vault_secrets RENAME TO vault_secrets_v4;
      ALTER TABLE provider_profiles RENAME TO provider_profiles_v4;
    `);
    this.#createProviderProfilesV2();
    const rows = this.#database.prepare("SELECT * FROM provider_profiles_v4 ORDER BY id").all().map(requiredRow);
    const insert = this.#database.prepare(`INSERT INTO provider_profiles
      (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      const previousKind = readString(row, "provider_kind");
      const previousUrl = readString(row, "base_url").replace(/\/$/u, "");
      const deepSeekOfficial = previousKind === "deepseek" && previousUrl === "https://api.deepseek.com";
      insert.run(
        readString(row, "id"), readString(row, "name"),
        deepSeekOfficial ? "deepseek" : "custom-openai-compatible",
        deepSeekOfficial ? "deepseek" : previousUrl,
        readString(row, "model"), readString(row, "protocol"), readString(row, "auth_mode"),
        readNullableString(row, "auth_environment_variable") ?? null, readNullableString(row, "auth_secret_id") ?? null,
        readString(row, "capabilities_json"), readNumber(row, "revision"), readNumber(row, "active"),
        readString(row, "created_at"), readString(row, "updated_at"),
      );
    }
    this.#database.exec(`
      CREATE TABLE vault_secrets (
        secret_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO vault_secrets SELECT * FROM vault_secrets_v4;
      DROP TABLE vault_secrets_v4;
      DROP TABLE provider_profiles_v4;
    `);
  }

  #reconcileSessionSchemaV5(): void {
    const sessionColumns = tableColumns(this.#database, "sessions");
    const pendingColumns = tableColumns(this.#database, "pending_messages");
    this.#transaction(() => {
      this.#migrateProviderProfilesV5();
      if (!sessionColumns.has("lease_owner")) this.#database.exec("ALTER TABLE sessions ADD COLUMN lease_owner TEXT");
      if (!sessionColumns.has("lease_expires_at")) this.#database.exec("ALTER TABLE sessions ADD COLUMN lease_expires_at TEXT");
      if (!pendingColumns.has("claimed_at")) this.#database.exec("ALTER TABLE pending_messages ADD COLUMN claimed_at TEXT");
      if (!pendingColumns.has("claim_owner")) this.#database.exec("ALTER TABLE pending_messages ADD COLUMN claim_owner TEXT");
      this.#database.exec("CREATE TABLE IF NOT EXISTS session_owners (owner_id TEXT PRIMARY KEY, expires_at TEXT NOT NULL)");
      if (!sessionColumns.has("domain_id")) this.#database.exec("ALTER TABLE sessions ADD COLUMN domain_id TEXT");
      if (!sessionColumns.has("project_id")) this.#database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
      this.#database.prepare("UPDATE sessions SET domain_id = ? WHERE domain_id IS NULL").run(this.#domainId);
    });
  }

  #registerOwnerAndRecover(): void {
    this.#transaction(() => {
      const expiresAt = new Date(Date.now() + this.#runLeaseMs).toISOString();
      this.#database.prepare("INSERT INTO session_owners (owner_id, expires_at) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET expires_at = excluded.expires_at").run(this.#ownerId, expiresAt);
      this.#recoverExpiredLeases();
    });
  }

  #heartbeatOwner(): void {
    if (this.#closed) return;
    try {
      this.#transaction(() => {
        const expiresAt = new Date(Date.now() + this.#runLeaseMs).toISOString();
        this.#database.prepare("UPDATE session_owners SET expires_at = ? WHERE owner_id = ?").run(expiresAt, this.#ownerId);
        this.#database.prepare("UPDATE sessions SET lease_expires_at = ? WHERE lease_owner = ? AND status = 'running'").run(expiresAt, this.#ownerId);
      });
    } catch { /* A busy peer cannot make an existing bounded lease immortal. */ }
  }

  #retireOwner(): void {
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare("UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL WHERE claim_owner = ?").run(this.#ownerId);
      this.#database.prepare("UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE lease_owner = ? AND status = 'running'").run(now, this.#ownerId);
      this.#database.prepare("DELETE FROM session_owners WHERE owner_id = ?").run(this.#ownerId);
    });
  }

  #recoverExpiredLeases(): void {
    const now = new Date().toISOString();
    this.#database.prepare("DELETE FROM session_owners WHERE expires_at <= ?").run(now);
    this.#database.prepare(`
      UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
        revision = revision + 1, updated_at = ?
      WHERE status = 'running' AND (
        active_run_id IS NULL OR lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR
        lease_owner NOT IN (SELECT owner_id FROM session_owners)
      )
    `).run(now, now);
    this.#database.prepare(`
      UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL
      WHERE claimed_run_id IS NOT NULL AND (
        claimed_at IS NULL OR claim_owner IS NULL OR
        claim_owner NOT IN (SELECT owner_id FROM session_owners) OR
        NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = pending_messages.session_id AND sessions.active_run_id = pending_messages.claimed_run_id AND sessions.status = 'running')
      )
    `).run();
  }

  #createProviderProfilesV2(): void {
    this.#database.exec(`
        CREATE TABLE provider_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          provider_kind TEXT NOT NULL CHECK (provider_kind IN ('custom-openai-compatible', 'deepseek', 'kimi', 'qwen', 'glm')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK (protocol IN ('chat-completions', 'responses')),
          auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer-env', 'encrypted-sqlite')),
          auth_environment_variable TEXT,
          auth_secret_id TEXT,
          capabilities_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
    `);
  }

  #createVaultTables(): void {
    this.#database.exec(`
      CREATE TABLE vault_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        kdf TEXT NOT NULL,
        salt BLOB NOT NULL,
        work_factor INTEGER NOT NULL,
        block_size INTEGER NOT NULL,
        parallelism INTEGER NOT NULL,
        verifier_nonce BLOB NOT NULL,
        verifier_ciphertext BLOB NOT NULL,
        verifier_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE vault_secrets (
        secret_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  #requireSession(sessionId: string): AgentSessionRecord {
    const row = optionalRow(this.#database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
    if (!row) throw new AlphionError("validation", `Unknown session: ${sessionId}`, { stage: "session" });
    return decodeSession(row);
  }

  #requireSessionShape(session: AgentSessionRecord): AgentShape {
    if (!session.shapeRevision || !session.shapeDigest) throw new AlphionError("integrity-failed", "Shaped Session is missing its shape identity.", { stage: "database" });
    const row = optionalRow(this.#database.prepare("SELECT shape_json FROM session_shapes WHERE session_id = ? AND shape_revision = ? AND shape_digest = ?").get(session.id, session.shapeRevision, session.shapeDigest));
    if (!row) throw new AlphionError("integrity-failed", "Session shape identity has no matching stored shape.", { stage: "database" });
    return parseAgentShape(readString(row, "shape_json"));
  }

  #assertRevision(session: AgentSessionRecord, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AlphionError("validation", "Expected revision must be a non-negative safe integer.", { stage: "session" });
    if (session.revision !== expectedRevision) throw new AlphionError("conflict", `Session revision changed; expected ${expectedRevision}, current ${session.revision}.`, { stage: "session" });
  }

  #recordSessionCommand(idempotencyKey: string, sessionId: string, result: unknown): void {
    validateIdempotencyKey(idempotencyKey);
    this.#database.prepare("INSERT INTO session_commands (idempotency_key, session_id, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(idempotencyKey, sessionId, canonicalJson(result), new Date().toISOString());
  }

  #replayedReceipt(idempotencyKey: string, sessionId: string): SessionWriteReceipt | undefined {
    validateIdempotencyKey(idempotencyKey);
    const row = optionalRow(this.#database.prepare("SELECT session_id, result_json FROM session_commands WHERE idempotency_key = ?").get(idempotencyKey));
    if (!row) return undefined;
    if (readString(row, "session_id") !== sessionId) throw new AlphionError("conflict", "Idempotency key belongs to another session.", { stage: "session" });
    const result = requiredRow(JSON.parse(readString(row, "result_json")));
    const revision = readNumber(result, "revision");
    const entryId = readNullableString(result, "entryId");
    const pendingMessageId = readNullableString(result, "pendingMessageId");
    return { sessionId, revision, ...(entryId ? { entryId } : {}), ...(pendingMessageId ? { pendingMessageId } : {}), replayed: true };
  }

  #assertIntegrity(): void {
    const rows = this.#database.prepare("PRAGMA quick_check").all();
    const valid = rows.length === 1 && Object.values(requiredRow(rows[0]))[0] === "ok";
    if (!valid) {
      throw new AlphionError("integrity-failed", "SQLite quick integrity check failed.", { stage: "database" });
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #pruneCache(): void {
    const maxBytes = 256 * 1024 * 1024;
    const row = requiredRow(this.#database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
    if (readNumber(row, "bytes") <= maxBytes) return;
    const targetBytes = Math.floor(maxBytes * 0.8);
    while (true) {
      const current = requiredRow(this.#database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
      if (readNumber(current, "bytes") <= targetBytes) break;
      this.#database.prepare("DELETE FROM cache_entries WHERE rowid IN (SELECT rowid FROM cache_entries ORDER BY last_accessed_at LIMIT 32)").run();
    }
  }
}

function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all().map((row) => readString(requiredRow(row), "name")));
}

function assertDatabaseHealthy(database: SqliteDatabase, message: string): void {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(requiredRow(rows[0]))[0] !== "ok") throw new AlphionError("integrity-failed", message, { stage: "database" });
}

function logicalDatabaseDigest(database: SqliteDatabase): string {
  const schema = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(requiredRow);
  const tables = schema.filter((row) => readString(row, "type") === "table").map((row) => readString(row, "name"));
  const content = tables.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = database.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all().map((row) => Object.fromEntries(Object.entries(requiredRow(row)).map(([key, value]) => [key, encodeSqlValue(value)])));
    return { table, rows };
  });
  return sha256(canonicalJson({ schema: schema.map((row) => ({ name: row.name, type: row.type, sql: row.sql })), content }));
}

function encodeSqlValue(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex")}`;
  throw new AlphionError("integrity-failed", "SQLite backup contains an unsupported value.", { stage: "database" });
}

function validateProviderProfile(
  input: ProviderProfileInput,
): { readonly baseUrl: string } {
  if (
    input.schemaVersion !== 2 ||
    input.id.trim().length === 0 ||
    input.name.trim().length === 0 ||
    input.model.trim().length === 0 ||
    input.id.length > 128 ||
    input.name.length > 256 ||
    input.model.length > 256
  ) {
    throw new AlphionError("validation", "Provider id, name, model, and schema version 2 are required.", { stage: "config" });
  }
  if (containsPotentialSecret([input.id, input.name, input.model, ...(input.kind === "custom-openai-compatible" ? [input.baseUrl] : [])])) {
    throw new AlphionError("validation", "Provider profile fields must not contain credential material.", { stage: "config" });
  }
  if (input.protocol !== "chat-completions" && input.protocol !== "responses") {
    throw new AlphionError("validation", "Provider protocol is unsupported.", { stage: "config" });
  }
  if (!['custom-openai-compatible', 'deepseek', 'kimi', 'qwen', 'glm'].includes(input.kind)) {
    throw new AlphionError("validation", "Provider kind is unsupported.", { stage: "config" });
  }
  if (input.kind === "deepseek" && input.protocol !== "chat-completions") {
    throw new AlphionError("validation", "DeepSeek profiles only support Chat Completions.", { stage: "config" });
  }
  if (
    typeof input.capabilities.streaming !== "boolean" ||
    typeof input.capabilities.tools !== "boolean" ||
    typeof input.capabilities.promptCaching !== "boolean" ||
    typeof input.capabilities.reasoning !== "boolean"
  ) {
    throw new AlphionError("validation", "Provider capabilities must be booleans.", { stage: "config" });
  }
  if (input.auth.mode !== "none" && input.auth.mode !== "bearer-env" && input.auth.mode !== "encrypted-sqlite") {
    throw new AlphionError("validation", "Provider authentication mode is unsupported.", { stage: "config" });
  }
  validateProviderPreset(input);
  if (input.auth.mode === "bearer-env" && !/^[A-Z_][A-Z0-9_]*$/.test(input.auth.environmentVariable)) {
    throw new AlphionError("validation", "Secret references must be portable uppercase environment-variable names.", { stage: "config" });
  }
  if (input.auth.mode === "encrypted-sqlite" && !/^vault_[A-Za-z0-9_-]{8,}$/.test(input.auth.secretId)) {
    throw new AlphionError("validation", "Vault secret reference is invalid.", { stage: "config" });
  }
  return { baseUrl: input.kind === "custom-openai-compatible" ? resolveProviderEndpoint(input) : input.presetId };
}

function decodeProviderProfile(row: Readonly<Record<string, unknown>>): ProviderProfile {
  const kind = readString(row, "provider_kind");
  if (!['custom-openai-compatible', 'deepseek', 'kimi', 'qwen', 'glm'].includes(kind)) {
    throw new AlphionError("integrity-failed", `Invalid provider kind: ${kind}`, { stage: "database" });
  }
  const protocol = readString(row, "protocol");
  if (protocol !== "chat-completions" && protocol !== "responses") {
    throw new AlphionError("integrity-failed", `Invalid provider protocol: ${protocol}`, { stage: "database" });
  }
  const authMode = readString(row, "auth_mode");
  const capabilities = parseRecord(readString(row, "capabilities_json"));
  const streaming = readBoolean(capabilities, "streaming");
  const tools = readBoolean(capabilities, "tools");
  const promptCaching = readBoolean(capabilities, "promptCaching");
  const reasoning = readBoolean(capabilities, "reasoning");
  const auth = authMode === "none"
    ? ({ mode: "none" } as const)
    : authMode === "bearer-env"
      ? ({ mode: "bearer-env", environmentVariable: requireNullableString(row, "auth_environment_variable") } as const)
      : authMode === "encrypted-sqlite"
        ? ({ mode: "encrypted-sqlite", secretId: requireNullableString(row, "auth_secret_id") } as const)
        : undefined;
  if (!auth) throw new AlphionError("integrity-failed", `Invalid provider auth mode: ${authMode}`, { stage: "database" });
  const storedEndpoint = readString(row, "base_url");
  const base = {
    schemaVersion: 2,
    id: readString(row, "id"),
    name: readString(row, "name"),
    model: readString(row, "model"),
    protocol,
    auth,
    capabilities: { streaming, tools, promptCaching, reasoning },
    revision: readNumber(row, "revision"),
    active: readNumber(row, "active") === 1,
  };
  if (kind === "custom-openai-compatible") return { ...base, kind, baseUrl: storedEndpoint };
  if (kind === "deepseek" || kind === "kimi" || kind === "qwen" || kind === "glm") {
    const profile = { ...base, kind, presetId: storedEndpoint };
    validateProviderPreset(profile);
    return profile;
  }
  throw new AlphionError("integrity-failed", `Invalid provider kind: ${kind}`, { stage: "database" });
}

function decodeCacheEntry(row: Readonly<Record<string, unknown>>): CacheEntry {
  return {
    namespace: readString(row, "namespace"),
    key: readString(row, "cache_key"),
    value: readString(row, "value_text"),
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
    provenance: readString(row, "provenance"),
  };
}

function decodeShellRule(row: Readonly<Record<string, unknown>>): ShellRule {
  const argumentsValue = JSON.parse(readString(row, "argument_prefix_json")) as unknown;
  if (!Array.isArray(argumentsValue) || !argumentsValue.every((item) => typeof item === "string")) {
    throw new AlphionError("integrity-failed", "Invalid shell rule argument prefix.", { stage: "database" });
  }
  const digest = readNullableString(row, "executable_digest");
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    executablePath: readString(row, "executable_path"),
    ...(digest ? { executableDigest: digest } : {}),
    argumentPrefix: argumentsValue,
    enabled: readNumber(row, "enabled") === 1,
  };
}

function decodeSession(row: Readonly<Record<string, unknown>>): AgentSessionRecord {
  const status = readString(row, "status");
  if (status !== "idle" && status !== "running" && status !== "legacy-audit") throw new AlphionError("integrity-failed", "Stored session status is invalid.", { stage: "database" });
  const currentLeafId = readNullableString(row, "current_leaf_id");
  const activeRunId = readNullableString(row, "active_run_id");
  const providerId = readNullableString(row, "provider_id");
  const shapeStatus = readString(row, "shape_status");
  if (shapeStatus !== "unshaped" && shapeStatus !== "shaped" && shapeStatus !== "legacy-unshaped") throw new AlphionError("integrity-failed", "Stored Session shape status is invalid.", { stage: "database" });
  const shapeRevision = row.shape_revision === null || row.shape_revision === undefined ? undefined : readNumber(row, "shape_revision");
  const shapeDigest = readNullableString(row, "shape_digest");
  const domainId = readString(row, "domain_id");
  const projectId = readNullableString(row, "project_id");
  if (!domainId) throw new AlphionError("integrity-failed", "Stored Session domain identity is missing.", { stage: "database" });
  return {
    schemaVersion: 2,
    id: readString(row, "id"),
    domainId,
    ...(projectId ? { projectId } : {}),
    title: readString(row, "title"),
    ...(currentLeafId ? { currentLeafId } : {}),
    revision: readNumber(row, "revision"),
    status,
    ...(activeRunId ? { activeRunId } : {}),
    ...(providerId ? { providerId } : {}),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    auditOnly: readNumber(row, "audit_only") === 1,
    shapeStatus,
    ...(shapeRevision ? { shapeRevision } : {}),
    ...(shapeDigest ? { shapeDigest } : {}),
  };
}

function parseAgentShape(value: string): AgentShape {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new AlphionError("integrity-failed", "Stored Agent shape JSON is invalid.", { stage: "database", cause: error }); }
  validateAgentShape(parsed);
  return parsed;
}

function validateAgentShape(shape: unknown): asserts shape is AgentShape {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) throw new AlphionError("validation", "Agent shape must be an object.", { stage: "shape" });
  const value = shape as Readonly<Record<string, unknown>>;
  if (value.schemaVersion !== 1 || typeof value.sessionId !== "string" || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) throw new AlphionError("validation", "Agent shape envelope is invalid.", { stage: "shape" });
  const exact = ["schemaVersion", "sessionId", "revision", "goal", "identity", "systemPromptPlan", "resources", "resourceIds", "resourceDigest", "toolIds", "capabilities", "policies", "behavior", "providerId", "requiredProviderCapabilities", "harnessPlan", "omissions", "diagnostics", "digest"];
  if (Object.keys(value).some((key) => !exact.includes(key))) throw new AlphionError("validation", "Agent shape contains an unknown field.", { stage: "shape" });
  for (const key of ["goal", "resourceDigest"] as const) if (typeof value[key] !== "string" || !value[key]) throw new AlphionError("validation", `Agent shape ${key} is invalid.`, { stage: "shape" });
  for (const key of ["resources", "resourceIds", "toolIds", "capabilities", "policies", "requiredProviderCapabilities", "omissions", "diagnostics"] as const) if (!Array.isArray(value[key])) throw new AlphionError("validation", `Agent shape ${key} must be an array.`, { stage: "shape" });
  for (const key of ["identity", "systemPromptPlan", "behavior", "harnessPlan"] as const) if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) throw new AlphionError("validation", `Agent shape ${key} must be an object.`, { stage: "shape" });
  const digest = value.digest;
  const { digest: _digest, ...base } = value;
  if (sha256(canonicalJson(base)) !== digest) throw new AlphionError("integrity-failed", "Agent shape digest does not match its content.", { stage: "shape" });
  if (containsPotentialSecret(value)) throw new AlphionError("forbidden", "Agent shape cannot contain probable secrets.", { stage: "shape" });
}

function decodeSessionEntry(row: Readonly<Record<string, unknown>>): SessionEntry {
  const parentId = readNullableString(row, "parent_id");
  const runId = readNullableString(row, "run_id");
  const message = parseAgentMessage(readString(row, "message_json"));
  return { schemaVersion: 1, id: readString(row, "id"), ...(parentId ? { parentId } : {}), sessionId: readString(row, "session_id"), ...(runId ? { runId } : {}), timestamp: readString(row, "timestamp"), message };
}

function decodePendingMessage(row: Readonly<Record<string, unknown>>): PendingSessionMessage {
  const kind = readString(row, "kind");
  if (kind !== "steer" && kind !== "follow-up") throw new AlphionError("integrity-failed", "Stored pending-message kind is invalid.", { stage: "database" });
  const message = parseAgentMessage(readString(row, "message_json"));
  if (message.kind !== "user" && message.kind !== "agent") throw new AlphionError("integrity-failed", "Pending session message must be a user or agent message.", { stage: "database" });
  return { id: readString(row, "id"), sessionId: readString(row, "session_id"), kind, message, idempotencyKey: readString(row, "idempotency_key"), createdAt: readString(row, "created_at") };
}

function decodeAgentEvent(row: Readonly<Record<string, unknown>>): AgentEvent {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new AlphionError("integrity-failed", `Unsupported stored event schema ${schemaVersion}.`, { stage: "events" });
  const kind = readString(row, "kind") as AgentEvent["kind"];
  const causationId = readNullableString(row, "causation_id");
  const sessionSequence = row.session_sequence === null || row.session_sequence === undefined ? undefined : readNumber(row, "session_sequence");
  if (schemaVersion === 2 && (!sessionSequence || sessionSequence < 1)) throw new AlphionError("integrity-failed", "Schema-v2 event is missing its session sequence.", { stage: "events" });
  return { schemaVersion, eventId: readString(row, "event_id"), sequence: readNumber(row, "sequence"), ...(sessionSequence ? { sessionSequence } : {}), runId: readString(row, "run_id"), sessionId: readString(row, "session_id"), correlationId: readString(row, "correlation_id"), ...(causationId ? { causationId } : {}), timestamp: readString(row, "timestamp"), kind, payload: parseRecord(readString(row, "payload_json")), previousDigest: readString(row, "previous_digest"), digest: readString(row, "digest") };
}

function parseAgentMessage(value: string): AgentMessage {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new AlphionError("integrity-failed", "Stored Agent message JSON is invalid.", { stage: "database", cause: error }); }
  validateAgentMessage(parsed);
  return parsed;
}

function validateAgentMessage(message: unknown): asserts message is AgentMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new AlphionError("validation", "Agent message must be an object.", { stage: "session" });
  const value = message as Readonly<Record<string, unknown>>;
  const kinds = ["user", "assistant", "tool-call", "observation", "memory", "system-event", "human-approval", "agent", "workflow"];
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.id !== "string" || value.id.length === 0 || typeof value.createdAt !== "string" || !kinds.includes(String(value.kind))) {
    throw new AlphionError("validation", "Agent message envelope is invalid.", { stage: "session" });
  }
  if (value.schemaVersion === 2) {
    const exact = ["schemaVersion", "kind", "id", "createdAt", "sourceSessionId", "targetSessionId", "domainId", "idempotencyKey", "correlationId", "causationId", "hop", "delivery", "content"];
    if (value.kind !== "agent" || Object.keys(value).some((key) => !exact.includes(key))) throw new AlphionError("validation", "Schema-v2 Agent message contains an invalid field.", { stage: "session" });
    for (const key of ["sourceSessionId", "targetSessionId", "domainId", "correlationId", "content"] as const) {
      if (typeof value[key] !== "string" || !value[key]) throw new AlphionError("validation", `Schema-v2 Agent message ${key} is invalid.`, { stage: "session" });
    }
    if (value.causationId !== undefined && (typeof value.causationId !== "string" || !value.causationId)) throw new AlphionError("validation", "Schema-v2 Agent message causationId is invalid.", { stage: "session" });
    if (!Number.isSafeInteger(value.hop) || (value.hop as number) < 1 || (value.hop as number) > 8 || (value.delivery !== "steer" && value.delivery !== "follow-up")) throw new AlphionError("validation", "Schema-v2 Agent message delivery identity is invalid.", { stage: "session" });
    validateIdempotencyKey(String(value.idempotencyKey));
  } else if (value.kind === "agent" && typeof value.agentId !== "string") {
    throw new AlphionError("validation", "Schema-v1 Agent message identity is invalid.", { stage: "session" });
  }
  if (typeof value.content !== "string" && value.kind !== "tool-call") throw new AlphionError("validation", "Agent message content is invalid.", { stage: "session" });
  if (containsPotentialSecret(value)) throw new AlphionError("forbidden", "Agent messages cannot contain probable secrets.", { stage: "session" });
}

function decodeCollaborationReceipt(row: Readonly<Record<string, unknown>>, replayed: boolean): SessionMessageReceipt {
  const delivery = readString(row, "delivery");
  if (delivery !== "steer" && delivery !== "follow-up") throw new AlphionError("integrity-failed", "Stored collaboration delivery is invalid.", { stage: "database" });
  const hop = readNumber(row, "hop");
  if (!Number.isSafeInteger(hop) || hop < 1 || hop > 8) throw new AlphionError("integrity-failed", "Stored collaboration hop is invalid.", { stage: "database" });
  return Object.freeze({ messageId: readString(row, "message_id"), sourceSessionId: readString(row, "source_session_id"), targetSessionId: readString(row, "target_session_id"), targetRevision: readNumber(row, "target_revision"), delivery, hop, replayed });
}

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new AlphionError("validation", "Idempotency key must be 8-200 safe characters.", { stage: "session" });
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function optionalRow(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : requiredRow(value);
}

function requiredRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlphionError("integrity-failed", "SQLite returned an invalid row.", { stage: "database" });
  }
  return value as Readonly<Record<string, unknown>>;
}

function readString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected text column ${key}.`, { stage: "database" });
  return value;
}

function readNullableString(row: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected nullable text column ${key}.`, { stage: "database" });
  return value;
}

function requireNullableString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = readNullableString(row, key);
  if (!value) throw new AlphionError("integrity-failed", `Missing text column ${key}.`, { stage: "database" });
  return value;
}

function readNumber(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new AlphionError("integrity-failed", `Expected numeric column ${key}.`, { stage: "database" });
}

function readBuffer(row: Readonly<Record<string, unknown>>, key: string): Buffer {
  const value = row[key];
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new AlphionError("integrity-failed", `Expected binary column ${key}.`, { stage: "database" });
}

function readBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new AlphionError("integrity-failed", `Expected boolean field ${key}.`, { stage: "database" });
  return value;
}

function parseRecord(serialized: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new AlphionError("integrity-failed", "Stored JSON is invalid.", { stage: "database", cause: error });
  }
  return requiredRow(value);
}

interface VaultMetadata {
  readonly salt: Buffer;
  readonly verifierNonce: Buffer;
  readonly verifierCiphertext: Buffer;
  readonly verifierTag: Buffer;
}

interface EncryptedValue {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

function validateMasterPassword(value: string): void {
  if (value.length < 12 || value.length > 1024 || value.includes("\0")) {
    throw new AlphionError("validation", "Master password must contain between 12 and 1024 characters.", {
      stage: "vault",
    });
  }
}

function deriveVaultKey(password: string, salt: Buffer): Buffer {
  try {
    return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  } catch (error) {
    throw new AlphionError("internal", "Credential vault key derivation failed.", { stage: "vault", cause: error });
  }
}

function encryptValue(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptValue(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function vaultVerifierAad(): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "vault-verifier" }), "utf8");
}

function secretAad(secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(
    canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "provider-credential", secretId, profileId, revision }),
    "utf8",
  );
}
