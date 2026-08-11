import type {
  AgentRunRequest,
  AgentRunResult,
  ProviderEvent,
  ProviderProfile,
  ProviderRequest,
  ShellRule,
  ToolContract,
  ToolResult,
} from "../domain/contracts.js";
import type { AgentEvent, AgentEventDraft } from "../protocol/events.js";

export interface AgentProvider {
  readonly profile: ProviderProfile;
  generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ToolExecutionContext {
  readonly projectRoot: string;
  readonly signal: AbortSignal;
}

export interface ToolExecutor {
  readonly contract: ToolContract;
  execute(input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly risk: "write" | "process";
  readonly actionDigest: string;
  readonly summary: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason: string;
}

export interface ApprovalPort {
  /** Changes whenever approval semantics or effective permissions change. */
  readonly revision: string;
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export type PolicyDecision =
  | Readonly<{ readonly outcome: "allow" }>
  | Readonly<{ readonly outcome: "approval"; readonly reason: string }>
  | Readonly<{ readonly outcome: "deny"; readonly reason: string }>;

export interface CapabilityPolicy {
  /** Changes whenever capability decisions change and participates in cache identity. */
  readonly revision: string;
  evaluate(tool: ToolContract, input: Readonly<Record<string, unknown>>): PolicyDecision;
}

export interface EventStore {
  append(event: AgentEventDraft): Promise<AgentEvent>;
  verifyRun(runId: string): Promise<boolean>;
}

export interface CacheEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly provenance: string;
}

export interface CacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
}

export interface CacheStore {
  get(namespace: string, key: string): Promise<CacheEntry | undefined>;
  set(entry: CacheEntry): Promise<void>;
  delete(namespace?: string): Promise<number>;
  stats(): Promise<CacheStats>;
}

export interface SecretResolver {
  resolve(reference: string): Promise<string | undefined>;
}

export interface ProviderProfileStore {
  upsertProfile(profile: Omit<ProviderProfile, "revision" | "active"> & { readonly active?: boolean }): Promise<ProviderProfile>;
  listProfiles(): Promise<readonly ProviderProfile[]>;
  getProfile(idOrName: string): Promise<ProviderProfile | undefined>;
  getActiveProfile(): Promise<ProviderProfile | undefined>;
  activateProfile(idOrName: string): Promise<ProviderProfile>;
}

export interface ShellPolicyStore {
  addShellRule(rule: Omit<ShellRule, "schemaVersion" | "id" | "enabled">): Promise<ShellRule>;
  listShellRules(): readonly ShellRule[];
  removeShellRule(id: string): Promise<boolean>;
  findAllowed(executablePath: string, args: readonly string[]): Promise<ShellRule | undefined>;
}

export interface AgentRunHandle {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentRunResult>;
  cancel(reason?: string): void;
}

export interface AgentRuntimeContract {
  start(request: AgentRunRequest): AgentRunHandle;
}
