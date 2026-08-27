import type { AgentMessage, ProviderMessage } from "../domain/contracts.js";
import { IMAGE_ATTACHMENT_LIMITS, type ImageAttachmentRef, type SessionMessageInput } from "../domain/attachment-contracts.js";
import { AlphionError } from "./errors.js";

export function normalizeSessionMessageInput(value: string | SessionMessageInput): SessionMessageInput {
  const input = typeof value === "string" ? { schemaVersion: 1 as const, text: value } : value;
  if (input.schemaVersion !== 1) throw invalid("Unsupported Session message input schema.");
  const text = input.text?.trim() ?? "";
  const attachments = [...(input.attachments ?? [])];
  if (!text && attachments.length === 0) throw invalid("Session message must contain text or an image.");
  if (text.length > 64 * 1024) throw invalid("Session message text exceeds 65536 characters.");
  if (attachments.length > IMAGE_ATTACHMENT_LIMITS.perMessage) throw invalid(`A message may contain at most ${IMAGE_ATTACHMENT_LIMITS.perMessage} images.`);
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    assertImageAttachmentRef(attachment);
    if (seen.has(attachment.id)) throw invalid("A message cannot contain the same image twice.");
    seen.add(attachment.id);
    totalBytes += attachment.byteSize;
  }
  if (totalBytes > IMAGE_ATTACHMENT_LIMITS.perMessageBytes) throw invalid("Message images exceed the 80 MiB total limit.");
  return Object.freeze({ schemaVersion: 1, ...(text ? { text } : {}), ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}) });
}

export function decodeSessionMessageInput(value: unknown): SessionMessageInput {
  if (typeof value === "string") return normalizeSessionMessageInput(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Session message input must be an object.");
  const input = value as Readonly<Record<string, unknown>>;
  if (Object.keys(input).some((key) => !["schemaVersion", "text", "attachments"].includes(key)) || input.schemaVersion !== 1 || (input.text !== undefined && typeof input.text !== "string") || (input.attachments !== undefined && !Array.isArray(input.attachments))) throw invalid("Session message input contains an unsupported field.");
  return normalizeSessionMessageInput({ schemaVersion: 1, ...(typeof input.text === "string" ? { text: input.text } : {}), ...(Array.isArray(input.attachments) ? { attachments: input.attachments } : {}) });
}

export function createUserMessage(input: SessionMessageInput, id: string, createdAt: string): Extract<AgentMessage, { readonly kind: "user" }> {
  const normalized = normalizeSessionMessageInput(input);
  if (!normalized.attachments?.length) return Object.freeze({ schemaVersion: 1, kind: "user", id, createdAt, content: normalized.text ?? "" });
  return Object.freeze({ schemaVersion: 3, kind: "user", id, createdAt, content: normalized.text ?? "", attachments: normalized.attachments });
}

export function userMessageInput(message: Extract<AgentMessage, { readonly kind: "user" }>): SessionMessageInput {
  return Object.freeze({ schemaVersion: 1, ...(message.content ? { text: message.content } : {}), ...(message.schemaVersion === 3 ? { attachments: message.attachments } : {}) });
}

export function providerUserMessage(input: SessionMessageInput): Extract<ProviderMessage, { readonly role: "user" }> {
  const normalized = normalizeSessionMessageInput(input);
  if (!normalized.attachments?.length) return Object.freeze({ role: "user", content: normalized.text ?? "" });
  return Object.freeze({ role: "user", content: Object.freeze([
    ...(normalized.text ? [Object.freeze({ type: "text" as const, text: normalized.text })] : []),
    ...normalized.attachments.map((attachment) => Object.freeze({ type: "image" as const, attachment })),
  ]) });
}

export function messageAttachments(message: AgentMessage): readonly ImageAttachmentRef[] {
  return message.kind === "user" && message.schemaVersion === 3 ? message.attachments : Object.freeze([]);
}

export function assertImageAttachmentRef(value: unknown): asserts value is ImageAttachmentRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Image attachment metadata must be an object.");
  const item = value as Readonly<Record<string, unknown>>;
  const keys = ["schemaVersion", "id", "domainId", "projectId", "digest", "mediaType", "byteSize", "width", "height", "fileName"];
  if (Object.keys(item).some((key) => !keys.includes(key)) || item.schemaVersion !== 1) throw invalid("Image attachment metadata contains an unsupported field or schema.");
  if (!safeId(item.id) || !safeId(item.domainId) || (item.projectId !== undefined && !safeId(item.projectId))) throw invalid("Image attachment identity is invalid.");
  if (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/u.test(item.digest)) throw invalid("Image attachment digest is invalid.");
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mediaType))) throw invalid("Image attachment media type is unsupported.");
  if (!bounded(item.byteSize, 1, IMAGE_ATTACHMENT_LIMITS.perImageBytes) || !bounded(item.width, 1, IMAGE_ATTACHMENT_LIMITS.maxDimension) || !bounded(item.height, 1, IMAGE_ATTACHMENT_LIMITS.maxDimension)) throw invalid("Image attachment dimensions or byte size are invalid.");
  if ((item.width as number) * (item.height as number) > IMAGE_ATTACHMENT_LIMITS.maxPixels) throw invalid("Image attachment exceeds the decoded pixel limit.");
  if (typeof item.fileName !== "string" || !item.fileName || item.fileName.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(item.fileName)) throw invalid("Image attachment file name is invalid.");
}

function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{4,200}$/u.test(value); }
function bounded(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function invalid(message: string): AlphionError { return new AlphionError("validation", message, { stage: "attachment" }); }
