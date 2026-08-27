import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import { AlphionError } from "../../src/application/errors.js";
import type {
  ProviderMessage,
  AgentToolCall,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest,
  ProviderUsage,
} from "../../src/domain/contracts.js";
import type { AgentProvider, AttachmentReader, SecretResolver } from "../../src/ports/index.js";
import { resolveProviderEndpoint } from "./provider-catalog.js";
import { validateProviderPreset } from "./provider-catalog.js";
import { toChatUserContent } from "./provider-image-content.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODELS = Object.freeze(["deepseek-chat", "deepseek-reasoner"] as const);

export class DeepSeekProvider implements AgentProvider {
  readonly profile: ProviderProfile;
  readonly #secrets: SecretResolver;
  readonly #endpoint: (profile: ProviderProfile) => string;
  readonly #attachments: AttachmentReader | undefined;

  constructor(profile: ProviderProfile, secrets: SecretResolver, options: Readonly<{ endpoint?: (profile: ProviderProfile) => string; attachments?: AttachmentReader }> = {}) {
    const endpoint = options.endpoint ?? resolveProviderEndpoint;
    validateProfile(profile, endpoint);
    this.profile = Object.freeze({
      ...profile,
      auth: Object.freeze({ ...profile.auth }),
      capabilities: Object.freeze({ ...profile.capabilities }),
    });
    this.#secrets = secrets;
    this.#endpoint = endpoint;
    this.#attachments = options.attachments;
  }

