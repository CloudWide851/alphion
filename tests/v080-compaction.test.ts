import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { buildCompactionPolicy, compactSessionEntriesForModel } from "../src/application/compaction.js";
import type { AgentMessage, ModelDescriptor, ProviderProfile, SessionEntry } from "../src/domain/contracts.js";
import type { AgentProvider } from "../src/ports/index.js";

test("model-aware compaction reserves output, Tool schema, and safety budget", () => {
  const unknown = buildCompactionPolicy({});
  assert.equal(unknown.contextWindowTokens, 32_768);
  assert.equal(unknown.triggerRatio, 0.85);
  assert.equal(unknown.effectiveInputTokens, Math.floor(32_768 * 0.85) - 4_096 - 2_048);
  const narrowed = buildCompactionPolicy({ model: model(100_000), triggerRatio: 0.8, outputReserveTokens: 1_000, toolReserveTokens: 2_000, safetyReserveTokens: 1_000 });
  assert.equal(narrowed.effectiveInputTokens, 76_000);
  assert.throws(() => buildCompactionPolicy({ triggerRatio: 0.86 }), /0\.85/u);
  assert.throws(() => buildCompactionPolicy({ model: model(4_096), outputReserveTokens: 2_048, safetyReserveTokens: 2_048 }), /1024/u);
});

test("compaction keeps the latest two cycles and produces a stable content digest", async () => {
  const entries = cycles("session_a", 5, 3_000);
  const requests: unknown[] = [];
  const provider = summaryProvider(requests);
  const first = await compactSessionEntriesForModel(entries, provider, new AbortController().signal, {
    sessionId: "session_a", runId: "run_a", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256,
  });
  const second = await compactSessionEntriesForModel(entries, provider, new AbortController().signal, {
    sessionId: "session_a", runId: "run_b", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256,
  });
  assert.ok(first.record);
  assert.ok(second.record);
  assert.equal(first.record.digest, second.record.digest);
  assert.notEqual(first.record.id, second.record.id);
  assert.equal(first.record.retainedCycleCount, 2);
  assert.deepEqual(first.messages.slice(1).map((item) => item.id), entries.slice(-4).map((entry) => entry.message.id));
  assert.deepEqual(first.record.memory.sourceEntryIds, entries.slice(0, -4).map((entry) => entry.id));
  assert.equal(requests.length, 2);
  const request = requests[0] as { tools: unknown[]; temperature: number; messages: readonly { content: string }[] };
  assert.deepEqual(request.tools, []);
  assert.equal(request.temperature, 0);
  assert.match(request.messages[0]?.content ?? "", /Never include reasoning/u);

  const other = await compactSessionEntriesForModel(entries.map((entry) => ({ ...entry, sessionId: "session_b" })), provider, new AbortController().signal, {
    sessionId: "session_b", runId: "run_c", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256,
  });
  assert.notEqual(other.record?.digest, first.record.digest);
});

test("invalid Provider summaries fall back while retaining mandatory durable categories", async () => {
  const source: AgentMessage[] = [
    message("workflow", "root", "Goal 目标 and acceptance 验收 " + "x".repeat(1_500)),
    message("workflow", "policy", "permission 权限 constraint 约束 revision r9 " + "x".repeat(1_500)),
    observation("failure", true), observation("evidence", false, "evidence_42"),
    message("workflow", "pending", "TODO unresolved 待办 " + "x".repeat(1_500)),
    ...cycles("session_required", 2, 1_000).map((entry) => entry.message),
  ];
  const entries = source.map((item, index) => entry("session_required", index, item));
  const provider: AgentProvider = {
    profile: providerProfile(),
    async *generate() { yield { type: "reasoning-delta", delta: "must not persist" }; yield { type: "done", finishReason: "stop" }; },
  };
  const before = JSON.stringify(entries);
  const result = await compactSessionEntriesForModel(entries, provider, new AbortController().signal, {
    sessionId: "session_required", runId: "run_required", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256,
  });
  assert.ok(result.record?.omissions.includes("provider-summary-fallback"));
  const memory = result.messages[0];
  assert.equal(memory?.kind, "memory");
  const content = memory?.kind === "memory" ? memory.content : "";
  for (const expected of ["Goal 目标", "permission 权限", "failure", "evidence_42", "TODO unresolved"]) assert.match(content, new RegExp(expected, "u"));
  assert.doesNotMatch(content, /must not persist/u);
  assert.equal(JSON.stringify(entries), before);
});

