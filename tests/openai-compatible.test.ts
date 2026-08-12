import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../adapters/model/openai-compatible.js";
import type { OpenAICompatibleProtocol, ProviderEvent, ProviderProfile, ProviderRequest } from "../src/domain/contracts.js";

const REQUEST: ProviderRequest = {
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hello" },
  ],
  tools: [{ name: "read", description: "Read", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
  maxOutputTokens: 32,
  temperature: 0,
  promptCacheKey: "stable-key",
};

test("Chat Completions streaming maps text, usage, and tool calls", async () => {
  await withFakeServer(async (baseUrl) => {
    const textEvents = await collect(new OpenAICompatibleProvider(profile(baseUrl, "chat-completions"), noSecrets()).generate(REQUEST, new AbortController().signal));
    assert.deepEqual(textEvents.filter((event) => event.type === "text-delta"), [{ type: "text-delta", delta: "hello" }]);
    assert.equal(textEvents.find((event) => event.type === "usage")?.type, "usage");

    const toolRequest: ProviderRequest = { ...REQUEST, messages: [...REQUEST.messages, { role: "user", content: "tool" }] };
    const toolEvents = await collect(new OpenAICompatibleProvider(profile(baseUrl, "chat-completions"), noSecrets()).generate(toolRequest, new AbortController().signal));
    assert.deepEqual(toolEvents.find((event) => event.type === "tool-call"), {
      type: "tool-call",
      call: { id: "call_chat", name: "read", arguments: { path: "README.md" } },
    });
  });
});

test("Responses streaming maps text, usage, and function calls", async () => {
  await withFakeServer(async (baseUrl) => {
    const textEvents = await collect(new OpenAICompatibleProvider(profile(baseUrl, "responses"), noSecrets()).generate(REQUEST, new AbortController().signal));
    assert.deepEqual(textEvents.filter((event) => event.type === "text-delta"), [{ type: "text-delta", delta: "hello" }]);
    const toolRequest: ProviderRequest = { ...REQUEST, messages: [...REQUEST.messages, { role: "user", content: "tool" }] };
    const toolEvents = await collect(new OpenAICompatibleProvider(profile(baseUrl, "responses"), noSecrets()).generate(toolRequest, new AbortController().signal));
    assert.deepEqual(toolEvents.find((event) => event.type === "tool-call"), {
      type: "tool-call",
      call: { id: "call_response", name: "read", arguments: { path: "README.md" } },
    });
  });
});

test("both protocols support explicit non-streaming operation", async () => {
  await withFakeServer(async (baseUrl) => {
    for (const protocol of ["chat-completions", "responses"] as const) {
      const base = profile(baseUrl, protocol);
      const nonStreaming: ProviderProfile = { ...base, capabilities: { ...base.capabilities, streaming: false } };
      const events = await collect(new OpenAICompatibleProvider(nonStreaming, noSecrets()).generate(REQUEST, new AbortController().signal));
      assert.deepEqual(events.find((event) => event.type === "text-delta"), { type: "text-delta", delta: "hello" });
      assert.equal(events.at(-1)?.type, "done");
    }
  });
});

test("streaming failure degrades once to a non-streaming response", async () => {
  await withFakeServer(async (baseUrl) => {
    const request: ProviderRequest = { ...REQUEST, messages: [...REQUEST.messages, { role: "user", content: "fallback" }] };
    const events = await collect(new OpenAICompatibleProvider(profile(baseUrl, "chat-completions"), noSecrets()).generate(request, new AbortController().signal));
    assert.equal(events[0]?.type, "degraded");
    assert.deepEqual(events.find((event) => event.type === "text-delta"), { type: "text-delta", delta: "fallback" });
  });
});

test("rate limiting retries once before output", async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    await readBody(request);
    requests += 1;
    if (requests === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "limited", type: "rate_limit_error" } }));
    } else {
      sendChatResponse(response, "retried");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const base = profile(`http://127.0.0.1:${address.port}/v1`, "chat-completions");
    const nonStreaming: ProviderProfile = { ...base, capabilities: { ...base.capabilities, streaming: false } };
    const events = await collect(new OpenAICompatibleProvider(nonStreaming, noSecrets()).generate(REQUEST, new AbortController().signal));
    assert.deepEqual(events.find((event) => event.type === "text-delta"), { type: "text-delta", delta: "retried" });
    assert.equal(requests, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("malformed tool arguments and incomplete Responses fail closed", async () => {
  await withFakeServer(async (baseUrl) => {
    const malformed: ProviderRequest = { ...REQUEST, messages: [...REQUEST.messages, { role: "user", content: "malformed" }] };
    await assert.rejects(
      collect(new OpenAICompatibleProvider(profile(baseUrl, "chat-completions"), noSecrets()).generate(malformed, new AbortController().signal)),
      /invalid JSON arguments/i,
    );
    const incomplete: ProviderRequest = { ...REQUEST, messages: [...REQUEST.messages, { role: "user", content: "incomplete" }] };
    await assert.rejects(
      collect(new OpenAICompatibleProvider(profile(baseUrl, "responses"), noSecrets()).generate(incomplete, new AbortController().signal)),
      /incomplete response/i,
    );
  });
});

test("caller cancellation aborts an in-flight compatible request", async () => {
  const server = createServer(async (request) => {
    await readBody(request);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const controller = new AbortController();
    const pending = collect(
      new OpenAICompatibleProvider(profile(`http://127.0.0.1:${address.port}/v1`, "chat-completions"), noSecrets()).generate(
        REQUEST,
        controller.signal,
      ),
    );
    setTimeout(() => controller.abort(new DOMException("test cancellation", "AbortError")), 20);
    await assert.rejects(pending, /test cancellation|aborted|cancel/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function profile(baseUrl: string, protocol: OpenAICompatibleProtocol): ProviderProfile {
  return {
    schemaVersion: 2,
    id: `fake-${protocol}`,
    name: `fake-${protocol}`,
    kind: "custom-openai-compatible",
    baseUrl,
    model: "fake-model",
    protocol,
    auth: { mode: "none" },
    capabilities: { streaming: true, tools: true, promptCaching: true, reasoning: false },
    revision: 1,
    active: true,
  };
}

function noSecrets() {
  return { resolve: () => Promise.resolve(undefined) };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<readonly ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function withFakeServer(operation: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => void handleRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const parsed = JSON.parse(body) as { stream?: boolean; messages?: Array<{ content?: string }>; input?: unknown };
  const serialized = JSON.stringify(parsed);
  const hasMarker = (marker: string) => serialized.includes(`"content":"${marker}"`);
  const wantsTool = hasMarker("tool");
  const wantsFallback = hasMarker("fallback");
  const wantsMalformed = hasMarker("malformed");
  const wantsIncomplete = hasMarker("incomplete");
  if (wantsFallback && parsed.stream) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "stream unsupported", type: "invalid_request_error" } }));
    return;
  }
  if (request.url === "/v1/chat/completions") {
    if (parsed.stream) sendChatStream(response, wantsTool, wantsMalformed);
    else sendChatResponse(response, wantsTool ? "tool" : wantsFallback ? "fallback" : "hello");
    return;
  }
  if (request.url === "/v1/responses") {
    if (parsed.stream) sendResponsesStream(response, wantsTool, wantsIncomplete);
    else sendResponsesResponse(response, "hello");
    return;
  }
  response.writeHead(404).end();
}

function sendChatStream(response: ServerResponse, tool: boolean, malformed = false): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (tool || malformed) {
    const argumentsText = malformed ? "{" : '{"path":"README.md"}';
    writeSse(response, chatChunk({ tool_calls: [{ index: 0, id: "call_chat", type: "function", function: { name: "read", arguments: argumentsText } }] }, null));
    writeSse(response, chatChunk({}, "tool_calls"));
  } else {
    writeSse(response, chatChunk({ content: "hello" }, null));
    writeSse(response, chatChunk({}, "stop"));
  }
  writeSse(response, { id: "chat", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 2 } } });
  response.end("data: [DONE]\n\n");
}

