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

export interface AgentRunRequest {
  readonly prompt: string;
  readonly projectRoot: string;
  readonly projectRevision: string;
  readonly sessionId?: string;
  readonly systemInstructions?: string;
  readonly budgets?: Partial<AgentBudgets>;
  readonly cacheResponses?: boolean;
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
}

export interface ShellRule {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly executablePath: string;
  readonly executableDigest?: string;
  readonly argumentPrefix: readonly string[];
  readonly enabled: boolean;
}
