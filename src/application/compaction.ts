import type { AgentMessage, ModelDescriptor, ProviderEvent, SessionEntry } from "../domain/contracts.js";
import type { CompactionPolicy, CompactionRecord, CompactionResult } from "../domain/compaction-contracts.js";
import type { AgentProvider } from "../ports/index.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { estimateTokens } from "./context-pack.js";
import { AlphionError } from "./errors.js";
import { validateJsonSchema } from "./json-schema.js";

const UNKNOWN_MODEL_CONTEXT_TOKENS = 32_768;
const MAX_TRIGGER_RATIO = 0.85;
const SUMMARY_SCHEMA = Object.freeze({
  type: "object",
  required: ["systemGoalsAcceptance", "permissionsConstraintsRevision", "failures", "evidence", "unresolved", "otherFacts"],
  additionalProperties: false,
  properties: {
    systemGoalsAcceptance: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
    permissionsConstraintsRevision: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
    failures: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
    evidence: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
    unresolved: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
    otherFacts: { type: "array", items: { type: "string", maxLength: 2_000 }, maxItems: 32 },
  },
} as const);

type SourceRecord = Readonly<{ sourceId: string; message: AgentMessage }>;
type SummaryCategory = "systemGoalsAcceptance" | "permissionsConstraintsRevision" | "failures" | "evidence" | "unresolved" | "otherFacts";
interface PlannedCompaction { readonly earlier: readonly SourceRecord[]; readonly retained: readonly AgentMessage[]; readonly sourceEntryIds: readonly string[]; readonly retainedCycleCount: number; }

export interface ModelCompactionRequest {
  readonly sessionId: string;
  readonly runId: string;
  readonly model?: ModelDescriptor;
  readonly triggerRatio?: number;
  readonly outputReserveTokens?: number;
  readonly toolReserveTokens?: number;
  readonly safetyReserveTokens?: number;
}

export function buildCompactionPolicy(input: Omit<ModelCompactionRequest, "sessionId" | "runId">): CompactionPolicy {
  const contextWindowTokens = input.model?.contextWindowTokens ?? UNKNOWN_MODEL_CONTEXT_TOKENS;
  const triggerRatio = input.triggerRatio ?? MAX_TRIGGER_RATIO;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 4_096) throw new AlphionError("validation", "Model context window must be at least 4096 tokens.", { stage: "compaction" });
  if (!Number.isFinite(triggerRatio) || triggerRatio < 0.5 || triggerRatio > MAX_TRIGGER_RATIO) throw new AlphionError("validation", "Compaction trigger ratio must be between 0.5 and 0.85.", { stage: "compaction" });
  const outputReserveTokens = reserve(input.outputReserveTokens, Math.min(4_096, Math.floor(contextWindowTokens / 8)), contextWindowTokens, "output");
  const toolReserveTokens = reserve(input.toolReserveTokens, 0, contextWindowTokens, "Tool schema");
  const safetyReserveTokens = reserve(input.safetyReserveTokens, Math.min(2_048, Math.floor(contextWindowTokens / 16)), contextWindowTokens, "safety");
  const effectiveInputTokens = Math.floor(contextWindowTokens * triggerRatio) - outputReserveTokens - toolReserveTokens - safetyReserveTokens;
  if (effectiveInputTokens < 1_024) throw new AlphionError("validation", "Compaction reserves leave less than 1024 input tokens.", { stage: "compaction" });
  return Object.freeze({ schemaVersion: 1, triggerRatio, contextWindowTokens, outputReserveTokens, toolReserveTokens, safetyReserveTokens, effectiveInputTokens });
}

