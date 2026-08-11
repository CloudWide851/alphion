const ALPHION_ASSETS = Object.freeze({
  primary: "alphion-logo.svg",
  icon: "alphion-icon.svg",
  wordmark: "alphion-wordmark.svg",
} as const);

/** Stable product identity shared by Alphion adapters and surfaces. */
export const ALPHION_BRAND = Object.freeze({
  name: "Alphion",
  tagline:
    "A lightweight, project-aware agent harness that evolves through evidence and control.",
  assets: ALPHION_ASSETS,
} as const);

export type AlphionBrand = typeof ALPHION_BRAND;

export { AgentRuntime } from "./application/agent-runtime.js";
export type { AgentRuntimeOptions } from "./application/agent-runtime.js";
export { AlphionError } from "./application/errors.js";
export { DefaultCapabilityPolicy } from "./application/policy.js";
export { TieredCache } from "./application/cache.js";
export { ToolRegistry } from "./application/tool-registry.js";
export type {
  AgentBudgets,
  AgentMessage,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCall,
  EvidenceRef,
  GroundingReport,
  OpenAICompatibleProtocol,
  ProviderCapabilities,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest,
  ProviderToolDefinition,
  ProviderUsage,
  ShellRule,
  ToolContract,
  ToolResult,
} from "./domain/contracts.js";
export type {
  AgentProvider,
  AgentRunHandle,
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
  CacheEntry,
  CacheStats,
  CacheStore,
  CapabilityPolicy,
  EventStore,
  ProviderProfileStore,
  SecretResolver,
  ShellPolicyStore,
  ToolExecutionContext,
  ToolExecutor,
} from "./ports/index.js";
export type { AgentEvent, AgentEventDraft, AgentEventKind } from "./protocol/events.js";
