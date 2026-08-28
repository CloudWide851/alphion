import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAICompatibleProvider } from "../adapters/model/openai-compatible.js";
import { ProjectCodeRecall } from "../adapters/recall/project-code-recall.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { AgentSession } from "../src/application/agent-session.js";
import { Agent } from "../src/application/agent.js";
import { canonicalJson, sha256 } from "../src/application/canonical.js";
import { AlphionError } from "../src/application/errors.js";
import { DefaultProviderTestService } from "../src/application/provider-test.js";
import { ToolRegistry } from "../src/application/tool-registry.js";
import type { AgentShape, HarnessPlan, ProjectProfile, ProviderProfileInput } from "../src/domain/contracts.js";
import type { ApprovalPort, ModelResolver, ProviderFactory } from "../src/ports/index.js";

test("ProjectCodeRecall uses a three-second CodeGraph budget and caches success", async () => {
  await withProject(async (root) => {
    let calls = 0;
    let timeoutMs = 0;
    const recall = new ProjectCodeRecall(async (request) => {
      calls += 1;
      timeoutMs = request.timeoutMs;
      return "src/example.ts:1:bounded recall";
    });
    const request = { projectRoot: root, projectRevision: "r1", query: "bounded recall", limit: 50 };
    const first = await recall.recall(request, new AbortController().signal);
    const second = await recall.recall(request, new AbortController().signal);
    assert.equal(timeoutMs, 3_000);
    assert.equal(calls, 1);
    assert.equal(first.degraded, false);
    assert.equal(first.items.length, 1);
    assert.equal(second, first);
  });
});

test("ProjectCodeRecall classifies missing and failed CodeGraph then uses stable lexical ordering", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "b.ts"), "export const needle = 'b';\n", "utf8");
    await writeFile(join(root, "a.ts"), "export const needle = 'a';\n", "utf8");
    await mkdir(join(root, ".codegraph"));
    await writeFile(join(root, ".codegraph", "hidden.ts"), "needle", "utf8");
    const missing = Object.assign(new Error("not installed"), { code: "ENOENT" });
    const recall = new ProjectCodeRecall(async () => { throw missing; });
    const result = await recall.recall({ projectRoot: root, projectRevision: "r1", query: "needle" }, new AbortController().signal);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.items.map((item) => item.path), ["a.ts", "b.ts"]);
    assert.deepEqual(result.diagnostics, ["codegraph-missing:lexical-fallback"]);

    const failed = new ProjectCodeRecall(async () => { throw Object.assign(new Error("exit 1"), { code: 1 }); });
    const abnormal = await failed.recall({ projectRoot: root, projectRevision: "r2", query: "needle" }, new AbortController().signal);
    assert.equal(abnormal.diagnostics[0], "codegraph-failed:lexical-fallback");
  });
});

test("ProjectCodeRecall discards time-dependent lexical prefixes and does not cache them", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "source.ts"), "needle\n", "utf8");
    let calls = 0;
    let clock = 0;
    const recall = new ProjectCodeRecall(
      async () => { calls += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      () => { clock += 600; return clock; },
    );
    const request = { projectRoot: root, projectRevision: "r1", query: "needle" };
    const first = await recall.recall(request, new AbortController().signal);
    const second = await recall.recall(request, new AbortController().signal);
    assert.deepEqual(first.items, []);
    assert.deepEqual(second.items, []);
    assert.ok(first.diagnostics.includes("lexical-time-budget-exhausted"));
    assert.equal(calls, 2);
  });
});