/** Model-aware durable compaction. It always derives memory from raw branch entries. */
export async function compactSessionEntriesForModel(entries: readonly SessionEntry[], provider: AgentProvider | undefined, signal: AbortSignal, request: ModelCompactionRequest): Promise<CompactionResult> {
  const policy = buildCompactionPolicy(request);
  const records = entries.map((entry) => ({ sourceId: entry.id, message: entry.message }));
  const originalTokens = records.reduce((total, record) => total + messageTokens(record.message), 0);
  const plan = compactionPlan(records, policy.effectiveInputTokens, messageTokens);
  if (!plan) return Object.freeze({ messages: Object.freeze(records.map((record) => record.message)) });
  let providerSummary: string | undefined;
  let usedFallback = true;
  if (provider) {
    providerSummary = await requestProviderSummary(plan, provider, signal);
    usedFallback = providerSummary === undefined;
  }
  const messages = compactPlan(plan, providerSummary);
  const memory = messages[0];
  if (!memory || memory.kind !== "memory") throw new AlphionError("internal", "Compaction did not produce memory.", { stage: "compaction" });
  const policyDigest = sha256(canonicalJson(policy));
  const modelId = request.model?.id ?? `${provider?.profile.kind ?? "custom"}:${provider?.profile.model ?? "unknown-32k"}`;
  const digest = sha256(canonicalJson({ sessionId: request.sessionId, sourceEntryIds: plan.sourceEntryIds, sourceDigest: sha256(canonicalJson(records)), retainedMessageIds: plan.retained.map((item) => item.id), policyDigest, modelId, memoryDigest: memory.digest }));
  const recordId = sha256(canonicalJson({ sessionId: request.sessionId, runId: request.runId, digest }));
  const record: CompactionRecord = Object.freeze({
    schemaVersion: 1,
    id: `compaction_${recordId.slice(0, 32)}`,
    sessionId: request.sessionId,
    runId: request.runId,
    createdAt: new Date().toISOString(),
    reason: "model-context-threshold",
    originalTokens,
    compactedTokens: messages.reduce((total, message) => total + messageTokens(message), 0),
    sourceEntryCount: plan.sourceEntryIds.length,
    retainedCycleCount: plan.retainedCycleCount,
    modelId,
    policyDigest,
    digest,
    sourceEntryIds: plan.sourceEntryIds,
    sourceDigest: sha256(canonicalJson(plan.earlier)),
    retainedKinds: Object.freeze([...new Set(plan.earlier.map((item) => item.message.kind))].sort()),
    omissions: Object.freeze(usedFallback ? [provider ? "provider-summary-fallback" : "provider-summary-unavailable"] : []),
    knownLosses: Object.freeze(["earlier-message-wording", "non-mandatory-earlier-detail"]),
    memory,
  });
  return Object.freeze({ messages, record });
}

/** Compatibility helper using the v0.7 character budget. */
export function compactMessages(messages: readonly AgentMessage[], maxCharacters = 32_000): readonly AgentMessage[] {
  return compactLegacy(messages.map((message) => ({ sourceId: message.id, message })), maxCharacters);
}

/** Compatibility helper using the v0.7 character budget. */
export function compactSessionEntries(entries: readonly SessionEntry[], maxCharacters = 32_000): readonly AgentMessage[] {
  return compactLegacy(entries.map((entry) => ({ sourceId: entry.id, message: entry.message })), maxCharacters);
}

/** Compatibility provider helper using the v0.7 character budget. */
export async function compactSessionEntriesWithProvider(entries: readonly SessionEntry[], provider: AgentProvider, signal: AbortSignal, maxCharacters = 32_000): Promise<readonly AgentMessage[]> {
  const records = entries.map((entry) => ({ sourceId: entry.id, message: entry.message }));
  const plan = compactionPlan(records, maxCharacters, (message) => messageText(message).length);
  if (!plan) return Object.freeze(records.map((record) => record.message));
  return compactPlan(plan, await requestProviderSummary(plan, provider, signal));
}

async function requestProviderSummary(plan: PlannedCompaction, provider: AgentProvider, signal: AbortSignal): Promise<string | undefined> {
  try {
    const recordsJson = canonicalJson(plan.earlier.map(({ sourceId, message }) => ({ sourceId, message })));
    if (recordsJson.length > 96_000) throw new Error("Compaction input exceeded its provider bound.");
    let output = "";
    let done = 0;
    const events: ProviderEvent[] = [];
    for await (const event of provider.generate({
      messages: [
        { role: "system", content: "Summarize the supplied conversation records into the exact JSON object requested. Preserve explicit system instructions, goals, acceptance criteria, permissions, constraints, project revision, failures, evidence, and unresolved items. Never include reasoning. Output JSON only." },
        { role: "user", content: `${canonicalJson(SUMMARY_SCHEMA)}\n\nRECORDS\n${recordsJson}` },
      ], tools: [], maxOutputTokens: 4_096, temperature: 0,
    }, signal)) {
      events.push(event);
      if (event.type === "text-delta") { output += event.delta; if (output.length > 24_000) throw new Error("Compaction summary exceeded its bound."); }
      else if (event.type === "tool-call" || event.type === "reasoning-delta") throw new Error("Compaction provider returned a forbidden event.");
      else if (event.type === "done") done += 1;
    }
    if (done !== 1 || events.length === 0) throw new Error("Compaction provider returned no unique terminal event.");
    const parsed: unknown = JSON.parse(output);
    validateJsonSchema(SUMMARY_SCHEMA, parsed);
    const summary = formatStructuredSummary(parsed as Readonly<Record<SummaryCategory, readonly string[]>>).slice(0, 16_000);
    return summary || undefined;
  } catch { return undefined; }
}

