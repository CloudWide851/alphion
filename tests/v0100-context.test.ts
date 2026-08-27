import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { actualProviderContextUsage, estimateProviderContextUsage } from "../src/application/provider-context-usage.js";
import { createConversationRunState, reduceConversationRun } from "../ui/conversation-run.js";
import type { AgentEvent, AgentEventKind } from "../src/index.js";

test("context usage separates Run totals from the latest Provider call", () => {
  const request = { messages: [{ role: "user" as const, content: "hello" }], tools: [], maxOutputTokens: 64, temperature: 0 };
  const estimate = estimateProviderContextUsage(request, 131_072);
  assert.equal(estimate.source, "estimated");
  assert.equal(estimate.occupiedTokens, estimate.inputTokens);
  const actual = actualProviderContextUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }, 131_072);
  assert.equal(actual.occupiedTokens, 120);
  let state = createConversationRunState("run_context", "session_context");
  state = reduceConversationRun(state, { kind: "agent-event", event: event("provider.started", { contextUsage: estimate }) });
  state = reduceConversationRun(state, { kind: "agent-event", event: event("model.usage", { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }, contextUsage: actual }) });
  state = reduceConversationRun(state, { kind: "agent-event", event: event("model.usage", { usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 0 }, contextUsage: actualProviderContextUsage({ inputTokens: 40, outputTokens: 10, cachedInputTokens: 0 }, 131_072) }) });
  assert.deepEqual(state.usage, { inputTokens: 140, outputTokens: 30, cachedInputTokens: 80 });
  assert.equal(state.contextUsage?.occupiedTokens, 50);
  assert.equal(state.contextUsage?.source, "actual");
});

test("SQLite v8 migrates through a verified backup and persists Provider Profile v3", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v0100-context-"));
  const path = join(directory, "state.sqlite3");
  try {
    new SqliteStore({ path }).close();
    const legacy = openSqliteDatabase(path);
    legacy.exec("DROP TABLE message_attachments; DROP TABLE attachments; ALTER TABLE provider_profiles DROP COLUMN context_window_tokens; PRAGMA user_version = 8;");
    legacy.close();
    const store = new SqliteStore({ path });
    const saved = await store.upsertProfile({ schemaVersion: 3, id: "vision-profile", name: "Vision", kind: "custom-openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "vision-local", protocol: "chat-completions", auth: { mode: "none" }, capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: true }, contextWindowTokens: 262_144, active: true });
    assert.deepEqual([saved.schemaVersion, saved.contextWindowTokens, saved.capabilities.vision], [3, 262_144, true]);
    store.close();
    assert.equal(version(path), 9);
    assert.equal(version(`${path}.v8-backup`), 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function event(kind: AgentEventKind, payload: Readonly<Record<string, unknown>>): AgentEvent {
  return { schemaVersion: 2, eventId: `event_${kind}`, sequence: 1, sessionSequence: 1, runId: "run_context", sessionId: "session_context", correlationId: "correlation_context", timestamp: new Date(0).toISOString(), kind, payload, previousDigest: "0".repeat(64), digest: "1".repeat(64) };
}

function version(path: string): number {
  const database = openSqliteDatabase(path, { readOnly: true });
  try { return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version; }
  finally { database.close(); }
}
