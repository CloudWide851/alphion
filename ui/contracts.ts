import type { AgentEvent, AgentSessionRecord, AgentStreamControlEvent, AttachmentImportInput, CompactionProjection, GoalRecord, ImageAttachmentRef, ProjectRecord, ScheduleExpression, SchedulePayload, ScheduleRecord, SessionMessageInput, SessionView } from "../src/index.js";
import { decodeSessionMessageInput } from "../src/application/attachments.js";

export type UiCommand =
  | Readonly<{ readonly kind: "surface.snapshot"; readonly selectedSessionId?: string }>
  | Readonly<{ readonly kind: "project.list" }>
  | Readonly<{ readonly kind: "project.create"; readonly root: string; readonly name?: string }>
  | Readonly<{ readonly kind: "project.inspect"; readonly refresh?: boolean }>
  | Readonly<{ readonly kind: "project.activate"; readonly projectId: string }>
  | Readonly<{ readonly kind: "session.list" }>
  | Readonly<{ readonly kind: "session.create"; readonly title: string; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.show"; readonly sessionId: string }>
  | Readonly<{ readonly kind: "session.send"; readonly sessionId: string; readonly message: string | SessionMessageInput; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.steer" | "session.follow-up"; readonly sessionId: string; readonly message: string | SessionMessageInput; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.checkout"; readonly sessionId: string; readonly entryId?: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.reshape"; readonly sessionId: string; readonly goal: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.fork"; readonly sessionId: string; readonly entryId?: string; readonly title?: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "session.compaction.list"; readonly sessionId: string; readonly limit?: number }>
  | Readonly<{ readonly kind: "session.compaction.show"; readonly sessionId: string; readonly compactionId: string }>
  | Readonly<{ readonly kind: "goal.list"; readonly includeArchived?: boolean }>
  | Readonly<{ readonly kind: "goal.get"; readonly goalId: string }>
  | Readonly<{ readonly kind: "goal.create"; readonly title: string; readonly rootGoal: string; readonly acceptanceCriteria: readonly string[]; readonly safetyConstraints?: readonly string[]; readonly providerId?: string; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "goal.update-root"; readonly goalId: string; readonly rootGoal: string; readonly acceptanceCriteria: readonly string[]; readonly safetyConstraints: readonly string[]; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "goal.progress"; readonly goalId: string; readonly progress: string; readonly subgoals?: readonly string[]; readonly nextStep?: string; readonly blockers?: readonly string[]; readonly evidenceIds: readonly string[]; readonly completionSuggested?: boolean; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "goal.confirm" | "goal.archive"; readonly goalId: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "goal.restore"; readonly goalId: string; readonly sourceRevision: number; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "schedule.list" }>
  | Readonly<{ readonly kind: "schedule.get"; readonly scheduleId: string }>
  | Readonly<{ readonly kind: "schedule.create"; readonly title: string; readonly expression: ScheduleExpression; readonly timezone: string; readonly payload: SchedulePayload; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "schedule.pause" | "schedule.resume" | "schedule.run-now"; readonly scheduleId: string; readonly expectedRevision: number; readonly idempotencyKey: string }>
  | Readonly<{ readonly kind: "schedule.executions"; readonly scheduleId: string; readonly limit?: number }>
  | Readonly<{ readonly kind: "provider.list" }>
  | Readonly<{ readonly kind: "provider.configure"; readonly profileId: string; readonly contextWindowTokens?: number; readonly vision: boolean }>
  | Readonly<{ readonly kind: "provider.test"; readonly profileId: string }>
  | Readonly<{ readonly kind: "provider.test-all" }>
  | Readonly<{ readonly kind: "resource.list" }>
  | Readonly<{ readonly kind: "doctor" }>
  | Readonly<{ readonly kind: "harness.plan"; readonly prompt: string }>
  | Readonly<{ readonly kind: "run.cancel"; readonly runId: string; readonly reason?: string }>;

export interface UiCommandEnvelope {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly command: UiCommand;
}

export interface UiCommandResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly status: "ok" | "accepted";
  readonly result: unknown;
}

