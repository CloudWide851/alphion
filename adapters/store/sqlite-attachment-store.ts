import type { AgentMessage, AgentSessionRecord } from "../../src/domain/contracts.js";
import type { ImageAttachmentRef, StoredImageAttachment } from "../../src/domain/attachment-contracts.js";
import { assertImageAttachmentRef, messageAttachments } from "../../src/application/attachments.js";
import { AlphionError } from "../../src/application/errors.js";
import type { SqliteDatabase } from "./database.js";
import { optionalRow, readNullableString, readNumber, readString, requiredRow } from "./sqlite-codecs.js";

export function putStoredAttachment(database: SqliteDatabase, attachment: StoredImageAttachment): ImageAttachmentRef {
  assertStoredAttachment(attachment);
  database.prepare(`INSERT OR IGNORE INTO attachments
    (id, domain_id, project_id, sha256, media_type, byte_size, width, height, file_name, storage_key, created_at, referenced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    attachment.id, attachment.domainId, attachment.projectId ?? null, attachment.digest, attachment.mediaType,
    attachment.byteSize, attachment.width, attachment.height, attachment.fileName, attachment.storageKey, attachment.createdAt, attachment.referencedAt ?? null,
  );
  const stored = findStoredAttachment(database, attachment.domainId, attachment.digest);
  if (!stored) throw new AlphionError("integrity-failed", "Attachment metadata could not be persisted.", { stage: "database" });
  return attachmentRef(stored);
}

export function getStoredAttachment(database: SqliteDatabase, attachmentId: string): StoredImageAttachment | undefined {
  const row = optionalRow(database.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId));
  return row ? decodeStoredAttachment(row) : undefined;
}

export function findStoredAttachment(database: SqliteDatabase, domainId: string, digest: string): StoredImageAttachment | undefined {
  const row = optionalRow(database.prepare("SELECT * FROM attachments WHERE domain_id = ? AND sha256 = ?").get(domainId, digest));
  return row ? decodeStoredAttachment(row) : undefined;
}

export function removeStoredDraftAttachments(database: SqliteDatabase, before: string, limit = 64): readonly StoredImageAttachment[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new AlphionError("validation", "Attachment cleanup limit must be 1-256.", { stage: "attachment" });
  const records = database.prepare("SELECT * FROM attachments WHERE referenced_at IS NULL AND created_at < ? ORDER BY created_at, id LIMIT ?").all(before, limit).map(requiredRow).map(decodeStoredAttachment);
  const remove = database.prepare("DELETE FROM attachments WHERE id = ? AND referenced_at IS NULL");
  for (const record of records) remove.run(record.id);
  return Object.freeze(records);
}

export function linkStoredMessageAttachments(database: SqliteDatabase, session: AgentSessionRecord, message: AgentMessage, createdAt: string): void {
  const attachments = messageAttachments(message);
  if (attachments.length === 0) return;
  const insert = database.prepare("INSERT OR IGNORE INTO message_attachments (session_id, message_id, attachment_id, position, created_at) VALUES (?, ?, ?, ?, ?)");
  const mark = database.prepare("UPDATE attachments SET referenced_at = COALESCE(referenced_at, ?) WHERE id = ?");
  for (const [position, attachment] of attachments.entries()) {
    const stored = getStoredAttachment(database, attachment.id);
    if (!stored || stored.domainId !== session.domainId || stored.projectId !== session.projectId || !sameAttachment(stored, attachment)) {
      throw new AlphionError("validation", "Image attachment is unavailable in this Project domain.", { stage: "attachment" });
    }
    insert.run(session.id, message.id, attachment.id, position, createdAt);
    mark.run(createdAt, attachment.id);
  }
}

function decodeStoredAttachment(row: Readonly<Record<string, unknown>>): StoredImageAttachment {
  const value: StoredImageAttachment = {
    schemaVersion: 1,
    id: readString(row, "id"), domainId: readString(row, "domain_id"),
    ...(readNullableString(row, "project_id") ? { projectId: readString(row, "project_id") } : {}),
    digest: readString(row, "sha256"), mediaType: readString(row, "media_type") as StoredImageAttachment["mediaType"],
    byteSize: readNumber(row, "byte_size"), width: readNumber(row, "width"), height: readNumber(row, "height"),
    fileName: readString(row, "file_name"), storageKey: readString(row, "storage_key"), createdAt: readString(row, "created_at"),
    ...(readNullableString(row, "referenced_at") ? { referencedAt: readString(row, "referenced_at") } : {}),
  };
  assertStoredAttachment(value);
  return Object.freeze(value);
}

function assertStoredAttachment(value: StoredImageAttachment): void {
  assertImageAttachmentRef(attachmentRef(value));
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/u.test(value.storageKey)) throw new AlphionError("validation", "Attachment storage key is invalid.", { stage: "attachment" });
  if (!value.createdAt || Number.isNaN(Date.parse(value.createdAt)) || (value.referencedAt && Number.isNaN(Date.parse(value.referencedAt)))) throw new AlphionError("validation", "Attachment timestamps are invalid.", { stage: "attachment" });
}

function attachmentRef(value: StoredImageAttachment): ImageAttachmentRef {
  return Object.freeze({ schemaVersion: 1, id: value.id, domainId: value.domainId, ...(value.projectId ? { projectId: value.projectId } : {}), digest: value.digest, mediaType: value.mediaType, byteSize: value.byteSize, width: value.width, height: value.height, fileName: value.fileName });
}
function sameAttachment(stored: StoredImageAttachment, ref: ImageAttachmentRef): boolean { return stored.domainId === ref.domainId && stored.projectId === ref.projectId && stored.digest === ref.digest && stored.mediaType === ref.mediaType && stored.byteSize === ref.byteSize && stored.width === ref.width && stored.height === ref.height && stored.fileName === ref.fileName; }
