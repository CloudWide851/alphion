import type { AgentBudgets, AgentRunRequest, AgentToolCall, EvidenceRef, GroundingReport, ProviderEvent, ProviderUsage, ToolResult } from "../domain/contracts.js";
import { emptyProviderUsage } from "../protocol/events.js";
import { AlphionError } from "./errors.js";

export const DEFAULT_BUDGETS: AgentBudgets = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 32,
  maxOutputTokens: 4096,
  maxOutputBytes: 1024 * 1024,
  runTimeoutMs: 300_000,
  modelTimeoutMs: 60_000,
});

export interface TurnOutcome {
  readonly text: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: ProviderUsage;
}

export function validateRunRequest(request: AgentRunRequest): void {
  if (request.prompt.trim().length === 0) {
    throw new AlphionError("validation", "Prompt must not be empty.", { stage: "request" });
  }
  if (request.projectRoot.trim().length === 0 || request.projectRevision.trim().length === 0) {
    throw new AlphionError("validation", "Project root and revision are required.", { stage: "request" });
  }
}

export function mergeBudgets(overrides: Partial<AgentBudgets> | undefined): AgentBudgets {
  const budgets: AgentBudgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AlphionError("validation", `Budget ${name} must be a positive safe integer.`, { stage: "request" });
    }
  }
  return budgets;
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
}

export function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

export function summarizeProviderEvents(events: readonly ProviderEvent[]): TurnOutcome {
  let text = "";
  let reasoningContent = "";
  let usage = emptyProviderUsage();
  const toolCalls: AgentToolCall[] = [];
  for (const event of events) {
    if (event.type === "text-delta") text += event.delta;
    else if (event.type === "reasoning-delta") reasoningContent += event.delta;
    else if (event.type === "tool-call") toolCalls.push(event.call);
    else if (event.type === "usage") usage = addUsage(usage, event.usage);
  }
  return { text, reasoningContent, toolCalls, usage };
}

export function assertProviderEventsWithinBudget(
  events: readonly ProviderEvent[],
  maxOutputBytes: number,
  requireDone: boolean,
): void {
  let outputBytes = 0;
  let doneEvents = 0;
  for (const event of events) {
    if (event.type === "text-delta" || event.type === "reasoning-delta") outputBytes += Buffer.byteLength(event.delta);
    else if (event.type === "done") doneEvents += 1;
    else if (event.type === "usage") assertValidUsage(event.usage);
  }
  if (outputBytes > maxOutputBytes) {
    throw new AlphionError("budget-exceeded", "Provider output exceeded the configured byte limit.", { stage: "provider" });
  }
  if (doneEvents > 1 || (requireDone && doneEvents !== 1)) {
    throw new AlphionError("dependency-unavailable", "Provider returned an incomplete or ambiguous terminal event.", {
      stage: "provider",
    });
  }
}

export function assertValidUsage(usage: ProviderUsage): void {
  const values = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new AlphionError("dependency-unavailable", "Provider returned invalid usage values.", { stage: "provider" });
  }
}

export function areReusableProviderEvents(events: readonly ProviderEvent[], maxOutputBytes: number): boolean {
  try {
    assertProviderEventsWithinBudget(events, maxOutputBytes, true);
    return true;
  } catch {
    return false;
  }
}

export function formatToolObservation(result: ToolResult): string {
  const evidence = result.evidence ? `\nEvidence: [evidence:${result.evidence.id}] ${result.evidence.summary}` : "";
  return `${result.isError ? "ERROR" : "OK"}: ${result.content}${evidence}`;
}

export function buildGroundingReport(text: string, availableIds: readonly string[]): GroundingReport {
  const references = new Set<string>();
  for (const match of text.matchAll(/\[evidence:([A-Za-z0-9_-]+)\]/g)) {
    const id = match[1];
    if (id) references.add(id);
  }
  const available = new Set(availableIds);
  return {
    availableEvidenceIds: [...available],
    referencedEvidenceIds: [...references].filter((id) => available.has(id)),
    missingEvidenceIds: [...references].filter((id) => !available.has(id)),
    unreferencedEvidenceIds: [...available].filter((id) => !references.has(id)),
  };
}

export function decodeProviderEvents(serialized: string): readonly ProviderEvent[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const decoded: ProviderEvent[] = [];
  for (const item of value) {
    const event = decodeProviderEvent(item);
    if (!event) return undefined;
    decoded.push(event);
  }
  return decoded;
}

function decodeProviderEvent(value: unknown): ProviderEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "text-delta":
      return typeof value.delta === "string" ? { type: "text-delta", delta: value.delta } : undefined;
    case "reasoning-delta":
      return typeof value.delta === "string" ? { type: "reasoning-delta", delta: value.delta } : undefined;
    case "degraded":
      return typeof value.reason === "string" ? { type: "degraded", reason: value.reason } : undefined;
    case "done":
      return typeof value.finishReason === "string" ? { type: "done", finishReason: value.finishReason } : undefined;
    case "usage": {
      const usage = decodeUsage(value.usage);
      return usage ? { type: "usage", usage } : undefined;
    }
    case "tool-call": {
      const call = decodeToolCall(value.call);
      return call ? { type: "tool-call", call } : undefined;
    }
    default:
      return undefined;
  }
}

function decodeUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens } = value;
  return typeof inputTokens === "number" && typeof outputTokens === "number" && typeof cachedInputTokens === "number"
    ? { inputTokens, outputTokens, cachedInputTokens }
    : undefined;
}

function decodeToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.arguments)) {
    return undefined;
  }
  return { id: value.id, name: value.name, arguments: value.arguments };
}

export function decodeToolResult(serialized: string): ToolResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.content !== "string" || typeof value.isError !== "boolean") return undefined;
  if (value.evidence === undefined) return { content: value.content, isError: value.isError };
  const evidence = value.evidence;
  if (
    !isRecord(evidence) ||
    typeof evidence.id !== "string" ||
    typeof evidence.kind !== "string" ||
    !["file", "search", "change", "process"].includes(evidence.kind) ||
    typeof evidence.digest !== "string" ||
    typeof evidence.summary !== "string"
  ) {
    return undefined;
  }
  return {
    content: value.content,
    isError: value.isError,
    evidence: {
      id: evidence.id,
      kind: evidence.kind as EvidenceRef["kind"],
      digest: evidence.digest,
      summary: evidence.summary,
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
