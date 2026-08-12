import { AlphionError } from "../src/application/errors.js";
import type { AgentShapeRequest, HarnessTaskOverlay, ResourceScope, SessionBehavior } from "../src/domain/contracts.js";

export const DESKTOP_RPC_SCHEMA_VERSION = 1 as const;
export const DESKTOP_RPC_MAX_LINE_BYTES = 1024 * 1024;

export type RpcCommandKind =
  | "session.create" | "session.list" | "session.show" | "session.checkout"
  | "session.send" | "session.steer" | "session.follow-up" | "session.shape" | "session.reshape"
  | "session.subscribe" | "session.unsubscribe" | "run.cancel" | "approval.decide"
  | "harness.plan" | "resource.list" | "resource.doctor" | "project.inspect"
  | "diagnose" | "cache.stats" | "cache.clear" | "provider.list" | "rpc.shutdown";

export interface RpcHello { readonly schemaVersion: 1; readonly type: "rpc.hello"; readonly requestId: string; readonly supportedVersions: readonly number[]; }
export type RpcRequest = { readonly [K in RpcCommandKind]: Readonly<{ readonly schemaVersion: 1; readonly type: "rpc.request"; readonly requestId: string; readonly kind: K; readonly sessionId?: string; readonly expectedRevision?: number; readonly idempotencyKey?: string; readonly payload: RpcPayloads[K] }> }[RpcCommandKind];
export type RpcInbound = RpcHello | RpcRequest;
export type RpcOutbound =
  | Readonly<{ readonly schemaVersion: 1; readonly type: "rpc.response"; readonly requestId: string; readonly status: "ok" | "accepted"; readonly result?: unknown }>
  | Readonly<{ readonly schemaVersion: 1; readonly type: "rpc.response"; readonly requestId: string; readonly status: "error"; readonly error: Readonly<{ code: string; message: string; stage: string; retryable: boolean }> }>
  | Readonly<{ readonly schemaVersion: 1; readonly type: "rpc.event"; readonly subscriptionId: string; readonly correlationId: string; readonly event: unknown }>;

const COMMANDS = new Set<RpcCommandKind>(["session.create", "session.list", "session.show", "session.checkout", "session.send", "session.steer", "session.follow-up", "session.shape", "session.reshape", "session.subscribe", "session.unsubscribe", "run.cancel", "approval.decide", "harness.plan", "resource.list", "resource.doctor", "project.inspect", "diagnose", "cache.stats", "cache.clear", "provider.list", "rpc.shutdown"]);
const ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const RESOURCE_SCOPES = new Set<ResourceScope>(["builtin", "user", "project", "session"]);

interface RpcPayloads {
  readonly "session.create": Readonly<{ title?: string; providerId?: string }>;
  readonly "session.list": Readonly<Record<never, never>>;
  readonly "session.show": Readonly<Record<never, never>>;
  readonly "session.checkout": Readonly<{ entryId?: string }>;
  readonly "session.send": Readonly<{ message: string }>;
  readonly "session.steer": Readonly<{ message: string }>;
  readonly "session.follow-up": Readonly<{ message: string }>;
  readonly "session.shape": Readonly<Record<never, never>>;
  readonly "session.reshape": AgentShapeRequest;
  readonly "session.subscribe": Readonly<{ subscriptionId: string; afterSessionSequence?: number }>;
  readonly "session.unsubscribe": Readonly<{ subscriptionId: string }>;
  readonly "run.cancel": Readonly<{ runId: string; reason?: string }>;
  readonly "approval.decide": Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean; reason?: string }>;
  readonly "harness.plan": Readonly<{ prompt: string; overlay?: HarnessTaskOverlay }>;
  readonly "resource.list": Readonly<{ disabledScopes?: readonly ResourceScope[]; disabledIds?: readonly string[] }>;
  readonly "resource.doctor": Readonly<{ disabledScopes?: readonly ResourceScope[]; disabledIds?: readonly string[] }>;
  readonly "project.inspect": Readonly<{ refresh?: boolean }>;
  readonly diagnose: Readonly<Record<never, never>>;
  readonly "cache.stats": Readonly<Record<never, never>>;
  readonly "cache.clear": Readonly<{ namespace?: string }>;
  readonly "provider.list": Readonly<Record<never, never>>;
  readonly "rpc.shutdown": Readonly<Record<never, never>>;
}

