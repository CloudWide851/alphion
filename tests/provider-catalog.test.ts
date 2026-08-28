import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEEPSEEK_MODELS } from "../adapters/model/deepseek.js";
import { describeProviderModel, LOCAL_PROVIDER_PRESETS, resolveProviderEndpoint, validateProviderPreset } from "../adapters/model/provider-catalog.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import type { BuiltInProviderKind, ProviderProfileInput } from "../src/domain/contracts.js";

const BUILT_INS = ["deepseek", "kimi", "qwen", "glm"] as const;
const CURRENT_MODELS = Object.freeze({
  deepseek: Object.freeze(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]),
  kimi: Object.freeze(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"]),
  qwen: Object.freeze(["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"]),
  glm: Object.freeze(["glm-5.3", "glm-5.3-flash", "glm-5.2"]),
});
const VISION_MODELS = Object.freeze({
  deepseek: Object.freeze(["deepseek-v4-flash-vision-exp"]),
  kimi: CURRENT_MODELS.kimi,
  qwen: Object.freeze(["qwen3.8-max", "qwen3.7-plus"]),
  glm: Object.freeze(["glm-5.3-flash"]),
});

test("Provider catalog defaults to mainland and exposes international presets without endpoints", () => {
  for (const kind of BUILT_INS) {
    const mainland = LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === kind);
    const international = LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === `${kind}-international`);
    assert.equal(mainland?.kind, kind);
    assert.equal(mainland?.region, "mainland");
    assert.equal(mainland?.requiresBaseUrl, false);
    assert.equal(international?.kind, kind);
    assert.equal(international?.region, "international");
    assert.deepEqual(mainland?.models, CURRENT_MODELS[kind]);
    assert.deepEqual(international?.models, CURRENT_MODELS[kind]);
    assert.deepEqual(mainland?.contextWindows, expectedContextWindows(kind));
    assert.deepEqual(international?.contextWindows, expectedContextWindows(kind));
    assert.deepEqual(mainland?.visionModels, VISION_MODELS[kind]);
    assert.deepEqual(international?.visionModels, VISION_MODELS[kind]);
  }
  const serialized = JSON.stringify(LOCAL_PROVIDER_PRESETS);
  assert.equal(serialized.includes("https://"), false);
  assert.equal(serialized.includes("legacyModels"), false);
  for (const legacy of ["deepseek-chat", "deepseek-reasoner", "moonshot-v1-8k", "kimi-k2-0711-preview", "qwen-plus", "qwen-max", "glm-4.5", "glm-4.5-air"]) assert.equal(serialized.includes(legacy), false);
  assert.deepEqual(DEEPSEEK_MODELS, CURRENT_MODELS.deepseek);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")?.contextWindows?.["deepseek-v4-flash"], 1_048_576);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "kimi")?.contextWindows?.["kimi-k3"], 1_048_576);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "kimi")?.contextWindows?.["kimi-k2.7-code"], 262_144);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "qwen")?.contextWindows?.["qwen3.8-flash"], 1_048_576);
  assert.equal(LOCAL_PROVIDER_PRESETS.find((preset) => preset.id === "glm")?.contextWindows?.["glm-5.2"], 1_048_576);
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
    await assert.rejects(store.upsertProfile({ ...builtIn("deepseek", "deepseek"), model: "deepseek-v999" }), /not in the catalog/iu);
    const advanced = await store.upsertProfile({ ...builtIn("deepseek", "deepseek"), id: "deepseek-advanced", model: "deepseek-v999", capabilities: { ...builtIn("deepseek", "deepseek").capabilities, unlistedModel: true } });
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

test("Provider catalog keeps v0.10 built-in models as private stored-profile compatibility", () => {
  const legacyModels = Object.freeze({ deepseek: "deepseek-chat", kimi: "moonshot-v1-8k", qwen: "qwen-plus", glm: "glm-4.5" });
  for (const kind of BUILT_INS) {
    const input = builtIn(kind, kind, legacyModels[kind]);
    assert.throws(() => validateProviderPreset(input), /not in the catalog/iu);
    const stored = { ...input, revision: 1, active: true };
    assert.doesNotThrow(() => validateProviderPreset(stored, true));
    assert.notEqual(describeProviderModel(stored).contextWindowTokens, 32_768);
  }
});

function builtIn(kind: BuiltInProviderKind, presetId: string, model = CURRENT_MODELS[kind][0]): Extract<ProviderProfileInput, { readonly kind: BuiltInProviderKind }> {
  return {
    schemaVersion: 3,
    id: `${kind}-${presetId}`,
    name: `${kind}-${presetId}`,
    kind,
    presetId,
    model,
    protocol: "chat-completions",
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false },
  };
}

function expectedContextWindows(kind: BuiltInProviderKind): Readonly<Record<string, number>> {
  return Object.fromEntries(CURRENT_MODELS[kind].map((model) => [model, kind === "kimi" && model !== "kimi-k3" ? 262_144 : 1_048_576]));
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
