import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DeepSeekProvider } from "../adapters/model/deepseek.js";
import type { ProviderEvent, ProviderProfile, ProviderRequest } from "../src/domain/contracts.js";

const REQUEST: ProviderRequest = {
  messages: [{ role: "system", content: "Be grounded." }, { role: "user", content: "hello" }],
  tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 1024,
  temperature: 0,
};
const TEST_KEY = ["sk", "deepseek", "test", "key", "material"].join("-");

test("DeepSeek reasoner streams reasoning, text, tools, cached usage, and bearer auth", async () => {
  const bodies: Readonly<Record<string, unknown>>[] = [];
  await withServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TEST_KEY}`);
    const body = JSON.parse(await readBody(request)) as Readonly<Record<string, unknown>>;
    bodies.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, chunk({ reasoning_content: "inspect evidence" }, null));
    writeSse(response, chunk({ content: "answer" }, null));
    writeSse(response, chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] }, null));
    writeSse(response, chunk({}, "tool_calls"));
    writeSse(response, { id: "usage", object: "chat.completion.chunk", created: 0, model: "deepseek-reasoner", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 6 } });
    response.end("data: [DONE]\n\n");
  }, async (baseUrl) => {
    const provider = deepSeekProvider(baseUrl, true);
    const events = await collect(provider.generate(REQUEST, new AbortController().signal));
    assert.deepEqual(events.filter((event) => event.type === "reasoning-delta"), [{ type: "reasoning-delta", delta: "inspect evidence" }]);
    assert.deepEqual(events.find((event) => event.type === "text-delta"), { type: "text-delta", delta: "answer" });
    assert.deepEqual(events.find((event) => event.type === "tool-call"), { type: "tool-call", call: { id: "call_1", name: "read", arguments: { path: "README.md" } } });
    assert.deepEqual(events.find((event) => event.type === "usage"), { type: "usage", usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 5 } });
    assert.equal("temperature" in (bodies[0] ?? {}), false);
    assert.equal(bodies[0]?.max_tokens, 1024);
  });
});

test("DeepSeek sends reasoning content back on tool continuation", async () => {
  let captured: Readonly<Record<string, unknown>> | undefined;
  await withServer(async (request, response) => {
    captured = JSON.parse(await readBody(request)) as Readonly<Record<string, unknown>>;
    sendCompletion(response, { content: "done", reasoning_content: "verified" });
  }, async (baseUrl) => {
    const request: ProviderRequest = {
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        { role: "assistant", content: "", reasoningContent: "inspect evidence", toolCalls: [{ id: "call_1", name: "read", arguments: { path: "README.md" } }] },
        { role: "tool", toolCallId: "call_1", name: "read", content: "OK" },
      ],
    };
    const base = profile(true);
    const nonStreaming = { ...base, capabilities: { ...base.capabilities, streaming: false } };
    const events = await collect(new DeepSeekProvider(nonStreaming, resolver(), endpoint(baseUrl)).generate(request, new AbortController().signal));
    assert.deepEqual(events.filter((event) => event.type === "reasoning-delta"), [{ type: "reasoning-delta", delta: "verified" }]);
    const messages = captured?.messages;
    assert.ok(Array.isArray(messages));
    const assistant = messages.find((message) => isRecord(message) && message.role === "assistant");
    assert.ok(isRecord(assistant));
    assert.equal(assistant.reasoning_content, "inspect evidence");
  });
});

test("DeepSeek retries one rate limit before output and fails malformed payloads closed", async () => {
  let requests = 0;
  await withServer(async (request, response) => {
    const body = await readBody(request);
    requests += 1;
    if (body.includes("malformed")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "bad", object: "chat.completion", choices: [] }));
    } else if (requests === 1) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "limited", type: "rate_limit_error" } }));
    } else sendCompletion(response, { content: "retried" });
  }, async (baseUrl) => {
    const base = profile(false);
    const nonStreaming = { ...base, capabilities: { ...base.capabilities, streaming: false } };
    const provider = new DeepSeekProvider(nonStreaming, resolver(), endpoint(baseUrl));
    const events = await collect(provider.generate(REQUEST, new AbortController().signal));
    assert.equal(events.find((event) => event.type === "text-delta")?.type, "text-delta");
    assert.equal(requests, 2);
    const malformed = { ...REQUEST, messages: [...REQUEST.messages, { role: "user" as const, content: "malformed" }] };
    await assert.rejects(
      collect(provider.generate(malformed, new AbortController().signal)),
      /no chat completion choice/i,
    );
  });
});

test("DeepSeek cancellation aborts an in-flight request", async () => {
  await withServer(async (request) => {
    await readBody(request);
  }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = collect(deepSeekProvider(baseUrl, false).generate(REQUEST, controller.signal));
    setTimeout(() => controller.abort(new DOMException("cancel test", "AbortError")), 20);
    await assert.rejects(pending, /cancel|abort/i);
  });
});

test("DeepSeek normalizes an AbortSignal timeout", async () => {
  await withServer(async (request) => {
    await readBody(request);
  }, async (baseUrl) => {
    const signal = AbortSignal.timeout(20);
    await assert.rejects(
      collect(deepSeekProvider(baseUrl, false).generate(REQUEST, signal)),
      /timeout/i,
    );
  });
});

function profile(reasoning: boolean): ProviderProfile {
  return {
    schemaVersion: 2,
    id: reasoning ? "deepseek-reasoner" : "deepseek-chat",
    name: reasoning ? "DeepSeek Reasoner" : "DeepSeek Chat",
    kind: "deepseek",
    presetId: "deepseek",
    model: reasoning ? "deepseek-reasoner" : "deepseek-chat",
    protocol: "chat-completions",
    auth: { mode: "bearer-env", environmentVariable: "DEEPSEEK_API_KEY" },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning },
    revision: 1,
    active: true,
  };
}

function deepSeekProvider(baseUrl: string, reasoning: boolean): DeepSeekProvider {
  return new DeepSeekProvider(profile(reasoning), resolver(), endpoint(baseUrl));
}

function endpoint(baseUrl: string): Readonly<{ endpoint: () => string }> {
  return { endpoint: () => baseUrl };
}

function resolver() {
  return { resolve: (reference: string) => Promise.resolve(reference === "DEEPSEEK_API_KEY" ? TEST_KEY : undefined) };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<readonly ProviderEvent[]> {
  const values: ProviderEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function chunk(delta: object, finishReason: string | null) {
  return { id: "deepseek", object: "chat.completion.chunk", created: 0, model: "deepseek-reasoner", choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }] };
}

function sendCompletion(response: ServerResponse, message: Readonly<Record<string, unknown>>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "deepseek",
    object: "chat.completion",
    created: 0,
    model: "deepseek-chat",
    choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", ...message } }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 3 },
  }));
}

function writeSse(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