export type UiInvalidationScope = "workspace" | "projects" | "sessions" | "session-view" | "compaction" | "goals" | "schedules";

export type UiEventPayload =
  | Readonly<{ readonly kind: "agent.event"; readonly event: AgentEvent | AgentStreamControlEvent }>
  | Readonly<{ readonly kind: "run.delta"; readonly runId: string; readonly sessionId: string; readonly delta: string }>
  | Readonly<{ readonly kind: "run.finished"; readonly runId: string; readonly sessionId: string; readonly status: string; readonly finalText: string }>
  | Readonly<{ readonly kind: "approval.challenge"; readonly requestId: string; readonly runId: string; readonly toolName: string; readonly actionDigest: string; readonly shapeDigest?: string; readonly summary: string }>
  | Readonly<{ readonly kind: "surface.invalidate"; readonly scopes: readonly UiInvalidationScope[]; readonly sessionIds: readonly string[] }>
  | Readonly<{ readonly kind: "stream.resync-required"; readonly cursor: number }>;

export interface UiEventEnvelope {
  readonly schemaVersion: 2;
  readonly cursor: number;
  readonly timestamp: string;
  readonly projectId?: string;
  readonly payload: UiEventPayload;
}

export interface UiEventFrame {
  readonly schemaVersion: 2;
  readonly cursorStart: number;
  readonly cursorEnd: number;
  readonly timestamp: string;
  readonly events: readonly UiEventEnvelope[];
}

export interface UiBackgroundRunSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface UiSurfaceSnapshot {
  readonly schemaVersion: 2;
  readonly cursor: number;
  readonly selectedProjectId: string;
  readonly project?: ProjectRecord;
  readonly projects: readonly ProjectRecord[];
  readonly sessions: readonly AgentSessionRecord[];
  readonly selectedSessionId?: string;
  readonly selectedView?: SessionView;
  readonly compaction?: CompactionProjection;
  readonly goals: readonly GoalRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly backgroundRuns: readonly UiBackgroundRunSummary[];
}

export interface UiCommandClient {
  execute(envelope: UiCommandEnvelope): Promise<UiCommandResult>;
  subscribe(afterCursor?: number): AsyncIterable<UiEventFrame>;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(input: Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean }>): void;
  close(): Promise<void>;
}

export interface UiAttachmentClient {
  importAttachment(input: AttachmentImportInput): Promise<ImageAttachmentRef>;
  readAttachment(attachmentId: string): Promise<Readonly<{ ref: ImageAttachmentRef; bytes: Uint8Array }>>;
}

export function decodeUiCommandEnvelope(value: unknown): UiCommandEnvelope {
  const envelope = record(value, "UI command envelope");
  exact(envelope, ["schemaVersion", "requestId", "command"]);
  if (envelope.schemaVersion !== 1 || !validId(envelope.requestId)) throw new Error("Unsupported UI command envelope.");
  return Object.freeze({ schemaVersion: 1, requestId: envelope.requestId, command: decodeCommand(envelope.command) });
}

export function decodeUiEventFrame(value: unknown): UiEventFrame {
  const frame = record(value, "UI event frame");
  exact(frame, ["schemaVersion", "cursorStart", "cursorEnd", "timestamp", "events"]);
  const cursorStart = nonnegativeInteger(frame.cursorStart); const cursorEnd = nonnegativeInteger(frame.cursorEnd);
  if (frame.schemaVersion !== 2 || cursorEnd < cursorStart || typeof frame.timestamp !== "string" || !Array.isArray(frame.events) || frame.events.length > 256) throw new Error("Unsupported UI event frame.");
  const events = frame.events.map(decodeUiEventEnvelope);
  if (events.length === 0 || events.at(-1)?.cursor !== cursorEnd || events.some((event, index) => event.cursor < cursorStart || event.cursor > cursorEnd || (index > 0 && event.cursor <= events[index - 1]!.cursor))) throw new Error("UI event frame cursor order is invalid.");
  return Object.freeze({ schemaVersion: 2, cursorStart, cursorEnd, timestamp: frame.timestamp, events: Object.freeze(events) });
}

