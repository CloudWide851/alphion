import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeProviderModel, LOCAL_PROVIDER_PRESETS, resolveProviderEndpoint } from "../adapters/model/provider-catalog.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import type { BuiltInProviderKind, ProviderProfileInput } from "../src/domain/contracts.js";

const BUILT_INS = ["deepseek", "kimi", "qwen", "glm"] as const;

test("Provider catalog defaults to mainland and exposes international presets without endpoints", () => {
  for (const kind of BUILT_INS) {
    const mainland = LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === kind);
    const international = LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === `${kind}-international`);
    assert.equal(mainland?.kind, kind);
    assert.equal(mainland?.region, "mainland");
    assert.equal(mainland?.requiresBaseUrl, false);
    assert.equal(international?.kind, kind);
    assert.equal(international?.region, "international");
  }
  assert.equal(JSON.stringify(LOCAL_PROVIDER_PRESETS).includes("https://"), false);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")?.contextWindows?.["deepseek-chat"], 131_072);
  assert.deepEqual(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")?.visionModels, []);
});

test("Provider catalog resolves official endpoints only inside the adapter boundary", () => {
  assert.equal(resolveProviderEndpoint(builtIn("deepseek", "deepseek")), "https://api.deepseek.com");
  assert.equal(resolveProviderEndpoint(builtIn("kimi", "kimi-international")), "https://api.moonshot.ai/v1");
  assert.equal(resolveProviderEndpoint(builtIn("qwen", "qwen")), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(resolveProviderEndpoint(builtIn("glm", "glm-international")), "https://api.z.ai/api/paas/v4");
});

test("Provider profiles reject mismatched presets and unsafe custom URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-provider-catalog-"));
  const store = new SqliteStore({ path: join(directory, "state.sqlite3") });
  try {
    await assert.rejects(store.upsertProfile(builtIn("qwen", "kimi")), /does not match/iu);
    await assert.rejects(store.upsertProfile({ ...builtIn("deepseek", "deepseek"), model: "deepseek-v4-flash" }), /not in the catalog/iu);
    const advanced = await store.upsertProfile({ ...builtIn("deepseek", "deepseek"), id: "deepseek-advanced", model: "deepseek-v4-flash", capabilities: { ...builtIn("deepseek", "deepseek").capabilities, unlistedModel: true } });
    assert.equal(advanced.capabilities.unlistedModel, true);
    await assert.rejects(store.upsertProfile(custom("http://example.com/v1")), /HTTPS or loopback/iu);
    await assert.rejects(store.upsertProfile(custom("https://user:pass@example.com/v1")), /credentials/iu);
    const saved = await store.upsertProfile(custom("http://127.0.0.1:1234/v1/"));
    assert.equal(saved.kind, "custom-openai-compatible");
    if (saved.kind !== "custom-openai-compatible") assert.fail("Expected custom Provider.");
    assert.equal(saved.baseUrl, "http://127.0.0.1:1234/v1");
    const configured = await store.upsertProfile({ ...custom("http://127.0.0.1:1234/v1"), contextWindowTokens: 262_144, capabilities: { ...custom("http://127.0.0.1:1234/v1").capabilities, vision: true } });
    assert.equal(describeProviderModel(configured).contextWindowTokens, 262_144);
    assert.equal(configured.capabilities.vision, true);
    await assert.rejects(store.upsertProfile({ ...custom("http://127.0.0.1:1234/v1"), contextWindowTokens: 4_095 }), /4096.*4194304/iu);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function builtIn(kind: BuiltInProviderKind, presetId: string): ProviderProfileInput {
  return {
    schemaVersion: 3,
    id: `${kind}-${presetId}`,
    name: `${kind}-${presetId}`,
    kind,
    presetId,
    model: kind === "deepseek" ? "deepseek-chat" : kind === "kimi" ? "moonshot-v1-8k" : kind === "qwen" ? "qwen-plus" : "glm-4.5",
    protocol: "chat-completions",
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false },
  };
}

function custom(baseUrl: string): ProviderProfileInput {
  return {
    schemaVersion: 3,
    id: "custom",
    name: "custom",
    kind: "custom-openai-compatible",
    baseUrl,
    model: "custom-model",
    protocol: "chat-completions",
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false },
  };
}
