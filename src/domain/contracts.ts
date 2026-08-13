export type OpenAICompatibleProtocol = "chat-completions" | "responses";
export type BuiltInProviderKind = "deepseek" | "kimi" | "qwen" | "glm";
export type ProviderKind = BuiltInProviderKind | "custom-openai-compatible";

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly promptCaching: boolean;
  readonly reasoning: boolean;
  /** Explicit operator acknowledgement for a model absent from a built-in catalog. */
  readonly unlistedModel?: boolean;
}

export type ProviderAuth = Readonly<
  | { readonly mode: "none" }
  | { readonly mode: "bearer-env"; readonly environmentVariable: string }
  | { readonly mode: "encrypted-sqlite"; readonly secretId: string }
>;

interface ProviderProfileBase {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly protocol: OpenAICompatibleProtocol;
  readonly auth: ProviderAuth;
  readonly capabilities: ProviderCapabilities;
  readonly revision: number;
  readonly active: boolean;
}

export type ProviderProfile =
  | Readonly<ProviderProfileBase & { readonly kind: BuiltInProviderKind; readonly presetId: string; readonly baseUrl?: never }>
  | Readonly<ProviderProfileBase & { readonly kind: "custom-openai-compatible"; readonly baseUrl: string; readonly presetId?: never }>;

export type ProviderProfileInput =
  | Readonly<Omit<Extract<ProviderProfile, { readonly kind: BuiltInProviderKind }>, "revision" | "active"> & { readonly active?: boolean }>
  | Readonly<Omit<Extract<ProviderProfile, { readonly kind: "custom-openai-compatible" }>, "revision" | "active"> & { readonly active?: boolean }>;

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Provider-wire conversation shape. Domain session messages never cross this boundary directly. */
export type ProviderMessage =
  | Readonly<{ readonly role: "system" | "user"; readonly content: string }>
  | Readonly<{
      readonly role: "assistant";
      readonly content: string;
      readonly reasoningContent?: string;
      readonly toolCalls?: readonly AgentToolCall[];
    }>
  | Readonly<{
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    }>;

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly promptCacheKey?: string;
}

export type ProviderEvent =
  | Readonly<{ readonly type: "text-delta"; readonly delta: string }>
  | Readonly<{ readonly type: "reasoning-delta"; readonly delta: string }>
  | Readonly<{ readonly type: "tool-call"; readonly call: AgentToolCall }>
  | Readonly<{ readonly type: "usage"; readonly usage: ProviderUsage }>
  | Readonly<{ readonly type: "degraded"; readonly reason: string }>
  | Readonly<{ readonly type: "done"; readonly finishReason: string }>;

export type ToolRisk = "read" | "write" | "process";
export type ToolCachePolicy = "none" | "content";
export type ToolExecutionMode = "serial" | "parallel-safe";
export type ToolSideEffect = "none" | "read" | "write" | "process";

export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly risk: ToolRisk;
  readonly cachePolicy: ToolCachePolicy;
  readonly executionMode?: ToolExecutionMode;
  readonly sideEffect?: ToolSideEffect;
  readonly idempotent?: boolean;
  readonly approval?: "never" | "policy" | "always";
  readonly timeoutMs?: number;
}

export interface EvidenceRef {
  readonly id: string;
  readonly kind: "file" | "search" | "change" | "process";
  readonly digest: string;
  readonly summary: string;
}

export interface ToolResult {
  readonly content: string;
  readonly evidence?: EvidenceRef;
  readonly isError: boolean;
}

export interface AgentBudgets {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxOutputTokens: number;
  readonly maxOutputBytes: number;
  readonly runTimeoutMs: number;
  readonly modelTimeoutMs: number;
}

export type ProfileFactCategory =
  | "language"
  | "runtime"
  | "module-system"
  | "package-manager"
  | "framework"
  | "quality-command"
  | "git"
  | "ci"
  | "constraint"
  | "risk";

export interface ProfileEvidence {
  readonly path: string;
  readonly detail: string;
  readonly digest?: string;
}

