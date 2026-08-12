import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSqliteDriverError, openSqliteDatabase } from "../adapters/store/database.js";
import { MemoryLruCache } from "../adapters/cache/memory-cache.js";
import { diagnoseLocalProject } from "../adapters/local/local-application.js";
import { NodeProjectProfiler } from "../adapters/project/project-profiler.js";
import { projectRevision } from "../adapters/project/project-revision.js";
import { AgentLoop } from "../src/application/agent-runtime.js";
import { sha256 } from "../src/application/canonical.js";
import { TieredCache } from "../src/application/cache.js";
import { assembleContextPack } from "../src/application/context-pack.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import { EMPTY_WORKING_MEMORY, reduceWorkingMemory } from "../src/application/working-memory.js";
import type { AgentProvider, ApprovalPort, EventStore } from "../src/ports/index.js";
import type { AgentEvent, AgentEventDraft } from "../src/protocol/events.js";

test("Phase 1 profiler deterministically detects Node/TypeScript facts and revision invalidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-profile-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({
      type: "module",
      engines: { node: ">=22.13" },
      scripts: { typecheck: "tsc --noEmit", test: "node --test", build: "tsc" },
      dependencies: { react: "19.2.0" },
    }));
    await writeFile(join(directory, "package-lock.json"), "{}");
    await writeFile(join(directory, "index.ts"), "export const value = 1;\n");
    const l2 = new MemoryLruCache();
    const cache = new TieredCache(new MemoryLruCache(), l2);
    const profiler = new NodeProjectProfiler({ cache });
    const [first, shared] = await Promise.all([
      profiler.inspect({ projectRoot: directory }),
      profiler.inspect({ projectRoot: directory }),
    ]);
    assert.deepEqual(shared, first);
    assert.equal(first.projectType, "node-typescript");
    assert.ok(first.facts.some((fact) => fact.id === "module-system:node" && fact.value === "ESM"));
    assert.deepEqual(first.qualityCommands, ["npm run typecheck", "npm run test", "npm run build"]);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 256 * 1024);
    const cached = await profiler.inspect({ projectRoot: directory });
    assert.equal(cached.digest, first.digest);
    const l2Reader = new NodeProjectProfiler({ cache: new TieredCache(new MemoryLruCache(), l2) });
    const persistentCached = await l2Reader.inspect({ projectRoot: directory });
    assert.equal(persistentCached.digest, first.digest);
    const revisionBefore = await projectRevision(directory);
    await writeFile(join(directory, "index.ts"), "export const value = 2;\n");
    const revisionAfter = await projectRevision(directory);
    assert.notEqual(revisionAfter, revisionBefore);
    const changed = await profiler.inspect({ projectRoot: directory });
    assert.notEqual(changed.projectRevision, first.projectRevision);
  } finally {
    await cleanup(directory);
  }
});

test("profiler reports bounded unknown, corrupt, conflict, secret, symlink and scan-limit conditions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-profile-edge-"));
  try {
    await writeFile(join(directory, "package.json"), "{ invalid");
    await writeFile(join(directory, "package-lock.json"), "{}");
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(join(directory, ".env"), "API_KEY=must-not-be-read\n");
    await writeFile(join(directory, "a.txt"), "a");
    await writeFile(join(directory, "b.txt"), "b");
    try {
      await symlink(join(directory, "a.txt"), join(directory, "linked.txt"));
    } catch {
      context.diagnostic("Symlink creation is unavailable; the remaining safety cases still run.");
    }
    const profile = await new NodeProjectProfiler({ scanLimit: 7, configLimitBytes: 8 }).inspect({ projectRoot: directory, refresh: true });
    const codes = new Set(profile.diagnostics.map((item) => item.code));
    assert.ok(codes.has("scan-truncated"));
    assert.ok(codes.has("conflicting-lockfiles"));
    assert.ok(codes.has("oversize-config"));
    assert.ok(codes.has("path-skipped"));
    assert.equal(JSON.stringify(profile).includes("must-not-be-read"), false);
    const corrupt = await new NodeProjectProfiler().inspect({ projectRoot: directory, refresh: true });
    assert.ok(corrupt.diagnostics.some((item) => item.code === "invalid-config"));
    const empty = await mkdtemp(join(tmpdir(), "alphion-profile-empty-"));
    try {
      const unknown = await new NodeProjectProfiler().inspect({ projectRoot: empty });
      assert.equal(unknown.projectType, "unknown");
      assert.ok(unknown.diagnostics.some((item) => item.code === "unknown-project"));
      assert.equal((await projectRevision(empty)), await projectRevision(empty));
    } finally {
      await cleanup(empty);
    }
  } finally {
    await cleanup(directory);
  }
});

