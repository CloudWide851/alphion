import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { AgentLoop } from "../src/application/agent-runtime.js";
import { SingleFlight, TieredCache } from "../src/application/cache.js";
import { sha256 } from "../src/application/canonical.js";
import { BoundedEventChannel } from "../src/application/event-channel.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import type { AgentProvider, ApprovalPort, ToolExecutor } from "../src/ports/index.js";
import type { EvidenceRef, ProviderEvent, ProviderProfile, ProviderRequest, SystemPromptPlan } from "../src/domain/contracts.js";
import { isAgentEvent, type AgentStreamEvent } from "../src/protocol/events.js";
import { MemoryLruCache } from "../adapters/cache/memory-cache.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { EditTool, GrepTool, ReadTool, ShellTool, WriteTool } from "../adapters/tools/index.js";

const PROFILE: ProviderProfile = Object.freeze({
  schemaVersion: 2,
  id: "fake",
  name: "fake",
  kind: "custom-openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "fake-model",
  protocol: "chat-completions",
  auth: { mode: "none" as const },
  capabilities: { streaming: true, tools: true, promptCaching: true, reasoning: false },
  revision: 1,
  active: true,
});

const TEST_SYSTEM_PROMPT: SystemPromptPlan = Object.freeze({ schemaVersion: 1, sections: Object.freeze([]), omissions: Object.freeze([]), budgetTokens: 256, estimatedTokens: 1, rendered: "Test system instructions.", digest: sha256("Test system instructions.") });

test("SQLite profiles, cache, hash-chain events, and shell rules round-trip", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "state.sqlite3");
    const store = new SqliteStore({ path });
    const created = await store.upsertProfile({
      schemaVersion: 2,
      id: "local",
      name: "Local",
      kind: "custom-openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "local-model",
      protocol: "chat-completions",
      auth: { mode: "bearer-env", environmentVariable: "LOCAL_MODEL_KEY" },
      capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
      active: true,
    });
    assert.equal(created.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal((await store.getActiveProfile())?.id, "local");
    assert.equal((await store.listProfiles()).length, 1);

    const now = Date.now();
    await store.set({
      namespace: "test",
      key: "key",
      value: "value",
      provenance: "{}",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10_000).toISOString(),
    });
    assert.equal((await store.get("test", "key"))?.value, "value");
    assert.equal((await store.stats()).entries, 1);

    const runBase = { runId: "run_test", sessionId: "session_test", correlationId: "correlation_test" };
    await store.append({ ...runBase, kind: "run.started", payload: { promptDigest: "digest" } });
    await store.append({ ...runBase, kind: "run.completed", payload: { ok: true } });
    assert.equal(await store.verifyRun("run_test"), true);
    await assert.rejects(store.append({ ...runBase, kind: "run.started", payload: { duplicate: true } }));
    assert.equal(await store.verifyRun("run_test"), true);

    const rule = await store.addShellRule({ executablePath: process.execPath, executableDigest: sha256(await readFile(process.execPath)), argumentPrefix: ["-e"] });
    assert.equal((await store.findAllowed(process.execPath, ["-e", "process.exit(0)"]))?.id, rule.id);
    assert.equal(store.listShellRules().length, 1);
    assert.equal(await store.removeShellRule(rule.id), true);
    store.close();

    const database = openSqliteDatabase(path);
    database.prepare("UPDATE events SET payload_json = ? WHERE run_id = ? AND sequence = 2").run('{"ok":false}', "run_test");
    database.close();
    const reopened = new SqliteStore({ path });
    assert.equal(await reopened.verifyRun("run_test"), false);
    reopened.close();
  });
});

test("SQLite rejects an unknown future schema", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "future.sqlite3");
    const database = openSqliteDatabase(path);
    database.exec("PRAGMA user_version = 999");
    database.close();
    assert.throws(() => new SqliteStore({ path }), /newer than supported/);
  });
});

