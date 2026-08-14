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

export { Agent } from "./application/agent.js";
export type { AgentOptions } from "./application/agent.js";
export { AgentSession } from "./application/agent-session.js";
export { DefaultSessionManager } from "./application/session-manager.js";
export { DefaultGoalManager } from "./application/goal-manager.js";
export { DefaultScheduleManager } from "./application/schedule-manager.js";
export { assertScheduleCadence, latestDueOccurrence, nextScheduleOccurrence } from "./application/schedule-time.js";
export { CapabilityRegistry, classifyTask, planHarness } from "./application/harness.js";
export { createAgentEnvironment } from "./application/agent-environment.js";
export { AgentShaper } from "./application/agent-shaper.js";
export { SystemPromptComposer } from "./application/system-prompt.js";
export { DeterministicRoutingPolicy, InMemoryModelMetadataRegistry, ProfileModelRegistry } from "./application/model-routing.js";
export { buildCompactionPolicy, compactMessages, compactSessionEntries, compactSessionEntriesForModel, compactSessionEntriesWithProvider } from "./application/compaction.js";
export type { ModelCompactionRequest } from "./application/compaction.js";
export { planProviderConversation, projectAgentMessages } from "./application/message-projection.js";
export type { ProviderConversationPlan, ProviderConversationPlanInput } from "./application/message-projection.js";
export { validateJsonSchema } from "./application/json-schema.js";
export { AlphionError } from "./application/errors.js";
export { DefaultCapabilityPolicy } from "./application/policy.js";
export { TieredCache } from "./application/cache.js";
export { ToolRegistry } from "./application/tool-registry.js";
export { ProviderConfigurationManager } from "./application/provider-configuration.js";
export type {
  AgentBudgets,
  AgentMessage,
  ProviderMessage,
  AgentEnvironment,
  AgentContext,
  RuntimeConfig,
  RuntimeState,
  AgentExecutionRequest,
  AgentResource,
  AgentShape,
  AgentShapeReceipt,
  AgentShapeRequest,
  AgentSessionRecord,
  CollaborationContext,
  CapabilityDescriptor,
  HarnessPlan,
  HarnessTaskOverlay,
  PendingSessionMessage,
  ProjectRecord,
  RecallItem,
  RecallResult,
  ResourceLoadRequest,
  ResourceLoadResult,
  ResourceManifest,
  ResourceManifestEntry,
  ResourceResolution,
  ResourceScope,
  SystemPromptPlan,
  SessionEntry,
  SessionForkEntryMapping,
  SessionForkProvenance,
  SessionForkReceipt,
  SessionForkRequest,
  SessionView,
  SessionWriteOptions,
  SessionWriteReceipt,
  SessionMessageReceipt,
  SessionMessageRequest,
  TaskLabel,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCall,
  EvidenceRef,
  GroundingReport,
  ContextItemCategory,
  ContextOmission,
  ContextPack,
  ContextPackItem,
  ContextPackSummary,
  DiagnosticCheck,
  DiagnosticReport,
  OpenAICompatibleProtocol,
  ProviderAuth,
  ProviderCapabilities,
  ProviderEvent,
  ProviderKind,
  ProviderProfile,
  ProviderProfileInput,
  ProviderPreset,
  ProviderRequest,
  ProviderToolDefinition,
  ProviderUsage,
  ShellRule,
  ProfileDiagnostic,
  ProfileEvidence,
  ProfileFact,
  ProfileFactCategory,
  ProjectProfile,
  ToolContract,
  ToolResult,
  VaultStatus,
  WorkingMemorySnapshot,
} from "./domain/contracts.js";
export type { CompactionPolicy, CompactionProjection, CompactionRecord, CompactionResult, CompactionSummary } from "./domain/compaction-contracts.js";
export type { SessionActivity } from "./domain/session-activity.js";
export type {
  GoalCreateRequest, GoalProgressRequest, GoalRecord, GoalRevision, GoalRevisionActor, GoalRootUpdateRequest, GoalStatus, GoalWriteReceipt,
  ScheduleClaim, ScheduleCreateRequest, ScheduleExecution, ScheduleExecutionStatus, ScheduleExpression, SchedulePayload, ScheduleRecord, ScheduleStatus, ScheduleWriteOptions,
} from "./domain/automation-contracts.js";
export type {
  AgentApplication,
  AgentContract,
  AgentExecutionHooks,
  AgentSessionContract,
  SessionManager,
  AgentProvider,
  AgentRunHandle,
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
  CacheEntry,
  CacheStats,
  CacheStore,
  AutomationStore,
  CapabilityPolicy,
  EventStore,
  DeviceKeyProvider,
  GoalManager,
  SessionStore,
  ResourceLoader,
  ModelResolver,
  ModelMetadataRegistry,
  ModelRegistry,
  ProviderFactory,
  ProviderResolver,
  RoutingPolicy,
  ScheduleManager,
  CodeRecall,
  ProviderProfileStore,
  ProviderConfigurationService,
  ProjectProfiler,
  ProjectManager,
  SecretResolver,
  SecretVault,
  ShellPolicyStore,
  ToolExecutionContext,
  ToolExecutor,
  ToolBeforeHook,
  ToolAfterHook,
} from "./ports/index.js";
export { isAgentEvent } from "./protocol/events.js";
export type { AgentEvent, AgentEventDraft, AgentEventKind, AgentStreamControlEvent, AgentStreamControlEventKind, AgentStreamEvent, AgentStreamEventKind, AgentTransientEvent, AgentTransientEventKind } from "./protocol/events.js";
export { assembleContextPack, summarizeContextPack } from "./application/context-pack.js";
export { EMPTY_WORKING_MEMORY, reduceWorkingMemory } from "./application/working-memory.js";
