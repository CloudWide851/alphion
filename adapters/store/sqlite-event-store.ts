import type { EventStore } from "../../src/ports/index.js";
import type { AgentEvent, AgentEventDraft } from "../../src/protocol/events.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { sanitizeRecord } from "../../src/application/sensitive-data.js";
import { SqliteConfigurationStore } from "./sqlite-configuration-store.js";
import { decodeAgentEvent, optionalRow, parseRecord, readNullableString, readNumber, readString, requiredRow } from "./sqlite-codecs.js";

export abstract class SqliteEventStore extends SqliteConfigurationStore implements EventStore {
  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    return this.transaction(() => {
      const safePayload = sanitizeRecord(draft.payload);
      const previous = optionalRow(this.database.prepare("SELECT sequence, digest FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1").get(draft.runId));
      const sequence = previous ? readNumber(previous, "sequence") + 1 : 1;
      const sessionRow = requiredRow(this.database.prepare("SELECT COALESCE(MAX(session_sequence), 0) AS sequence FROM events WHERE session_id = ?").get(draft.sessionId));
      const sessionSequence = readNumber(sessionRow, "sequence") + 1;
      const previousDigest = previous ? readString(previous, "digest") : "0".repeat(64);
      const eventId = createId("event");
      const timestamp = new Date().toISOString();
      const digest = sha256(canonicalJson({ schemaVersion: 2, eventId, sequence, sessionSequence, runId: draft.runId, sessionId: draft.sessionId, correlationId: draft.correlationId, ...(draft.causationId ? { causationId: draft.causationId } : {}), timestamp, kind: draft.kind, payload: safePayload, previousDigest }));
      const event: AgentEvent = { schemaVersion: 2, eventId, sequence, sessionSequence, runId: draft.runId, sessionId: draft.sessionId, correlationId: draft.correlationId, ...(draft.causationId ? { causationId: draft.causationId } : {}), timestamp, kind: draft.kind, payload: safePayload, previousDigest, digest };
      if (event.kind === "run.started") {
        const shapeRevision = typeof safePayload.shapeRevision === "number" ? safePayload.shapeRevision : null;
        const shapeDigest = typeof safePayload.shapeDigest === "string" ? safePayload.shapeDigest : null;
        this.database.prepare("INSERT INTO runs (run_id, session_id, status, created_at, updated_at, shape_revision, shape_digest) VALUES (?, ?, 'running', ?, ?, ?, ?)").run(event.runId, event.sessionId, event.timestamp, event.timestamp, shapeRevision, shapeDigest);
      }
      this.database.prepare(`INSERT INTO events
        (run_id, sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`)
        .run(event.runId, event.sequence, event.eventId, event.sessionId, event.correlationId, event.causationId ?? null, event.timestamp, event.kind, JSON.stringify(event.payload), event.previousDigest, event.digest, event.sessionSequence ?? 0);
      if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.cancelled") this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(event.kind.slice("run.".length), event.timestamp, event.runId);
      return event;
    });
  }

  async verifyRun(runId: string): Promise<boolean> {
    const rows = this.database.prepare(`SELECT sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence FROM events WHERE run_id = ? ORDER BY sequence`).all(runId);
    let expectedSequence = 1;
    let previousDigest = "0".repeat(64);
    for (const value of rows) {
      const row = requiredRow(value);
      const sequence = readNumber(row, "sequence");
      if (sequence !== expectedSequence || readString(row, "previous_digest") !== previousDigest) return false;
      const schemaVersion = readNumber(row, "schema_version");
      const shape = { schemaVersion, eventId: readString(row, "event_id"), sequence, ...(schemaVersion === 2 ? { sessionSequence: readNumber(row, "session_sequence") } : {}), runId, sessionId: readString(row, "session_id"), correlationId: readString(row, "correlation_id"), ...(readNullableString(row, "causation_id") ? { causationId: readNullableString(row, "causation_id") } : {}), timestamp: readString(row, "timestamp"), kind: readString(row, "kind"), payload: parseRecord(readString(row, "payload_json")), previousDigest };
      const digest = sha256(canonicalJson(shape));
      if (digest !== readString(row, "digest")) return false;
      previousDigest = digest;
      expectedSequence += 1;
    }
    return rows.length > 0;
  }

  async listSessionEvents(sessionId: string, afterSessionSequence = 0): Promise<readonly AgentEvent[]> {
    if (!Number.isSafeInteger(afterSessionSequence) || afterSessionSequence < 0) throw new AlphionError("validation", "Event replay cursor must be a non-negative safe integer.", { stage: "events" });
    const rows = this.database.prepare(`SELECT run_id, sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest, schema_version, session_sequence FROM events WHERE session_id = ? AND (session_sequence IS NULL OR session_sequence > ?) ORDER BY COALESCE(session_sequence, 0), timestamp, run_id, sequence`).all(sessionId, afterSessionSequence).map(requiredRow);
    return Object.freeze(rows.map(decodeAgentEvent));
  }
}