test("SQLite rejects duplicate in-process writers and corrupt state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "writer.sqlite3");
    const first = new SqliteStore({ path });
    assert.throws(() => new SqliteStore({ path }), /writer open/i);
    first.close();
    const reopened = new SqliteStore({ path });
    reopened.close();

    const corruptPath = join(directory, "corrupt.sqlite3");
    await writeFile(corruptPath, "this is not sqlite", "utf8");
    assert.throws(() => new SqliteStore({ path: corruptPath }), /SQLite state|integrity/i);
  });
});

test("memory cache evicts, expires, and single-flight shares one result", async () => {
  const cache = new MemoryLruCache({ maxEntries: 1, maxBytes: 1024 });
  const now = Date.now();
  const entry = (key: string, expiresAt: number) => ({
    namespace: "n",
    key,
    value: key,
    provenance: "{}",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
  await cache.set(entry("a", now + 10_000));
  await cache.set(entry("b", now + 10_000));
  assert.equal(await cache.get("n", "a"), undefined);
  assert.equal((await cache.get("n", "b"))?.value, "b");
  await cache.set(entry("expired", now - 1));
  assert.equal(await cache.get("n", "expired"), undefined);

  const flights = new SingleFlight<number>();
  const owner = flights.acquire("same");
  const follower = flights.acquire("same");
  assert.equal(owner.owner, true);
  assert.equal(follower.owner, false);
  owner.complete(42);
  assert.equal(await follower.promise, 42);
});

test("bounded event channel coalesces progress and offers non-blocking resync boundaries", async () => {
  const channel = new BoundedEventChannel<number>(1);
  assert.equal(await channel.push(1, false), true);
  assert.equal(await channel.push(2, false), true);
  assert.deepEqual(await channel.next(), { value: 2, done: false });
  await channel.push(3, true);
  const blocked = channel.push(4, true);
  assert.deepEqual(await channel.next(), { value: 3, done: false });
  assert.equal(await blocked, true);
  assert.deepEqual(await channel.next(), { value: 4, done: false });
  channel.close();
  assert.equal((await channel.next()).done, true);
  const fanout = new BoundedEventChannel<string>(1, { maxBytes: 4, measure: (value) => Buffer.byteLength(value) });
  assert.equal(fanout.offer("ab", false), true);
  assert.equal(fanout.offer("cd", false, (previous) => `${previous}cd`), true);
  assert.equal(fanout.offer("overflow", true), false);
  assert.equal(fanout.replace("sync", true), true);
  assert.deepEqual(await fanout.next(), { value: "sync", done: false });
});

test("safe file tools read, grep, edit, write, and reject secret or stale access", async () => {
  await withTemporaryDirectory(async (directory) => {
    const source = join(directory, "source.txt");
    await writeFile(source, "alpha\nbeta\n", "utf8");
    await writeFile(join(directory, ".env"), "SECRET=value", "utf8");
    await writeFile(join(directory, ".npmrc"), "token=value", "utf8");
    const context = { projectRoot: directory, signal: new AbortController().signal };

    const read = await new ReadTool().execute({ path: "source.txt" }, context);
    assert.equal(read.content, "alpha\nbeta\n");
    await assert.rejects(new ReadTool().execute({ path: ".env" }, context), /secret/i);
    await assert.rejects(new ReadTool().execute({ path: ".npmrc" }, context), /secret/i);
    await assert.rejects(new ReadTool().execute({ path: "../outside.txt" }, context), /escapes/i);

    const grep = await new GrepTool().execute({ query: "beta" }, context);
    assert.match(grep.content, /source\.txt:2:beta/);

    await assert.rejects(
      new EditTool().execute({ path: "source.txt", expectedSha256: "0".repeat(64), oldText: "alpha", newText: "gamma" }, context),
      /changed/i,
    );
    const digest = sha256(await readFile(source, "utf8"));
    await new EditTool().execute({ path: "source.txt", expectedSha256: digest, oldText: "alpha", newText: "gamma" }, context);
    assert.match(await readFile(source, "utf8"), /gamma/);

    await new WriteTool().execute({ path: "new.txt", content: "created", mode: "create" }, context);
    assert.equal(await readFile(join(directory, "new.txt"), "utf8"), "created");
    await assert.rejects(new WriteTool().execute({ path: "new.txt", content: "again", mode: "create" }, context), /refuses/i);
    await assert.rejects(
      new WriteTool().execute({ path: "new.txt", content: "again", mode: "overwrite", expectedSha256: "0".repeat(64) }, context),
      /changed/i,
    );

    const outsideDirectory = await mkdtemp(join(tmpdir(), "alphion-outside-"));
    const outside = join(outsideDirectory, "outside-target.txt");
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(outside, join(directory, "linked.txt"));
      await assert.rejects(new ReadTool().execute({ path: "linked.txt" }, context), /escapes/i);
      await symlink(outsideDirectory, join(directory, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        new WriteTool().execute({ path: "linked-directory/new.txt", content: "escape", mode: "create" }, context),
        /escapes/i,
      );
    } catch (error) {
      if (!(error instanceof Error && /privilege|not permitted|operation not permitted/i.test(error.message))) throw error;
    } finally {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});

test("shell requires an allowlist rule and enforces executable digest", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "shell.sqlite3") });
    const shell = new ShellTool(store);
    const context = { projectRoot: directory, signal: new AbortController().signal };
    await assert.rejects(shell.execute({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"] }, context), /allowlisted/i);
    await store.addShellRule({
      executablePath: process.execPath,
      executableDigest: sha256(await readFile(process.execPath)),
      argumentPrefix: ["-e"],
    });
    const result = await shell.execute({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"] }, context);
    assert.equal(result.isError, false);
    assert.match(result.content, /stdout:\nok/);
    await assert.rejects(
      shell.execute({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 100 }, context),
      /timed out/i,
    );
    store.close();
  });
});

test("Agent runtime grounds a read tool result, persists events, and reuses both cache tiers", async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "fact.txt"), "observed fact", "utf8");
    const store = new SqliteStore({ path: join(directory, "agent.sqlite3") });
    const provider = new ReadThenAnswerProvider();
    const cache = new TieredCache(new MemoryLruCache(), store);
    const runtime = new AgentLoop({
      provider,
      tools: new ToolRegistry([new ReadTool()]),
      eventStore: store,
      approval: alwaysApprove(),
      cache,
    });
    const first = await runAndCollect(runtime, directory, "revision-1");
    assert.equal(first.result.status, "completed");
    assert.equal(first.result.grounding.missingEvidenceIds.length, 0);
    assert.equal(first.result.grounding.referencedEvidenceIds.length, 1);
    assert.equal(provider.calls, 2);
    assert.equal(await store.verifyRun(first.result.runId), true);

    const coldMemoryRuntime = new AgentLoop({
      provider,
      tools: new ToolRegistry([new ReadTool()]),
      eventStore: store,
      approval: alwaysApprove(),
      cache: new TieredCache(new MemoryLruCache(), store),
    });
    const second = await runAndCollect(coldMemoryRuntime, directory, "revision-1");
    assert.equal(second.result.status, "completed");
    assert.equal(provider.calls, 2);
    assert.ok(second.events.some((event) => event.kind === "cache.hit" && event.payload.tier === "l2"));
    await cache.delete();
    const third = await runAndCollect(runtime, directory, "revision-1");
    assert.equal(third.result.status, "completed");
    assert.equal(provider.calls, 4);
    store.close();
  });
});