export function decodeRpcLine(line: string): RpcInbound {
  if (Buffer.byteLength(line) > DESKTOP_RPC_MAX_LINE_BYTES) throw protocolError("RPC line exceeds the maximum size.");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch (error) { throw new AlphionError("validation", "RPC line is not valid JSON.", { stage: "rpc", cause: error }); }
  const value = record(parsed, "RPC message must be an object.");
  if (value.schemaVersion !== 1) throw new AlphionError("incompatible-schema", "Unsupported RPC schema version.", { stage: "rpc" });
  if (value.type === "rpc.hello") {
    exact(value, ["schemaVersion", "type", "requestId", "supportedVersions"]);
    const requestId = identifier(value.requestId, "requestId");
    if (!Array.isArray(value.supportedVersions) || !value.supportedVersions.every(Number.isSafeInteger)) throw protocolError("supportedVersions must be integers.");
    return Object.freeze({ schemaVersion: 1, type: "rpc.hello", requestId, supportedVersions: Object.freeze([...value.supportedVersions] as number[]) });
  }
  if (value.type !== "rpc.request") throw protocolError("Unknown RPC message type.");
  exact(value, ["schemaVersion", "type", "requestId", "kind", "sessionId", "expectedRevision", "idempotencyKey", "payload"]);
  const requestId = identifier(value.requestId, "requestId");
  if (typeof value.kind !== "string" || !COMMANDS.has(value.kind as RpcCommandKind)) throw protocolError("Unknown RPC command kind.");
  const sessionId = value.sessionId === undefined ? undefined : identifier(value.sessionId, "sessionId");
  if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0)) throw protocolError("expectedRevision must be a non-negative integer.");
  const idempotencyKey = value.idempotencyKey === undefined ? undefined : identifier(value.idempotencyKey, "idempotencyKey");
  const kind = value.kind as RpcCommandKind;
  const payload = decodePayload(kind, record(value.payload ?? {}, "RPC payload must be an object."));
  return Object.freeze({ schemaVersion: 1, type: "rpc.request", requestId, kind, ...(sessionId ? { sessionId } : {}), ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision as number } : {}), ...(idempotencyKey ? { idempotencyKey } : {}), payload }) as RpcRequest;
}

function decodePayload<K extends RpcCommandKind>(kind: K, payload: Record<string, unknown>): RpcPayloads[K] {
  const fields: Readonly<Record<RpcCommandKind, readonly string[]>> = {
    "session.create": ["title", "providerId"], "session.list": [], "session.show": [], "session.checkout": ["entryId"],
    "session.send": ["message"], "session.steer": ["message"], "session.follow-up": ["message"], "session.shape": [],
    "session.reshape": ["goal", "resourceIds", "capabilities", "policies", "toolIds", "providerId", "behavior", "promptBudgetTokens"],
    "session.subscribe": ["subscriptionId", "afterSessionSequence"], "session.unsubscribe": ["subscriptionId"], "run.cancel": ["runId", "reason"],
    "approval.decide": ["requestId", "actionDigest", "shapeDigest", "approved", "reason"],
    "harness.plan": ["prompt", "overlay"], "resource.list": ["disabledScopes", "disabledIds"], "resource.doctor": ["disabledScopes", "disabledIds"],
    "project.inspect": ["refresh"], diagnose: [], "cache.stats": [], "cache.clear": ["namespace"], "provider.list": [], "rpc.shutdown": [],
  };
  exact(payload, fields[kind]);
  const stringValue = (key: string, required = false): string | undefined => {
    const value = payload[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || (required && !value.trim())) throw protocolError(`${key} must be a${required ? " non-empty" : ""} string.`);
    return value;
  };
  const optionalStrings = (key: string): readonly string[] | undefined => payload[key] === undefined ? undefined : stringArray(payload[key], key);
  let decoded: Readonly<Record<string, unknown>>;
  switch (kind) {
    case "session.create": decoded = compact({ title: stringValue("title"), providerId: stringValue("providerId") }); break;
    case "session.checkout": decoded = compact({ entryId: stringValue("entryId") }); break;
    case "session.send": case "session.steer": case "session.follow-up": decoded = { message: stringValue("message", true) }; break;
    case "session.reshape": return decodeShapeRequest(payload) as RpcPayloads[K];
    case "session.subscribe": decoded = compact({ subscriptionId: identifier(payload.subscriptionId, "subscriptionId"), afterSessionSequence: optionalInteger(payload.afterSessionSequence, "afterSessionSequence", 0) }); break;
    case "session.unsubscribe": decoded = { subscriptionId: identifier(payload.subscriptionId, "subscriptionId") }; break;
    case "run.cancel": decoded = compact({ runId: identifier(payload.runId, "runId"), reason: stringValue("reason") }); break;
    case "approval.decide": {
      if (typeof payload.approved !== "boolean") throw protocolError("approved must be boolean.");
      decoded = compact({ requestId: identifier(payload.requestId, "requestId"), actionDigest: digest(payload.actionDigest, "actionDigest"), shapeDigest: payload.shapeDigest === undefined ? undefined : digest(payload.shapeDigest, "shapeDigest"), approved: payload.approved, reason: stringValue("reason") });
      break;
    }
    case "harness.plan": decoded = compact({ prompt: stringValue("prompt", true), overlay: payload.overlay === undefined ? undefined : decodeOverlay(payload.overlay) }); break;
    case "resource.list": case "resource.doctor": {
      const disabledScopes = optionalStrings("disabledScopes");
      if (disabledScopes?.some((scope) => !RESOURCE_SCOPES.has(scope as ResourceScope))) throw protocolError("disabledScopes contains an unknown resource scope.");
      decoded = compact({ disabledScopes: disabledScopes as readonly ResourceScope[] | undefined, disabledIds: optionalStrings("disabledIds") });
      break;
    }
    case "project.inspect": if (payload.refresh !== undefined && typeof payload.refresh !== "boolean") throw protocolError("refresh must be boolean."); else decoded = compact({ refresh: payload.refresh }); break;
    case "cache.clear": decoded = compact({ namespace: stringValue("namespace") }); break;
    default: decoded = {};
  }
  return Object.freeze(decoded) as RpcPayloads[K];
}

