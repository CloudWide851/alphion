import type { ScheduleClaim, ScheduleCreateRequest, ScheduleExecution, ScheduleRecord, ScheduleWriteOptions } from "../domain/automation-contracts.js";
import type { AgentRunHandle, ApprovalPort, AutomationStore, GoalManager, ScheduleManager, SessionManager } from "../ports/index.js";
import { createId } from "./canonical.js";
import { AlphionError } from "./errors.js";
import { assertScheduleCadence, latestDueOccurrence, nextScheduleOccurrence } from "./schedule-time.js";

const DEFAULT_SCAN_MS = 30_000;
const LEASE_MS = 10 * 60_000;
const DENY_UNATTENDED: ApprovalPort = Object.freeze({ revision: "scheduler-unattended-deny-v1", requestApproval: () => Promise.resolve(Object.freeze({ approved: false, reason: "Scheduled work has no interactive approval client." })) });

export interface DefaultScheduleManagerOptions {
  readonly store: AutomationStore;
  readonly sessions: SessionManager;
  readonly goals: GoalManager;
  readonly assertOpen: () => void;
  readonly enabled?: boolean;
  readonly scanIntervalMs?: number;
  readonly now?: () => Date;
}

export class DefaultScheduleManager implements ScheduleManager {
  readonly #owner = createId("scheduler");
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #handles = new Set<AgentRunHandle>();
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  constructor(private readonly options: DefaultScheduleManagerOptions) { this.#now = options.now ?? (() => new Date()); }

  async create(request: ScheduleCreateRequest): Promise<ScheduleRecord> {
    this.options.assertOpen();
    await this.#validatePayload(request);
    const nextRunAt = assertScheduleCadence(request.expression, request.timezone, this.#now());
    return this.options.store.createSchedule(request, nextRunAt);
  }
  list(): Promise<readonly ScheduleRecord[]> { this.options.assertOpen(); return this.options.store.listSchedules(); }
  async get(scheduleId: string): Promise<ScheduleRecord> { this.options.assertOpen(); const value = await this.options.store.getSchedule(scheduleId); if (!value) throw new AlphionError("validation", "Unknown schedule.", { stage: "scheduler" }); return value; }
  pause(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleRecord> { this.options.assertOpen(); return this.options.store.setScheduleStatus(scheduleId, "paused", options); }
  async resume(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleRecord> { this.options.assertOpen(); const schedule = await this.get(scheduleId); const next = nextScheduleOccurrence(schedule.expression, schedule.timezone, this.#now()); if (!next) throw new AlphionError("conflict", "Schedule has no future occurrence.", { stage: "scheduler" }); return this.options.store.setScheduleStatus(scheduleId, "active", options, next.toISOString()); }
  executions(scheduleId: string, limit?: number): Promise<readonly ScheduleExecution[]> { this.options.assertOpen(); return this.options.store.listScheduleExecutions(scheduleId, limit); }

  async runNow(scheduleId: string, options: ScheduleWriteOptions): Promise<ScheduleExecution> {
    this.options.assertOpen();
    const claim = await this.options.store.claimScheduleNow(scheduleId, this.#owner, new Date(this.#now().getTime() + LEASE_MS).toISOString(), options);
    if (!claim.replayed) this.#own(this.#dispatch(claim));
    return claim.execution;
  }

  start(): void {
    if (this.#closed || this.#timer || this.options.enabled === false) return;
    const scanMs = this.options.scanIntervalMs ?? DEFAULT_SCAN_MS;
    if (!Number.isSafeInteger(scanMs) || scanMs < 1_000) throw new AlphionError("validation", "Scheduler scan interval is invalid.", { stage: "scheduler" });
    this.#own(this.#scan());
    this.#timer = setInterval(() => this.#own(this.#scan()), scanMs);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const handle of this.#handles) handle.cancel("Scheduler is closing.");
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  async #scan(): Promise<void> {
    if (this.#closed) return;
    const now = this.#now();
    const schedules = (await this.options.store.listSchedules()).filter((item) => item.status === "active" && item.nextRunAt && Date.parse(item.nextRunAt) <= now.getTime()).slice(0, 16);
    if (this.#closed) return;
    for (const schedule of schedules) {
      if (this.#closed) return;
      const due = latestDueOccurrence(schedule, now);
      if (!due) continue;
      const claim = await this.options.store.claimSchedule(schedule.id, due.dueAt, due.nextRunAt, due.missedCount, this.#owner, new Date(now.getTime() + LEASE_MS).toISOString(), schedule.revision).catch((error) => {
        if (error instanceof AlphionError && error.code === "conflict") return undefined;
        throw error;
      });
      if (claim) this.#own(this.#dispatch(claim));
    }
  }

  async #dispatch(claim: ScheduleClaim): Promise<void> {
    let handle: AgentRunHandle | undefined;
    try {
      const prompt = await this.#prompt(claim.schedule);
      const sessionId = claim.schedule.payload.kind === "goal.review" ? (await this.options.goals.get(claim.schedule.payload.goalId)).sessionId : claim.schedule.payload.sessionId;
      const session = await this.options.sessions.get(sessionId);
      const record = await session.get();
      if (this.#closed) throw new AlphionError("cancelled", "Scheduler is closing.", { stage: "scheduler" });
      if (record.status === "running") {
        await session.followUp(prompt, { expectedRevision: record.revision, idempotencyKey: `schedule:${claim.execution.id}:follow-up` }, DENY_UNATTENDED);
        await this.options.store.updateScheduleExecution(claim.execution.id, "queued", { reason: "durable-follow-up-queued" });
        return;
      }
      handle = await session.send(prompt, { expectedRevision: record.revision, idempotencyKey: `schedule:${claim.execution.id}:send` }, DENY_UNATTENDED);
      this.#handles.add(handle);
      if (this.#closed) handle.cancel("Scheduler is closing.");
      await this.options.store.updateScheduleExecution(claim.execution.id, "running", { runId: handle.runId });
      const result = await handle.result;
      await this.options.store.updateScheduleExecution(claim.execution.id, result.status === "completed" ? "completed" : "failed", { runId: handle.runId, ...(result.errorCode ? { reason: result.errorCode } : {}) });
    } catch (error) {
      handle?.cancel("Scheduled execution failed.");
      const reason = error instanceof AlphionError ? `${error.code}:${error.reason ?? error.stage}` : "internal";
      await this.options.store.updateScheduleExecution(claim.execution.id, "failed", { ...(handle ? { runId: handle.runId } : {}), reason }).catch(() => undefined);
    } finally { if (handle) this.#handles.delete(handle); }
  }

  async #prompt(schedule: ScheduleRecord): Promise<string> {
    if (schedule.payload.kind === "session.prompt") return schedule.payload.prompt;
    const goal = await this.options.goals.get(schedule.payload.goalId);
    return `Review Goal ${goal.title}. Root goal: ${goal.current.rootGoal}\nAcceptance criteria:\n${goal.current.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\nCurrent progress: ${goal.current.progress || "none"}\nIdentify Evidence-backed progress, blockers, and the next step. You may suggest completion but must not confirm it.`;
  }

  async #validatePayload(request: ScheduleCreateRequest): Promise<void> {
    if (request.payload.kind === "goal.review") { await this.options.goals.get(request.payload.goalId); return; }
    const session = await this.options.sessions.get(request.payload.sessionId);
    const record = await session.get();
    if (record.auditOnly) throw new AlphionError("forbidden", "Schedules cannot target an audit-only Session.", { stage: "scheduler" });
    if (!request.payload.prompt.trim() || request.payload.prompt.length > 16_384) throw new AlphionError("validation", "Scheduled Session prompt must contain 1-16384 characters.", { stage: "scheduler" });
  }

  #own(task: Promise<unknown>): void { this.#tasks.add(task); void task.finally(() => this.#tasks.delete(task)).catch(() => undefined); }
}