test("Agent runtime denies a write when approval is unavailable", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "deny.sqlite3") });
    const runtime = new AgentLoop({
      provider: new WriteThenStopProvider(),
      tools: new ToolRegistry([new WriteTool()]),
      eventStore: store,
      approval: {
        revision: "test-deny-v1",
        requestApproval: () => Promise.resolve({ approved: false, reason: "test denial" }),
      },
    });
    const completed = await runAndCollect(runtime, directory, "revision-denied");
    assert.equal(completed.result.status, "completed");
    await assert.rejects(readFile(join(directory, "denied.txt")), /ENOENT/);
    assert.ok(completed.events.some((event) => event.kind === "approval.resolved" && event.payload.approved === false));
    store.close();
  });
});

test("Agent runtime preserves reasoning for tool continuation but excludes it from the final answer", async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, "fact.txt"), "fact", "utf8");
    const store = new SqliteStore({ path: join(directory, "reasoning.sqlite3") });
    const provider = new ReasoningThenAnswerProvider();
    const runtime = new AgentLoop({
      provider,
      tools: new ToolRegistry([new ReadTool()]),
      eventStore: store,
      approval: alwaysApprove(),
    });
    const collected = await runAndCollect(runtime, directory, "reasoning-revision");
    assert.equal(collected.result.finalText, "observed answer");
    assert.equal(collected.result.finalText.includes("inspect first"), false);
    assert.equal(collected.events.some((event) => event.kind === "model.reasoning.delta"), false);
    const replay = await store.listSessionEvents(collected.result.sessionId);
    assert.equal(JSON.stringify(replay).includes("inspect first"), false);
    assert.equal(provider.sawReasoningContinuation, true);
    store.close();
  });
});

