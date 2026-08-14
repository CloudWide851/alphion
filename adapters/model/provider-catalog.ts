import { AlphionError } from "../../src/application/errors.js";
import type { BuiltInProviderKind, ModelDescriptor, ProviderPreset, ProviderProfile, ProviderProfileInput } from "../../src/domain/contracts.js";

interface CatalogEntry extends ProviderPreset { readonly endpoint: string; }

const CATALOG: readonly CatalogEntry[] = Object.freeze([
  entry("deepseek", "DeepSeek（中国大陆）", "deepseek", "mainland", "https://api.deepseek.com", ["deepseek-chat", "deepseek-reasoner"]),
  entry("deepseek-international", "DeepSeek（国际）", "deepseek", "international", "https://api.deepseek.com", ["deepseek-chat", "deepseek-reasoner"]),
  entry("kimi", "Kimi（中国大陆）", "kimi", "mainland", "https://api.moonshot.cn/v1", ["moonshot-v1-8k", "kimi-k2-0711-preview"]),
  entry("kimi-international", "Kimi（国际）", "kimi", "international", "https://api.moonshot.ai/v1", ["moonshot-v1-8k", "kimi-k2-0711-preview"]),
  entry("qwen", "Qwen（中国大陆）", "qwen", "mainland", "https://dashscope.aliyuncs.com/compatible-mode/v1", ["qwen-plus", "qwen-max"]),
  entry("qwen-international", "Qwen（国际）", "qwen", "international", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ["qwen-plus", "qwen-max"]),
  entry("glm", "GLM（中国大陆）", "glm", "mainland", "https://open.bigmodel.cn/api/paas/v4", ["glm-4.5", "glm-4.5-air"]),
  entry("glm-international", "GLM（国际）", "glm", "international", "https://api.z.ai/api/paas/v4", ["glm-4.5", "glm-4.5-air"]),
  Object.freeze({ id: "custom-openai-compatible", label: "自定义 OpenAI 兼容接口", kind: "custom-openai-compatible", region: "custom", requiresBaseUrl: true, endpoint: "", models: Object.freeze([]), protocol: "chat-completions" }),
]);

const CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "deepseek-chat": 131_072,
  "deepseek-reasoner": 131_072,
  "moonshot-v1-8k": 8_192,
  "kimi-k2-0711-preview": 131_072,
  "qwen-plus": 131_072,
  "qwen-max": 131_072,
  "glm-4.5": 131_072,
  "glm-4.5-air": 131_072,
});

export const LOCAL_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze(CATALOG.map(({ endpoint: _endpoint, ...preset }) => Object.freeze(preset)));

function providerCatalogEntry(presetId: string): CatalogEntry {
  const preset = CATALOG.find((item) => item.id === presetId);
  if (!preset) throw new AlphionError("validation", "Unknown Provider preset.", { stage: "config" });
  return preset;
}

/** Returns form metadata without exposing official catalog endpoints. */
export function providerPreset(presetId: string): ProviderPreset {
  const preset = LOCAL_PROVIDER_PRESETS.find((item) => item.id === presetId);
  if (!preset) throw new AlphionError("validation", "Unknown Provider preset.", { stage: "config" });
  return preset;
}

export function resolveProviderEndpoint(profile: ProviderProfile | ProviderProfileInput): string {
  return profile.kind === "custom-openai-compatible" ? validateCustomEndpoint(profile.baseUrl) : providerCatalogEntry(profile.presetId).endpoint;
}

export function describeProviderModel(profile: ProviderProfile): ModelDescriptor {
  const cataloged = profile.kind !== "custom-openai-compatible" && providerCatalogEntry(profile.presetId).models.includes(profile.model);
  return Object.freeze({
    id: `${profile.kind === "custom-openai-compatible" ? profile.id : profile.presetId}:${profile.model}`,
    providerKind: profile.kind,
    model: profile.model,
    capabilities: profile.capabilities,
    contextWindowTokens: cataloged ? CONTEXT_WINDOWS[profile.model] ?? 32_768 : 32_768,
  });
}

export function validateProviderPreset(profile: ProviderProfile | ProviderProfileInput, allowStoredUnlistedModel = false): void {
  if (profile.kind === "custom-openai-compatible") { validateCustomEndpoint(profile.baseUrl); return; }
  const preset = providerCatalogEntry(profile.presetId);
  if (preset.kind !== profile.kind) throw new AlphionError("validation", "Provider kind does not match its catalog preset.", { stage: "config" });
  if (preset.protocol !== profile.protocol) throw new AlphionError("validation", "Built-in Provider protocol does not match its catalog preset.", { stage: "config" });
  if (!allowStoredUnlistedModel && !preset.models.includes(profile.model) && profile.capabilities.unlistedModel !== true) {
    throw new AlphionError("validation", "Built-in Provider model is not in the catalog; use the explicit advanced unlisted-model flow.", { stage: "config", reason: "unlisted-model-confirmation-required" });
  }
}

function entry(id: string, label: string, kind: BuiltInProviderKind, region: "mainland" | "international", endpoint: string, models: readonly string[]): CatalogEntry {
  return Object.freeze({ id, label, kind, region, requiresBaseUrl: false, endpoint, models: Object.freeze([...models]), protocol: "chat-completions" });
}

function validateCustomEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new AlphionError("validation", "Custom Provider URL is invalid.", { stage: "config", cause: error }); }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw new AlphionError("validation", "Custom Provider URL must use HTTPS or loopback HTTP without credentials, query, or fragment.", { stage: "config" });
  return url.toString().replace(/\/$/u, "");
}
