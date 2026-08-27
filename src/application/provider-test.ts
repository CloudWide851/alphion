import type { ProviderTestResult } from "../domain/provider-test-contracts.js";
import type { ProviderRequest, ProviderUsage } from "../domain/contracts.js";
import type { ProviderFactory, ProviderProfileStore, ProviderTestService } from "../ports/index.js";
import { AlphionError } from "./errors.js";
import { containsPotentialSecret } from "./sensitive-data.js";

const TEST_PROMPT = "你好，请用一句话说明你是什么模型。";
const EMPTY_USAGE: ProviderUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

export class DefaultProviderTestService implements ProviderTestService {
  constructor(
    private readonly profiles: ProviderProfileStore,
    private readonly factory: ProviderFactory,
    private readonly timeoutMs = 20_000,
  ) {}

  async test(profileId: string, signal?: AbortSignal): Promise<ProviderTestResult> {
    const profile = await this.profiles.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown Provider profile: ${profileId}`, { stage: "provider-test" });
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new DOMException("Cancelled.", "AbortError"));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Provider test timed out.", "TimeoutError")), this.timeoutMs);
    timer.unref();
    let usage = EMPTY_USAGE;
    let text = "";
    try {
      const provider = this.factory.create(profile);
      for await (const event of provider.generate(testRequest(), controller.signal)) {
        if (event.type === "text-delta") text = `${text}${event.delta}`.slice(0, 4_096);
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "tool-call") throw new AlphionError("dependency-unavailable", "Provider test returned an unexpected Tool call.", { stage: "provider-test", reason: "unexpected-tool-call" });
      }
      return Object.freeze({ schemaVersion: 1, profileId: profile.id, profileName: profile.name, model: profile.model, status: "success", latencyMs: Math.max(0, Date.now() - started), usage, response: safeResponse(text) });
    } catch (error) {
      const normalized = normalizeTestError(error, controller.signal);
      return Object.freeze({ schemaVersion: 1, profileId: profile.id, profileName: profile.name, model: profile.model, status: "failed", latencyMs: Math.max(0, Date.now() - started), usage, errorCode: normalized.code, errorReason: normalized.reason ?? normalized.code });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      text = "";
    }
  }

  async testAll(signal?: AbortSignal): Promise<readonly ProviderTestResult[]> {
    const profiles = [...await this.profiles.listProfiles()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 32);
    const results = new Array<ProviderTestResult>(profiles.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < profiles.length) {
        const index = next++;
        const profile = profiles[index];
        if (profile) results[index] = await this.test(profile.id, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, profiles.length) }, worker));
    return Object.freeze(results);
  }
}

function testRequest(): ProviderRequest {
  return Object.freeze({
    messages: Object.freeze([{ role: "user" as const, content: TEST_PROMPT }]),
    tools: Object.freeze([]),
    maxOutputTokens: 64,
    temperature: 0,
  });
}

function safeResponse(value: string): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "").trim().slice(0, 512);
  if (!cleaned) return "";
  return containsPotentialSecret(cleaned) ? "[已隐藏可能的敏感内容]" : cleaned;
}

function normalizeTestError(error: unknown, signal: AbortSignal): AlphionError {
  if (error instanceof AlphionError) return error;
  const reason = signal.aborted ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError") return new AlphionError("timeout", "Provider test timed out.", { stage: "provider-test", reason: "provider-test-timeout" });
  if (reason instanceof Error && reason.name === "AbortError") return new AlphionError("cancelled", "Provider test was cancelled.", { stage: "provider-test", reason: "provider-test-cancelled" });
  return new AlphionError("dependency-unavailable", "Provider test failed.", { stage: "provider-test", reason: "provider-test-failed", cause: error });
}
