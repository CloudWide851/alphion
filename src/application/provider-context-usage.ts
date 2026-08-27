import type { ProviderContextUsage, ProviderRequest, ProviderUsage } from "../domain/contracts.js";

export const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_768;

export function estimateProviderContextUsage(request: ProviderRequest, contextWindowTokens: number): ProviderContextUsage {
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), "utf8") / 4));
  return contextUsage("estimated", { inputTokens, outputTokens: 0, cachedInputTokens: 0 }, contextWindowTokens);
}

export function actualProviderContextUsage(usage: ProviderUsage, contextWindowTokens: number): ProviderContextUsage {
  return contextUsage("actual", usage, contextWindowTokens);
}

function contextUsage(source: ProviderContextUsage["source"], usage: ProviderUsage, contextWindowTokens: number): ProviderContextUsage {
  return Object.freeze({
    schemaVersion: 1,
    source,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    occupiedTokens: usage.inputTokens + usage.outputTokens,
    contextWindowTokens,
  });
}