test("ProjectCodeRecall enforces result, file and byte budgets deterministically", async () => {
  await withProject(async (root) => {
    const missing = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    const matches = join(root, "matches");
    await mkdir(matches);
    await Promise.all(Array.from({ length: 25 }, (_, index) => writeFile(join(matches, `${String(index).padStart(2, "0")}.ts`), "needle\n", "utf8")));
    const resultLimited = await new ProjectCodeRecall(missing, () => 0).recall({ projectRoot: root, projectRevision: "results", query: "needle", scope: ["matches"], limit: 50 }, new AbortController().signal);
    assert.equal(resultLimited.items.length, 20);
    assert.ok(resultLimited.diagnostics.includes("lexical-result-budget-exhausted"));

    const files = join(root, "files");
    await mkdir(files);
    await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(join(files, `${String(index).padStart(3, "0")}.txt`), "plain\n", "utf8")));
    let fileCalls = 0;
    const fileRecall = new ProjectCodeRecall(async () => { fileCalls += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, () => 0);
    const fileRequest = { projectRoot: root, projectRevision: "files", query: "needle", scope: ["files"] };
    const fileLimited = await fileRecall.recall(fileRequest, new AbortController().signal);
    await fileRecall.recall(fileRequest, new AbortController().signal);
    assert.ok(fileLimited.diagnostics.includes("lexical-file-budget-exhausted"));
    assert.equal(fileCalls, 1);

    const bytes = join(root, "bytes");
    await mkdir(bytes);
    const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
    await Promise.all(Array.from({ length: 9 }, (_, index) => writeFile(join(bytes, `${index}.txt`), oneMiB)));
    const byteLimited = await new ProjectCodeRecall(missing, () => 0).recall({ projectRoot: root, projectRevision: "bytes", query: "needle", scope: ["bytes"] }, new AbortController().signal);
    assert.ok(byteLimited.diagnostics.includes("lexical-byte-budget-exhausted"));
  });
});

test("ProjectCodeRecall propagates caller cancellation and never caches it", async () => {
  await withProject(async (root) => {
    let calls = 0;
    const recall = new ProjectCodeRecall(({ signal }) => new Promise<string>((_resolve, reject) => {
      calls += 1;
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }));
    const request = { projectRoot: root, projectRevision: "r1", query: "cancel me" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const reason = new DOMException("caller stopped recall", "AbortError");
      const pending = recall.recall(request, controller.signal);
      queueMicrotask(() => controller.abort(reason));
      await assert.rejects(pending, (error) => error === reason);
    }
    assert.equal(calls, 2);
  });
});