export interface ProfileFact {
  readonly id: string;
  readonly category: ProfileFactCategory;
  readonly name: string;
  readonly value: string;
  readonly confidence: "observed" | "inferred";
  readonly evidence: readonly ProfileEvidence[];
}

export interface ProfileDiagnostic {
  readonly code:
    | "unknown-project"
    | "scan-truncated"
    | "profile-truncated"
    | "oversize-config"
    | "invalid-config"
    | "conflicting-lockfiles"
    | "git-unavailable"
    | "path-skipped";
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly path?: string;
}

export interface ProjectProfile {
  readonly schemaVersion: 1;
  readonly projectRevision: string;
  readonly profilerVersion: string;
  readonly rulesVersion: string;
  readonly projectType: "node-typescript" | "node-javascript" | "unknown";
  readonly facts: readonly ProfileFact[];
  readonly qualityCommands: readonly string[];
  readonly diagnostics: readonly ProfileDiagnostic[];
  readonly scannedPaths: number;
  readonly truncated: boolean;
  readonly digest: string;
}

export type ContextItemCategory =
  | "security-policy"
  | "goal"
  | "permission"
  | "constraint"
  | "project-profile"
  | "quality-command"
  | "working-memory";

export interface ContextPackItem {
  readonly id: string;
  readonly category: ContextItemCategory;
  readonly content: string;
  readonly required: boolean;
  readonly estimatedTokens: number;
}

export interface ContextOmission {
  readonly id: string;
  readonly category: ContextItemCategory;
  readonly reason: "empty" | "budget" | "oversize";
}

export interface ContextPack {
  readonly schemaVersion: 1;
  readonly projectRevision: string;
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly items: readonly ContextPackItem[];
  readonly omissions: readonly ContextOmission[];
  readonly digest: string;
  readonly rendered: string;
}

export interface ContextPackSummary {
  readonly digest: string;
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly itemCount: number;
  readonly omissionCount: number;
}

export interface WorkingMemorySnapshot {
  readonly schemaVersion: 1;
  readonly phase: "idle" | "profiling" | "context" | "model" | "tools" | "completed" | "failed" | "cancelled";
  readonly turns: number;
  readonly toolCalls: number;
  readonly evidenceIds: readonly string[];
  readonly errorCodes: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly lastEventSequence: number;
}

export interface DiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "warning" | "fail" | "unknown";
  readonly summary: string;
  readonly remediation?: string;
}

export interface DiagnosticReport {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly overall: "healthy" | "attention" | "unhealthy";
  readonly checks: readonly DiagnosticCheck[];
}

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly region: "mainland" | "international" | "custom";
  readonly requiresBaseUrl: boolean;
  readonly models: readonly string[];
  readonly protocol: OpenAICompatibleProtocol;
}

export interface AgentRunRequest {
  readonly runId?: string;
  readonly prompt: string;
  readonly projectRoot: string;
  readonly projectRevision: string;
  readonly sessionId?: string;
  /** Versioned privileged instructions. Runtime never assembles ad-hoc system strings. */
  readonly systemPromptPlan: SystemPromptPlan;
  readonly modelContextMessages?: readonly ProviderMessage[];
  readonly budgets?: Partial<AgentBudgets>;
  readonly cacheResponses?: boolean;
  readonly projectProfile?: ProjectProfile;
  readonly contextPack?: ContextPack;
  readonly workingMemory?: WorkingMemorySnapshot;
  /** Immutable identity of the Session shape used by this run. */
  readonly shape?: AgentShape;
  /** Bounded causal identity for project-scoped Session collaboration. */
  readonly collaboration?: CollaborationContext;
}

/** Immutable, session-derived inputs used to assemble one model context. */
export interface AgentContext {
  readonly projectRoot: string;
  readonly projectRevision: string;
  readonly history: readonly AgentMessage[];
  readonly environment: AgentEnvironment;
  readonly harnessPlan: HarnessPlan;
  readonly recall?: RecallResult;
}

/** Per-session execution configuration. It is never stored on the shared Agent. */
export interface RuntimeConfig {
  readonly providerId?: string;
  readonly budgets?: Partial<AgentBudgets>;
  readonly cacheResponses?: boolean;
}