test("ContextPack keeps mandatory items, records omissions and runtime injects it before model events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-context-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test", build: "tsc" } }));
    await writeFile(join(directory, "index.ts"), "export {};\n");
    const profile = await new NodeProjectProfiler().inspect({ projectRoot: directory });
    const contextPack = assembleContextPack({
      prompt: "Inspect this project and report observed facts. ".repeat(40),
      projectProfile: profile,
      systemInstructions: "Do not change files.",
      workingMemory: EMPTY_WORKING_MEMORY,
      budgetTokens: 256,
    });
    assert.ok(contextPack.estimatedTokens <= contextPack.budgetTokens);
    assert.deepEqual(contextPack.items.filter((item) => item.required).map((item) => item.category), [
      "security-policy", "goal", "permission", "constraint",
    ]);
    assert.ok(contextPack.omissions.length > 0);

    const events: AgentEvent[] = [];
    const requests: string[][] = [];
    const store = memoryEventStore();
    const provider: AgentProvider = {
      profile: {
        schemaVersion: 2,
        id: "fake",
        name: "Fake",
        kind: "custom-openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fake",
        protocol: "chat-completions",
        auth: { mode: "none" },
        capabilities: { streaming: true, tools: false, promptCaching: false, reasoning: false },
        revision: 1,
        active: true,
      },
      async *generate(request) {
        requests.push(request.messages.map((message) => message.content));
        yield { type: "text-delta", delta: "observed" };
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 1, cachedInputTokens: 0 } };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const runtime = new AgentLoop({ provider, tools: new ToolRegistry([]), eventStore: store, approval: allowApproval() });
    const handle = runtime.execute({
      prompt: "Inspect",
      projectRoot: directory,
      projectRevision: profile.projectRevision,
      systemPromptPlan: { schemaVersion: 1, sections: [], omissions: [], budgetTokens: 256, estimatedTokens: 1, rendered: "Do not change files.", digest: sha256("Do not change files.") },
      projectProfile: profile,
      contextPack,
      workingMemory: EMPTY_WORKING_MEMORY,
    });
    const consumed = (async () => { for await (const event of handle.events) if (!("delivery" in event)) events.push(event); })();
    const result = await handle.result;
    await consumed;
    assert.deepEqual(events.slice(0, 3).map((event) => event.kind), ["run.started", "project.profiled", "context.assembled"]);
    assert.equal(requests[0]?.[1], contextPack.rendered);
    assert.equal(result.context?.digest, contextPack.digest);
    assert.equal(result.workingMemory?.phase, "completed");
    assert.equal(result.workingMemory?.outputTokens, 1);
  } finally {
    await cleanup(directory);
  }
});

test("working memory is a deterministic replay of typed run events", () => {
  const kinds: AgentEvent["kind"][] = ["run.started", "project.profiled", "context.assembled", "provider.started", "tool.requested", "tool.completed", "run.completed"];
  const payloads: Readonly<Record<string, unknown>>[] = [
    {}, {}, {}, {}, {}, { evidence: { id: "evidence_1" } },
    { turns: 2, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 } },
  ];
  const final = kinds.reduce((state, kind, index) => reduceWorkingMemory(state, eventAt(kind, index + 1, payloads[index] ?? {})), EMPTY_WORKING_MEMORY);
  const replay = kinds.reduce((state, kind, index) => reduceWorkingMemory(state, eventAt(kind, index + 1, payloads[index] ?? {})), EMPTY_WORKING_MEMORY);
  assert.deepEqual(replay, final);
  assert.deepEqual(final, {
    schemaVersion: 1,
    phase: "completed",
    turns: 2,
    toolCalls: 1,
    evidenceIds: ["evidence_1"],
    errorCodes: [],
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 3,
    lastEventSequence: 7,
  });
});

