import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { decodeDesktopApprovalDecision, decodeDesktopCredential, DESKTOP_IPC_CHANNELS, DESKTOP_IPC_SCHEMA_VERSION } from "../desktop/index.js";

test("Desktop IPC contract is versioned, allowlisted, and strict", () => {
  assert.equal(DESKTOP_IPC_SCHEMA_VERSION, 1);
  assert.deepEqual(Object.keys(DESKTOP_IPC_CHANNELS).sort(), ["approval", "command", "credential", "event", "external"]);
  assert.deepEqual(decodeDesktopCredential({ profileId: "profile_0001", secret: "temporary" }), { profileId: "profile_0001", secret: "temporary" });
  assert.throws(() => decodeDesktopCredential({ profileId: "profile_0001", secret: "temporary", persist: true }), /unknown/iu);
  assert.throws(() => decodeDesktopApprovalDecision({ requestId: "approval_0001", actionDigest: "bad", approved: true }), /invalid/iu);
  const digest = "a".repeat(64);
  assert.deepEqual(decodeDesktopApprovalDecision({ requestId: "approval_0001", actionDigest: digest, shapeDigest: digest, approved: false }), { requestId: "approval_0001", actionDigest: digest, shapeDigest: digest, approved: false });
});

test("Electron Main and preload retain hardened process boundaries", async () => {
  const main = await readFile(resolve("desktop/main.ts"), "utf8");
  const preload = await readFile(resolve("desktop/preload.cts"), "utf8");
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{ action: "deny" \}\)\)/u);
  assert.match(main, /will-navigate/u);
  assert.match(main, /will-attach-webview/u);
  assert.match(main, /assertTrustedSender/u);
  assert.doesNotMatch(preload, /(?:node:fs|node:path|child_process|better-sqlite3|LocalAlphionApplication)/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("alphionDesktop"/u);
});

test("Desktop JSONL host files and generic credential commands are removed", async () => {
  const index = await readFile(resolve("desktop/index.ts"), "utf8");
  assert.doesNotMatch(index, /JSONL|Stdio|Transport|createDesktopHost|runDesktopHost/u);
  assert.doesNotMatch(index, /vault|masterPassword|apiKey/iu);
});