test("Agent runtime propagates caller cancellation to the provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "cancel.sqlite3") });
    const runtime = new AgentLoop({
      provider: new WaitingProvider(),
      tools: new ToolRegistry([]),
      eventStore: store,
      approval: alwaysApprove(),
    });
    const handle = runtime.execute({ prompt: "wait", projectRoot: directory, projectRevision: "cancel-revision", systemPromptPlan: TEST_SYSTEM_PROMPT });
    const events: AgentStreamEvent[] = [];
    const consume = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    setTimeout(() => handle.cancel("test cancellation"), 10);
    const result = await handle.result;
    await consume;
    assert.equal(result.status, "cancelled");
    assert.ok(events.some((event) => event.kind === "run.cancelled"));
    store.close();
  });
});

test("Agent response cache identity includes policy, permission, tool, and provider revisions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "identity.sqlite3") });
    const counter = { calls: 0 };
    const provider = new CountingAnswerProvider(PROFILE, counter);
    const makeRuntime = (approvalRevision: string, policyRevision: string, toolDescription: string, selectedProvider = provider) =>
      new AgentLoop({
        provider: selectedProvider,
        tools: new ToolRegistry([dummyReadTool(toolDescription)]),
        eventStore: store,
        approval: { revision: approvalRevision, requestApproval: () => Promise.resolve({ approved: true, reason: "test" }) },
        policy: { revision: policyRevision, evaluate: () => ({ outcome: "allow" }) },
        cache: new TieredCache(new MemoryLruCache(), store),
      });

    await runAndCollect(makeRuntime("permission-1", "policy-1", "schema-1"), directory, "revision-1");
    await runAndCollect(makeRuntime("permission-2", "policy-1", "schema-1"), directory, "revision-1");
    await runAndCollect(makeRuntime("permission-2", "policy-2", "schema-1"), directory, "revision-1");
    await runAndCollect(makeRuntime("permission-2", "policy-2", "schema-2"), directory, "revision-1");
    const revisedProvider = new CountingAnswerProvider({ ...PROFILE, revision: 2 }, counter);
    await runAndCollect(makeRuntime("permission-2", "policy-2", "schema-2", revisedProvider), directory, "revision-1");
    assert.equal(counter.calls, 5);

    await runAndCollect(makeRuntime("permission-2", "policy-2", "schema-2", revisedProvider), directory, "revision-1");
    assert.equal(counter.calls, 5);
    store.close();
  });
});

test("Agent does not persist secret-like responses and redacts event payloads", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "secret.sqlite3") });
    const token = `sk-${"a".repeat(20)}`;
    const provider = new EchoProvider(token);
    const runtime = new AgentLoop({
      provider,
      tools: new ToolRegistry([]),
      eventStore: store,
      approval: alwaysApprove(),
      cache: new TieredCache(new MemoryLruCache(), store),
    });
    const first = await runAndCollect(runtime, directory, "revision-secret", `repeat ${token}`);
    const second = await runAndCollect(runtime, directory, "revision-secret", `repeat ${token}`);
    assert.equal(provider.calls, 2);
    assert.equal((await store.stats()).entries, 0);
    const serializedEvents = JSON.stringify([...first.events, ...second.events]);
    assert.doesNotMatch(serializedEvents, new RegExp(token));
    assert.match(serializedEvents, /REDACTED/);
    store.close();
  });
});

