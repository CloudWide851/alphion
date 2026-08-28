import { AlphionError } from "../../src/application/errors.js";
import type { BuiltInProviderKind, ModelDescriptor, ProviderPreset, ProviderProfile, ProviderProfileInput } from "../../src/domain/contracts.js";

interface CatalogEntry extends ProviderPreset {
  readonly endpoint: string;
  readonly legacyModels: readonly string[];
}

export const DEEPSEEK_CATALOG_MODELS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
] as const);

const KIMI_CATALOG_MODELS = Object.freeze(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"] as const);
const QWEN_CATALOG_MODELS = Object.freeze(["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"] as const);
const GLM_CATALOG_MODELS = Object.freeze(["glm-5.3", "glm-5.3-flash", "glm-5.2"] as const);

const CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "deepseek-v4-flash": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
  "deepseek-v4-flash-vision-exp": 1_048_576,
  "deepseek-chat": 131_072,
  "deepseek-reasoner": 131_072,
  "kimi-k3": 1_048_576,
  "kimi-k2.7-code": 262_144,
  "kimi-k2.7-code-highspeed": 262_144,
  "kimi-k2.6": 262_144,
  "kimi-k2.5": 262_144,
  "moonshot-v1-8k": 8_192,
  "kimi-k2-0711-preview": 131_072,
  "qwen3.8-max": 1_048_576,
  "qwen3.7-plus": 1_048_576,
  "qwen3.8-flash": 1_048_576,
  "qwen-plus": 131_072,
  "qwen-max": 131_072,
  "glm-5.3": 1_048_576,
  "glm-5.3-flash": 1_048_576,
  "glm-5.2": 1_048_576,
  "glm-4.5": 131_072,
  "glm-4.5-air": 131_072,
});

const VISION_MODELS: ReadonlySet<string> = new Set<string>([
  "deepseek-v4-flash-vision-exp",
  ...KIMI_CATALOG_MODELS,
  "qwen3.8-max",
  "qwen3.7-plus",
  "glm-5.3-flash",
]);

const CATALOG: readonly CatalogEntry[] = Object.freeze([
  entry("deepseek", "DeepSeek（中国大陆）", "deepseek", "mainland", "https://api.deepseek.com", DEEPSEEK_CATALOG_MODELS, ["deepseek-chat", "deepseek-reasoner"]),
  entry("deepseek-international", "DeepSeek（国际）", "deepseek", "international", "https://api.deepseek.com", DEEPSEEK_CATALOG_MODELS, ["deepseek-chat", "deepseek-reasoner"]),
  entry("kimi", "Kimi（中国大陆）", "kimi", "mainland", "https://api.moonshot.cn/v1", KIMI_CATALOG_MODELS, ["moonshot-v1-8k", "kimi-k2-0711-preview"]),
  entry("kimi-international", "Kimi（国际）", "kimi", "international", "https://api.moonshot.ai/v1", KIMI_CATALOG_MODELS, ["moonshot-v1-8k", "kimi-k2-0711-preview"]),
  entry("qwen", "Qwen（中国大陆）", "qwen", "mainland", "https://dashscope.aliyuncs.com/compatible-mode/v1", QWEN_CATALOG_MODELS, ["qwen-plus", "qwen-max"]),
  entry("qwen-international", "Qwen（国际）", "qwen", "international", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", QWEN_CATALOG_MODELS, ["qwen-plus", "qwen-max"]),
  entry("glm", "GLM（中国大陆）", "glm", "mainland", "https://open.bigmodel.cn/api/paas/v4", GLM_CATALOG_MODELS, ["glm-4.5", "glm-4.5-air"]),
  entry("glm-international", "GLM（国际）", "glm", "international", "https://api.z.ai/api/paas/v4", GLM_CATALOG_MODELS, ["glm-4.5", "glm-4.5-air"]),
  Object.freeze({ id: "custom-openai-compatible", label: "自定义 OpenAI 兼容接口", kind: "custom-openai-compatible", region: "custom", requiresBaseUrl: true, endpoint: "", models: Object.freeze([]), legacyModels: Object.freeze([]), protocol: "chat-completions" }),
]);

export const LOCAL_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze(CATALOG.map(({ endpoint: _endpoint, legacyModels: _legacyModels, ...preset }) => Object.freeze(preset)));

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
  const cataloged = profile.kind !== "custom-openai-compatible" && knownCatalogModel(providerCatalogEntry(profile.presetId), profile.model);
  return Object.freeze({
    id: `${profile.kind === "custom-openai-compatible" ? profile.id : profile.presetId}:${profile.model}`,
    providerKind: profile.kind,
    model: profile.model,
    capabilities: profile.capabilities,
    contextWindowTokens: profile.contextWindowTokens ?? (cataloged ? CONTEXT_WINDOWS[profile.model] ?? 32_768 : 32_768),
  });
}

export function validateProviderPreset(profile: ProviderProfile | ProviderProfileInput, allowStoredLegacyModel = false): void {
  if (profile.kind === "custom-openai-compatible") { validateCustomEndpoint(profile.baseUrl); return; }
  const preset = providerCatalogEntry(profile.presetId);
  if (preset.kind !== profile.kind) throw new AlphionError("validation", "Provider kind does not match its catalog preset.", { stage: "config" });
  if (preset.protocol !== profile.protocol) throw new AlphionError("validation", "Built-in Provider protocol does not match its catalog preset.", { stage: "config" });
  const supported = preset.models.includes(profile.model) || (allowStoredLegacyModel && preset.legacyModels.includes(profile.model));
  if (!supported && profile.capabilities.unlistedModel !== true) {
    throw new AlphionError("validation", "Built-in Provider model is not in the catalog; use the explicit advanced unlisted-model flow.", { stage: "config", reason: "unlisted-model-confirmation-required" });
  }
}

function entry(id: string, label: string, kind: BuiltInProviderKind, region: "mainland" | "international", endpoint: string, models: readonly string[], legacyModels: readonly string[]): CatalogEntry {
  const contextWindows = Object.freeze(Object.fromEntries(models.map((model) => [model, CONTEXT_WINDOWS[model] ?? 32_768])));
  const visionModels = Object.freeze(models.filter((model) => VISION_MODELS.has(model)));
  return Object.freeze({ id, label, kind, region, requiresBaseUrl: false, endpoint, models: Object.freeze([...models]), legacyModels: Object.freeze([...legacyModels]), contextWindows, visionModels, protocol: "chat-completions" });
}

function knownCatalogModel(entry: CatalogEntry, model: string): boolean { return entry.models.includes(model) || entry.legacyModels.includes(model); }

function validateCustomEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new AlphionError("validation", "Custom Provider URL is invalid.", { stage: "config", cause: error }); }
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw new AlphionError("validation", "Custom Provider URL must use HTTPS or loopback HTTP without credentials, query, or fragment.", { stage: "config" });
  return url.toString().replace(/\/$/u, "");
}
