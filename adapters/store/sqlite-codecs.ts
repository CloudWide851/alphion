import { createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { resolve } from "node:path";
import type {
  AgentMessage, AgentSessionRecord, AgentShape, PendingSessionMessage,
  ProviderProfile, ProviderProfileInput, SessionEntry, SessionForkProvenance, SessionMessageReceipt, ShellRule,
} from "../../src/domain/contracts.js";
import type { CacheEntry } from "../../src/ports/index.js";
import type { AgentEvent } from "../../src/protocol/events.js";
import { canonicalJson, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret } from "../../src/application/sensitive-data.js";
import { resolveProviderEndpoint, validateProviderPreset } from "../model/provider-catalog.js";
import type { SqliteDatabase } from "./database.js";
import { SCRYPT_OPTIONS, VAULT_SCHEMA_VERSION } from "./sqlite-constants.js";

export function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(database.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all().map((row) => readString(requiredRow(row), "name")));
}

export function assertDatabaseHealthy(database: SqliteDatabase, message: string): void {
  const rows = database.prepare("PRAGMA quick_check").all();
  if (rows.length !== 1 || Object.values(requiredRow(rows[0]))[0] !== "ok") throw new AlphionError("integrity-failed", message, { stage: "database" });
}

export function logicalDatabaseDigest(database: SqliteDatabase): string {
  const schema = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(requiredRow);
  const tables = schema.filter((row) => readString(row, "type") === "table").map((row) => readString(row, "name"));
  const content = tables.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = database.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all().map((row) => Object.fromEntries(Object.entries(requiredRow(row)).map(([key, value]) => [key, encodeSqlValue(value)])));
    return { table, rows };
  });
  return sha256(canonicalJson({ schema: schema.map((row) => ({ name: row.name, type: row.type, sql: row.sql })), content }));
}

export function encodeSqlValue(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex")}`;
  throw new AlphionError("integrity-failed", "SQLite backup contains an unsupported value.", { stage: "database" });
}

export function validateProviderProfile(
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

export function decodeProviderProfile(row: Readonly<Record<string, unknown>>): ProviderProfile {
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
  } as const;
  if (kind === "custom-openai-compatible") return { ...base, kind, baseUrl: storedEndpoint };
  if (kind === "deepseek" || kind === "kimi" || kind === "qwen" || kind === "glm") {
    const profile: ProviderProfile = { ...base, kind, presetId: storedEndpoint };
    validateProviderPreset(profile);
    return profile;
  }
  throw new AlphionError("integrity-failed", `Invalid provider kind: ${kind}`, { stage: "database" });
}

export function decodeCacheEntry(row: Readonly<Record<string, unknown>>): CacheEntry {
  return {
    namespace: readString(row, "namespace"),
    key: readString(row, "cache_key"),
    value: readString(row, "value_text"),
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
    provenance: readString(row, "provenance"),
  };
}

export function decodeShellRule(row: Readonly<Record<string, unknown>>): ShellRule {
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

export function decodeSession(row: Readonly<Record<string, unknown>>): AgentSessionRecord {
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
  const forkSourceSessionId = readNullableString(row, "fork_source_session_id");
  if (!domainId) throw new AlphionError("integrity-failed", "Stored Session domain identity is missing.", { stage: "database" });
  return {
    schemaVersion: 3,
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
    ...(forkSourceSessionId ? { forkProvenance: decodeForkProvenance(row, forkSourceSessionId) } : {}),
  };
}

function decodeForkProvenance(row: Readonly<Record<string, unknown>>, sourceSessionId: string): SessionForkProvenance {
  const sourceEntryId = readNullableString(row, "fork_source_entry_id");
  return Object.freeze({ schemaVersion: 1, sourceSessionId, ...(sourceEntryId ? { sourceEntryId } : {}), sourceRevision: readNumber(row, "fork_source_revision"), branchDigest: readString(row, "fork_branch_digest"), forkedAt: readString(row, "forked_at") });
}

export function parseAgentShape(value: string): AgentShape {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new AlphionError("integrity-failed", "Stored Agent shape JSON is invalid.", { stage: "database", cause: error }); }
  validateAgentShape(parsed);
  return parsed;
}

