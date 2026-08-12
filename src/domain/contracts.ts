export type OpenAICompatibleProtocol = "chat-completions" | "responses";
export type ProviderKind = "openai-compatible" | "deepseek";

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly promptCaching: boolean;
  readonly reasoning: boolean;
}

export type ProviderAuth = Readonly<
  | { readonly mode: "none" }
  | { readonly mode: "bearer-env"; readonly environmentVariable: string }
  | { readonly mode: "encrypted-sqlite"; readonly secretId: string }
>;

export interface ProviderProfile {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly protocol: OpenAICompatibleProtocol;
  readonly auth: ProviderAuth;
  readonly capabilities: ProviderCapabilities;
  readonly revision: number;
  readonly active: boolean;
}

export type ProviderProfileInput = Omit<ProviderProfile, "revision" | "active"> & {
  readonly active?: boolean;
};

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type AgentMessage =
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
  readonly messages: readonly AgentMessage[];
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

export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly risk: ToolRisk;
  readonly cachePolicy: ToolCachePolicy;
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
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly protocol: OpenAICompatibleProtocol;
}

export interface AgentRunRequest {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly projectRevision: string;
  readonly sessionId?: string;
  readonly systemInstructions?: string;
  readonly budgets?: Partial<AgentBudgets>;
  readonly cacheResponses?: boolean;
  readonly projectProfile?: ProjectProfile;
  readonly contextPack?: ContextPack;
  readonly workingMemory?: WorkingMemorySnapshot;
}

export interface AgentApplicationRunRequest extends Omit<AgentRunRequest, "projectRevision"> {
  readonly providerId?: string;
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
