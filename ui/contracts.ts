import type { AgentEvent, AgentStreamControlEvent } from "../src/index.js";

export type UiCommand =
  | Readonly<{ readonly kind: "project.list" }>
  | Readonly<{ readonly kind: "project.activate"; readonly projectId: string }>
  | Readonly<{ readonly kind: "session.list" }>
  | Readonly<{ readonly kind: "session.create"; readonly title: string; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.show"; readonly sessionId: string }>
  | Readonly<{ readonly kind: "session.send"; readonly sessionId: string; readonly message: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.steer" | "session.follow-up"; readonly sessionId: string; readonly message: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.checkout"; readonly sessionId: string; readonly entryId?: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.reshape"; readonly sessionId: string; readonly goal: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "provider.list" }>
  | Readonly<{ readonly kind: "resource.list" }>
  | Readonly<{ readonly kind: "doctor" }>
  | Readonly<{ readonly kind: "harness.plan"; readonly prompt: string }>
  | Readonly<{ readonly kind: "run.cancel"; readonly runId: string; readonly reason?: string }>;

export interface UiCommandEnvelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly command: UiCommand;
}

export interface UiCommandResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly status: "ok" | "accepted";
  readonly result: unknown;
}

export type UiEventPayload =
  | Readonly<{ readonly kind: "agent.event"; readonly event: AgentEvent | AgentStreamControlEvent }>
  | Readonly<{ readonly kind: "run.delta"; readonly runId: string; readonly sessionId: string; readonly delta: string }>
  | Readonly<{ readonly kind: "run.finished"; readonly runId: string; readonly sessionId: string; readonly status: string; readonly finalText: string }>
  | Readonly<{ readonly kind: "approval.challenge"; readonly requestId: string; readonly runId: string; readonly toolName: string; readonly actionDigest: string; readonly shapeDigest?: string; readonly summary: string }>
  | Readonly<{ readonly kind: "stream.resync-required"; readonly cursor: number }>;

export interface UiEventEnvelope {
  readonly schemaVersion: 1;
  readonly cursor: number;
  readonly timestamp: string;
  readonly payload: UiEventPayload;
}

export interface UiCommandClient {
  execute(envelope: UiCommandEnvelope): Promise<UiCommandResult>;
  subscribe(afterCursor?: number): AsyncIterable<UiEventEnvelope>;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(input: Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean }>): void;
  close(): Promise<void>;
}

export function decodeUiCommandEnvelope(value: unknown): UiCommandEnvelope {
  const envelope = record(value, "UI command envelope");
  exact(envelope, ["schemaVersion", "requestId", "command"]);
  if (envelope.schemaVersion !== 1 || !validId(envelope.requestId)) throw new Error("Unsupported UI command envelope.");
  return Object.freeze({ schemaVersion: 1, requestId: envelope.requestId, command: decodeCommand(envelope.command) });
}

function decodeCommand(value: unknown): UiCommand {
  const input = record(value, "UI command");
  if (typeof input.kind !== "string") throw new Error("UI command kind is required.");
  switch (input.kind) {
    case "project.list": case "session.list": case "provider.list": case "resource.list": case "doctor":
      exact(input, ["kind"]); return Object.freeze({ kind: input.kind });
    case "project.activate": exact(input, ["kind", "projectId"]); return Object.freeze({ kind: input.kind, projectId: requiredText(input.projectId) });
    case "session.create": exact(input, ["kind", "title", "idempotencyKey"]); return Object.freeze({ kind: input.kind, title: requiredText(input.title), idempotencyKey: commandKey(input.idempotencyKey) });
    case "session.show": exact(input, ["kind", "sessionId"]); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId) });
    case "session.send": case "session.steer": case "session.follow-up":
      exact(input, ["kind", "sessionId", "message", "expectedRevision", "idempotencyKey"]);
      return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), message: requiredText(input.message), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "session.checkout": {
      exact(input, ["kind", "sessionId", "entryId", "expectedRevision", "idempotencyKey"]);
      const entryId = input.entryId === undefined ? undefined : requiredText(input.entryId);
      return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), ...(entryId ? { entryId } : {}), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    }
    case "session.reshape": exact(input, ["kind", "sessionId", "goal", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), goal: requiredText(input.goal), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "harness.plan": exact(input, ["kind", "prompt"]); return Object.freeze({ kind: input.kind, prompt: requiredText(input.prompt) });
    case "run.cancel": {
      exact(input, ["kind", "runId", "reason"]); const reason = input.reason === undefined ? undefined : requiredText(input.reason);
      return Object.freeze({ kind: input.kind, runId: requiredText(input.runId), ...(reason ? { reason } : {}) });
    }
    default: throw new Error("Unknown UI command kind.");
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Readonly<Record<string, unknown>>; }
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown UI command field."); }
function requiredText(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 64 * 1024) throw new Error("A bounded non-empty string is required."); return value.trim(); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{8,200}$/u.test(value); }
function commandKey(value: unknown): string { if (!validId(value)) throw new Error("A valid idempotency key is required."); return value; }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("A non-negative expected revision is required."); return value as number; }
