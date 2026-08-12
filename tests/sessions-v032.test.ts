import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { LocalResourceLoader } from "../adapters/resources/local-resource-loader.js";
import { CapabilityRegistry, planHarness } from "../src/application/harness.js";
import { validateJsonSchema } from "../src/application/json-schema.js";
import { AgentSession } from "../src/application/agent-session.js";
import { DefaultSessionManager } from "../src/application/session-manager.js";
import { Agent } from "../src/application/agent.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import { BoundedEventChannel } from "../src/application/event-channel.js";
import { canonicalJson, sha256 } from "../src/application/canonical.js";
import { compactSessionEntries, compactSessionEntriesWithProvider } from "../src/application/compaction.js";
import type { AgentMessage, AgentRunResult, AgentShape, EvidenceRef, ProjectProfile, SessionEntry } from "../src/domain/contracts.js";
import type { AgentContract, AgentExecutionHooks, AgentProvider, AgentRunHandle, ApprovalPort, ModelResolver } from "../src/ports/index.js";
import type { ProviderEvent, ProviderRequest } from "../src/domain/contracts.js";
import type { AgentEvent, AgentStreamEvent } from "../src/protocol/events.js";

test("session branches enforce revision, idempotency, FIFO queues and leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-session-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  try {
    const session = await store.createSession({ title: "test", idempotencyKey: "create:test:0001" });
    const first = user("first");
    const receipt = await store.appendSessionEntry(session.id, first, { expectedRevision: 0, idempotencyKey: "append:test:0001" });
    const replay = await store.appendSessionEntry(session.id, first, { expectedRevision: 0, idempotencyKey: "append:test:0001" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.entryId, receipt.entryId);
    await assert.rejects(store.appendSessionEntry(session.id, user("stale"), { expectedRevision: 0, idempotencyKey: "append:test:stale" }), /revision changed/iu);
    const shaped = await store.reshapeSession(session.id, testShape(session.id), { expectedRevision: receipt.revision, idempotencyKey: "reshape:test:0001" });
    const leased = await store.acquireRunLease(session.id, "run-one", shaped.revision);
    await assert.rejects(store.acquireRunLease(session.id, "run-two", leased.revision), /already active/iu);
    const beforeRejectedSend = (await store.getSessionView(session.id))?.entries.length;
    await assert.rejects(store.beginShapedSessionRun(session.id, "run-rejected", user("must not persist"), testShape(session.id), { expectedRevision: leased.revision, idempotencyKey: "send:test:reject" }), /already active/iu);
    assert.equal((await store.getSessionView(session.id))?.entries.length, beforeRejectedSend);
    const queued = await store.enqueuePending(session.id, "steer", user("redirect"), { expectedRevision: leased.revision, idempotencyKey: "steer:test:0001" });
    const drained = await store.drainPending(session.id, "steer", "run-one");
    assert.deepEqual(drained.map((item) => item.message.content), ["redirect"]);
    const released = await store.releaseRunLease(session.id, "run-one");
    await store.checkoutSession(session.id, undefined, { expectedRevision: released.revision, idempotencyKey: "checkout:test:0001" });
    assert.equal((await store.getSessionView(session.id))?.entries.length, 0);
    assert.ok(queued.revision > leased.revision);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SessionManager facade owns stable sessions and delegates every workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-manager-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  const agent = new SessionAgentDouble();
  const manager = new DefaultSessionManager({ store, session: (id) => testSession(id, store, agent), assertOpen: () => undefined });
  try {
    const created = await manager.create({ title: "manager", idempotencyKey: "create:manager:0001" });
    assert.strictEqual(await manager.get(created.id), created);
    assert.equal((await manager.list()).some((item) => item.id === created.id), true);
    assert.equal((await manager.view(created.id)).session.id, created.id);
    const checkout = await manager.checkout(created.id, undefined, { expectedRevision: 0, idempotencyKey: "checkout:manager:0001" });
    const handle = await manager.send(created.id, "run", { expectedRevision: checkout.revision, idempotencyKey: "send:manager:0001" }, allowApproval());
    const running = await created.get();
    const steer = await manager.steer(created.id, "redirect", { expectedRevision: running.revision, idempotencyKey: "steer:manager:0001" });
    await manager.followUp(created.id, "next", { expectedRevision: steer.revision, idempotencyKey: "follow:manager:0001" }, allowApproval());
    const iterator = manager.subscribe(created.id)[Symbol.asyncIterator]();
    const next = iterator.next();
    await agent.emit(0, sessionEvent(handle.runId, created.id, 1, "provider.started", { model: "test" }));
    assert.equal((await next).value?.kind, "provider.started");
    await iterator.return?.();
    agent.complete(0, "done");
    await waitUntil(() => agent.requests.length === 2);
    agent.complete(1, "next done");
    await waitUntil(async () => (await created.get()).status === "idle");
  } finally { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("schema v2 migration creates backup and read-only legacy session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-migrate-"));
  const path = join(directory, "state.sqlite3");
  let store = new SqliteStore({ path });
  store.close();
  const db = openSqliteDatabase(path);
  db.exec("DROP TABLE session_shapes; DROP TABLE session_commands; DROP TABLE pending_messages; DROP TABLE session_entries; DROP TABLE sessions; DROP TABLE session_owners; DROP INDEX events_session_sequence; ALTER TABLE events DROP COLUMN session_sequence; ALTER TABLE events DROP COLUMN schema_version; ALTER TABLE runs DROP COLUMN shape_revision; ALTER TABLE runs DROP COLUMN shape_digest; CREATE TABLE backup_fixture (value TEXT NOT NULL); INSERT INTO backup_fixture VALUES ('wal-visible'); PRAGMA user_version = 2;");
  db.close();
  store = new SqliteStore({ path });
  try {
    assert.equal(existsSync(`${path}.v2-backup`), true);
    const backup = openSqliteDatabase(`${path}.v2-backup`, { readOnly: true });
    try {
      assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
      assert.equal((backup.prepare("SELECT value FROM backup_fixture").get() as { value: string }).value, "wal-visible");
      assert.equal(Object.values(backup.prepare("PRAGMA quick_check").get() as Record<string, unknown>)[0], "ok");
    } finally { backup.close(); }
  }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("harness and resource loading are deterministic and bounded", async () => {
  const registry = new CapabilityRegistry([
    { id: "project.read", description: "read", taskLabels: ["diagnose", "verify"], permissions: ["project:read"], defaultBudget: 4 },
    { id: "project.write", description: "write", taskLabels: ["implement"], permissions: ["project:write"], defaultBudget: 2 },
  ]);
  assert.deepEqual(planHarness("diagnose a failure", registry), planHarness("diagnose a failure", registry));
  const multiLabel = planHarness("fix, diagnose and review a failure", registry);
  assert.deepEqual(multiLabel.taskLabels, ["implement", "diagnose", "verify"]);
  assert.deepEqual(multiLabel.capabilities, ["project.read", "project.write"]);
  assert.equal(multiLabel.digest, planHarness("fix, diagnose and review a failure", registry).digest);
  const narrowed = planHarness("diagnose a failure", registry, { capabilities: ["project.read"], permissions: [], budgets: { operations: 2, maxRecallItems: 5 }, evaluator: "quality-gate" });
  assert.deepEqual(narrowed.permissions, []);
  assert.deepEqual(narrowed.budgets, { operations: 2, maxRecallItems: 5 });
  assert.deepEqual(narrowed, planHarness("diagnose a failure", registry, { permissions: [], capabilities: ["project.read"], evaluator: "quality-gate", budgets: { maxRecallItems: 5, operations: 2 } }));
  assert.throws(() => planHarness("diagnose a failure", registry, { capabilities: ["project.write"] }), /cannot widen capability/iu);
  assert.throws(() => planHarness("diagnose a failure", registry, { budgets: { operations: 5 } }), /cannot widen budget/iu);
  const directory = await mkdtemp(join(tmpdir(), "alphion-resource-"));
  try {
    await mkdir(join(directory, ".alphion-resources"));
    await writeFile(join(directory, ".alphion-resources", "project.md"), "safe context");
    await writeFile(join(directory, ".env"), "SECRET=value");
    await writeFile(join(directory, ".alphion-resources", "manifest.json"), JSON.stringify({ schemaVersion: 1, packageId: "project.test", resources: [{ id: "project-context", kind: "context", path: "project.md" }] }));
    const loaded = await new LocalResourceLoader().resolve({ projectRoot: directory });
    assert.equal(loaded.resources.some((item) => item.content.includes("SECRET")), false);
    assert.equal(loaded.resources.find((item) => item.id === "project-context")?.content, "safe context");
    const overridden = await new LocalResourceLoader().resolve({ projectRoot: directory, sessionOverrides: [{ id: "project-context", kind: "prompt", inline: "task context" }] });
    assert.equal(overridden.resources.find((item) => item.id === "project-context")?.kind, "prompt");
    assert.equal(overridden.resources.find((item) => item.id === "project-context")?.provenance.scope, "session");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("compaction preserves required fields and accepts only a validated no-tool deterministic provider summary", async () => {
  const entries = [
    entry("system", systemEvent("system", "Goal: ship; acceptance: tests pass; revision abc; permission read only")),
    entry("failure", observation("failure", "command failed", true)),
    entry("evidence", observation("evidence", "evidence README proves behavior", false, { id: "ev-1", kind: "file", digest: "a".repeat(64), summary: "README" })),
    entry("unresolved", workflow("unresolved", "TODO unresolved migration")),
    entry("old-user", user("old request")),
    entry("old-answer", assistant("old answer")),
    entry("latest-user-1", user("latest one")),
    entry("latest-answer-1", assistant("latest answer one")),
    entry("latest-user-2", user("latest two")),
    entry("latest-answer-2", assistant("latest answer two")),
  ];
  const fallback = compactSessionEntries(entries, 1);
  assert.equal(fallback[0]?.kind, "memory");
  const fallbackText = fallback[0]?.kind === "memory" ? fallback[0].content : "";
  assert.match(fallbackText, /Goal: ship|acceptance: tests pass/u);
  assert.match(fallbackText, /permission read only|revision abc/u);
  assert.match(fallbackText, /command failed/u);
  assert.match(fallbackText, /evidence README/u);
  assert.match(fallbackText, /TODO unresolved/u);
  assert.deepEqual(fallback.slice(-4).map((message) => "content" in message ? message.content : ""), ["latest one", "latest answer one", "latest two", "latest answer two"]);

  const provider = new StructuredCompactionProvider(false);
  const compacted = await compactSessionEntriesWithProvider(entries, provider, new AbortController().signal, 1);
  assert.deepEqual(provider.request?.tools, []);
  assert.equal(provider.request?.temperature, 0);
  assert.equal(compacted[0]?.kind === "memory" && compacted[0].content.includes("provider goal"), true);
  const rejected = await compactSessionEntriesWithProvider(entries, new StructuredCompactionProvider(true), new AbortController().signal, 1);
  assert.equal(rejected[0]?.kind === "memory" && rejected[0].content.includes("Provider structured summary"), false);
  assert.deepEqual(rejected, fallback);
});

test("opening a store recovers orphaned leases and pending claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-recovery-"));
  const path = join(directory, "state.sqlite3");
  let store = new SqliteStore({ path });
  const session = await store.createSession({ title: "recover", idempotencyKey: "create:recover:0001" });
  const shaped = await store.reshapeSession(session.id, testShape(session.id), { expectedRevision: session.revision, idempotencyKey: "reshape:recover:0001" });
  const leased = await store.acquireRunLease(session.id, "orphan-run", shaped.revision);
  await store.enqueuePending(session.id, "steer", user("recover me"), { expectedRevision: leased.revision, idempotencyKey: "steer:recover:0001" });
  await store.drainPending(session.id, "steer", "orphan-run");
  store.close();
  const raw = openSqliteDatabase(path);
  raw.prepare("UPDATE sessions SET status = 'running', active_run_id = 'orphan-run', lease_owner = 'dead-owner', lease_expires_at = '2000-01-01T00:00:00.000Z'").run();
  raw.prepare("UPDATE pending_messages SET claimed_run_id = 'orphan-run', claimed_at = '2000-01-01T00:00:00.000Z', claim_owner = 'dead-owner'").run();
  raw.prepare("DELETE FROM session_owners").run();
  raw.close();
  store = new SqliteStore({ path });
  try {
    const recovered = await store.getSession(session.id);
    assert.equal(recovered?.status, "idle");
    assert.equal(recovered?.activeRunId, undefined);
    const next = await store.acquireRunLease(session.id, "next-run", recovered?.revision ?? -1);
    const pending = await store.drainPending(session.id, "steer", "next-run");
    assert.deepEqual(pending.map((item) => item.message.content), ["recover me"]);
    assert.equal(next.status, "running");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("central JSON schema subset rejects unknown and malformed arguments", () => {
  const schema = { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false } as const;
  validateJsonSchema(schema, { count: 2 });
  assert.throws(() => validateJsonSchema(schema, { count: 0, extra: true }), /not allowed|below minimum/iu);
});

test("session injects steering at the next model boundary and launches terminal and idle follow-ups without overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-orchestration-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  const agent = new SessionAgentDouble();
  const approval = allowApproval();
  let session: AgentSession | undefined;
  try {
    const record = await store.createSession({ title: "flow", idempotencyKey: "create:flow:0001" });
    session = testSession(record.id, store, agent);
    const activeSession = session;
    const first = await activeSession.send("initial", { expectedRevision: record.revision, idempotencyKey: "send:flow:0001" }, approval);
    const running = await activeSession.get();
    await activeSession.steer("redirect", { expectedRevision: running.revision, idempotencyKey: "steer:flow:0001" });
    const hooks = agent.hooks[0];
    assert.ok(hooks);
    assert.deepEqual((await hooks.drainSteering(first.runId, new AbortController().signal)).map((message) => "content" in message ? message.content : ""), ["redirect"]);
    assert.equal((await hooks.drainSteering(first.runId, new AbortController().signal)).length, 0);
    const queuedRevision = (await activeSession.get()).revision;
    await activeSession.followUp("after terminal", { expectedRevision: queuedRevision, idempotencyKey: "follow:flow:0001" }, approval);
    agent.complete(0, "first done");
    await waitUntil(() => agent.requests.length === 2);
    assert.equal(agent.maxActive, 1);
    assert.equal(agent.requests[1]?.prompt, "after terminal");
    agent.complete(1, "follow done");
    await waitUntil(async () => (await activeSession.get()).status === "idle");
    const idleRevision = (await activeSession.get()).revision;
    await activeSession.followUp("from idle", { expectedRevision: idleRevision, idempotencyKey: "follow:flow:0002" }, approval);
    await waitUntil(() => agent.requests.length === 3);
    assert.equal(agent.requests[2]?.prompt, "from idle");
    agent.complete(2, "idle done");
    await activeSession.close();
  } finally { await session?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Agent injects bounded recall, resources and complete HarnessPlan into provider model context", async () => {
  const provider = new CaptureProvider();
  const models: ModelResolver = { resolveModel: () => Promise.resolve(provider) };
  const events = { append: async (draft: Parameters<import("../src/ports/index.js").EventStore["append"]>[0]) => ({ ...draft, schemaVersion: 2 as const, eventId: `event-${provider.requests.length}`, sequence: 1, sessionSequence: 1, timestamp: new Date(0).toISOString(), previousDigest: "0".repeat(64), digest: "d".repeat(64) }), verifyRun: () => Promise.resolve(true), listSessionEvents: () => Promise.resolve([]) };
  const agent = new Agent({ models, tools: new ToolRegistry([]), eventStore: events });
  const promptPlan = { schemaVersion: 1 as const, sections: [], omissions: [], budgetTokens: 2048, estimatedTokens: 10, rendered: "RESOURCE_SYSTEM_PROMPT\npermissions=project:read\nomissions=project.write\nevaluator=quality-gate", digest: "prompt-plan" };
  const handle = await agent.execute({ prompt: "diagnose", projectRoot: process.cwd(), projectRevision: "revision", history: [], environment: { identity: { id: "test", name: "Test Agent", description: "identity" }, projectRoot: process.cwd(), projectRevision: "revision", capabilities: ["project.read"], policies: ["deny-write"], skills: [], resources: [], systemPromptPlan: promptPlan, digest: "environment-digest" }, harnessPlan: { schemaVersion: 1, task: "diagnose", taskLabels: ["diagnose"], risk: "medium", capabilities: ["project.read"], reasons: ["task:diagnose"], permissions: ["project:read"], budgets: { operations: 4 }, evaluator: "quality-gate", omissions: ["project.write"], digest: "plan-digest" }, recall: { items: [{ source: "lexical", path: "src/example.ts", excerpt: "RECALL_EXCERPT", confidence: 0.5, evidence: "recall-digest" }], degraded: true, diagnostics: ["fallback"] } }, allowApproval());
  const consume = (async () => { for await (const _event of handle.events) { /* drain */ } })();
  await handle.result; await consume;
  const system = provider.requests[0]?.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n") ?? "";
  assert.match(system, /RESOURCE_SYSTEM_PROMPT/u);
  assert.doesNotMatch(system, /RECALL_EXCERPT/u);
  assert.match(provider.requests[0]?.messages.find((message) => message.role === "user" && message.content.includes("RECALL_EXCERPT"))?.content ?? "", /Retrieved evidence context/u);
  assert.match(system, /permissions=project:read/u);
  assert.match(system, /omissions=project.write/u);
  assert.match(system, /evaluator=quality-gate/u);
});

test("session branch replay retains tool, evidence, approval and failure events but excludes reasoning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-replay-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  const agent = new SessionAgentDouble();
  try {
    const record = await store.createSession({ title: "replay", idempotencyKey: "create:replay:0001" });
    const session = testSession(record.id, store, agent);
    const handle = await session.send("inspect", { expectedRevision: record.revision, idempotencyKey: "send:replay:0001" }, allowApproval());
    await agent.emit(0, { delivery: "transient", runId: handle.runId, sessionId: record.id, correlationId: handle.runId, timestamp: new Date(0).toISOString(), kind: "model.reasoning.delta", payload: { delta: "private chain" } });
    await agent.emit(0, sessionEvent(handle.runId, record.id, 2, "tool.requested", { toolCallId: "call-1", toolName: "project.read", arguments: { path: "README.md" }, final: true }));
    await agent.emit(0, sessionEvent(handle.runId, record.id, 3, "approval.requested", { requestId: "approval-1", toolName: "project.read", actionDigest: "a".repeat(64) }));
    await agent.emit(0, sessionEvent(handle.runId, record.id, 4, "approval.resolved", { requestId: "approval-1", approved: true, reason: "operator approved" }));
    await agent.emit(0, sessionEvent(handle.runId, record.id, 5, "tool.completed", { toolCallId: "call-1", toolName: "project.read", content: "observed", isError: false, evidence: { id: "evidence-1", kind: "file", digest: "b".repeat(64), summary: "README" } }));
    await agent.emit(0, sessionEvent(handle.runId, record.id, 6, "run.failed", { code: "provider", stage: "model", retryable: true }));
    agent.complete(0, "");
    await handle.result;
    const kinds = (await session.view()).entries.map((entry) => entry.message.kind);
    assert.deepEqual(kinds, ["user", "tool-call", "human-approval", "human-approval", "observation", "system-event"]);
    assert.equal(JSON.stringify(await session.view()).includes("private chain"), false);
    const observation = (await session.view()).entries.find((entry) => entry.message.kind === "observation")?.message;
    assert.equal(observation?.kind === "observation" ? observation.evidence?.id : undefined, "evidence-1");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a stalled Session subscriber receives resync without delaying Run completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-slow-subscriber-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  const agent = new SessionAgentDouble();
  try {
    const record = await store.createSession({ title: "slow", idempotencyKey: "create:slow:0001" });
    const session = testSession(record.id, store, agent);
    const subscription = session.subscribe()[Symbol.asyncIterator]();
    const handle = await session.send("stream", { expectedRevision: record.revision, idempotencyKey: "send:slow:0001" }, allowApproval());
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      await agent.emit(0, sessionEvent(handle.runId, record.id, sequence, "provider.started", { model: `test-${sequence}` }));
    }
    agent.complete(0, "done");
    await Promise.race([handle.result, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow subscriber blocked the run")), 500))]);
    let sawResync = false;
    for (let count = 0; count < 257; count += 1) {
      const next = await subscription.next();
      if (next.done) break;
      if ("delivery" in next.value && next.value.delivery === "control") { sawResync = true; break; }
    }
    assert.equal(sawResync, true);
    await subscription.return?.();
    await session.close();
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

class SessionAgentDouble implements AgentContract {
  readonly requests: Array<{ readonly prompt: string }> = [];
  readonly hooks: AgentExecutionHooks[] = [];
  readonly #runs: Array<{ readonly channel: BoundedEventChannel<AgentStreamEvent>; readonly resolve: (result: AgentRunResult) => void; readonly runId: string; readonly sessionId: string }> = [];
  active = 0;
  maxActive = 0;

  execute(request: Parameters<AgentContract["execute"]>[0], _approval: ApprovalPort, hooks?: AgentExecutionHooks): Promise<AgentRunHandle> {
    this.requests.push({ prompt: request.prompt });
    if (hooks) this.hooks.push(hooks);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const channel = new BoundedEventChannel<AgentStreamEvent>(16);
    let resolveResult!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => { resolveResult = resolve; });
    const runId = request.runId ?? `run-${this.requests.length}`;
    const sessionId = request.sessionId ?? "session";
    this.#runs.push({ channel, resolve: resolveResult, runId, sessionId });
    return Promise.resolve({ runId, sessionId, events: channel, result, cancel: () => undefined });
  }

  complete(index: number, finalText: string): void {
    const run = this.#runs[index];
    if (!run) throw new Error("missing run");
    this.active -= 1;
    run.channel.close();
    run.resolve({ runId: run.runId, sessionId: run.sessionId, status: "completed", finalText, turns: 1, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, grounding: { availableEvidenceIds: [], referencedEvidenceIds: [], missingEvidenceIds: [], unreferencedEvidenceIds: [] } });
  }

  async emit(index: number, event: AgentStreamEvent): Promise<void> {
    const run = this.#runs[index];
    if (!run) throw new Error("missing run");
    await run.channel.push(event, event.kind !== "model.delta" && event.kind !== "model.reasoning.delta");
  }
}

class CaptureProvider implements AgentProvider {
  readonly profile = { schemaVersion: 2 as const, id: "capture", name: "capture", kind: "custom-openai-compatible" as const, baseUrl: "http://127.0.0.1:1/v1", model: "capture", protocol: "chat-completions" as const, auth: { mode: "none" as const }, capabilities: { streaming: false, tools: false, promptCaching: false, reasoning: false }, revision: 1, active: true };
  readonly requests: ProviderRequest[] = [];
  async *generate(request: ProviderRequest): AsyncIterable<ProviderEvent> { this.requests.push(request); yield { type: "text-delta", delta: "done" }; yield { type: "done", finishReason: "stop" }; }
}

class StructuredCompactionProvider implements AgentProvider {
  readonly profile = { schemaVersion: 2 as const, id: "compactor", name: "compactor", kind: "custom-openai-compatible" as const, baseUrl: "http://127.0.0.1:1/v1", model: "compactor", protocol: "chat-completions" as const, auth: { mode: "none" as const }, capabilities: { streaming: false, tools: true, promptCaching: false, reasoning: false }, revision: 1, active: true };
  request: ProviderRequest | undefined;
  constructor(private readonly forbiddenReasoning: boolean) {}
  async *generate(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.request = request;
    if (this.forbiddenReasoning) yield { type: "reasoning-delta", delta: "private compaction chain" };
    yield { type: "text-delta", delta: JSON.stringify({ systemGoalsAcceptance: ["provider goal"], permissionsConstraintsRevision: ["revision abc"], failures: ["command failed"], evidence: ["ev-1"], unresolved: ["migration"], otherFacts: [] }) };
    yield { type: "done", finishReason: "stop" };
  }
}

function testSession(sessionId: string, store: SqliteStore, agent: AgentContract): AgentSession {
  const plan = () => ({ schemaVersion: 1 as const, task: "implement" as const, taskLabels: ["implement" as const], risk: "low" as const, capabilities: [], reasons: [], permissions: [], budgets: {}, evaluator: "test", omissions: [], digest: "plan" });
  return new AgentSession({ sessionId, store, agent, projectRoot: process.cwd(), projectProfile: () => Promise.resolve(TEST_PROFILE), environment: (_profile, shape) => Promise.resolve({ identity: shape.identity, projectRoot: process.cwd(), projectRevision: "revision", capabilities: shape.capabilities, policies: shape.policies, skills: [], resources: shape.resources, systemPromptPlan: shape.systemPromptPlan, digest: "digest" }), shape: (request, revision) => Promise.resolve(testShape(sessionId, revision, request.goal)), plan });
}

function testShape(sessionId: string, revision = 1, goal = "test"): AgentShape {
  const plan = { schemaVersion: 1 as const, sections: [], omissions: [], budgetTokens: 2048, estimatedTokens: 1, rendered: "test", digest: "prompt" };
  const harnessPlan = { schemaVersion: 1 as const, task: "implement" as const, taskLabels: ["implement" as const], risk: "low" as const, capabilities: [], reasons: [], permissions: [], budgets: {}, evaluator: "test", omissions: [], digest: "plan" };
  const base = { schemaVersion: 1 as const, sessionId, revision, goal, identity: { id: "test", name: "test", description: "test" }, systemPromptPlan: plan, resources: [], resourceIds: [], resourceDigest: "resources", toolIds: [], capabilities: [], policies: [], behavior: { compaction: "hybrid" as const, steering: true, followUps: true }, requiredProviderCapabilities: [], harnessPlan, omissions: [], diagnostics: [] };
  return { ...base, digest: sha256(canonicalJson(base)) };
}

const TEST_PROFILE: ProjectProfile = { schemaVersion: 1, projectRevision: "revision", profilerVersion: "test", rulesVersion: "test", projectType: "unknown", facts: [], qualityCommands: [], diagnostics: [], scannedPaths: 0, truncated: false, digest: "profile" };
function allowApproval(): ApprovalPort { return { revision: "allow", requestApproval: () => Promise.resolve({ approved: true, reason: "test" }) }; }
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> { for (let count = 0; count < 200; count += 1) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("condition timed out"); }

function user(content: string): Extract<AgentMessage, { readonly kind: "user" }> {
  return { schemaVersion: 1, kind: "user", id: `message-${content}`, createdAt: new Date(0).toISOString(), content };
}

function assistant(content: string): Extract<AgentMessage, { readonly kind: "assistant" }> {
  return { schemaVersion: 1, kind: "assistant", id: `message-${content}`, createdAt: new Date(0).toISOString(), content };
}

function systemEvent(id: string, content: string): Extract<AgentMessage, { readonly kind: "system-event" }> {
  return { schemaVersion: 1, kind: "system-event", id: `message-${id}`, createdAt: new Date(0).toISOString(), eventKind: id, content };
}

function observation(id: string, content: string, isError: boolean, evidence?: EvidenceRef): Extract<AgentMessage, { readonly kind: "observation" }> {
  return { schemaVersion: 1, kind: "observation", id: `message-${id}`, createdAt: new Date(0).toISOString(), toolCallId: `call-${id}`, toolName: "test", content, ...(evidence ? { evidence } : {}), isError };
}

function workflow(id: string, content: string): Extract<AgentMessage, { readonly kind: "workflow" }> {
  return { schemaVersion: 1, kind: "workflow", id: `message-${id}`, createdAt: new Date(0).toISOString(), state: id, content };
}

function entry(id: string, message: AgentMessage): SessionEntry {
  return { schemaVersion: 1, id: `entry-${id}`, sessionId: "session-compaction", timestamp: new Date(0).toISOString(), message };
}

function sessionEvent(runId: string, sessionId: string, sequence: number, kind: AgentEvent["kind"], payload: Readonly<Record<string, unknown>>): AgentEvent {
  return { schemaVersion: 2, eventId: `event-replay-${sequence}`, sequence, sessionSequence: sequence, runId, sessionId, correlationId: runId, timestamp: new Date(sequence * 1_000).toISOString(), kind, payload, previousDigest: "0".repeat(64), digest: String(sequence).padStart(64, "0") };
}
