import type { ProviderUsage } from "../domain/contracts.js";

export type AgentEventKind =
  | "run.started"
  | "provider.started"
  | "provider.degraded"
  | "model.delta"
  | "model.reasoning.delta"
  | "model.usage"
  | "cache.hit"
  | "cache.miss"
  | "cache.stored"
  | "tool.requested"
  | "approval.requested"
  | "approval.resolved"
  | "tool.completed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface AgentEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly sequence: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly timestamp: string;
  readonly kind: AgentEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousDigest: string;
  readonly digest: string;
}

export type AgentEventDraft = Omit<
  AgentEvent,
  "schemaVersion" | "eventId" | "sequence" | "timestamp" | "previousDigest" | "digest"
>;

export function isCriticalAgentEvent(kind: AgentEventKind): boolean {
  return kind !== "model.delta" && kind !== "model.reasoning.delta";
}

export function emptyProviderUsage(): ProviderUsage {
  return Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
}
