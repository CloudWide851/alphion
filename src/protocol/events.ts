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
export type AgentStreamControlEventKind = "stream.resync-required";
export type AgentStreamEventKind = AgentEventKind | AgentTransientEventKind | AgentStreamControlEventKind;

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

/** Non-durable control record emitted only to a lagging subscriber. */
export interface AgentStreamControlEvent {
  readonly delivery: "control";
  readonly sessionId: string;
  readonly timestamp: string;
  readonly kind: AgentStreamControlEventKind;
  readonly payload: Readonly<{ afterSessionSequence: number; reason: "slow-consumer" }>;
}

export type AgentStreamEvent = AgentEvent | AgentTransientEvent | AgentStreamControlEvent;

/** Narrows a mixed live stream to authority-backed events safe for durable projections. */
export function isAgentEvent(event: AgentStreamEvent): event is AgentEvent {
  return !("delivery" in event);
}

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