function decodeShapeRequest(payload: Record<string, unknown>): AgentShapeRequest {
  const behavior = payload.behavior === undefined ? undefined : decodeBehavior(payload.behavior);
  const promptBudgetTokens = optionalInteger(payload.promptBudgetTokens, "promptBudgetTokens", 256, 128_000);
  const resourceIds = optionalStringArray(payload.resourceIds, "resourceIds");
  const capabilities = optionalStringArray(payload.capabilities, "capabilities");
  const policies = optionalStringArray(payload.policies, "policies");
  const toolIds = optionalStringArray(payload.toolIds, "toolIds");
  const providerId = optionalText(payload.providerId, "providerId");
  return Object.freeze({ goal: requiredText(payload.goal, "goal"), ...(resourceIds ? { resourceIds } : {}), ...(capabilities ? { capabilities } : {}), ...(policies ? { policies } : {}), ...(toolIds ? { toolIds } : {}), ...(providerId ? { providerId } : {}), ...(behavior ? { behavior } : {}), ...(promptBudgetTokens !== undefined ? { promptBudgetTokens } : {}) });
}
function decodeBehavior(value: unknown): Partial<SessionBehavior> { const item = record(value, "behavior must be an object."); exact(item, ["compaction", "steering", "followUps"]); if (item.compaction !== undefined && item.compaction !== "deterministic" && item.compaction !== "hybrid") throw protocolError("behavior.compaction is invalid."); for (const key of ["steering", "followUps"] as const) if (item[key] !== undefined && typeof item[key] !== "boolean") throw protocolError(`behavior.${key} must be boolean.`); return Object.freeze(compact({ compaction: item.compaction, steering: item.steering, followUps: item.followUps })) as Partial<SessionBehavior>; }
function decodeOverlay(value: unknown): HarnessTaskOverlay { const item = record(value, "overlay must be an object."); exact(item, ["capabilities", "permissions", "budgets", "evaluator"]); const evaluator = item.evaluator; if (evaluator !== undefined && evaluator !== "acceptance-criteria" && evaluator !== "quality-gate") throw protocolError("overlay.evaluator is invalid."); let budgets: Readonly<Record<string, number>> | undefined; if (item.budgets !== undefined) { const raw = record(item.budgets, "overlay.budgets must be an object."); const entries = Object.entries(raw); if (entries.some(([key, amount]) => !ID.test(key) || !Number.isSafeInteger(amount) || (amount as number) < 0)) throw protocolError("overlay.budgets must contain non-negative integers."); budgets = Object.freeze(Object.fromEntries(entries) as Record<string, number>); } return Object.freeze(compact({ capabilities: optionalStringArray(item.capabilities, "overlay.capabilities"), permissions: optionalStringArray(item.permissions, "overlay.permissions"), budgets, evaluator })) as HarnessTaskOverlay; }
function optionalStringArray(value: unknown, label: string): readonly string[] | undefined { return value === undefined ? undefined : stringArray(value, label); }
function stringArray(value: unknown, label: string): readonly string[] { if (!Array.isArray(value)) throw protocolError(`${label} must contain non-empty bounded strings.`); const strings: string[] = []; for (const item of value) { if (typeof item !== "string" || !item.trim() || item.length > 200) throw protocolError(`${label} must contain non-empty bounded strings.`); strings.push(item); } return Object.freeze([...new Set(strings)]); }
function requiredText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw protocolError(`${label} must be a non-empty string.`); return value; }
function optionalText(value: unknown, label: string): string | undefined { return value === undefined ? undefined : requiredText(value, label); }
function optionalInteger(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined { if (value === undefined) return undefined; if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw protocolError(`${label} must be an integer between ${minimum} and ${maximum}.`); return value as number; }
function digest(value: unknown, label: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw protocolError(`${label} must be a SHA-256 digest.`); return value; }
function compact(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }

function record(value: unknown, message: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError(message); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: readonly string[]): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length > 0) throw protocolError(`Unknown RPC field: ${unknown.join(", ")}.`); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !ID.test(value)) throw protocolError(`${label} is invalid.`); return value; }
function protocolError(message: string): AlphionError { return new AlphionError("validation", message, { stage: "rpc" }); }
