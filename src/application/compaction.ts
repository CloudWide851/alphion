import type { AgentMessage, ProviderEvent, SessionEntry } from "../domain/contracts.js";
import type { AgentProvider } from "../ports/index.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { validateJsonSchema } from "./json-schema.js";

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

type CompactionRecord = Readonly<{ sourceId: string; message: AgentMessage }>;
type SummaryCategory = "systemGoalsAcceptance" | "permissionsConstraintsRevision" | "failures" | "evidence" | "unresolved" | "otherFacts";

export function compactMessages(messages: readonly AgentMessage[], maxCharacters = 32_000): readonly AgentMessage[] {
  return compactRecords(messages.map((message) => ({ sourceId: message.id, message })), maxCharacters);
}

/** Rebuilds model memory from the current raw branch and records immutable entry ids. */
export function compactSessionEntries(entries: readonly SessionEntry[], maxCharacters = 32_000): readonly AgentMessage[] {
  return compactRecords(entries.map((entry) => ({ sourceId: entry.id, message: entry.message })), maxCharacters);
}

/** Uses the session's provider only for a validated no-tool summary; failures use the deterministic path. */
export async function compactSessionEntriesWithProvider(
  entries: readonly SessionEntry[],
  provider: AgentProvider,
  signal: AbortSignal,
  maxCharacters = 32_000,
): Promise<readonly AgentMessage[]> {
  const records = entries.map((entry) => ({ sourceId: entry.id, message: entry.message }));
  const plan = compactionPlan(records, maxCharacters);
  if (!plan) return Object.freeze(records.map((record) => record.message));
  const fallback = compactPlan(plan);
  try {
    const recordsJson = canonicalJson(plan.earlier.map(({ sourceId, message }) => ({ sourceId, message })));
    if (recordsJson.length > 96_000) throw new Error("Compaction input exceeded its provider bound.");
    const events: ProviderEvent[] = [];
    let output = "";
    let done = 0;
    for await (const event of provider.generate({
      messages: [
        { role: "system", content: "Summarize the supplied conversation records into the exact JSON object requested. Preserve explicit system instructions, goals, acceptance criteria, permissions, constraints, project revision, failures, evidence, and unresolved items. Never include reasoning. Output JSON only." },
        { role: "user", content: `${canonicalJson(SUMMARY_SCHEMA)}\n\nRECORDS\n${recordsJson}` },
      ],
      tools: [],
      maxOutputTokens: 4_096,
      temperature: 0,
    }, signal)) {
      events.push(event);
      if (event.type === "text-delta") {
        output += event.delta;
        if (output.length > 24_000) throw new Error("Compaction summary exceeded its bound.");
      } else if (event.type === "tool-call" || event.type === "reasoning-delta") {
        throw new Error("Compaction provider returned a forbidden event.");
      } else if (event.type === "done") done += 1;
    }
    if (done !== 1 || events.length === 0) throw new Error("Compaction provider returned no unique terminal event.");
    const parsed: unknown = JSON.parse(output);
    validateJsonSchema(SUMMARY_SCHEMA, parsed);
    const structured = parsed as Readonly<Record<SummaryCategory, readonly string[]>>;
    const providerSummary = formatStructuredSummary(structured).slice(0, 16_000);
    if (!providerSummary) throw new Error("Compaction provider returned an empty summary.");
    return compactPlan(plan, providerSummary);
  } catch {
    return fallback;
  }
}

function compactRecords(records: readonly CompactionRecord[], maxCharacters: number): readonly AgentMessage[] {
  const plan = compactionPlan(records, maxCharacters);
  return plan ? compactPlan(plan) : Object.freeze(records.map((record) => record.message));
}

function compactionPlan(records: readonly CompactionRecord[], maxCharacters: number): Readonly<{ earlier: readonly CompactionRecord[]; retained: readonly AgentMessage[]; sourceEntryIds: readonly string[] }> | undefined {
  const messages = records.map((record) => record.message);
  if (messages.reduce((sum, item) => sum + messageText(item).length, 0) <= maxCharacters) return undefined;
  const cycleStarts = messages.map((item, index) => item.kind === "user" ? index : -1).filter((index) => index >= 0);
  const keepFrom = cycleStarts[Math.max(0, cycleStarts.length - 2)] ?? Math.max(0, messages.length - 4);
  const earlier = records.slice(0, keepFrom);
  return Object.freeze({ earlier, retained: messages.slice(keepFrom), sourceEntryIds: Object.freeze(earlier.map((item) => item.sourceId)) });
}

function compactPlan(plan: Readonly<{ earlier: readonly CompactionRecord[]; retained: readonly AgentMessage[]; sourceEntryIds: readonly string[] }>, providerSummary?: string): readonly AgentMessage[] {
  const required = deterministicSummary(plan.earlier);
  const summary = [required, providerSummary ? `Provider structured summary:\n${providerSummary}` : ""].filter(Boolean).join("\n\n").slice(0, 24_000);
  const sourceEntryIds = plan.sourceEntryIds;
  const digest = sha256(canonicalJson({ sourceEntryIds, summary }));
  const memory: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "memory", id: `message_compaction_${digest.slice(0, 32)}`, createdAt: new Date(0).toISOString(), content: summary, sourceEntryIds: Object.freeze(sourceEntryIds), digest });
  return Object.freeze([memory, ...plan.retained]);
}

function deterministicSummary(records: readonly CompactionRecord[]): string {
  const categories: Record<SummaryCategory, string[]> = { systemGoalsAcceptance: [], permissionsConstraintsRevision: [], failures: [], evidence: [], unresolved: [], otherFacts: [] };
  for (const { message } of records) {
    const line = `${message.kind}: ${messageText(message)}`;
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
  const sections: readonly Readonly<[SummaryCategory, string]>[] = [
    ["systemGoalsAcceptance", "System / goals / acceptance"],
    ["permissionsConstraintsRevision", "Permissions / constraints / revision"],
    ["failures", "Failures"],
    ["evidence", "Evidence"],
    ["unresolved", "Unresolved"],
    ["otherFacts", "Other durable facts"],
  ];
  return sections.flatMap(([key, label]) => categories[key].length > 0 ? [`${label}:`, ...categories[key].slice(-8).map((item) => `- ${item.slice(0, 300)}`)] : []).join("\n");
}

function messageText(message: AgentMessage): string {
  if ("content" in message) return message.content;
  return canonicalJson(message.call);
}
