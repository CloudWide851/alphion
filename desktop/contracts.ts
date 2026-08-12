import type { UiCommandEnvelope, UiCommandResult, UiEventEnvelope } from "../ui/contracts.js";

export const DESKTOP_IPC_SCHEMA_VERSION = 1 as const;
export const DESKTOP_IPC_CHANNELS = Object.freeze({
  command: "alphion:command",
  event: "alphion:event",
  credential: "alphion:credential",
  approval: "alphion:approval",
  external: "alphion:external",
} as const);

export interface DesktopApprovalDecision {
  readonly requestId: string;
  readonly actionDigest: string;
  readonly shapeDigest?: string;
  readonly approved: boolean;
}

/** The complete, narrow object exposed in the sandboxed Renderer. */
export interface DesktopRendererBridge {
  readonly schemaVersion: typeof DESKTOP_IPC_SCHEMA_VERSION;
  invoke(envelope: UiCommandEnvelope): Promise<UiCommandResult>;
  subscribe(listener: (event: UiEventEnvelope) => void): () => void;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(decision: DesktopApprovalDecision): Promise<void>;
  openExternal(href: string): Promise<boolean>;
}

export function decodeDesktopApprovalDecision(value: unknown): DesktopApprovalDecision {
  const input = record(value, "Desktop approval decision");
  exact(input, ["requestId", "actionDigest", "shapeDigest", "approved"]);
  if (!validId(input.requestId) || !/^[a-f0-9]{64}$/u.test(text(input.actionDigest)) || typeof input.approved !== "boolean") throw new Error("Desktop approval decision is invalid.");
  const shapeDigest = input.shapeDigest === undefined ? undefined : text(input.shapeDigest);
  if (shapeDigest !== undefined && !/^[a-f0-9]{64}$/u.test(shapeDigest)) throw new Error("Desktop shape digest is invalid.");
  return Object.freeze({ requestId: input.requestId, actionDigest: input.actionDigest as string, ...(shapeDigest ? { shapeDigest } : {}), approved: input.approved });
}

export function decodeDesktopCredential(value: unknown): Readonly<{ profileId: string; secret: string }> {
  const input = record(value, "Desktop credential"); exact(input, ["profileId", "secret"]);
  const profileId = text(input.profileId); const secret = typeof input.secret === "string" ? input.secret : "";
  if (!/^[A-Za-z0-9:_-]{1,200}$/u.test(profileId) || !secret || secret.length > 16 * 1024) throw new Error("Desktop credential payload is invalid.");
  return Object.freeze({ profileId, secret });
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Readonly<Record<string, unknown>>; }
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown Desktop IPC field."); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{8,200}$/u.test(value); }