test("Agent fails closed on incomplete, oversized, and timed-out provider output", async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const [name, provider, budgets, expected] of [
      ["incomplete", new IncompleteProvider(), undefined, "dependency-unavailable"],
      ["oversized", new OversizedProvider(), { maxOutputBytes: 8 }, "budget-exceeded"],
      ["timeout", new WaitingProvider(), { modelTimeoutMs: 10, runTimeoutMs: 1000 }, "timeout"],
    ] as const) {
      const store = new SqliteStore({ path: join(directory, `${name}.sqlite3`) });
      const runtime = new AgentLoop({
        provider,
        tools: new ToolRegistry([]),
        eventStore: store,
        approval: alwaysApprove(),
      });
      const handle = runtime.execute({
        prompt: name,
        projectRoot: directory,
        projectRevision: `revision-${name}`,
        systemPromptPlan: TEST_SYSTEM_PROMPT,
        ...(budgets ? { budgets } : {}),
      });
      const consume = (async () => {
        for await (const _event of handle.events) {
          // Drain the bounded channel while the result is produced.
        }
      })();
      const result = await handle.result;
      await consume;
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, expected);
      store.close();
    }
  });
});

test("tool pipeline revalidates final hook args, approves final args, orders parallel updates/results, preserves barriers, times out, and terminates whole batch", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "pipeline.sqlite3") });
    const provider = new ToolBatchProvider();
    const timeline: string[] = [];
    const evidence: EvidenceRef = { id: "evidence-stable", kind: "search", digest: "a".repeat(64), summary: "stable" };
    const parallel = (name: string, delay: number, terminate = false): ToolExecutor => ({
      contract: { name, description: name, inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, risk: "read", cachePolicy: "none", executionMode: "parallel-safe", sideEffect: "none", idempotent: true, approval: "never", timeoutMs: 500 },
      before: [async (input) => ({ action: "continue", input: { value: Number(input.value) + 1 } })],
      execute: async (input, context) => { timeline.push(`start:${name}:${String(input.value)}`); await context.reportUpdate?.(`update:${name}`); await new Promise((resolve) => setTimeout(resolve, delay)); timeline.push(`end:${name}`); return { content: name, evidence, isError: false }; },
      after: [async (result) => ({ result: { ...result, content: `${result.content}:after`, evidence: { ...evidence, summary: `${name}:changed` } }, terminate })],
    });
    const barrier: ToolExecutor = { contract: { name: "barrier", description: "barrier", inputSchema: { type: "object", additionalProperties: false }, risk: "write", cachePolicy: "none", executionMode: "serial", sideEffect: "write", idempotent: false, approval: "always", timeoutMs: 500 }, before: [async () => ({ action: "continue", input: {} })], execute: async (_input, context) => { timeline.push("barrier"); await context.reportUpdate?.("update:barrier"); return { content: "barrier", isError: false }; } };
    const timeout: ToolExecutor = { contract: { name: "timeout-tool", description: "timeout", inputSchema: { type: "object", additionalProperties: false }, risk: "read", cachePolicy: "none", executionMode: "serial", sideEffect: "none", idempotent: true, approval: "never", timeoutMs: 5 }, execute: async (_input, context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })) };
    const approvals: Readonly<Record<string, unknown>>[] = [];
    const runtime = new AgentLoop({ provider, tools: new ToolRegistry([parallel("parallel-a", 20), parallel("parallel-b", 1, true), barrier, timeout]), eventStore: store, approval: { revision: "pipeline", requestApproval: (request) => { approvals.push(request.input); return Promise.resolve({ approved: true, reason: "test" }); } } });
    const collected = await runAndCollect(runtime, directory, "pipeline-revision", "pipeline");
    assert.equal(collected.result.status, "completed");
    assert.equal(provider.calls, 1, "whole-batch terminate skips the automatic next model call");
    assert.ok(timeline.indexOf("start:parallel-b:3") < timeline.indexOf("end:parallel-a"), "parallel-safe calls overlap");
    assert.ok(timeline.indexOf("end:parallel-b") < timeline.indexOf("end:parallel-a"), "executors may finish out of model order");
    assert.ok(timeline.indexOf("barrier") > timeline.indexOf("end:parallel-a"), "serialized call is a barrier");
    assert.deepEqual(approvals, [{}], "approval sees final before-hook arguments");
    const durableEvents = collected.events.filter(isAgentEvent);
    const updates = durableEvents.filter((event) => event.kind === "tool.updated").map((event) => event.payload.content);
    assert.deepEqual(updates, ["update:parallel-a", "update:parallel-b", "update:barrier"]);
    const completed = durableEvents.filter((event) => event.kind === "tool.completed");
    assert.deepEqual(completed.map((event) => event.payload.toolName), ["parallel-a", "parallel-b", "barrier", "timeout-tool"], "durable completions retain model order");
    assert.equal(completed.at(-1)?.payload.code, "timeout");
    store.close();
  });
});

