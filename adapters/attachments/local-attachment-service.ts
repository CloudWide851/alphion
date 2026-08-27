import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { assertImageAttachmentRef } from "../../src/application/attachments.js";
import { IMAGE_ATTACHMENT_LIMITS, type AttachmentImportInput, type ImageAttachmentRef, type ImageMediaType, type StoredImageAttachment } from "../../src/domain/attachment-contracts.js";
import type { AttachmentService, AttachmentStore } from "../../src/ports/index.js";

export interface LocalAttachmentServiceOptions {
  readonly root: string;
  readonly domainId: string;
  readonly projectId?: string;
  readonly store: AttachmentStore;
}

export class LocalAttachmentService implements AttachmentService {
  readonly #root: string;
  constructor(private readonly options: LocalAttachmentServiceOptions) { this.#root = resolve(options.root); }

  async importFile(path: string, signal?: AbortSignal): Promise<ImageAttachmentRef> {
    assertNotAborted(signal);
    const requested = resolve(path);
    const link = await lstat(requested).catch((error) => { throw unavailable("Image file cannot be opened.", error); });
    if (!link.isFile() || link.isSymbolicLink()) throw invalid("Image import requires a regular, non-symbolic-link file.");
    const canonical = await realpath(requested).catch((error) => { throw unavailable("Image file cannot be resolved.", error); });
    const handle = await open(canonical, "r").catch((error) => { throw unavailable("Image file cannot be opened.", error); });
    try {
      const before = await handle.stat();
      assertFileSize(before.size);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) throw new AlphionError("conflict", "Image file changed while it was being imported.", { stage: "attachment" });
      return this.#import({ fileName: basename(canonical), bytes }, signal);
    } finally { await handle.close(); }
  }

  importBytes(input: AttachmentImportInput, signal?: AbortSignal): Promise<ImageAttachmentRef> {
    return this.#import({ fileName: input.fileName, bytes: Uint8Array.from(input.bytes) }, signal);
  }

  async get(attachmentId: string): Promise<ImageAttachmentRef | undefined> {
    const stored = await this.options.store.getAttachment(attachmentId);
    return stored ? toRef(stored) : undefined;
  }

