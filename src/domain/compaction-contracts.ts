import type { AgentMessage } from "./contracts.js";

export interface CompactionPolicy {
  readonly schemaVersion: 1;
  readonly triggerRatio: number;
  readonly contextWindowTokens: number;
  readonly outputReserveTokens: number;
  readonly toolReserveTokens: number;
  readonly safetyReserveTokens: number;
  readonly effectiveInputTokens: number;
}

export interface CompactionSummary {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly reason: "model-context-threshold";
  readonly originalTokens: number;
  readonly compactedTokens: number;
  readonly sourceEntryCount: number;
  readonly retainedCycleCount: number;
  readonly modelId: string;
  readonly policyDigest: string;
  readonly digest: string;
}

export interface CompactionRecord extends CompactionSummary {
  readonly runId: string;
  readonly sourceEntryIds: readonly string[];
  readonly sourceDigest: string;
  readonly retainedKinds: readonly string[];
  readonly omissions: readonly string[];
  readonly knownLosses: readonly string[];
  readonly memory: Extract<AgentMessage, { readonly kind: "memory" }>;
}

export interface CompactionProjection {
  readonly latest?: CompactionSummary;
  readonly count: number;
}

export interface CompactionResult {
  readonly messages: readonly AgentMessage[];
  readonly record?: CompactionRecord;
}
