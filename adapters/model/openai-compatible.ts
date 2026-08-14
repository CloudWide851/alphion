import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses";
import type {
  ProviderMessage,
  AgentToolCall,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest,
  ProviderUsage,
} from "../../src/domain/contracts.js";
import type { AgentProvider, SecretResolver } from "../../src/ports/index.js";
import { AlphionError } from "../../src/application/errors.js";
import { resolveProviderEndpoint, validateProviderPreset } from "./provider-catalog.js";

export class OpenAICompatibleProvider implements AgentProvider {
  readonly profile: ProviderProfile;
  readonly #secrets: SecretResolver;

  constructor(profile: ProviderProfile, secrets: SecretResolver) {
    validateProviderProfile(profile);
    this.profile = Object.freeze({
      ...profile,
      auth: Object.freeze({ ...profile.auth }),
      capabilities: Object.freeze({ ...profile.capabilities }),
    });
    this.#secrets = secrets;
  }

  async *generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const client = await this.#createClient();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let observed = false;
      try {
        const stream = this.profile.protocol === "chat-completions"
          ? this.#generateChat(client, request, signal)
          : this.#generateResponses(client, request, signal);
        for await (const event of stream) {
          observed = true;
          yield event;
        }
        return;
      } catch (error) {
        if (signal.aborted) throw normalizeProviderError(signal.reason);
        if (observed || attempt === 1 || !isRetryableProviderError(error)) throw normalizeProviderError(error);
        await waitForRetry(attempt, signal);
      }
    }
  }

  async #createClient(): Promise<OpenAI> {
    let apiKey = "alphion-no-auth";
    if (this.profile.auth.mode !== "none") {
      const reference = this.profile.auth.mode === "bearer-env"
        ? this.profile.auth.environmentVariable
        : this.profile.auth.secretId;
      const resolved = await this.#secrets.resolve(reference);
      if (!resolved) {
        throw new AlphionError(
          "dependency-unavailable",
          "The configured device credential is unavailable.",
          { stage: "provider", reason: "credential-unavailable" },
        );
      }
      apiKey = resolved;
    }
    return new OpenAI({
      apiKey,
      baseURL: resolveProviderEndpoint(this.profile),
      maxRetries: 0,
    });
  }

  async *#generateChat(client: OpenAI, request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (!this.profile.capabilities.streaming) {
      yield* this.#generateChatNonStreaming(client, request, signal);
      return;
    }
    let observedChunk = false;
    try {
      const tools = toChatTools(request);
      const body: ChatCompletionCreateParamsStreaming = {
        model: this.profile.model,
        messages: toChatMessages(request.messages),
        ...(tools.length > 0 ? { tools } : {}),
        max_completion_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
      };
      const stream = await client.chat.completions.create(body, { signal });
      const pending = new Map<number, { id: string; name: string; argumentsText: string }>();
      let finishReason = "stop";
      for await (const chunk of stream) {
        observedChunk = true;
        yield* decodeChatChunk(chunk, pending);
        const choice = chunk.choices[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      for (const value of pending.values()) {
        yield { type: "tool-call", call: toToolCall(value.id, value.name, value.argumentsText) };
      }
      yield { type: "done", finishReason };
    } catch (error) {
      if (observedChunk || !isStreamingCompatibilityError(error)) throw error;
      yield { type: "degraded", reason: "Streaming was unavailable; retried once without streaming." };
      yield* this.#generateChatNonStreaming(client, request, signal);
    }
  }

  async *#generateChatNonStreaming(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const tools = toChatTools(request);
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: this.profile.model,
      messages: toChatMessages(request.messages),
      ...(tools.length > 0 ? { tools } : {}),
      max_completion_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      stream: false,
      ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
    };
    const completion = await client.chat.completions.create(body, { signal });
    yield* decodeChatCompletion(completion);
  }

  async *#generateResponses(client: OpenAI, request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (!this.profile.capabilities.streaming) {
      yield* this.#generateResponsesNonStreaming(client, request, signal);
      return;
    }
    let observedEvent = false;
    try {
      const input = toResponsesInput(request.messages);
      const tools = toResponsesTools(request);
      const body: ResponseCreateParamsStreaming = {
        model: this.profile.model,
        instructions: input.instructions,
        input: input.items,
        ...(tools.length > 0 ? { tools } : {}),
        max_output_tokens: request.maxOutputTokens,
        store: false,
        stream: true,
        ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
      };
      const stream = await client.responses.create(body, { signal });
      for await (const event of stream) {
        observedEvent = true;
        yield* decodeResponseStreamEvent(event);
      }
    } catch (error) {
      if (observedEvent || !isStreamingCompatibilityError(error)) throw error;
      yield { type: "degraded", reason: "Streaming was unavailable; retried once without streaming." };
      yield* this.#generateResponsesNonStreaming(client, request, signal);
    }
  }

  async *#generateResponsesNonStreaming(
    client: OpenAI,
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const input = toResponsesInput(request.messages);
    const tools = toResponsesTools(request);
    const body: ResponseCreateParamsNonStreaming = {
      model: this.profile.model,
      instructions: input.instructions,
      input: input.items,
      ...(tools.length > 0 ? { tools } : {}),
      max_output_tokens: request.maxOutputTokens,
      store: false,
      stream: false,
      ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
    };
    const response = await client.responses.create(body, { signal });
    yield* decodeResponse(response);
  }
}