export function decodeUiSurfaceSnapshot(value: unknown): UiSurfaceSnapshot {
  const snapshot = record(value, "UI surface snapshot");
  exact(snapshot, ["schemaVersion", "cursor", "selectedProjectId", "project", "projects", "sessions", "selectedSessionId", "selectedView", "compaction", "goals", "schedules", "backgroundRuns"]);
  if (snapshot.schemaVersion !== 2 || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.goals) || !Array.isArray(snapshot.schedules) || !Array.isArray(snapshot.backgroundRuns)) throw new Error("Unsupported UI surface snapshot.");
  const cursor = nonnegativeInteger(snapshot.cursor);
  const selectedSessionId = snapshot.selectedSessionId === undefined ? undefined : requiredText(snapshot.selectedSessionId);
  const backgroundRuns = snapshot.backgroundRuns.map(decodeBackgroundRun);
  return Object.freeze({ schemaVersion: 2, cursor, selectedProjectId: requiredText(snapshot.selectedProjectId), ...(snapshot.project === undefined ? {} : { project: snapshot.project as ProjectRecord }), projects: Object.freeze(snapshot.projects as ProjectRecord[]), sessions: Object.freeze(snapshot.sessions as AgentSessionRecord[]), ...(selectedSessionId ? { selectedSessionId } : {}), ...(snapshot.selectedView === undefined ? {} : { selectedView: snapshot.selectedView as SessionView }), ...(snapshot.compaction === undefined ? {} : { compaction: snapshot.compaction as CompactionProjection }), goals: Object.freeze(snapshot.goals as GoalRecord[]), schedules: Object.freeze(snapshot.schedules as ScheduleRecord[]), backgroundRuns: Object.freeze(backgroundRuns) });
}

function decodeUiEventEnvelope(value: unknown): UiEventEnvelope {
  const event = record(value, "UI event envelope");
  exact(event, ["schemaVersion", "cursor", "timestamp", "projectId", "payload"]);
  if (event.schemaVersion !== 2 || typeof event.timestamp !== "string") throw new Error("Unsupported UI event envelope.");
  const projectId = event.projectId === undefined ? undefined : requiredText(event.projectId);
  return Object.freeze({ schemaVersion: 2, cursor: nonnegativeInteger(event.cursor), timestamp: event.timestamp, ...(projectId ? { projectId } : {}), payload: decodeUiEventPayload(event.payload) });
}

function decodeUiEventPayload(value: unknown): UiEventPayload {
  const payload = record(value, "UI event payload");
  if (typeof payload.kind !== "string") throw new Error("UI event kind is required.");
  if (payload.kind === "run.delta") { exact(payload, ["kind", "runId", "sessionId", "delta"]); return Object.freeze({ kind: payload.kind, runId: requiredText(payload.runId), sessionId: requiredText(payload.sessionId), delta: boundedText(payload.delta) }); }
  if (payload.kind === "run.finished") { exact(payload, ["kind", "runId", "sessionId", "status", "finalText"]); return Object.freeze({ kind: payload.kind, runId: requiredText(payload.runId), sessionId: requiredText(payload.sessionId), status: requiredText(payload.status), finalText: boundedText(payload.finalText) }); }
  if (payload.kind === "stream.resync-required") { exact(payload, ["kind", "cursor"]); return Object.freeze({ kind: payload.kind, cursor: nonnegativeInteger(payload.cursor) }); }
  if (payload.kind === "surface.invalidate") { exact(payload, ["kind", "scopes", "sessionIds"]); const scopes = texts(payload.scopes) as readonly UiInvalidationScope[]; const allowed: readonly string[] = ["workspace", "projects", "sessions", "session-view", "compaction", "goals", "schedules"]; if (scopes.some((scope) => !allowed.includes(scope))) throw new Error("Unknown UI invalidation scope."); return Object.freeze({ kind: payload.kind, scopes, sessionIds: texts(payload.sessionIds) }); }
  if (payload.kind === "approval.challenge") { exact(payload, ["kind", "requestId", "runId", "toolName", "actionDigest", "shapeDigest", "summary"]); const shapeDigest = payload.shapeDigest === undefined ? undefined : requiredText(payload.shapeDigest); return Object.freeze({ kind: payload.kind, requestId: requiredText(payload.requestId), runId: requiredText(payload.runId), toolName: requiredText(payload.toolName), actionDigest: requiredText(payload.actionDigest), ...(shapeDigest ? { shapeDigest } : {}), summary: boundedText(payload.summary) }); }
  if (payload.kind === "agent.event") { exact(payload, ["kind", "event"]); const event = record(payload.event, "Agent event"); if (typeof event.kind !== "string" || typeof event.runId !== "string" || typeof event.sessionId !== "string") throw new Error("Agent event projection is invalid."); return Object.freeze({ kind: payload.kind, event: Object.freeze(event) as unknown as AgentEvent | AgentStreamControlEvent }); }
  throw new Error("Unknown UI event kind.");
}

