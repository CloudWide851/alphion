import type { ProviderUsage } from "../domain/contracts.js";

export type AgentEventKind =
  | "run.started"
  | "project.profiled"
  | "context.assembled"
  | "provider.started"
  | "provider.degraded"
  | "model.delta"
  | "model.usage"
  | "cache.hit"
  | "cache.miss"
  | "cache.stored"
  | "tool.requested"
  | "tool.updated"
  | "approval.requested"
  | "approval.resolved"
  | "tool.completed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type AgentTransientEventKind = "model.reasoning.delta";
export type AgentStreamEventKind = AgentEventKind | AgentTransientEventKind;

export interface AgentEvent {
  readonly schemaVersion: 1 | 2;
  readonly eventId: string;
  readonly sequence: number;
  readonly sessionSequence?: number;
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

/** Live-only progress that is intentionally absent from Event History and replay. */
export interface AgentTransientEvent {
  readonly delivery: "transient";
  readonly runId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly kind: AgentTransientEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type AgentStreamEvent = AgentEvent | AgentTransientEvent;

export type AgentEventDraft = Omit<
  AgentEvent,
  "schemaVersion" | "eventId" | "sequence" | "sessionSequence" | "timestamp" | "previousDigest" | "digest"
>;

export function isCriticalAgentEvent(kind: AgentEventKind): boolean {
  return kind !== "model.delta";
}

export function emptyProviderUsage(): ProviderUsage {
  return Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
}