function validateProviderProfile(profile: ProviderProfile): void {
  if (profile.schemaVersion !== 2 || !["custom-openai-compatible", "kimi", "qwen", "glm"].includes(profile.kind)) {
    throw new AlphionError("validation", "OpenAI-compatible provider requires a schema-v2 compatible profile.", {
      stage: "provider",
    });
  }
  validateProviderPreset(profile);
  let url: URL;
  try {
    url = new URL(resolveProviderEndpoint(profile));
  } catch (error) {
    throw new AlphionError("validation", "Compatible provider URL is invalid.", { stage: "provider", cause: error });
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!secure && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new AlphionError("validation", "Compatible provider URL must use HTTPS or loopback HTTP without embedded credentials.", {
      stage: "provider",
    });
  }
  if (profile.protocol !== "chat-completions" && profile.protocol !== "responses") {
    throw new AlphionError("validation", "Compatible provider protocol is unsupported.", { stage: "provider" });
  }
  if (profile.auth.mode === "bearer-env" && !/^[A-Z_][A-Z0-9_]*$/.test(profile.auth.environmentVariable)) {
    throw new AlphionError("validation", "Compatible provider secret reference is invalid.", { stage: "provider" });
  }
  if (profile.auth.mode === "encrypted-sqlite" && !/^vault_[A-Za-z0-9_-]{8,}$/.test(profile.auth.secretId)) {
    throw new AlphionError("validation", "Compatible provider vault reference is invalid.", { stage: "provider" });
  }
}

function toChatMessages(messages: readonly ProviderMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
  });
}

function toChatTools(request: ProviderRequest): ChatCompletionTool[] {
  return request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function toResponsesInput(messages: readonly ProviderMessage[]): { readonly instructions: string; readonly items: ResponseInput } {
  const instructions = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const items: ResponseInput = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        items.push({ role: "user", content: message.content });
        break;
      case "assistant":
        if (message.content) items.push({ role: "assistant", content: message.content });
        for (const call of message.toolCalls ?? []) {
          items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
        }
        break;
      case "tool":
        items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
        break;
    }
  }
  return { instructions, items };
}