  async *generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const client = await this.#createClient();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let observed = false;
      try {
        const events = this.profile.capabilities.streaming
          ? this.#generateStreaming(client, request, signal)
          : this.#generateNonStreaming(client, request, signal);
        for await (const event of events) {
          observed = true;
          yield event;
        }
        return;
      } catch (error) {
        if (signal.aborted) throw normalizeDeepSeekError(signal.reason);
        if (observed || attempt === 1 || !isRetryable(error)) throw normalizeDeepSeekError(error);
        await waitForRetry(attempt, signal);
      }
    }
  }

  async #createClient(): Promise<OpenAI> {
    if (this.profile.auth.mode === "none") {
      throw new AlphionError("dependency-unavailable", "DeepSeek requires a configured API credential.", {
        stage: "provider",
        reason: "credential-unavailable",
      });
    }
    const reference = this.profile.auth.mode === "bearer-env"
      ? this.profile.auth.environmentVariable
      : this.profile.auth.secretId;
    const apiKey = await this.#secrets.resolve(reference);
    if (!apiKey) {
      throw new AlphionError("dependency-unavailable", "The DeepSeek Project credential is unavailable.", {
        stage: "provider",
        reason: "credential-unavailable",
      });
    }
    return new OpenAI({ apiKey, baseURL: this.#endpoint(this.profile), maxRetries: 0 });
  }

  async *#generateStreaming(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    let observedChunk = false;
    try {
      const tools = toTools(request);
      const body = {
        model: this.profile.model,
        messages: await toMessages(request.messages, this.#attachments, signal),
        ...(tools.length > 0 ? { tools } : {}),
        max_tokens: request.maxOutputTokens,
        ...(!this.profile.capabilities.reasoning ? { temperature: request.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      } as ChatCompletionCreateParamsStreaming;
      const stream = await client.chat.completions.create(body, { signal });
      const pending = new Map<number, PendingToolCall>();
      let finishReason = "stop";
      for await (const chunk of stream) {
        observedChunk = true;
        yield* decodeChunk(chunk, pending);
        const reason = chunk.choices[0]?.finish_reason;
        if (reason) finishReason = reason;
      }
      for (const value of pending.values()) {
        yield { type: "tool-call", call: toToolCall(value.id, value.name, value.argumentsText) };
      }
      yield { type: "done", finishReason };
    } catch (error) {
      if (observedChunk || !isStreamingCompatibilityError(error)) throw error;
      yield { type: "degraded", reason: "DeepSeek streaming was unavailable; retried once without streaming." };
      yield* this.#generateNonStreaming(client, request, signal);
    }
  }

  async *#generateNonStreaming(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const tools = toTools(request);
    const body = {
      model: this.profile.model,
      messages: await toMessages(request.messages, this.#attachments, signal),
      ...(tools.length > 0 ? { tools } : {}),
      max_tokens: request.maxOutputTokens,
      ...(!this.profile.capabilities.reasoning ? { temperature: request.temperature } : {}),
      stream: false,
    } as ChatCompletionCreateParamsNonStreaming;
    const completion = await client.chat.completions.create(body, { signal });
    yield* decodeCompletion(completion);
  }
}

interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsText: string;
}

function validateProfile(profile: ProviderProfile, endpoint: (profile: ProviderProfile) => string): void {
  if (profile.schemaVersion !== 3 || profile.kind !== "deepseek" || profile.protocol !== "chat-completions") {
    throw new AlphionError("validation", "DeepSeek requires a schema-v3 DeepSeek Chat Completions profile.", {
      stage: "provider",
    });
  }
  validateProviderPreset(profile);
  let url: URL;
  try {
    url = new URL(endpoint(profile));
  } catch (error) {
    throw new AlphionError("validation", "DeepSeek provider URL is invalid.", { stage: "provider", cause: error });
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new AlphionError("validation", "DeepSeek URL must use HTTPS or loopback HTTP without embedded credentials.", {
      stage: "provider",
    });
  }
  if (profile.auth.mode === "bearer-env" && !/^[A-Z_][A-Z0-9_]*$/.test(profile.auth.environmentVariable)) {
    throw new AlphionError("validation", "DeepSeek environment credential reference is invalid.", { stage: "provider" });
  }
  if (profile.auth.mode === "encrypted-project" && !/^credential_[A-Za-z0-9_-]{8,}$/u.test(profile.auth.secretId)) {
    throw new AlphionError("validation", "DeepSeek Project credential reference is invalid.", { stage: "provider" });
  }
}

async function toMessages(messages: readonly ProviderMessage[], attachments: AttachmentReader | undefined, signal: AbortSignal): Promise<ChatCompletionMessageParam[]> {
  const result: ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        result.push({ role: "system", content: message.content }); break;
      case "user":
        result.push({ role: "user", content: await toChatUserContent(message.content, attachments, signal) }); break;
      case "assistant":
        result.push({
          role: "assistant",
          content: message.content,
          ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        } as ChatCompletionMessageParam); break;
      case "tool":
        result.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content }); break;
    }
  }
  return result;
}


