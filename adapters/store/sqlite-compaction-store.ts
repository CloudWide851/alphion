import type { CompactionProjection, CompactionRecord, CompactionSummary } from "../../src/domain/compaction-contracts.js";
import { canonicalJson, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import type { SqliteDatabase } from "./database.js";
import { optionalRow, readString, requiredRow } from "./sqlite-codecs.js";

export function appendStoredCompaction(database: SqliteDatabase, record: CompactionRecord): void {
  validateCompactionRecord(record);
  const existing = optionalRow(database.prepare("SELECT record_json FROM compaction_records WHERE id = ?").get(record.id));
  if (existing) {
    const stored = decodeCompactionRecord(JSON.parse(readString(existing, "record_json")));
    if (stored.digest !== record.digest || stored.sessionId !== record.sessionId || stored.runId !== record.runId) throw new AlphionError("conflict", "Compaction identity already belongs to different content.", { stage: "compaction" });
    return;
  }
  database.prepare("INSERT INTO compaction_records (id, session_id, run_id, created_at, digest, record_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(record.id, record.sessionId, record.runId, record.createdAt, record.digest, canonicalJson(record));
}

export function listStoredCompactions(database: SqliteDatabase, sessionId: string, limit = 50): readonly CompactionRecord[] {
  validateLimit(limit);
  return Object.freeze(database.prepare("SELECT record_json FROM compaction_records WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(sessionId, limit).map((row) => decodeCompactionRecord(JSON.parse(readString(requiredRow(row), "record_json")))));
}

export function getStoredCompaction(database: SqliteDatabase, compactionId: string): CompactionRecord | undefined {
  const row = optionalRow(database.prepare("SELECT record_json FROM compaction_records WHERE id = ?").get(compactionId));
  return row ? decodeCompactionRecord(JSON.parse(readString(row, "record_json"))) : undefined;
}

export function projectStoredCompactions(database: SqliteDatabase, sessionId: string): CompactionProjection {
  const row = optionalRow(database.prepare("SELECT record_json, (SELECT COUNT(*) FROM compaction_records WHERE session_id = ?) AS total FROM compaction_records WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(sessionId, sessionId));
  if (!row) return Object.freeze({ count: 0 });
  const record = decodeCompactionRecord(JSON.parse(readString(row, "record_json")));
  const count = numberField(row.total, "compaction count");
  return Object.freeze({ latest: compactionSummary(record), count });
}

function compactionSummary(record: CompactionRecord): CompactionSummary {
  const { runId: _runId, sourceEntryIds: _ids, sourceDigest: _source, retainedKinds: _retained, omissions: _omissions, knownLosses: _losses, memory: _memory, ...summary } = record;
  return Object.freeze(summary);
}

function decodeCompactionRecord(value: unknown): CompactionRecord {
  validateCompactionRecord(value);
  const record = value as CompactionRecord;
  return Object.freeze({ ...record, sourceEntryIds: Object.freeze([...record.sourceEntryIds]), retainedKinds: Object.freeze([...record.retainedKinds]), omissions: Object.freeze([...record.omissions]), knownLosses: Object.freeze([...record.knownLosses]), memory: Object.freeze({ ...record.memory, sourceEntryIds: Object.freeze([...record.memory.sourceEntryIds]) }) });
}

function validateCompactionRecord(value: unknown): asserts value is CompactionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  const strings = ["id", "sessionId", "runId", "createdAt", "reason", "modelId", "policyDigest", "digest", "sourceDigest"];
  const numbers = ["originalTokens", "compactedTokens", "sourceEntryCount", "retainedCycleCount"];
  const arrays = ["sourceEntryIds", "retainedKinds", "omissions", "knownLosses"];
  if (item.schemaVersion !== 1 || strings.some((key) => typeof item[key] !== "string") || numbers.some((key) => !Number.isSafeInteger(item[key]) || Number(item[key]) < 0) || arrays.some((key) => !Array.isArray(item[key]) || !(item[key] as unknown[]).every((entry) => typeof entry === "string")) || item.reason !== "model-context-threshold") throw invalid();
  if (![item.digest, item.sourceDigest, item.policyDigest].every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))) throw invalid();
  if (!Number.isFinite(Date.parse(String(item.createdAt)))) throw invalid();
  if (!item.memory || typeof item.memory !== "object" || Array.isArray(item.memory)) throw invalid();
  const memory = item.memory as Record<string, unknown>;
  if (memory.schemaVersion !== 1 || memory.kind !== "memory" || typeof memory.id !== "string" || typeof memory.content !== "string" || typeof memory.digest !== "string" || !Array.isArray(memory.sourceEntryIds) || !memory.sourceEntryIds.every((entry) => typeof entry === "string")) throw invalid();
  if (canonicalJson(memory.sourceEntryIds) !== canonicalJson(item.sourceEntryIds)) throw invalid();
  const memoryDigest = sha256(canonicalJson({ sourceEntryIds: memory.sourceEntryIds, summary: memory.content }));
  if (memory.digest !== memoryDigest || memory.id !== `message_compaction_${memoryDigest.slice(0, 32)}`) throw invalid();
  const recordId = sha256(canonicalJson({ sessionId: item.sessionId, runId: item.runId, digest: item.digest }));
  if (item.id !== `compaction_${recordId.slice(0, 32)}`) throw invalid();
}

function validateLimit(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new AlphionError("validation", "Compaction list limit must be 1-500.", { stage: "compaction" }); }
function numberField(value: unknown, label: string): number { const number = typeof value === "bigint" ? Number(value) : value; if (!Number.isSafeInteger(number) || Number(number) < 0) throw new AlphionError("integrity-failed", `Stored ${label} is invalid.`, { stage: "database" }); return Number(number); }
function invalid(): AlphionError { return new AlphionError("integrity-failed", "Stored compaction record is invalid.", { stage: "database" }); }