export function validateAgentShape(shape: unknown): asserts shape is AgentShape {
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

export function decodeSessionEntry(row: Readonly<Record<string, unknown>>): SessionEntry {
  const parentId = readNullableString(row, "parent_id");
  const runId = readNullableString(row, "run_id");
  const message = parseAgentMessage(readString(row, "message_json"));
  return { schemaVersion: 1, id: readString(row, "id"), ...(parentId ? { parentId } : {}), sessionId: readString(row, "session_id"), ...(runId ? { runId } : {}), timestamp: readString(row, "timestamp"), message };
}

export function decodePendingMessage(row: Readonly<Record<string, unknown>>): PendingSessionMessage {
  const kind = readString(row, "kind");
  if (kind !== "steer" && kind !== "follow-up") throw new AlphionError("integrity-failed", "Stored pending-message kind is invalid.", { stage: "database" });
  const message = parseAgentMessage(readString(row, "message_json"));
  if (message.kind !== "user" && message.kind !== "agent") throw new AlphionError("integrity-failed", "Pending session message must be a user or agent message.", { stage: "database" });
  return { id: readString(row, "id"), sessionId: readString(row, "session_id"), kind, message, idempotencyKey: readString(row, "idempotency_key"), createdAt: readString(row, "created_at") };
}

export function decodeAgentEvent(row: Readonly<Record<string, unknown>>): AgentEvent {
  const schemaVersion = readNumber(row, "schema_version");
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new AlphionError("integrity-failed", `Unsupported stored event schema ${schemaVersion}.`, { stage: "events" });
  const kind = readString(row, "kind") as AgentEvent["kind"];
  const causationId = readNullableString(row, "causation_id");
  const sessionSequence = row.session_sequence === null || row.session_sequence === undefined ? undefined : readNumber(row, "session_sequence");
  if (schemaVersion === 2 && (!sessionSequence || sessionSequence < 1)) throw new AlphionError("integrity-failed", "Schema-v2 event is missing its session sequence.", { stage: "events" });
  return { schemaVersion, eventId: readString(row, "event_id"), sequence: readNumber(row, "sequence"), ...(sessionSequence ? { sessionSequence } : {}), runId: readString(row, "run_id"), sessionId: readString(row, "session_id"), correlationId: readString(row, "correlation_id"), ...(causationId ? { causationId } : {}), timestamp: readString(row, "timestamp"), kind, payload: parseRecord(readString(row, "payload_json")), previousDigest: readString(row, "previous_digest"), digest: readString(row, "digest") };
}

export function parseAgentMessage(value: string): AgentMessage {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new AlphionError("integrity-failed", "Stored Agent message JSON is invalid.", { stage: "database", cause: error }); }
  validateAgentMessage(parsed);
  return parsed;
}

export function validateAgentMessage(message: unknown): asserts message is AgentMessage {
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

export function decodeCollaborationReceipt(row: Readonly<Record<string, unknown>>, replayed: boolean): SessionMessageReceipt {
  const delivery = readString(row, "delivery");
  if (delivery !== "steer" && delivery !== "follow-up") throw new AlphionError("integrity-failed", "Stored collaboration delivery is invalid.", { stage: "database" });
  const hop = readNumber(row, "hop");
  if (!Number.isSafeInteger(hop) || hop < 1 || hop > 8) throw new AlphionError("integrity-failed", "Stored collaboration hop is invalid.", { stage: "database" });
  return Object.freeze({ messageId: readString(row, "message_id"), sourceSessionId: readString(row, "source_session_id"), targetSessionId: readString(row, "target_session_id"), targetRevision: readNumber(row, "target_revision"), delivery, hop, replayed });
}

export function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value)) throw new AlphionError("validation", "Idempotency key must be 8-200 safe characters.", { stage: "session" });
}

export function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function optionalRow(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : requiredRow(value);
}

export function requiredRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlphionError("integrity-failed", "SQLite returned an invalid row.", { stage: "database" });
  }
  return value as Readonly<Record<string, unknown>>;
}

export function readString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected text column ${key}.`, { stage: "database" });
  return value;
}

export function readNullableString(row: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected nullable text column ${key}.`, { stage: "database" });
  return value;
}

export function requireNullableString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = readNullableString(row, key);
  if (!value) throw new AlphionError("integrity-failed", `Missing text column ${key}.`, { stage: "database" });
  return value;
}

export function readNumber(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new AlphionError("integrity-failed", `Expected numeric column ${key}.`, { stage: "database" });
}

export function readBuffer(row: Readonly<Record<string, unknown>>, key: string): Buffer {
  const value = row[key];
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new AlphionError("integrity-failed", `Expected binary column ${key}.`, { stage: "database" });
}

export function readBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new AlphionError("integrity-failed", `Expected boolean field ${key}.`, { stage: "database" });
  return value;
}

export function parseRecord(serialized: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new AlphionError("integrity-failed", "Stored JSON is invalid.", { stage: "database", cause: error });
  }
  return requiredRow(value);
}

export interface VaultMetadata {
  readonly salt: Buffer;
  readonly verifierNonce: Buffer;
  readonly verifierCiphertext: Buffer;
  readonly verifierTag: Buffer;
}

export interface EncryptedValue {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export function validateMasterPassword(value: string): void {
  if (value.length < 12 || value.length > 1024 || value.includes("\0")) {
    throw new AlphionError("validation", "Master password must contain between 12 and 1024 characters.", {
      stage: "vault",
    });
  }
}

export function deriveVaultKey(password: string, salt: Buffer): Buffer {
  try {
    return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  } catch (error) {
    throw new AlphionError("internal", "Credential vault key derivation failed.", { stage: "vault", cause: error });
  }
}

export function encryptValue(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptValue(
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

export function vaultVerifierAad(): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "vault-verifier" }), "utf8");
}

export function secretAad(secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(
    canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "provider-credential", secretId, profileId, revision }),
    "utf8",
  );
}