function decodeBackgroundRun(value: unknown): UiBackgroundRunSummary {
  const run = record(value, "Background Run summary"); exact(run, ["projectId", "projectName", "sessionId", "runId", "title", "updatedAt"]);
  return Object.freeze({ projectId: requiredText(run.projectId), projectName: requiredText(run.projectName), sessionId: requiredText(run.sessionId), runId: requiredText(run.runId), title: requiredText(run.title), updatedAt: requiredText(run.updatedAt) });
}

function decodeCommand(value: unknown): UiCommand {
  const input = record(value, "UI command");
  if (typeof input.kind !== "string") throw new Error("UI command kind is required.");
  switch (input.kind) {
    case "project.list": case "session.list": case "provider.list": case "provider.test-all": case "resource.list": case "doctor": case "schedule.list":
      exact(input, ["kind"]); return Object.freeze({ kind: input.kind });
    case "provider.test": exact(input, ["kind", "profileId"]); return Object.freeze({ kind: input.kind, profileId: requiredText(input.profileId) });
    case "provider.configure": { exact(input, ["kind", "profileId", "contextWindowTokens", "vision"]); const contextWindowTokens = optionalInteger(input.contextWindowTokens, 4_096, 4_194_304); const vision = optionalBoolean(input.vision); if (vision === undefined) throw new Error("Provider vision capability is required."); return Object.freeze({ kind: input.kind, profileId: requiredText(input.profileId), ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }), vision }); }
    case "project.inspect": { exact(input, ["kind", "refresh"]); const refresh = optionalBoolean(input.refresh); return Object.freeze({ kind: input.kind, ...(refresh === undefined ? {} : { refresh }) }); }
    case "project.create": { exact(input, ["kind", "root", "name"]); const name = input.name === undefined ? undefined : requiredText(input.name); return Object.freeze({ kind: input.kind, root: requiredText(input.root), ...(name ? { name } : {}) }); }
    case "surface.snapshot": { exact(input, ["kind", "selectedSessionId"]); const selectedSessionId = input.selectedSessionId === undefined ? undefined : requiredText(input.selectedSessionId); return Object.freeze({ kind: input.kind, ...(selectedSessionId ? { selectedSessionId } : {}) }); }
    case "project.activate": exact(input, ["kind", "projectId"]); return Object.freeze({ kind: input.kind, projectId: requiredText(input.projectId) });
    case "session.create": exact(input, ["kind", "title", "idempotencyKey"]); return Object.freeze({ kind: input.kind, title: requiredText(input.title), idempotencyKey: commandKey(input.idempotencyKey) });
    case "session.show": exact(input, ["kind", "sessionId"]); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId) });
    case "session.send": case "session.steer": case "session.follow-up":
      exact(input, ["kind", "sessionId", "message", "expectedRevision", "idempotencyKey"]);
      return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), message: typeof input.message === "string" ? requiredText(input.message) : decodeSessionMessageInput(input.message), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "session.checkout": {
      exact(input, ["kind", "sessionId", "entryId", "expectedRevision", "idempotencyKey"]);
      const entryId = input.entryId === undefined ? undefined : requiredText(input.entryId);
      return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), ...(entryId ? { entryId } : {}), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    }
    case "session.reshape": exact(input, ["kind", "sessionId", "goal", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), goal: requiredText(input.goal), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "session.fork": { exact(input, ["kind", "sessionId", "entryId", "title", "expectedRevision", "idempotencyKey"]); const entryId = input.entryId === undefined ? undefined : requiredText(input.entryId); const title = input.title === undefined ? undefined : requiredText(input.title); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), ...(entryId ? { entryId } : {}), ...(title ? { title } : {}), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) }); }
    case "session.compaction.list": { exact(input, ["kind", "sessionId", "limit"]); const limit = optionalInteger(input.limit, 1, 500); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), ...(limit === undefined ? {} : { limit }) }); }
    case "session.compaction.show": exact(input, ["kind", "sessionId", "compactionId"]); return Object.freeze({ kind: input.kind, sessionId: requiredText(input.sessionId), compactionId: requiredText(input.compactionId) });
    case "goal.list": { exact(input, ["kind", "includeArchived"]); const includeArchived = optionalBoolean(input.includeArchived); return Object.freeze({ kind: input.kind, ...(includeArchived === undefined ? {} : { includeArchived }) }); }
    case "goal.get": exact(input, ["kind", "goalId"]); return Object.freeze({ kind: input.kind, goalId: requiredText(input.goalId) });
    case "goal.create": { exact(input, ["kind", "title", "rootGoal", "acceptanceCriteria", "safetyConstraints", "providerId", "idempotencyKey"]); const safetyConstraints = optionalTexts(input.safetyConstraints); const providerId = input.providerId === undefined ? undefined : requiredText(input.providerId); return Object.freeze({ kind: input.kind, title: requiredText(input.title), rootGoal: requiredText(input.rootGoal), acceptanceCriteria: texts(input.acceptanceCriteria), ...(safetyConstraints ? { safetyConstraints } : {}), ...(providerId ? { providerId } : {}), idempotencyKey: commandKey(input.idempotencyKey) }); }
    case "goal.update-root": exact(input, ["kind", "goalId", "rootGoal", "acceptanceCriteria", "safetyConstraints", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, goalId: requiredText(input.goalId), rootGoal: requiredText(input.rootGoal), acceptanceCriteria: texts(input.acceptanceCriteria), safetyConstraints: texts(input.safetyConstraints), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "goal.progress": { exact(input, ["kind", "goalId", "progress", "subgoals", "nextStep", "blockers", "evidenceIds", "completionSuggested", "expectedRevision", "idempotencyKey"]); const subgoals = optionalTexts(input.subgoals); const blockers = optionalTexts(input.blockers); const nextStep = input.nextStep === undefined ? undefined : requiredText(input.nextStep); const completionSuggested = optionalBoolean(input.completionSuggested); return Object.freeze({ kind: input.kind, goalId: requiredText(input.goalId), progress: requiredText(input.progress), ...(subgoals ? { subgoals } : {}), ...(nextStep ? { nextStep } : {}), ...(blockers ? { blockers } : {}), evidenceIds: texts(input.evidenceIds), ...(completionSuggested === undefined ? {} : { completionSuggested }), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) }); }
    case "goal.confirm": case "goal.archive": exact(input, ["kind", "goalId", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, goalId: requiredText(input.goalId), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "goal.restore": exact(input, ["kind", "goalId", "sourceRevision", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, goalId: requiredText(input.goalId), sourceRevision: integer(input.sourceRevision, 1, Number.MAX_SAFE_INTEGER), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "schedule.get": exact(input, ["kind", "scheduleId"]); return Object.freeze({ kind: input.kind, scheduleId: requiredText(input.scheduleId) });
    case "schedule.create": exact(input, ["kind", "title", "expression", "timezone", "payload", "idempotencyKey"]); return Object.freeze({ kind: input.kind, title: requiredText(input.title), expression: scheduleExpression(input.expression), timezone: requiredText(input.timezone), payload: schedulePayload(input.payload), idempotencyKey: commandKey(input.idempotencyKey) });
    case "schedule.pause": case "schedule.resume": case "schedule.run-now": exact(input, ["kind", "scheduleId", "expectedRevision", "idempotencyKey"]); return Object.freeze({ kind: input.kind, scheduleId: requiredText(input.scheduleId), expectedRevision: revision(input.expectedRevision), idempotencyKey: commandKey(input.idempotencyKey) });
    case "schedule.executions": { exact(input, ["kind", "scheduleId", "limit"]); const limit = optionalInteger(input.limit, 1, 500); return Object.freeze({ kind: input.kind, scheduleId: requiredText(input.scheduleId), ...(limit === undefined ? {} : { limit }) }); }
    case "harness.plan": exact(input, ["kind", "prompt"]); return Object.freeze({ kind: input.kind, prompt: requiredText(input.prompt) });
    case "run.cancel": {
      exact(input, ["kind", "runId", "reason"]); const reason = input.reason === undefined ? undefined : requiredText(input.reason);
      return Object.freeze({ kind: input.kind, runId: requiredText(input.runId), ...(reason ? { reason } : {}) });
    }
    default: throw new Error("Unknown UI command kind.");
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Readonly<Record<string, unknown>>; }
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown UI command field."); }
function requiredText(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 64 * 1024) throw new Error("A bounded non-empty string is required."); return value.trim(); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9:_-]{8,200}$/u.test(value); }
function commandKey(value: unknown): string { if (!validId(value)) throw new Error("A valid idempotency key is required."); return value; }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("A non-negative expected revision is required."); return value as number; }
function optionalBoolean(value: unknown): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== "boolean") throw new Error("A boolean is required."); return value; }
function texts(value: unknown): readonly string[] { if (!Array.isArray(value) || value.length > 128 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 8_000)) throw new Error("A bounded string array is required."); return Object.freeze(value.map((item) => (item as string).trim())); }
function optionalTexts(value: unknown): readonly string[] | undefined { return value === undefined ? undefined : texts(value); }
function integer(value: unknown, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error("A bounded integer is required."); return Number(value); }
function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined { return value === undefined ? undefined : integer(value, minimum, maximum); }
function nonnegativeInteger(value: unknown): number { return integer(value, 0, Number.MAX_SAFE_INTEGER); }
function boundedText(value: unknown): string { if (typeof value !== "string" || value.length > 1024 * 1024) throw new Error("A bounded string is required."); return value; }
function scheduleExpression(value: unknown): ScheduleExpression { const item = record(value, "Schedule expression"); if (item.kind === "once") { exact(item, ["kind", "at"]); return Object.freeze({ kind: "once", at: requiredText(item.at) }); } if (item.kind === "interval") { exact(item, ["kind", "everyMinutes", "anchorAt"]); const anchorAt = item.anchorAt === undefined ? undefined : requiredText(item.anchorAt); return Object.freeze({ kind: "interval", everyMinutes: integer(item.everyMinutes, 5, 525_600), ...(anchorAt ? { anchorAt } : {}) }); } if (item.kind === "cron") { exact(item, ["kind", "expression"]); return Object.freeze({ kind: "cron", expression: requiredText(item.expression) }); } throw new Error("Unknown schedule expression."); }
function schedulePayload(value: unknown): SchedulePayload { const item = record(value, "Schedule payload"); if (item.kind === "goal.review") { exact(item, ["kind", "goalId"]); return Object.freeze({ kind: "goal.review", goalId: requiredText(item.goalId) }); } if (item.kind === "session.prompt") { exact(item, ["kind", "sessionId", "prompt"]); return Object.freeze({ kind: "session.prompt", sessionId: requiredText(item.sessionId), prompt: requiredText(item.prompt) }); } throw new Error("Unknown schedule payload."); }
