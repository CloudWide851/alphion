import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/application/agent-runtime.js";
import { SingleFlight, TieredCache } from "../src/application/cache.js";
import { sha256 } from "../src/application/canonical.js";
import { BoundedEventChannel } from "../src/application/event-channel.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import type { AgentProvider, ApprovalPort } from "../src/ports/index.js";
import type { ProviderEvent, ProviderProfile, ProviderRequest } from "../src/domain/contracts.js";
import type { AgentEvent } from "../src/protocol/events.js";
import { MemoryLruCache } from "../adapters/cache/memory-cache.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { EditTool, GrepTool, ReadTool, ShellTool, WriteTool } from "../adapters/tools/index.js";

const PROFILE: ProviderProfile = Object.freeze({
  schemaVersion: 1,
  id: "fake",
  name: "fake",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "fake-model",
  protocol: "chat-completions",
  auth: { mode: "none" as const },
  capabilities: { streaming: true, tools: true, promptCaching: true },
  revision: 1,
  active: true,
});

test("SQLite profiles, cache, hash-chain events, and shell rules round-trip", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "state.sqlite3");
    const store = new SqliteStore({ path });
    const created = await store.upsertProfile({
      schemaVersion: 1,
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "local-model",
      protocol: "chat-completions",
      auth: { mode: "bearer-env", environmentVariable: "LOCAL_MODEL_KEY" },
      capabilities: { streaming: true, tools: true, promptCaching: false },
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

    const database = new DatabaseSync(path);
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
    const database = new DatabaseSync(path);
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

test("bounded event channel coalesces progress and backpressures critical events", async () => {
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
    const runtime = new AgentRuntime({
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

    const coldMemoryRuntime = new AgentRuntime({
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
    const runtime = new AgentRuntime({
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

test("Agent runtime propagates caller cancellation to the provider", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "cancel.sqlite3") });
    const runtime = new AgentRuntime({
      provider: new WaitingProvider(),
      tools: new ToolRegistry([]),
      eventStore: store,
      approval: alwaysApprove(),
    });
    const handle = runtime.start({ prompt: "wait", projectRoot: directory, projectRevision: "cancel-revision" });
    const events: AgentEvent[] = [];
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
      new AgentRuntime({
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
    const runtime = new AgentRuntime({
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
      const runtime = new AgentRuntime({
        provider,
        tools: new ToolRegistry([]),
        eventStore: store,
        approval: alwaysApprove(),
      });
      const handle = runtime.start({
        prompt: name,
        projectRoot: directory,
        projectRevision: `revision-${name}`,
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

async function runAndCollect(runtime: AgentRuntime, projectRoot: string, projectRevision: string, prompt = "Read the fact.") {
  const handle = runtime.start({ prompt, projectRoot, projectRevision });
  const events: AgentEvent[] = [];
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
