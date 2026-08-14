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
  SessionForkReceipt,
  SessionForkRequest,
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
import type { CompactionProjection, CompactionRecord } from "../domain/compaction-contracts.js";
import type { SessionActivity } from "../domain/session-activity.js";
import type {
  GoalCreateRequest, GoalProgressRequest, GoalRecord, GoalRootUpdateRequest, GoalWriteReceipt,
  ScheduleClaim, ScheduleCreateRequest, ScheduleExecution, ScheduleRecord, ScheduleWriteOptions,
} from "../domain/automation-contracts.js";

export interface AgentProvider {
  readonly profile: ProviderProfile;
  generate(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ModelResolver {
  resolveModel(request: ModelSelectionRequest): Promise<AgentProvider>;
  describeModel?(provider: AgentProvider): Promise<ModelDescriptor | undefined>;
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
  readonly sessionId: string;
  readonly runId: string;
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
  forkSession(request: SessionForkRequest): Promise<SessionForkReceipt>;
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
  appendCompaction(record: CompactionRecord): Promise<void>;
  listCompactions(sessionId: string, limit?: number): Promise<readonly CompactionRecord[]>;
  getCompaction(compactionId: string): Promise<CompactionRecord | undefined>;
  getCompactionProjection(sessionId: string): Promise<CompactionProjection>;
}

export interface DeviceKeyProvider {
  load(): Promise<Uint8Array | undefined>;
  loadOrCreate(): Promise<Uint8Array>;
}

export interface AutomationStore {
  createGoal(request: GoalCreateRequest): Promise<GoalWriteReceipt>;
  listGoals(includeArchived?: boolean): Promise<readonly GoalRecord[]>;
  getGoal(goalId: string): Promise<GoalRecord | undefined>;
  updateGoalRoot(request: GoalRootUpdateRequest): Promise<GoalWriteReceipt>;
  appendGoalProgress(request: GoalProgressRequest): Promise<GoalWriteReceipt>;
  setGoalStatus(goalId: string, status: "completed" | "archived" | "active", expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt>;
  restoreGoalRevision(goalId: string, sourceRevision: number, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt>;
  createSchedule(request: ScheduleCreateRequest, nextRunAt: string): Promise<ScheduleRecord>;
  listSchedules(): Promise<readonly ScheduleRecord[]>;
  getSchedule(scheduleId: string): Promise<ScheduleRecord | undefined>;
  setScheduleStatus(scheduleId: string, status: "active" | "paused", options: ScheduleWriteOptions, nextRunAt?: string): Promise<ScheduleRecord>;
  claimSchedule(scheduleId: string, dueAt: string, nextRunAt: string | undefined, missedCount: number, owner: string, leaseExpiresAt: string, expectedRevision: number): Promise<ScheduleClaim | undefined>;
  claimScheduleNow(scheduleId: string, owner: string, leaseExpiresAt: string, options: ScheduleWriteOptions): Promise<ScheduleClaim>;
  updateScheduleExecution(executionId: string, status: ScheduleExecution["status"], details?: Readonly<{ runId?: string; reason?: string }>): Promise<ScheduleExecution>;
  listScheduleExecutions(scheduleId: string, limit?: number): Promise<readonly ScheduleExecution[]>;
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
  provision(): Promise<void>;
  importCredential(profileId: string, secret: string): Promise<ProviderProfile>;
  removeCredential(profileId: string): Promise<ProviderProfile>;
  reset(): Promise<number>;
  legacyStatus(): Promise<Readonly<{ disabled: boolean; secretCount: number }>>;
  resetLegacy(): Promise<number>;
}

export interface ProviderConfigurationService {
  listProfiles(): Promise<readonly ProviderProfile[]>;
  upsertProfile(profile: ProviderProfileInput): Promise<ProviderProfile>;
  activateProfile(idOrName: string): Promise<ProviderProfile>;
  vaultStatus(): Promise<VaultStatus>;
  provisionVault(): Promise<void>;
  importCredential(profileId: string, secret: string): Promise<ProviderProfile>;
  removeCredential(profileId: string): Promise<ProviderProfile>;
  resetVault(): Promise<number>;
  legacyVaultStatus(): Promise<Readonly<{ disabled: boolean; secretCount: number }>>;
  resetLegacyVault(): Promise<number>;
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
  fork(request: Omit<SessionForkRequest, "sourceSessionId">): Promise<SessionForkReceipt>;
  checkout(entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  send(content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle>;
  steer(content: string, options: SessionWriteOptions): Promise<SessionWriteReceipt>;
  followUp(content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt>;
  resumePending(approval: ApprovalPort): void;
  subscribe(afterSessionSequence?: number): AsyncIterable<AgentStreamEvent>;
  listCompactions(limit?: number): Promise<readonly CompactionRecord[]>;
  getCompaction(compactionId: string): Promise<CompactionRecord | undefined>;
  compactionProjection(): Promise<CompactionProjection>;
  /** Stops new work, cancels active runs, and drains all store-owning tasks. */
  close(): Promise<void>;
}

/** Project-scoped owner of all durable session workflows. */
export interface SessionManager {
  create(input?: Readonly<{ title?: string; providerId?: string; idempotencyKey?: string }>): Promise<AgentSessionContract>;
  fork(request: SessionForkRequest): Promise<SessionForkReceipt>;
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
  listCompactions(sessionId: string, limit?: number): Promise<readonly CompactionRecord[]>;
  getCompaction(sessionId: string, compactionId: string): Promise<CompactionRecord | undefined>;
  getCompactionProjection(sessionId: string): Promise<CompactionProjection>;
  /** Bounded live-only fan-out for Runs started by UI, collaboration, follow-up, or Scheduler. */
  subscribeActivity?(): AsyncIterable<SessionActivity>;
  /** Drains every materialized session before its backing store is closed. */
  close(): Promise<void>;
}

export interface GoalManager {
  create(request: GoalCreateRequest): Promise<GoalWriteReceipt>;
  list(includeArchived?: boolean): Promise<readonly GoalRecord[]>;
  get(goalId: string): Promise<GoalRecord>;
  updateRoot(request: GoalRootUpdateRequest): Promise<GoalWriteReceipt>;
  appendProgress(request: GoalProgressRequest): Promise<GoalWriteReceipt>;
  suggestCompletion(request: Omit<GoalProgressRequest, "completionSuggested">): Promise<GoalWriteReceipt>;
  confirmCompletion(goalId: string, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt>;
  archive(goalId: string, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt>;
  restoreRevision(goalId: string, sourceRevision: number, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt>;
}

export interface ScheduleManager {
  create(request: ScheduleCreateRequest): Promise<ScheduleRecord>;
  list(): Promise<readonly ScheduleRecord[]>;
  get(scheduleId: string): Promise<ScheduleRecord>;
  pause(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleRecord>;
  resume(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleRecord>;
  runNow(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleExecution>;
  executions(scheduleId: string, limit?: number): Promise<readonly ScheduleExecution[]>;
  start(): void;
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
  readonly goals: GoalManager;
  readonly schedules: ScheduleManager;
  planHarness(prompt: string, overlay?: HarnessTaskOverlay): Promise<HarnessPlan>;
  loadResources(request?: Omit<ResourceLoadRequest, "projectRoot">): Promise<ResourceResolution>;
  inspectProject(options?: Readonly<{ refresh?: boolean }>): Promise<ProjectProfile>;
  diagnose(): Promise<DiagnosticReport>;
  providerPresets(): readonly ProviderPreset[];
  cacheStats(): Promise<CacheStats>;
  clearCache(namespace?: string): Promise<number>;
  close(): Promise<void>;
}