/** Mutable state owned by exactly one active run. */
export interface RuntimeState {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: WorkingMemorySnapshot["phase"];
  readonly turns: number;
  readonly toolCalls: number;
  readonly mutationRevision: number;
}

export interface AgentMessageBase {
  readonly id: string;
  readonly createdAt: string;
}

/** Versioned, provider-independent messages persisted in session branches. */
export type AgentMessage =
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "user"; readonly content: string }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "assistant"; readonly content: string; readonly evidenceIds?: readonly string[] }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "tool-call"; readonly call: AgentToolCall }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "observation"; readonly toolCallId: string; readonly toolName: string; readonly content: string; readonly evidence?: EvidenceRef; readonly isError: boolean }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "memory"; readonly content: string; readonly sourceEntryIds: readonly string[]; readonly digest: string }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "system-event"; readonly eventKind: string; readonly content: string }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "human-approval"; readonly requestId: string; readonly approved: boolean; readonly content: string }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "agent"; readonly agentId: string; readonly content: string }>
  | Readonly<AgentMessageBase & { readonly schemaVersion: 1; readonly kind: "workflow"; readonly state: string; readonly content: string }>
  | Readonly<AgentMessageBase & {
      readonly schemaVersion: 2; readonly kind: "agent";
      readonly sourceSessionId: string; readonly targetSessionId: string; readonly domainId: string;
      readonly idempotencyKey: string; readonly correlationId: string; readonly causationId?: string;
      readonly hop: number; readonly delivery: "steer" | "follow-up"; readonly content: string;
    }>;

export type SessionStatus = "idle" | "running" | "legacy-audit";

export interface SessionForkEntryMapping {
  readonly sourceEntryId: string;
  readonly targetEntryId: string;
}

export interface SessionForkProvenance {
  readonly schemaVersion: 1;
  readonly sourceSessionId: string;
  readonly sourceEntryId?: string;
  readonly sourceRevision: number;
  readonly branchDigest: string;
  readonly forkedAt: string;
}

export interface SessionForkRequest {
  readonly sourceSessionId: string;
  readonly sourceEntryId?: string;
  readonly title?: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface AgentSessionRecord {
  readonly schemaVersion: 3;
  readonly id: string;
  readonly domainId: string;
  readonly projectId?: string;
  readonly title: string;
  readonly currentLeafId?: string;
  readonly revision: number;
  readonly status: SessionStatus;
  readonly activeRunId?: string;
  readonly providerId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly auditOnly: boolean;
  readonly shapeStatus: "unshaped" | "shaped" | "legacy-unshaped";
  readonly shapeRevision?: number;
  readonly shapeDigest?: string;
  readonly forkProvenance?: SessionForkProvenance;
}

export interface SessionForkReceipt {
  readonly session: AgentSessionRecord;
  readonly provenance: SessionForkProvenance;
  readonly entryMapping: readonly SessionForkEntryMapping[];
  readonly replayed: boolean;
}

export interface SessionEntry {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly parentId?: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly timestamp: string;
  readonly message: AgentMessage;
}

export interface SessionView {
  readonly session: AgentSessionRecord;
  readonly entries: readonly SessionEntry[];
}

export type PendingMessageKind = "steer" | "follow-up";

export interface PendingSessionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: PendingMessageKind;
  readonly message: Extract<AgentMessage, { readonly kind: "user" | "agent" }>;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface CollaborationContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly hop: number;
}

export interface SessionMessageRequest {
  readonly sourceSessionId: string; readonly sourceRunId: string; readonly targetSessionId: string;
  readonly domainId: string; readonly shapeDigest: string; readonly idempotencyKey: string;
  readonly correlationId: string; readonly causationId?: string; readonly hop: number; readonly content: string;
}

export interface SessionMessageReceipt {
  readonly messageId: string; readonly sourceSessionId: string; readonly targetSessionId: string;
  readonly targetRevision: number; readonly delivery: "steer" | "follow-up"; readonly hop: number; readonly replayed: boolean;
}

