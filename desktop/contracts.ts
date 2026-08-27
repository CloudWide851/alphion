import type { ImageAttachmentRef } from "../src/index.js";
import type { UiCommandEnvelope, UiCommandResult, UiEventFrame } from "../ui/contracts.js";

export const DESKTOP_IPC_SCHEMA_VERSION = 1 as const;
export const DESKTOP_IPC_CHANNELS = Object.freeze({
  command: "alphion:command",
  event: "alphion:event",
  credential: "alphion:credential",
  approval: "alphion:approval",
  external: "alphion:external",
  attachmentImport: "alphion:attachment-import",
  attachmentRead: "alphion:attachment-read",
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
  subscribe(listener: (frame: UiEventFrame) => void): () => void;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(decision: DesktopApprovalDecision): Promise<void>;
  openExternal(href: string): Promise<boolean>;
  importAttachment(fileName: string, bytes: Uint8Array): Promise<ImageAttachmentRef>;
  readAttachment(attachmentId: string): Promise<Readonly<{ ref: ImageAttachmentRef; bytes: Uint8Array }>>;
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

export function decodeDesktopAttachmentImport(value: unknown): Readonly<{ fileName: string; bytes: Uint8Array }> {
  const input = record(value, "Desktop image attachment"); exact(input, ["fileName", "bytes"]);
  const fileName = text(input.fileName); const bytes = input.bytes;
  if (!fileName || fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(fileName) || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024) throw new Error("Desktop image attachment is invalid.");
  return Object.freeze({ fileName, bytes: Uint8Array.from(bytes) });
}
export function decodeDesktopAttachmentId(value: unknown): string { const id = text(value); if (!/^[A-Za-z0-9:_-]{4,200}$/u.test(id)) throw new Error("Desktop image attachment ID is invalid."); return id; }

function record(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Readonly<Record<string, unknown>>; }
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown Desktop IPC field."); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{8,200}$/u.test(value); }
