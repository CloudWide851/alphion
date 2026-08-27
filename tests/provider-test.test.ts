import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LocalProviderFactory } from "../adapters/model/local-model-resolver.js";
import { DefaultProviderTestService } from "../src/application/provider-test.js";
import type { ProviderProfile, ProviderProfileInput } from "../src/domain/contracts.js";
import type { ProviderProfileStore } from "../src/ports/index.js";

test("Provider test sends one exact real request without history, tools, or fallback", async () => {
  const requests: unknown[] = [];
  await protocolServer(async (url) => {
    const profile = compatibleProfile("exact", url);
    const service = new DefaultProviderTestService(profileStore([profile]), new LocalProviderFactory({ resolve: () => Promise.resolve(undefined) }));
    const result = await service.test(profile.id);
    assert.equal(result.status, "success");
    assert.equal(result.response, "我是本地测试模型。");
    assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 });
  }, requests);
  const body = requests[0] as { messages: unknown[]; tools?: unknown; temperature: number; max_completion_tokens: number };
  assert.deepEqual(body.messages, [{ role: "user", content: "你好，请用一句话说明你是什么模型。" }]);
  assert.equal(body.tools, undefined);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_completion_tokens, 64);
});

test("Provider test-all is bounded to two concurrent exact profiles", async () => {
  const requests: unknown[] = [];
  let active = 0;
  let peak = 0;
  await protocolServer(async (url) => {
    const profiles = [compatibleProfile("one", url), compatibleProfile("two", url), compatibleProfile("three", url)];
    const service = new DefaultProviderTestService(profileStore(profiles), new LocalProviderFactory({ resolve: () => Promise.resolve(undefined) }));
    const results = await service.testAll();
    assert.deepEqual(results.map((item) => item.profileId), ["one", "three", "two"]);
    assert.ok(results.every((item) => item.status === "success"));
  }, requests, async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
  });
  assert.equal(requests.length, 3);
  assert.equal(peak, 2);
});

function compatibleProfile(id: string, baseUrl: string): ProviderProfile {
  return Object.freeze({
    schemaVersion: 3,
    id,
    name: id,
    kind: "custom-openai-compatible",
    baseUrl,
    model: `model-${id}`,
    protocol: "chat-completions",
    auth: Object.freeze({ mode: "none" }),
    capabilities: Object.freeze({ streaming: false, tools: false, promptCaching: false, reasoning: false, vision: false }),
    revision: 1,
    active: id === "two",
  });
}

function profileStore(profiles: readonly ProviderProfile[]): ProviderProfileStore {
  return {
    listProfiles: () => Promise.resolve(profiles),
    getProfile: (idOrName) => Promise.resolve(profiles.find((item) => item.id === idOrName || item.name === idOrName)),
    getActiveProfile: () => Promise.resolve(profiles.find((item) => item.active)),
    upsertProfile: (_profile: ProviderProfileInput) => Promise.reject(new Error("not used")),
    activateProfile: () => Promise.reject(new Error("not used")),
  };
}

async function protocolServer(
  operation: (baseUrl: string) => Promise<void>,
  requests: unknown[],
  beforeResponse: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => void (async () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      await beforeResponse();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "chatcmpl-local", object: "chat.completion", created: 1, model: "local-test", choices: [{ index: 0, message: { role: "assistant", content: "我是本地测试模型。" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    })());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local protocol server did not bind a TCP port.");
  try { await operation(`http://127.0.0.1:${address.port}/v1`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