export interface ProjectRecord {
  readonly schemaVersion: 1; readonly id: string; readonly name: string; readonly root: string;
  readonly statePath: string; readonly domainId: string; readonly createdAt: string; readonly updatedAt: string;
}

export interface SessionWriteOptions {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface SessionWriteReceipt {
  readonly sessionId: string;
  readonly revision: number;
  readonly entryId?: string;
  readonly pendingMessageId?: string;
  readonly replayed: boolean;
}

export type ResourceKind = "extension" | "skill" | "prompt" | "theme" | "context";
export type ResourceScope = "builtin" | "user" | "project" | "session";

export interface ResourceProvenance {
  readonly scope: ResourceScope;
  readonly packageId: string;
  readonly manifestPath: string;
  readonly sourcePath: string;
}

export interface AgentResource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly source: string;
  readonly content: string;
  readonly digest: string;
  readonly dependencies: readonly string[];
  readonly tags: readonly string[];
  readonly constraints?: readonly string[];
  readonly provenance: ResourceProvenance;
}

export interface ResourceLoadRequest {
  readonly projectRoot: string;
  readonly userResourceRoot?: string;
  readonly disabledScopes?: readonly ResourceScope[];
  readonly disabledIds?: readonly string[];
  readonly sessionOverrides?: readonly ResourceManifestEntry[];
  readonly maxResources?: number;
  readonly maxFileBytes?: number;
  readonly maxBytes?: number;
}

export interface ResourceManifestEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly path?: string;
  readonly inline?: string;
  readonly dependencies?: readonly string[];
  readonly tags?: readonly string[];
  readonly enabled?: boolean;
}

export interface ResourceManifest {
  readonly schemaVersion: 1;
  readonly packageId: string;
  readonly resources: readonly ResourceManifestEntry[];
}

export interface ResourceShadow {
  readonly id: string;
  readonly selected: ResourceProvenance;
  readonly shadowed: ResourceProvenance;
}

export interface ResourceDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly scope?: ResourceScope;
  readonly resourceId?: string;
  readonly path?: string;
}

export interface ResourceResolution {
  readonly schemaVersion: 1;
  readonly resources: readonly AgentResource[];
  readonly shadows: readonly ResourceShadow[];
  readonly omissions: readonly string[];
  readonly diagnostics: readonly ResourceDiagnostic[];
  readonly digest: string;
}

/** @deprecated Use ResourceResolution. */
export type ResourceLoadResult = ResourceResolution;

export interface AgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface AgentEnvironment {
  readonly identity: AgentIdentity;
  readonly projectRoot: string;
  readonly projectRevision: string;
  readonly capabilities: readonly string[];
  readonly policies: readonly string[];
  readonly skills: readonly AgentResource[];
  readonly resources: readonly AgentResource[];
  readonly systemPromptPlan: SystemPromptPlan;
  readonly digest: string;
}

export type SystemPromptSectionKind = "identity" | "workspace" | "session" | "policy" | "resource" | "harness";

export interface SystemPromptSection {
  readonly id: string;
  readonly kind: SystemPromptSectionKind;
  readonly authority: "root" | "application" | "session" | "resource";
  readonly content: string;
  readonly required: boolean;
  readonly provenance: readonly string[];
  readonly estimatedTokens: number;
  readonly digest: string;
}