function chatChunk(delta: object, finishReason: string | null) {
  return { id: "chat", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }] };
}

function sendChatResponse(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "chat", object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content, refusal: null, annotations: [] } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 0 } } }));
}

function sendResponsesStream(response: ServerResponse, tool: boolean, incomplete = false): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (incomplete) {
    writeSse(response, { type: "response.incomplete", sequence_number: 1, response: responseObject("", false) });
    response.end("data: [DONE]\n\n");
    return;
  }
  if (tool) {
    writeSse(response, { type: "response.output_item.done", sequence_number: 1, output_index: 0, item: { type: "function_call", id: "item_1", call_id: "call_response", name: "read", arguments: '{"path":"README.md"}', status: "completed" } });
  } else {
    writeSse(response, { type: "response.output_text.delta", sequence_number: 1, item_id: "msg", output_index: 0, content_index: 0, delta: "hello", logprobs: [] });
  }
  writeSse(response, { type: "response.completed", sequence_number: 2, response: responseObject(tool ? "" : "hello", tool) });
  response.end("data: [DONE]\n\n");
}

function sendResponsesResponse(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(responseObject(content, false)));
}

function responseObject(content: string, tool: boolean) {
  return {
    id: "resp",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "fake-model",
    output_text: content,
    output: tool
      ? [{ type: "function_call", id: "item_1", call_id: "call_response", name: "read", arguments: '{"path":"README.md"}', status: "completed" }]
      : [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [], logprobs: [] }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 0 } },
    error: null,
    incomplete_details: null,
  };
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