function compactLegacy(records: readonly SourceRecord[], maxCharacters: number): readonly AgentMessage[] {
  const plan = compactionPlan(records, maxCharacters, (message) => messageText(message).length);
  return plan ? compactPlan(plan) : Object.freeze(records.map((record) => record.message));
}

function compactionPlan(records: readonly SourceRecord[], budget: number, measure: (message: AgentMessage) => number): PlannedCompaction | undefined {
  if (!Number.isFinite(budget) || budget < 1) throw new AlphionError("validation", "Compaction budget must be positive.", { stage: "compaction" });
  const messages = records.map((record) => record.message);
  if (messages.reduce((sum, item) => sum + measure(item), 0) <= budget) return undefined;
  const cycleStarts = messages.map((item, index) => item.kind === "user" ? index : -1).filter((index) => index >= 0);
  const keepFrom = cycleStarts[Math.max(0, cycleStarts.length - 2)] ?? Math.max(0, messages.length - 4);
  const earlier = records.slice(0, keepFrom);
  if (earlier.length === 0) return undefined;
  return Object.freeze({ earlier, retained: Object.freeze(messages.slice(keepFrom)), sourceEntryIds: Object.freeze(earlier.map((item) => item.sourceId)), retainedCycleCount: Math.min(2, cycleStarts.length) });
}

function compactPlan(plan: PlannedCompaction, providerSummary?: string): readonly AgentMessage[] {
  const required = deterministicSummary(plan.earlier);
  const summary = [required, providerSummary ? `Provider structured summary:\n${providerSummary}` : ""].filter(Boolean).join("\n\n").slice(0, 24_000);
  const digest = sha256(canonicalJson({ sourceEntryIds: plan.sourceEntryIds, summary }));
  const memory: Extract<AgentMessage, { readonly kind: "memory" }> = Object.freeze({ schemaVersion: 1, kind: "memory", id: `message_compaction_${digest.slice(0, 32)}`, createdAt: new Date(0).toISOString(), content: summary, sourceEntryIds: plan.sourceEntryIds, digest });
  return Object.freeze([memory, ...plan.retained]);
}

function deterministicSummary(records: readonly SourceRecord[]): string {
  const categories: Record<SummaryCategory, string[]> = { systemGoalsAcceptance: [], permissionsConstraintsRevision: [], failures: [], evidence: [], unresolved: [], otherFacts: [] };
  for (const { message } of records) {
    const evidence = message.kind === "observation" && message.evidence
      ? ` Evidence ${message.evidence.id} (${message.evidence.kind}, digest ${message.evidence.digest}): ${message.evidence.summary};`
      : "";
    const line = `${message.kind}:${evidence} ${messageText(message)}`;
    const lowered = line.toLowerCase();
    if (/goal|acceptance|system|目标|验收|系统/u.test(lowered)) categories.systemGoalsAcceptance.push(line);
    else if (/permission|constraint|revision|policy|权限|约束|修订|策略/u.test(lowered)) categories.permissionsConstraintsRevision.push(line);
    else if (message.kind === "observation" && message.isError || /fail|error|cancel|失败|错误|取消/u.test(lowered)) categories.failures.push(line);
    else if (message.kind === "observation" && message.evidence || /evidence|证据/u.test(lowered)) categories.evidence.push(line);
    else if (/unresolved|todo|pending|待办|未解决/u.test(lowered)) categories.unresolved.push(line);
    else if (["memory", "system-event", "workflow", "human-approval", "observation", "agent"].includes(message.kind)) categories.otherFacts.push(line);
  }
  return `Deterministic branch summary (${records.length} earlier messages):\n${formatStructuredSummary(categories)}`;
}

function formatStructuredSummary(categories: Readonly<Record<SummaryCategory, readonly string[]>>): string {
  const sections: readonly Readonly<[SummaryCategory, string]>[] = [["systemGoalsAcceptance", "System / goals / acceptance"], ["permissionsConstraintsRevision", "Permissions / constraints / revision"], ["failures", "Failures"], ["evidence", "Evidence"], ["unresolved", "Unresolved"], ["otherFacts", "Other durable facts"]];
  return sections.flatMap(([key, label]) => categories[key].length > 0 ? [`${label}:`, ...categories[key].slice(-8).map((item) => `- ${item.slice(0, 300)}`)] : []).join("\n");
}

function messageText(message: AgentMessage): string { return "content" in message ? message.content : canonicalJson(message.call); }
function messageTokens(message: AgentMessage): number { return estimateTokens(canonicalJson(message)); }
function reserve(value: number | undefined, fallback: number, context: number, label: string): number { const selected = value ?? fallback; if (!Number.isSafeInteger(selected) || selected < 0 || selected > Math.floor(context / 2)) throw new AlphionError("validation", `${label} reserve is invalid.`, { stage: "compaction" }); return selected; }
