import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_PROVIDER_PRESETS, resolveProviderEndpoint } from "../adapters/model/provider-catalog.js";
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
    await assert.rejects(store.upsertProfile(custom("http://example.com/v1")), /HTTPS or loopback/iu);
    await assert.rejects(store.upsertProfile(custom("https://user:pass@example.com/v1")), /credentials/iu);
    const saved = await store.upsertProfile(custom("http://127.0.0.1:1234/v1/"));
    assert.equal(saved.kind, "custom-openai-compatible");
    if (saved.kind !== "custom-openai-compatible") assert.fail("Expected custom Provider.");
    assert.equal(saved.baseUrl, "http://127.0.0.1:1234/v1");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function builtIn(kind: BuiltInProviderKind, presetId: string): ProviderProfileInput {
  return {
    schemaVersion: 2,
    id: `${kind}-${presetId}`,
    name: `${kind}-${presetId}`,
    kind,
    presetId,
    model: `${kind}-model`,
    protocol: "chat-completions",
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
  };
}

function custom(baseUrl: string): ProviderProfileInput {
  return {
    schemaVersion: 2,
    id: "custom",
    name: "custom",
    kind: "custom-openai-compatible",
    baseUrl,
    model: "custom-model",
    protocol: "chat-completions",
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
  };
}