test("tool pipeline rejects invalid before-hook arguments and evidence identity replacement", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "pipeline-invalid.sqlite3") });
    const invalid: ToolExecutor = { contract: { name: "invalid", description: "invalid", inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, risk: "read", cachePolicy: "none" }, before: [async () => ({ action: "continue", input: { value: "bad" } })], execute: () => Promise.resolve({ content: "must not execute", isError: false }) };
    const replace: ToolExecutor = { contract: { name: "replace", description: "replace", inputSchema: { type: "object", additionalProperties: false }, risk: "read", cachePolicy: "none" }, execute: () => Promise.resolve({ content: "ok", evidence: { id: "one", kind: "search", digest: "b".repeat(64), summary: "one" }, isError: false }), after: [async (result) => ({ result: { ...result, evidence: { id: "two", kind: "search", digest: "c".repeat(64), summary: "two" } } })] };
    const runtime = new AgentLoop({ provider: new ToolBatchProvider(["invalid", "replace"]), tools: new ToolRegistry([invalid, replace]), eventStore: store, approval: alwaysApprove() });
    const collected = await runAndCollect(runtime, directory, "pipeline-invalid", "pipeline");
    assert.equal(collected.result.status, "completed");
    assert.deepEqual(collected.events.filter(isAgentEvent).filter((event) => event.kind === "tool.completed").map((event) => event.payload.code), ["validation", "integrity-failed"]);
    store.close();
  });
});

class ToolBatchProvider implements AgentProvider {
  readonly profile = PROFILE;
  calls = 0;
  constructor(private readonly names: readonly string[] = ["parallel-a", "parallel-b", "barrier", "timeout-tool"]) {}
  async *generate(): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls > 1) { yield { type: "text-delta", delta: "replanned" }; yield { type: "done", finishReason: "stop" }; return; }
    for (const [index, name] of this.names.entries()) yield { type: "tool-call", call: { id: `call-${index}`, name, arguments: name.startsWith("parallel") ? { value: index + 1 } : {} } };
    yield { type: "done", finishReason: "tool_calls" };
  }
}

class ReadThenAnswerProvider implements AgentProvider {
  readonly profile = PROFILE;
  calls = 0;

  async *generate(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    const last = request.messages.at(-1);
    if (last?.role !== "tool") {
      yield { type: "tool-call", call: { id: "read_1", name: "read", arguments: { path: "fact.txt" } } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 } };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    const evidenceId = /\[evidence:([^\]]+)\]/.exec(last.content)?.[1];
    yield { type: "text-delta", delta: `observed: fact [evidence:${evidenceId ?? "missing"}]` };
    yield { type: "usage", usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } };
    yield { type: "done", finishReason: "stop" };
  }
}

class WriteThenStopProvider implements AgentProvider {
  readonly profile = PROFILE;

