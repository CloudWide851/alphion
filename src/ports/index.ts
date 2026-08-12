import type {
  AgentRunResult,
  AgentExecutionRequest,
  AgentMessage,
  AgentShape,
  AgentShapeReceipt,
  AgentShapeRequest,
  AgentSessionRecord,
  HarnessPlan,
  HarnessTaskOverlay,
  ModelDescriptor,
  ModelSelectionRequest,
  ModelRouteCandidate,
  PendingMessageKind,
  PendingSessionMessage,
  ProjectRecord,
  RecallResult,
  ResourceLoadRequest,
  ResourceResolution,
  SessionView,
  SessionWriteOptions,
  SessionWriteReceipt,
  SessionMessageReceipt,
  SessionMessageRequest,
  ProviderEvent,
  ProviderProfile,
  ProviderProfileInput,
  ProviderPreset,
  ProjectProfile,
  DiagnosticReport,
  ProviderRequest,
  ShellRule,
  ToolContract,
  ToolResult,
  VaultStatus,
} from "../domain/contracts.js";
import type { AgentEvent, AgentEventDraft, AgentStreamEvent } from "../protocol/events.js";

export interface AgentProvider {
  readonly profile: ProviderProfile;
  generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ModelResolver {
  resolveModel(request: ModelSelectionRequest): Promise<AgentProvider>;
}

export interface ModelRegistry {
  list(): Promise<readonly ProviderProfile[]>;
  get(idOrName: string): Promise<ProviderProfile | undefined>;
  active(): Promise<ProviderProfile | undefined>;
}

/** Non-secret model metadata source. It never constructs SDK clients or resolves credentials. */
export interface ModelMetadataRegistry {
  listModels(): Promise<readonly ModelDescriptor[]>;
  getModel(id: string): Promise<ModelDescriptor | undefined>;
}

export interface RoutingPolicy {
  route(request: ModelSelectionRequest, profiles: readonly ProviderProfile[]): readonly ModelRouteCandidate[];
}

export interface ProviderFactory {
  create(profile: ProviderProfile): AgentProvider;
}

export interface ProviderResolver extends ModelResolver {
  resolve(request: ModelSelectionRequest): Promise<Readonly<{ provider: AgentProvider; reasons: readonly string[] }>>;
}

export interface ResourceLoader {
  resolve(request: ResourceLoadRequest, signal?: AbortSignal): Promise<ResourceResolution>;
}

export interface CodeRecall {
  recall(request: Readonly<{ projectRoot: string; projectRevision: string; query: string; scope?: readonly string[]; limit?: number }>, signal: AbortSignal): Promise<RecallResult>;
  clear(): void;
}

export interface ToolExecutionContext {
  readonly projectRoot: string;
  readonly signal: AbortSignal;
  readonly reportUpdate?: (content: string) => Promise<void>;
  readonly sendSessionMessage?: (targetSessionId: string, content: string, idempotencyKey: string) => Promise<SessionMessageReceipt>;
}

export type ToolBeforeHook = (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<Readonly<{ action: "continue"; input?: Readonly<Record<string, unknown>> } | { action: "block"; content: string } | { action: "terminate"; content: string }>>;
export type ToolAfterHook = (result: ToolResult, context: ToolExecutionContext) => Promise<Readonly<{ result?: ToolResult; terminate?: boolean }>>;

export interface ToolExecutor {
  readonly contract: ToolContract;
  execute(input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ToolResult>;
  readonly before?: readonly ToolBeforeHook[];
  readonly after?: readonly ToolAfterHook[];
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly risk: "write" | "process";
  readonly actionDigest: string;
  readonly shapeDigest?: string;
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
  listSessionEvents(sessionId: string, afterSessionSequence?: number): Promise<readonly AgentEvent[]>;
}

export interface SessionStore {
  createSession(input: Readonly<{ title: string; providerId?: string; idempotencyKey: string }>): Promise<AgentSessionRecord>;
  listSessions(): Promise<readonly AgentSessionRecord[]>;
  getSession(sessionId: string): Promise<AgentSessionRecord | undefined>;
  getSessionView(sessionId: string): Promise<SessionView | undefined>;
  listSessionEvents(sessionId: string, afterSessionSequence?: number): Promise<readonly AgentEvent[]>;
  appendSessionEntry(sessionId: string, message: AgentMessage, options: SessionWriteOptions, runId?: string): Promise<SessionWriteReceipt>;
  getSessionShape(sessionId: string): Promise<AgentShape | undefined>;
  reshapeSession(sessionId: string, shape: AgentShape, options: SessionWriteOptions): Promise<AgentShapeReceipt>;
  /** Atomically freezes an initial shape, appends the user entry and acquires the sole run lease. */
  beginShapedSessionRun(sessionId: string, runId: string, message: Extract<AgentMessage, { readonly kind: "user" }>, initialShape: AgentShape | undefined, options: SessionWriteOptions): Promise<Readonly<{ receipt: SessionWriteReceipt; session: AgentSessionRecord; shape: AgentShape }>>;
  checkoutSession(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  enqueuePending(sessionId: string, kind: PendingMessageKind, message: Extract<AgentMessage, { readonly kind: "user" | "agent" }>, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  deliverSessionMessage(request: SessionMessageRequest): Promise<SessionMessageReceipt>;
  /** Claims the complete FIFO snapshot currently visible to a run. Claimed rows remain durable until acknowledged. */
  drainPending(sessionId: string, kind: PendingMessageKind, runId: string): Promise<readonly PendingSessionMessage[]>;
  acknowledgePending(sessionId: string, kind: PendingMessageKind, runId: string, pendingIds: readonly string[]): Promise<void>;
  releasePendingClaims(sessionId: string, kind: PendingMessageKind, runId: string): Promise<void>;
  acquireRunLease(sessionId: string, runId: string, expectedRevision: number): Promise<AgentSessionRecord>;
  releaseRunLease(sessionId: string, runId: string): Promise<AgentSessionRecord>;
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
  upsertProfile(profile: ProviderProfileInput): Promise<ProviderProfile>;
  listProfiles(): Promise<readonly ProviderProfile[]>;
  getProfile(idOrName: string): Promise<ProviderProfile | undefined>;
  getActiveProfile(): Promise<ProviderProfile | undefined>;
  activateProfile(idOrName: string): Promise<ProviderProfile>;
}

export interface SecretVault extends SecretResolver {
  status(): Promise<VaultStatus>;
  initialize(masterPassword: string): Promise<void>;
  unlock(masterPassword: string): Promise<void>;
  lock(): void;
  importCredential(profileId: string, secret: string): Promise<ProviderProfile>;
  removeCredential(profileId: string): Promise<ProviderProfile>;
  rotateMasterPassword(currentPassword: string, nextPassword: string): Promise<void>;
  reset(): Promise<number>;
}

export interface ProviderConfigurationService {
  listProfiles(): Promise<readonly ProviderProfile[]>;
  upsertProfile(profile: ProviderProfileInput): Promise<ProviderProfile>;
  activateProfile(idOrName: string): Promise<ProviderProfile>;
  vaultStatus(): Promise<VaultStatus>;
  initializeVault(masterPassword: string): Promise<void>;
  unlockVault(masterPassword: string): Promise<void>;
  lockVault(): void;
  importCredential(profileId: string, secret: string): Promise<ProviderProfile>;
  removeCredential(profileId: string): Promise<ProviderProfile>;
  rotateVaultPassword(currentPassword: string, nextPassword: string): Promise<void>;
  resetVault(): Promise<number>;
}

export interface ProjectProfiler {
  inspect(options: Readonly<{ projectRoot: string; refresh?: boolean }>): Promise<ProjectProfile>;
}

export interface ShellPolicyStore {
  addShellRule(rule: Omit<ShellRule, "schemaVersion" | "id" | "enabled">): Promise<ShellRule>;
  listShellRules(): readonly ShellRule[];
  removeShellRule(id: string): Promise<boolean>;
  findAllowed(executablePath: string, args: readonly string[]): Promise<ShellRule | undefined>;
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly events: AsyncIterable<AgentStreamEvent>;
  readonly result: Promise<AgentRunResult>;
  cancel(reason?: string): void;
}

export interface AgentContract {
  execute(request: AgentExecutionRequest, approval: ApprovalPort, hooks?: AgentExecutionHooks): Promise<AgentRunHandle>;
}

export interface AgentExecutionHooks {
  /** Atomically drains the steering snapshot visible at this model boundary. */
  drainSteering(runId: string, signal: AbortSignal): Promise<readonly AgentMessage[]>;
  deliverSessionMessage?(targetSessionId: string, content: string, idempotencyKey: string): Promise<SessionMessageReceipt>;
}

export interface AgentSessionContract {
  readonly id: string;
  get(): Promise<AgentSessionRecord>;
  view(): Promise<SessionView>;
  getShape(): Promise<AgentShape | undefined>;
  reshape(request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt>;
  checkout(entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  send(content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle>;
  steer(content: string, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  followUp(content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt>;
  resumePending(approval: ApprovalPort): void;
  subscribe(afterSessionSequence?: number): AsyncIterable<AgentStreamEvent>;
  /** Stops new work, cancels active runs, and drains all store-owning tasks. */
  close(): Promise<void>;
}

/** Project-scoped owner of all durable session workflows. */
export interface SessionManager {
  create(input?: Readonly<{ title?: string; providerId?: string; idempotencyKey?: string }>): Promise<AgentSessionContract>;
  list(): Promise<readonly AgentSessionRecord[]>;
  get(sessionId: string): Promise<AgentSessionContract>;
  view(sessionId: string): Promise<SessionView>;
  getShape(sessionId: string): Promise<AgentShape | undefined>;
  reshape(sessionId: string, request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt>;
  checkout(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  send(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle>;
  steer(sessionId: string, content: string, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  followUp(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt>;
  deliver(request: SessionMessageRequest): Promise<SessionMessageReceipt>;
  subscribe(sessionId: string, afterSessionSequence?: number): AsyncIterable<AgentStreamEvent>;
  /** Drains every materialized session before its backing store is closed. */
  close(): Promise<void>;
}

export interface ProjectManager {
  register(input: Readonly<{ name: string; root: string }>): Promise<ProjectRecord>;
  create(input: Readonly<{ name: string; root: string }>): Promise<ProjectRecord>;
  list(): Promise<readonly ProjectRecord[]>;
  get(projectId: string): Promise<ProjectRecord | undefined>;
  activate(projectId: string): Promise<ProjectRecord>;
  remove(projectId: string): Promise<boolean>;
  current(): Promise<ProjectRecord | undefined>;
}

export interface AgentApplication {
  readonly configuration: ProviderConfigurationService;
  readonly agent: AgentContract;
  readonly sessions: SessionManager;
  planHarness(prompt: string, overlay?: HarnessTaskOverlay): Promise<HarnessPlan>;
  loadResources(request?: Omit<ResourceLoadRequest, "projectRoot">): Promise<ResourceResolution>;
  inspectProject(options?: Readonly<{ refresh?: boolean }>): Promise<ProjectProfile>;
  diagnose(): Promise<DiagnosticReport>;
  providerPresets(): readonly ProviderPreset[];
  cacheStats(): Promise<CacheStats>;
  clearCache(namespace?: string): Promise<number>;
  close(): Promise<void>;
}