export interface SystemPromptPlan {
  readonly schemaVersion: 1;
  readonly sections: readonly SystemPromptSection[];
  readonly omissions: readonly string[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly rendered: string;
  readonly digest: string;
}

export interface SessionBehavior {
  readonly compaction: "deterministic" | "hybrid";
  readonly steering: boolean;
  readonly followUps: boolean;
}

export interface AgentShapeRequest {
  readonly goal: string;
  readonly resourceIds?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly policies?: readonly string[];
  readonly toolIds?: readonly string[];
  readonly providerId?: string;
  readonly behavior?: Partial<SessionBehavior>;
  readonly promptBudgetTokens?: number;
}

export interface AgentShape {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly goal: string;
  readonly identity: AgentIdentity;
  readonly systemPromptPlan: SystemPromptPlan;
  readonly resources: readonly AgentResource[];
  readonly resourceIds: readonly string[];
  readonly resourceDigest: string;
  readonly toolIds: readonly string[];
  readonly capabilities: readonly string[];
  readonly policies: readonly string[];
  readonly behavior: SessionBehavior;
  readonly providerId?: string;
  readonly requiredProviderCapabilities: readonly (keyof ProviderCapabilities)[];
  readonly harnessPlan: HarnessPlan;
  readonly omissions: readonly string[];
  readonly diagnostics: readonly string[];
  readonly digest: string;
}

export interface AgentShapeReceipt {
  readonly sessionId: string;
  readonly revision: number;
  readonly shapeRevision: number;
  readonly shapeDigest: string;
  readonly replayed: boolean;
}

export type TaskLabel = "explain" | "diagnose" | "implement" | "verify" | "release";

export interface CapabilityDescriptor {
  readonly id: string;
  readonly description: string;
  readonly taskLabels: readonly TaskLabel[];
  readonly permissions: readonly string[];
  readonly defaultBudget: number;
}

export interface HarnessPlan {
  readonly schemaVersion: 1;
  readonly task: TaskLabel;
  readonly taskLabels: readonly TaskLabel[];
  readonly risk: "low" | "medium" | "high";
  readonly capabilities: readonly string[];
  readonly reasons: readonly string[];
  readonly permissions: readonly string[];
  readonly budgets: Readonly<Record<string, number>>;
  readonly evaluator: string;
  /** Effective task-scoped restrictions after validation. Never contains widened values. */
  readonly overlay?: HarnessTaskOverlay;
  readonly omissions: readonly string[];
  readonly digest: string;
}

export interface HarnessTaskOverlay {
  readonly capabilities?: readonly string[];
  readonly permissions?: readonly string[];
  readonly budgets?: Readonly<Record<string, number>>;
  readonly evaluator?: "acceptance-criteria" | "quality-gate";
}

export interface RecallItem {
  readonly source: "codegraph" | "lexical";
  readonly path: string;
  readonly excerpt: string;
  readonly confidence: number;
  readonly evidence: string;
}

export interface RecallResult {
  readonly items: readonly RecallItem[];
  readonly degraded: boolean;
  readonly diagnostics: readonly string[];
}

export interface ModelSelectionRequest {
  readonly sessionId: string;
  readonly providerId?: string;
  readonly requiredCapabilities: readonly (keyof ProviderCapabilities)[];
}

export interface ModelDescriptor {
  readonly id: string;
  readonly providerKind: ProviderKind;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
}

export interface ModelRouteCandidate {
  readonly profileId: string;
  readonly reason: string;
  readonly rank: number;
}

export interface ModelResolutionSummary {
  readonly providerId: string;
  readonly reasons: readonly string[];
}

export interface AgentExecutionRequest extends Omit<AgentRunRequest, "systemPromptPlan" | "modelContextMessages"> {
  readonly providerId?: string;
  readonly history: readonly AgentMessage[];
  readonly environment: AgentEnvironment;
  readonly harnessPlan: HarnessPlan;
  readonly recall?: RecallResult;
}

export interface VaultStatus {
  readonly initialized: boolean;
  readonly locked: boolean;
  readonly secretCount: number;
  readonly autoLockMs: number;
}

export interface GroundingReport {
  readonly availableEvidenceIds: readonly string[];
  readonly referencedEvidenceIds: readonly string[];
  readonly missingEvidenceIds: readonly string[];
  readonly unreferencedEvidenceIds: readonly string[];
}

export interface AgentRunResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly finalText: string;
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: ProviderUsage;
  readonly grounding: GroundingReport;
  readonly errorCode?: string;
  readonly context?: ContextPackSummary;
  readonly workingMemory?: WorkingMemorySnapshot;
}

export interface ShellRule {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly executablePath: string;
  readonly executableDigest?: string;
  readonly argumentPrefix: readonly string[];
  readonly enabled: boolean;
}