function toResponsesTools(request: ProviderRequest): Tool[] {
  return request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

function* decodeChatChunk(
  chunk: ChatCompletionChunk,
  pending: Map<number, { id: string; name: string; argumentsText: string }>,
): Iterable<ProviderEvent> {
  const choice = chunk.choices[0];
  const content = choice?.delta.content;
  if (typeof content === "string" && content.length > 0) yield { type: "text-delta", delta: content };
  for (const partial of choice?.delta.tool_calls ?? []) {
    const previous = pending.get(partial.index) ?? { id: partial.id ?? `tool_${partial.index}`, name: "", argumentsText: "" };
    pending.set(partial.index, {
      id: partial.id ?? previous.id,
      name: partial.function?.name ?? previous.name,
      argumentsText: previous.argumentsText + (partial.function?.arguments ?? ""),
    });
  }
  if (chunk.usage) yield { type: "usage", usage: chatUsage(chunk.usage) };
}

function* decodeChatCompletion(completion: ChatCompletion): Iterable<ProviderEvent> {
  const choice = completion.choices[0];
  if (!choice) throw new AlphionError("dependency-unavailable", "Provider returned no chat completion choice.", { stage: "provider" });
  if (choice.message.content) yield { type: "text-delta", delta: choice.message.content };
  for (const call of choice.message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    yield { type: "tool-call", call: toToolCall(call.id, call.function.name, call.function.arguments) };
  }
  if (completion.usage) yield { type: "usage", usage: chatUsage(completion.usage) };
  yield { type: "done", finishReason: choice.finish_reason };
}

function* decodeResponseStreamEvent(event: ResponseStreamEvent): Iterable<ProviderEvent> {
  switch (event.type) {
    case "response.output_text.delta":
      yield { type: "text-delta", delta: event.delta };
      return;
    case "response.output_item.done":
      if (event.item.type === "function_call") {
        yield {
          type: "tool-call",
          call: toToolCall(event.item.call_id, event.item.name, event.item.arguments),
        };
      }
      return;
    case "response.completed":
      if (event.response.usage) yield { type: "usage", usage: responseUsage(event.response.usage) };
      yield { type: "done", finishReason: "completed" };
      return;
    case "response.failed":
      throw new AlphionError("dependency-unavailable", "Provider reported a failed response.", { stage: "provider" });
    case "response.incomplete":
      throw new AlphionError("dependency-unavailable", "Provider reported an incomplete response.", { stage: "provider" });
    default:
      return;
  }
}

function* decodeResponse(response: Response): Iterable<ProviderEvent> {
  if (response.status !== "completed") {
    throw new AlphionError("dependency-unavailable", `Provider returned response status ${response.status ?? "unknown"}.`, {
      stage: "provider",
    });
  }
  if (response.output_text) yield { type: "text-delta", delta: response.output_text };
  for (const item of response.output) {
    if (item.type === "function_call") {
      yield { type: "tool-call", call: toToolCall(item.call_id, item.name, item.arguments) };
    }
  }
  if (response.usage) yield { type: "usage", usage: responseUsage(response.usage) };
  yield { type: "done", finishReason: response.status ?? "completed" };
}

function toToolCall(id: string, name: string, argumentsText: string): AgentToolCall {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText || "{}");
  } catch (error) {
    throw new AlphionError("dependency-unavailable", `Provider returned invalid JSON arguments for tool ${name}.`, {
      stage: "provider",
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || id.length === 0 || name.length === 0) {
    throw new AlphionError("dependency-unavailable", `Provider returned invalid arguments for tool ${name || "<unnamed>"}.`, {
      stage: "provider",
    });
  }
  return { id, name, arguments: value as Readonly<Record<string, unknown>> };
}

function chatUsage(usage: ChatCompletion["usage"] extends infer U ? NonNullable<U> : never): ProviderUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function responseUsage(usage: NonNullable<Response["usage"]>): ProviderUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  return error instanceof OpenAI.APIError && (error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500);
}

function isStreamingCompatibilityError(error: unknown): boolean {
  return error instanceof OpenAI.APIError && [400, 404, 405, 415, 422].includes(error.status);
}

function normalizeProviderError(error: unknown): AlphionError {
  if (error instanceof AlphionError) return error;
  if (error instanceof OpenAI.APIUserAbortError) {
    return new AlphionError("cancelled", "Compatible provider request was cancelled.", { stage: "provider", cause: error });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AlphionError("timeout", "Compatible provider request timed out.", { stage: "provider", cause: error });
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
      ? "Compatible provider rejected the configured credential."
      : requestRejected
        ? "Compatible provider rejected the configured model or request."
        : `Compatible provider request failed with HTTP ${error.status}.`;
    return new AlphionError("dependency-unavailable", message, {
      stage: "provider",
      retryable: isRetryableProviderError(error),
      reason: credentialRejected ? "credential-rejected" : requestRejected ? "model-or-request-rejected" : "provider-failure",
      cause: error,
    });
  }
  return new AlphionError("dependency-unavailable", "Compatible provider request failed.", {
    stage: "provider",
    retryable: isRetryableProviderError(error),
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
