import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAttachmentService } from "../adapters/attachments/local-attachment-service.js";
import { toChatUserContent, toResponsesUserContent } from "../adapters/model/provider-image-content.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { createUserMessage, normalizeSessionMessageInput, providerUserMessage } from "../src/application/attachments.js";

test("content-addressed images persist metadata and ordered message references without binary JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v0100-attachment-"));
  const statePath = join(directory, "state.sqlite3");
  const root = join(directory, "attachments");
  const store = new SqliteStore({ path: statePath, domainId: "domain_attachment", projectId: "project_attachment" });
  try {
    const service = new LocalAttachmentService({ root, domainId: "domain_attachment", projectId: "project_attachment", store });
    const first = await service.importBytes({ fileName: "screen.png", bytes: png(640, 480) });
    const duplicate = await service.importBytes({ fileName: "duplicate.png", bytes: png(640, 480) });
    assert.equal(duplicate.id, first.id);
    assert.equal((await service.readAttachment(first)).byteLength, first.byteSize);
    const session = await store.createSession({ title: "images", idempotencyKey: "create:attachment-session" });
    const message = createUserMessage({ schemaVersion: 1, text: "查看图片", attachments: [first] }, "message_attachment", new Date(0).toISOString());
    await store.appendSessionEntry(session.id, message, { expectedRevision: session.revision, idempotencyKey: "append:attachment-message" });
    const view = await store.getSessionView(session.id);
    assert.deepEqual(view?.entries.at(-1)?.message, message);
    assert.ok((await store.getAttachment(first.id))?.referencedAt);
    assert.equal(Buffer.from(JSON.stringify(view)).includes(png(640, 480)), false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("image validation rejects unsafe formats, pixel bombs, duplicate refs, and excessive message counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v0100-invalid-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3"), domainId: "domain_invalid" });
  const service = new LocalAttachmentService({ root: join(directory, "attachments"), domainId: "domain_invalid", store });
  try {
    await assert.rejects(service.importBytes({ fileName: "fake.png", bytes: Uint8Array.from([1, 2, 3]) }), /PNG|JPEG|WebP|GIF/iu);
    await assert.rejects(service.importBytes({ fileName: "bomb.png", bytes: png(20_000, 20_000) }), /pixel/iu);
    const image = await service.importBytes({ fileName: "ok.png", bytes: png(32, 32) });
    assert.throws(() => normalizeSessionMessageInput({ schemaVersion: 1, attachments: [image, image] }), /same image/iu);
    assert.throws(() => normalizeSessionMessageInput({ schemaVersion: 1, attachments: Array.from({ length: 9 }, (_, index) => ({ ...image, id: `${image.id}-${index}` })) }), /at most 8/iu);
    assert.throws(() => normalizeSessionMessageInput({ schemaVersion: 1, attachments: Array.from({ length: 5 }, (_, index) => ({ ...image, id: `${image.id}:large:${index}`, digest: String(index).repeat(64), byteSize: 20 * 1024 * 1024 })) }), /80 MiB/iu);
    await assert.rejects(service.importBytes({ fileName: "large.png", bytes: new Uint8Array(20 * 1024 * 1024 + 1) }), /20 MiB/iu);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PNG JPEG GIF and WebP signatures preserve bounded dimensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v0100-formats-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3"), domainId: "domain_formats" });
  const service = new LocalAttachmentService({ root: join(directory, "attachments"), domainId: "domain_formats", store });
  try {
    for (const [name, bytes, mediaType] of [["a.png", png(11, 12), "image/png"], ["a.jpg", jpeg(13, 14), "image/jpeg"], ["a.gif", gif(15, 16), "image/gif"], ["a.webp", webp(17, 18), "image/webp"]] as const) {
      const image = await service.importBytes({ fileName: name, bytes });
      assert.equal(image.mediaType, mediaType);
      assert.ok(image.width >= 11 && image.height >= 12);
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Provider user content preserves text then image order and permits image-only input", () => {
  const first = ref("attachment_first", "a".repeat(64));
  const second = ref("attachment_second", "b".repeat(64));
  const mixed = providerUserMessage({ schemaVersion: 1, text: "按顺序查看", attachments: [first, second] });
  assert.deepEqual(mixed.content, [{ type: "text", text: "按顺序查看" }, { type: "image", attachment: first }, { type: "image", attachment: second }]);
  const imageOnly = createUserMessage({ schemaVersion: 1, attachments: [first] }, "message_image_only", new Date(0).toISOString());
  assert.equal(imageOnly.content, "");
  assert.equal(imageOnly.schemaVersion, 3);
});

test("Provider wire helpers read image bytes only at the concrete adapter boundary", async () => {
  const attachment = ref("attachment_wire", "c".repeat(64));
  const content = providerUserMessage({ schemaVersion: 1, text: "图像", attachments: [attachment] }).content;
  const reader = { readAttachment: async () => Uint8Array.from([1, 2, 3]) };
  assert.deepEqual(await toChatUserContent(content, reader, new AbortController().signal), [
    { type: "text", text: "图像" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
  ]);
  assert.deepEqual(await toResponsesUserContent(content, reader, new AbortController().signal), [
    { type: "input_text", text: "图像" },
    { type: "input_image", image_url: "data:image/png;base64,AQID", detail: "auto" },
  ]);
});

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(bytes); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
function gif(width: number, height: number): Buffer { const bytes = Buffer.alloc(10); bytes.write("GIF89a", 0, "ascii"); bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); return bytes; }
function webp(width: number, height: number): Buffer { const bytes = Buffer.alloc(30); bytes.write("RIFF", 0, "ascii"); bytes.write("WEBP", 8, "ascii"); bytes.write("VP8X", 12, "ascii"); bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3); return bytes; }
function jpeg(width: number, height: number): Buffer { const bytes = Buffer.alloc(21); bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]); bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes; }
function ref(id: string, digest: string) { return Object.freeze({ schemaVersion: 1 as const, id, domainId: "domain_test", projectId: "project_test", digest, mediaType: "image/png" as const, byteSize: 24, width: 1, height: 1, fileName: `${id}.png` }); }