test("exact Provider test and full SQLite Session chat both succeed when Recall is unavailable", async () => {
  await withProtocolServer(async (baseUrl, requests, firstChatAt) => {
    await withProject(async (root) => {
      const store = new SqliteStore({ path: join(root, ".alphion", "alphion.sqlite3"), projectId: "project_v0102", domainId: "domain_v0102" });
      try {
        const profile = await store.upsertProfile(profileInput(baseUrl));
        const factory: ProviderFactory = { create: (selected) => new OpenAICompatibleProvider(selected, { resolve: () => Promise.resolve(undefined) }) };
        const providerTests = new DefaultProviderTestService(store, factory, 2_000);
        const testResult = await providerTests.test(profile.id);
        assert.equal(testResult.status, "success");

        const models = exactModels(store, factory);
        const agent = new Agent({ models, tools: new ToolRegistry([]), eventStore: store });
        const record = await store.createSession({ title: "v0.10.2 integration", providerId: profile.id, idempotencyKey: "v0102:create-session" });
        const harness = testHarness();
        const session = new AgentSession({
          sessionId: record.id,
          store,
          agent,
          projectRoot: root,
          projectProfile: () => Promise.resolve(TEST_PROJECT_PROFILE),
          environment: (_project, shape) => Promise.resolve({ identity: shape.identity, projectRoot: root, projectRevision: "revision", capabilities: shape.capabilities, policies: shape.policies, skills: [], resources: [], systemPromptPlan: shape.systemPromptPlan, digest: "environment" }),
          shape: (request, revision) => Promise.resolve(testShape(record.id, profile.id, request.goal, revision)),
          plan: () => harness,
          models,
          recall: { recall: (_request, signal) => new Promise((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
          }) },
        });
        const startedAt = Date.now();
        const run = await session.send("你好", { expectedRevision: record.revision, idempotencyKey: "v0102:send-chat" }, allowApproval());
        const result = await run.result;
        assert.equal(result.status, "completed");
        assert.equal(result.finalText, "聊天成功");
        assert.ok(firstChatAt.value - startedAt >= 4_500 && firstChatAt.value - startedAt < 5_800, `Provider started after ${firstChatAt.value - startedAt}ms`);
        const chatRequest = requests.at(-1) as { messages?: readonly { role?: string; content?: unknown }[] };
        assert.equal(chatRequest.messages?.filter((message) => message.role === "user" && message.content === "你好").length, 1);
        assert.equal((await session.get()).status, "idle");
        await session.close();
      } finally { store.close(); }
    });
  });
});

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "alphion-v0102-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function withProtocolServer(run: (baseUrl: string, requests: unknown[], firstChatAt: { value: number }) => Promise<void>): Promise<void> {
  const requests: unknown[] = [];
  const firstChatAt = { value: 0 };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as { messages?: readonly { role?: string; content?: unknown }[] };
    requests.push(parsed);
    if (parsed.messages?.some((message) => message.role === "user" && message.content === "你好")) firstChatAt.value ||= Date.now();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "chatcmpl-v0102", object: "chat.completion", created: 1, model: "local-v0102", choices: [{ index: 0, message: { role: "assistant", content: requests.length === 1 ? "Provider 实测成功" : "聊天成功" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${address.port}/v1`, requests, firstChatAt); }
  finally { await new Promise<void>((resolvePromise) => server.close(() => resolvePromise())); }
}

function profileInput(baseUrl: string): ProviderProfileInput {
  return { schemaVersion: 3, id: "provider_v0102", name: "v0.10.2 local", kind: "custom-openai-compatible", baseUrl, model: "local-v0102", protocol: "chat-completions", auth: { mode: "none" }, capabilities: { streaming: false, tools: false, promptCaching: false, reasoning: false, vision: false }, active: true };
}

function exactModels(store: SqliteStore, factory: ProviderFactory): ModelResolver {
  return {
    resolveModel: async (request) => {
      const profile = await store.getProfile(request.providerId ?? "provider_v0102");
      if (!profile) throw new Error("missing exact test profile");
      return factory.create(profile);
    },
    describeModel: (provider) => Promise.resolve({ id: provider.profile.id, providerKind: provider.profile.kind, model: provider.profile.model, capabilities: provider.profile.capabilities, contextWindowTokens: 32_768 }),
  };
}

function testShape(sessionId: string, providerId: string, goal: string, revision: number): AgentShape {
  const systemPromptPlan = { schemaVersion: 1 as const, sections: [], omissions: [], budgetTokens: 2048, estimatedTokens: 1, rendered: "You are Alphion.", digest: "prompt" };
  const base = { schemaVersion: 1 as const, sessionId, revision, goal, identity: { id: "v0102", name: "Alphion", description: "integration" }, systemPromptPlan, resources: [], resourceIds: [], resourceDigest: "resources", toolIds: [], capabilities: [], policies: [], behavior: { compaction: "hybrid" as const, steering: true, followUps: true }, providerId, requiredProviderCapabilities: [], harnessPlan: testHarness(), omissions: [], diagnostics: [] };
  return { ...base, digest: sha256(canonicalJson(base)) };
}

function testHarness(): HarnessPlan {
  return { schemaVersion: 1, task: "implement", taskLabels: ["implement"], risk: "low", capabilities: [], reasons: [], permissions: [], budgets: {}, evaluator: "test", omissions: [], digest: "harness" };
}

function allowApproval(): ApprovalPort {
  return { revision: "allow", requestApproval: () => Promise.resolve({ approved: true, reason: "test" }) };
}

const TEST_PROJECT_PROFILE: ProjectProfile = { schemaVersion: 1, projectRevision: "revision", profilerVersion: "test", rulesVersion: "test", projectType: "unknown", facts: [], qualityCommands: [], diagnostics: [], scannedPaths: 0, truncated: false, digest: "profile" };