test("doctor does not create or migrate missing local state and emits no secret detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-doctor-"));
  const statePath = join(directory, ".alphion", "doctor.sqlite3");
  try {
    const report = await diagnoseLocalProject({ projectRoot: directory, statePath });
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.checks.some((check) => check.id === "sqlite" && check.status === "warning"));
    await assert.rejects(access(statePath));
    assert.doesNotMatch(JSON.stringify(report), /api.?key|password|bearer/iu);
  } finally {
    await cleanup(directory);
  }
});

test("native SQLite ABI failures are dependency diagnostics, not database corruption", () => {
  const error = normalizeSqliteDriverError(new Error("better_sqlite3.node was compiled against NODE_MODULE_VERSION 148; this Node.js requires NODE_MODULE_VERSION 127"));
  assert.equal(error.code, "dependency-unavailable");
  assert.equal(error.stage, "database");
  assert.match(error.message, /native-abi-mismatch/u);
  assert.doesNotMatch(error.message, /corrupt|integrity/iu);
});

test("doctor fails closed on corrupt and future SQLite state without migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-doctor-state-"));
  try {
    const futurePath = join(directory, "future.sqlite3");
    const future = openSqliteDatabase(futurePath);
    future.exec("PRAGMA user_version = 99");
    future.close();
    const futureReport = await diagnoseLocalProject({ projectRoot: directory, statePath: futurePath });
    assert.ok(futureReport.checks.some((check) => check.id === "sqlite" && check.status === "fail" && check.summary.includes("99")));
    const verify = openSqliteDatabase(futurePath, { readOnly: true });
    const version = verify.prepare("PRAGMA user_version").get() as Readonly<Record<string, number>>;
    verify.close();
    assert.equal(version.user_version, 99);

    const corruptPath = join(directory, "corrupt.sqlite3");
    await writeFile(corruptPath, "not a sqlite database");
    const corruptReport = await diagnoseLocalProject({ projectRoot: directory, statePath: corruptPath });
    assert.ok(corruptReport.checks.some((check) => check.id === "sqlite" && check.status === "fail"));
  } finally {
    await cleanup(directory);
  }
});

test("doctor reports schema v2 as a pending read-only upgrade to v5", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-doctor-v2-"));
  try {
    const statePath = join(directory, "v2.sqlite3");
    const database = openSqliteDatabase(statePath);
    database.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE provider_profiles (id TEXT PRIMARY KEY, active INTEGER NOT NULL);
      CREATE TABLE vault_metadata (id INTEGER PRIMARY KEY);
    `);
    database.close();
    const report = await diagnoseLocalProject({ projectRoot: directory, statePath });
    const check = report.checks.find((item) => item.id === "sqlite");
    assert.equal(check?.status, "warning");
    assert.match(check?.summary ?? "", /schema 2.*5/u);
    const verify = openSqliteDatabase(statePath, { readOnly: true });
    const version = verify.prepare("PRAGMA user_version").get() as Readonly<Record<string, number>>;
    verify.close();
    assert.equal(version.user_version, 2);
  } finally {
    await cleanup(directory);
  }
});

function memoryEventStore(): EventStore {
  let sequence = 0;
  let previousDigest = "0".repeat(64);
  return {
    async append(draft: AgentEventDraft) {
      sequence += 1;
      const event: AgentEvent = {
        schemaVersion: 1,
        eventId: `event_${sequence}`,
        sequence,
        runId: draft.runId,
        sessionId: draft.sessionId,
        correlationId: draft.correlationId,
        ...(draft.causationId ? { causationId: draft.causationId } : {}),
        timestamp: "2026-08-11T00:00:00.000Z",
        kind: draft.kind,
        payload: draft.payload,
        previousDigest,
        digest: `${sequence}`.padStart(64, "0"),
      };
      previousDigest = event.digest;
      return event;
    },
    verifyRun: async () => true,
    listSessionEvents: async () => [],
  };
}

function allowApproval(): ApprovalPort {
  return { revision: "test", requestApproval: async () => ({ approved: true, reason: "test" }) };
}

function eventAt(kind: AgentEvent["kind"], sequence: number, payload: Readonly<Record<string, unknown>>): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: `event_${sequence}`,
    sequence,
    runId: "run_1",
    sessionId: "session_1",
    correlationId: "correlation_1",
    timestamp: "2026-08-11T00:00:00.000Z",
    kind,
    payload,
    previousDigest: "0".repeat(64),
    digest: "1".repeat(64),
  };
}

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