  async *generate(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const last = request.messages.at(-1);
    if (last?.role !== "tool") {
      yield { type: "tool-call", call: { id: "write_1", name: "write", arguments: { path: "denied.txt", content: "no", mode: "create" } } };
      yield { type: "done", finishReason: "tool_calls" };
    } else {
      yield { type: "text-delta", delta: "proposed: write was not executed" };
      yield { type: "done", finishReason: "stop" };
    }
  }
}

class ReasoningThenAnswerProvider implements AgentProvider {
  readonly profile: ProviderProfile = {
    schemaVersion: 2,
    id: PROFILE.id,
    name: PROFILE.name,
    kind: "deepseek",
    presetId: "deepseek",
    model: "deepseek-reasoner",
    protocol: "chat-completions",
    auth: PROFILE.auth,
    capabilities: { ...PROFILE.capabilities, reasoning: true },
    revision: PROFILE.revision,
    active: PROFILE.active,
  };
  sawReasoningContinuation = false;

  async *generate(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const last = request.messages.at(-1);
    if (last?.role !== "tool") {
      yield { type: "reasoning-delta", delta: "inspect first" };
      yield { type: "tool-call", call: { id: "read_reasoning", name: "read", arguments: { path: "fact.txt" } } };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }
    const assistant = request.messages.findLast((message) => message.role === "assistant");
    this.sawReasoningContinuation = assistant?.role === "assistant" && assistant.reasoningContent === "inspect first";
    yield { type: "text-delta", delta: "observed answer" };
    yield { type: "done", finishReason: "stop" };
  }
}

class WaitingProvider implements AgentProvider {
  readonly profile = PROFILE;

  async *generate(_request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    await new Promise<void>((_resolve, reject) => {
      const cancel = () => reject(signal.reason ?? new DOMException("Cancelled.", "AbortError"));
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
    yield { type: "done", finishReason: "unreachable" };
  }
}

class CountingAnswerProvider implements AgentProvider {
  readonly profile: ProviderProfile;
  readonly #counter: { calls: number };

  constructor(profile: ProviderProfile, counter: { calls: number }) {
    this.profile = profile;
    this.#counter = counter;
  }

  async *generate(): AsyncIterable<ProviderEvent> {
    this.#counter.calls += 1;
    yield { type: "text-delta", delta: "observed: stable answer" };
    yield { type: "done", finishReason: "stop" };
  }
}

class EchoProvider implements AgentProvider {
  readonly profile = PROFILE;
  calls = 0;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  async *generate(): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    yield { type: "text-delta", delta: this.#text };
    yield { type: "done", finishReason: "stop" };
  }
}

class IncompleteProvider implements AgentProvider {
  readonly profile = PROFILE;

  async *generate(): AsyncIterable<ProviderEvent> {
    yield { type: "text-delta", delta: "partial" };
  }
}

class OversizedProvider implements AgentProvider {
  readonly profile = PROFILE;

  async *generate(): AsyncIterable<ProviderEvent> {
    yield { type: "text-delta", delta: "output larger than eight bytes" };
    yield { type: "done", finishReason: "stop" };
  }
}

function dummyReadTool(description: string) {
  return {
    contract: {
      name: "dummy-read",
      description,
      inputSchema: { type: "object", additionalProperties: false },
      risk: "read" as const,
      cachePolicy: "content" as const,
    },
    execute: () => Promise.resolve({ content: "unused", isError: false }),
  };
}

function alwaysApprove(): ApprovalPort {
  return { revision: "test-allow-v1", requestApproval: () => Promise.resolve({ approved: true, reason: "test" }) };
}

async function runAndCollect(runtime: AgentLoop, projectRoot: string, projectRevision: string, prompt = "Read the fact.") {
  const handle = runtime.execute({ prompt, projectRoot, projectRevision, systemPromptPlan: TEST_SYSTEM_PROMPT });
  const events: AgentStreamEvent[] = [];
  const consume = (async () => {
    for await (const event of handle.events) events.push(event);
  })();
  const result = await handle.result;
  await consume;
  return { result, events };
}

async function withTemporaryDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-test-"));
  try {
    await operation(directory);
  } finally {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (process.platform !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
    }
  }
}