  async readAttachment(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<Uint8Array> {
    assertNotAborted(signal); assertImageAttachmentRef(attachment);
    if (attachment.domainId !== this.options.domainId || attachment.projectId !== this.options.projectId) throw new AlphionError("forbidden", "Image attachment belongs to another Project domain.", { stage: "attachment" });
    const stored = await this.options.store.getAttachment(attachment.id);
    if (!stored || !sameRef(stored, attachment)) throw new AlphionError("integrity-failed", "Image attachment metadata does not match durable state.", { stage: "attachment" });
    const path = safeStoragePath(this.#root, stored.storageKey);
    const metadata = await lstat(path).catch((error) => { throw unavailable("Image attachment content is unavailable.", error); });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== stored.byteSize) throw new AlphionError("integrity-failed", "Image attachment content identity is invalid.", { stage: "attachment" });
    const handle = await open(path, "r");
    try {
      const bytes = await handle.readFile();
      assertNotAborted(signal);
      if (bytes.byteLength !== stored.byteSize || sha256(bytes) !== stored.digest) throw new AlphionError("integrity-failed", "Image attachment content digest is invalid.", { stage: "attachment" });
      return Uint8Array.from(bytes);
    } finally { await handle.close(); }
  }

  async cleanupDrafts(before = new Date(Date.now() - 24 * 60 * 60 * 1_000), limit = 64): Promise<number> {
    const removed = await this.options.store.removeUnreferencedAttachments(before.toISOString(), limit);
    await Promise.all(removed.map((item) => rm(safeStoragePath(this.#root, item.storageKey), { force: true }).catch(() => undefined)));
    return removed.length;
  }

  async #import(input: AttachmentImportInput, signal?: AbortSignal): Promise<ImageAttachmentRef> {
    assertNotAborted(signal);
    assertFileSize(input.bytes.byteLength);
    const bytes = Uint8Array.from(input.bytes);
    const image = inspectImage(bytes);
    const digest = sha256(bytes);
    const existing = await this.options.store.findAttachment(this.options.domainId, digest);
    if (existing) { await this.#ensureStored(existing, bytes); return toRef(existing); }
    const extension = extensionFor(image.mediaType);
    const storageKey = `${digest.slice(0, 2)}/${digest}.${extension}`;
    const record: StoredImageAttachment = Object.freeze({
      schemaVersion: 1, id: createId("attachment"), domainId: this.options.domainId,
      ...(this.options.projectId ? { projectId: this.options.projectId } : {}), digest, mediaType: image.mediaType,
      byteSize: bytes.byteLength, width: image.width, height: image.height, fileName: safeFileName(input.fileName, extension),
      storageKey, createdAt: new Date().toISOString(),
    });
    await this.#ensureStored(record, bytes);
    return this.options.store.putAttachment(record);
  }

  async #ensureStored(record: StoredImageAttachment, bytes: Uint8Array): Promise<void> {
    const destination = safeStoragePath(this.#root, record.storageKey);
    await mkdir(dirname(destination), { recursive: true });
    let handle;
    try { handle = await open(destination, "wx", 0o600); }
    catch (error) {
      if (!isExists(error)) throw unavailable("Image attachment content cannot be stored.", error);
      const current = await stat(destination);
      if (!current.isFile() || current.size !== record.byteSize) throw new AlphionError("integrity-failed", "Existing image attachment content is invalid.", { stage: "attachment" });
      const existing = await open(destination, "r");
      try { if (sha256(await existing.readFile()) !== record.digest) throw new AlphionError("integrity-failed", "Existing image attachment digest is invalid.", { stage: "attachment" }); }
      finally { await existing.close(); }
      return;
    }
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await rm(destination, { force: true }).catch(() => undefined); throw unavailable("Image attachment content cannot be stored.", error); }
    finally { await handle.close(); }
  }
}

export function defaultUnownedAttachmentRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ALPHION_HOME?.trim()) return join(resolve(environment.ALPHION_HOME), "attachments");
  if (process.platform === "win32") return join(environment.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "alphion", "attachments");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "alphion", "attachments");
  return join(environment.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "alphion", "attachments");
}

function inspectImage(bytes: Uint8Array): Readonly<{ mediaType: ImageMediaType; width: number; height: number }> {
  const image = pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
  if (!image) throw invalid("Only valid PNG, JPEG, WebP, and GIF images are supported.");
  if (image.width < 1 || image.height < 1 || image.width > IMAGE_ATTACHMENT_LIMITS.maxDimension || image.height > IMAGE_ATTACHMENT_LIMITS.maxDimension || image.width * image.height > IMAGE_ATTACHMENT_LIMITS.maxPixels) throw invalid("Image dimensions exceed the safe pixel limit.");
  return image;
}

function pngSize(b: Uint8Array) { return b.length >= 24 && hex(b, 0, 8) === "89504e470d0a1a0a" && text(b, 12, 16) === "IHDR" ? { mediaType: "image/png" as const, width: be32(b, 16), height: be32(b, 20) } : undefined; }
function gifSize(b: Uint8Array) { const header = text(b, 0, 6); return b.length >= 10 && (header === "GIF87a" || header === "GIF89a") ? { mediaType: "image/gif" as const, width: le16(b, 6), height: le16(b, 8) } : undefined; }
function jpegSize(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= b.length) {
    while (b[offset] === 0xff) offset += 1;
    const marker = b[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    const length = be16(b, offset); if (length < 2 || offset + length > b.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { mediaType: "image/jpeg" as const, width: be16(b, offset + 5), height: be16(b, offset + 3) };
    offset += length;
  }
  return undefined;
}
function webpSize(b: Uint8Array) {
  if (b.length < 30 || text(b, 0, 4) !== "RIFF" || text(b, 8, 12) !== "WEBP") return undefined;
  const kind = text(b, 12, 16);
  if (kind === "VP8X") return { mediaType: "image/webp" as const, width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  if (kind === "VP8L" && b[20] === 0x2f) return { mediaType: "image/webp" as const, width: 1 + (b[21]! | ((b[22]! & 0x3f) << 8)), height: 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)) };
  if (kind === "VP8 " && hex(b, 23, 26) === "9d012a") return { mediaType: "image/webp" as const, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  return undefined;
}

function assertFileSize(size: number): void { if (!Number.isSafeInteger(size) || size < 1 || size > IMAGE_ATTACHMENT_LIMITS.perImageBytes) throw invalid("Each image must be between 1 byte and 20 MiB."); }
function safeStoragePath(root: string, key: string): string { const path = resolve(root, key); const rel = relative(root, path); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new AlphionError("integrity-failed", "Attachment storage key escapes its root.", { stage: "attachment" }); return path; }
function safeFileName(value: string, extension: string): string { const stem = basename(value, extname(value)).replace(/[\u0000-\u001f\u007f/\\]/gu, "-").trim().slice(0, 220) || "image"; return `${stem}.${extension}`; }
function toRef(value: StoredImageAttachment): ImageAttachmentRef { return Object.freeze({ schemaVersion: 1, id: value.id, domainId: value.domainId, ...(value.projectId ? { projectId: value.projectId } : {}), digest: value.digest, mediaType: value.mediaType, byteSize: value.byteSize, width: value.width, height: value.height, fileName: value.fileName }); }
function sameRef(a: StoredImageAttachment, b: ImageAttachmentRef): boolean { return a.id === b.id && a.domainId === b.domainId && a.projectId === b.projectId && a.digest === b.digest && a.mediaType === b.mediaType && a.byteSize === b.byteSize && a.width === b.width && a.height === b.height; }
function extensionFor(type: ImageMediaType): "png" | "jpg" | "webp" | "gif" { return type === "image/jpeg" ? "jpg" : type.slice("image/".length) as "png" | "webp" | "gif"; }
function be16(b: Uint8Array, o: number): number { return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0); }
function be32(b: Uint8Array, o: number): number { return ((b[o] ?? 0) * 0x1000000) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0); }
function le16(b: Uint8Array, o: number): number { return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8); }
function le24(b: Uint8Array, o: number): number { return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16); }
function text(b: Uint8Array, start: number, end: number): string { return String.fromCharCode(...b.slice(start, end)); }
function hex(b: Uint8Array, start: number, end: number): string { return Buffer.from(b.slice(start, end)).toString("hex"); }
function assertNotAborted(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Image import cancelled.", "AbortError"); }
function invalid(message: string): AlphionError { return new AlphionError("validation", message, { stage: "attachment" }); }
function unavailable(message: string, cause: unknown): AlphionError { return new AlphionError("dependency-unavailable", message, { stage: "attachment", cause }); }
function isExists(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST"; }