test("compaction persistence is append-only and snapshot projection hides summary content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-compaction-"));
  try {
    const store = new SqliteStore({ path: join(directory, "state.sqlite3"), projectId: "project_a", domainId: "domain_a" });
    const session = await store.createSession({ title: "Compaction", idempotencyKey: "create_compaction_session" });
    const result = await compactSessionEntriesForModel(cycles(session.id, 4, 3_000), undefined, new AbortController().signal, {
      sessionId: session.id, runId: "run_store", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256,
    });
    assert.ok(result.record);
    await store.appendCompaction(result.record);
    await store.appendCompaction({ ...result.record, createdAt: new Date().toISOString() });
    const projection = await store.getCompactionProjection(session.id);
    assert.equal(projection.count, 1);
    assert.equal(projection.latest?.digest, result.record.digest);
    assert.equal("memory" in (projection.latest ?? {}), false);
    assert.doesNotMatch(JSON.stringify(projection), /Deterministic branch summary/u);
    const view = await store.getSessionView(session.id);
    assert.equal(view?.session.currentLeafId, undefined);
    assert.equal(view?.entries.length, 0);
    assert.equal((await store.listCompactions(session.id)).length, 1);
    store.close();

    const tamper = new SqliteStore({ path: join(directory, "tamper.sqlite3"), projectId: "project_tamper", domainId: "domain_tamper" });
    const tamperSession = await tamper.createSession({ title: "Tamper", idempotencyKey: "create_tamper_session" });
    const tamperResult = await compactSessionEntriesForModel(cycles(tamperSession.id, 4, 3_000), undefined, new AbortController().signal, { sessionId: tamperSession.id, runId: "run_tamper", model: model(4_096), outputReserveTokens: 512, safetyReserveTokens: 256 });
    assert.ok(tamperResult.record);
    await tamper.appendCompaction(tamperResult.record);
    tamper.close();
    const { openSqliteDatabase } = await import("../adapters/store/database.js");
    const database = openSqliteDatabase(join(directory, "tamper.sqlite3"));
    const stored = database.prepare("SELECT record_json FROM compaction_records WHERE id = ?").get(tamperResult.record.id) as { record_json: string };
    database.prepare("UPDATE compaction_records SET record_json = ? WHERE id = ?").run(stored.record_json.replace("Deterministic", "Altered"), tamperResult.record.id);
    database.close();
    const reopened = new SqliteStore({ path: join(directory, "tamper.sqlite3"), projectId: "project_tamper", domainId: "domain_tamper" });
    await assert.rejects(reopened.getCompaction(tamperResult.record.id), /invalid/iu);
    reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function model(contextWindowTokens: number): ModelDescriptor {
  return { id: `model_${contextWindowTokens}`, providerKind: "deepseek", model: "deepseek-chat", capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false }, contextWindowTokens };
}

function cycles(sessionId: string, count: number, size: number): SessionEntry[] {
  const values: SessionEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(entry(sessionId, values.length, message("user", `user_${index}`, `question ${index} ${"q".repeat(size)}`)));
    values.push(entry(sessionId, values.length, message("assistant", `assistant_${index}`, `answer ${index} ${"a".repeat(size)}`)));
  }
  return values;
}

function entry(sessionId: string, index: number, messageValue: AgentMessage): SessionEntry {
  return { schemaVersion: 1, id: `entry_${index}_${messageValue.id}`, ...(index > 0 ? { parentId: `entry_${index - 1}_${index % 2 === 0 ? `assistant_${index / 2 - 1}` : `user_${Math.floor(index / 2)}`}` } : {}), sessionId, timestamp: "2026-01-01T00:00:00.000Z", message: messageValue };
}

function message(kind: "user" | "assistant" | "workflow", id: string, content: string): AgentMessage {
  return kind === "workflow"
    ? { schemaVersion: 1, kind, id: `message_${id}`, createdAt: "2026-01-01T00:00:00.000Z", state: "active", content }
    : { schemaVersion: 1, kind, id: `message_${id}`, createdAt: "2026-01-01T00:00:00.000Z", content };
}

function observation(id: string, isError: boolean, evidenceId?: string): AgentMessage {
  return { schemaVersion: 1, kind: "observation", id: `message_${id}`, createdAt: "2026-01-01T00:00:00.000Z", toolCallId: `call_${id}`, toolName: "test", content: `${id} ${"o".repeat(1_500)}`, ...(evidenceId ? { evidence: { id: evidenceId, kind: "search", digest: "a".repeat(64), summary: "verified" } } : {}), isError };
}

function providerProfile(): ProviderProfile {
  return { schemaVersion: 3, id: "summary", name: "Summary", kind: "deepseek", presetId: "deepseek", model: "deepseek-chat", protocol: "chat-completions", auth: { mode: "none" }, capabilities: { streaming: true, tools: false, promptCaching: false, reasoning: false, vision: false }, revision: 1, active: true };
}

function summaryProvider(requests: unknown[]): AgentProvider {
  return { profile: providerProfile(), async *generate(request) { requests.push(request); yield { type: "text-delta", delta: JSON.stringify({ systemGoalsAcceptance: ["goal"], permissionsConstraintsRevision: ["policy"], failures: [], evidence: [], unresolved: [], otherFacts: ["fact"] }) }; yield { type: "done", finishReason: "stop" }; } };
}