function toTools(request: ProviderRequest): ChatCompletionTool[] {
  return request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function* decodeChunk(chunk: ChatCompletionChunk, pending: Map<number, PendingToolCall>): Iterable<ProviderEvent> {
  const choice = chunk.choices[0];
  const content = choice?.delta.content;
  if (typeof content === "string" && content.length > 0) yield { type: "text-delta", delta: content };
  const reasoning = optionalString(choice?.delta, "reasoning_content");
  if (reasoning) yield { type: "reasoning-delta", delta: reasoning };
  for (const partial of choice?.delta.tool_calls ?? []) {
    const previous = pending.get(partial.index) ?? {
      id: partial.id ?? `tool_${partial.index}`,
      name: "",
      argumentsText: "",
    };
    pending.set(partial.index, {
      id: partial.id ?? previous.id,
      name: partial.function?.name ?? previous.name,
      argumentsText: previous.argumentsText + (partial.function?.arguments ?? ""),
    });
  }
  if (chunk.usage) yield { type: "usage", usage: deepSeekUsage(chunk.usage) };
}

function* decodeCompletion(completion: ChatCompletion): Iterable<ProviderEvent> {
  const choice = completion.choices[0];
  if (!choice) {
    throw new AlphionError("dependency-unavailable", "DeepSeek returned no chat completion choice.", { stage: "provider" });
  }
  const reasoning = optionalString(choice.message, "reasoning_content");
  if (reasoning) yield { type: "reasoning-delta", delta: reasoning };
  if (choice.message.content) yield { type: "text-delta", delta: choice.message.content };
  for (const call of choice.message.tool_calls ?? []) {
    if (call.type === "function") {
      yield { type: "tool-call", call: toToolCall(call.id, call.function.name, call.function.arguments) };
    }
  }
  if (completion.usage) yield { type: "usage", usage: deepSeekUsage(completion.usage) };
  yield { type: "done", finishReason: choice.finish_reason };
}

function deepSeekUsage(value: unknown): ProviderUsage {
  const usage = asRecord(value);
  const inputTokens = nonNegativeInteger(usage.prompt_tokens, "prompt_tokens");
  const outputTokens = nonNegativeInteger(usage.completion_tokens, "completion_tokens");
  const cacheHit = usage.prompt_cache_hit_tokens;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cachedInputTokens = cacheHit === undefined
    ? details?.cached_tokens === undefined
      ? 0
      : nonNegativeInteger(details.cached_tokens, "cached_tokens")
    : nonNegativeInteger(cacheHit, "prompt_cache_hit_tokens");
  return { inputTokens, outputTokens, cachedInputTokens };
}

function toToolCall(id: string, name: string, argumentsText: string): AgentToolCall {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText || "{}");
  } catch (error) {
    throw new AlphionError("dependency-unavailable", `DeepSeek returned invalid JSON arguments for tool ${name}.`, {
      stage: "provider",
      cause: error,
    });
  }
  if (!isRecord(value) || id.length === 0 || name.length === 0) {
    throw new AlphionError("dependency-unavailable", "DeepSeek returned an invalid tool call.", { stage: "provider" });
  }
  return { id, name, arguments: value };
}

function optionalString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const result = value[key];
  return typeof result === "string" && result.length > 0 ? result : undefined;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new AlphionError("dependency-unavailable", `DeepSeek returned invalid usage field ${field}.`, { stage: "provider" });
  }
  return value;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new AlphionError("dependency-unavailable", "DeepSeek returned an invalid response payload.", { stage: "provider" });
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  return error instanceof OpenAI.APIError && (error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500);
}

function isStreamingCompatibilityError(error: unknown): boolean {
  return error instanceof OpenAI.APIError && [400, 404, 405, 415, 422].includes(error.status);
}

function normalizeDeepSeekError(error: unknown): AlphionError {
  if (error instanceof AlphionError) return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AlphionError("cancelled", "DeepSeek request was cancelled.", { stage: "provider", cause: error });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AlphionError("timeout", "DeepSeek request timed out.", { stage: "provider", cause: error });
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new AlphionError(error.name === "TimeoutError" ? "timeout" : "cancelled", error.message, {
      stage: "provider",
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    const credentialRejected = error.status === 401 || error.status === 403;
    const requestRejected = error.status === 400 || error.status === 404 || error.status === 422;
    const message = credentialRejected
      ? "DeepSeek rejected the configured credential."
      : requestRejected
        ? "DeepSeek rejected the configured model or request."
        : `DeepSeek request failed with HTTP ${error.status}.`;
    return new AlphionError("dependency-unavailable", message, {
      stage: "provider",
      retryable: isRetryable(error),
      reason: credentialRejected ? "credential-rejected" : requestRejected ? "model-or-request-rejected" : "provider-failure",
      cause: error,
    });
  }
  return new AlphionError("dependency-unavailable", "DeepSeek request failed.", {
    stage: "provider",
    retryable: isRetryable(error),
    reason: "provider-unavailable",
    cause: error,
  });
}

async function waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, 250 * (attempt + 1));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Cancelled.", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
