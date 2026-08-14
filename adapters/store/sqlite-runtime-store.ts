import type {
  GoalCreateRequest, GoalProgressRequest, GoalRecord, GoalRootUpdateRequest, GoalWriteReceipt,
  ScheduleClaim, ScheduleCreateRequest, ScheduleExecution, ScheduleRecord, ScheduleWriteOptions,
} from "../../src/domain/automation-contracts.js";
import type { AutomationStore } from "../../src/ports/index.js";
import {
  appendStoredGoalProgress, claimStoredSchedule, claimStoredScheduleNow, createStoredGoal, createStoredSchedule,
  getStoredGoal, getStoredSchedule, listStoredGoals, listStoredScheduleExecutions, listStoredSchedules,
  restoreStoredGoalRevision, setStoredGoalStatus, setStoredScheduleStatus, updateStoredGoalRoot, updateStoredScheduleExecution,
} from "./sqlite-automation-store.js";
import { SqliteStore } from "./sqlite-store.js";

export class SqliteRuntimeStore extends SqliteStore implements AutomationStore {
  async createGoal(request: GoalCreateRequest): Promise<GoalWriteReceipt> { return this.transaction(() => createStoredGoal(this.database, this.identity(), request)); }
  async listGoals(includeArchived?: boolean): Promise<readonly GoalRecord[]> { return listStoredGoals(this.database, this.identity(), includeArchived); }
  async getGoal(goalId: string): Promise<GoalRecord | undefined> { return getStoredGoal(this.database, goalId); }
  async updateGoalRoot(request: GoalRootUpdateRequest): Promise<GoalWriteReceipt> { return this.transaction(() => updateStoredGoalRoot(this.database, request)); }
  async appendGoalProgress(request: GoalProgressRequest): Promise<GoalWriteReceipt> { return this.transaction(() => appendStoredGoalProgress(this.database, request)); }
  async setGoalStatus(goalId: string, status: "completed" | "archived" | "active", expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt> { return this.transaction(() => setStoredGoalStatus(this.database, goalId, status, expectedRevision, idempotencyKey)); }
  async restoreGoalRevision(goalId: string, sourceRevision: number, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt> { return this.transaction(() => restoreStoredGoalRevision(this.database, goalId, sourceRevision, expectedRevision, idempotencyKey)); }
  async createSchedule(request: ScheduleCreateRequest, nextRunAt: string): Promise<ScheduleRecord> { return this.transaction(() => createStoredSchedule(this.database, this.identity(), request, nextRunAt)); }
  async listSchedules(): Promise<readonly ScheduleRecord[]> { return listStoredSchedules(this.database, this.identity()); }
  async getSchedule(scheduleId: string): Promise<ScheduleRecord | undefined> { return getStoredSchedule(this.database, scheduleId); }
  async setScheduleStatus(scheduleId: string, status: "active" | "paused", options: ScheduleWriteOptions, nextRunAt?: string): Promise<ScheduleRecord> { return this.transaction(() => setStoredScheduleStatus(this.database, scheduleId, status, options, nextRunAt)); }
  async claimSchedule(scheduleId: string, dueAt: string, nextRunAt: string | undefined, missedCount: number, owner: string, leaseExpiresAt: string, expectedRevision: number): Promise<ScheduleClaim | undefined> { return this.transaction(() => claimStoredSchedule(this.database, scheduleId, dueAt, nextRunAt, missedCount, owner, leaseExpiresAt, expectedRevision)); }
  async claimScheduleNow(scheduleId: string, owner: string, leaseExpiresAt: string, options: ScheduleWriteOptions): Promise<ScheduleClaim> { return this.transaction(() => claimStoredScheduleNow(this.database, scheduleId, owner, leaseExpiresAt, options)); }
  async updateScheduleExecution(executionId: string, status: ScheduleExecution["status"], details?: Readonly<{ runId?: string; reason?: string }>): Promise<ScheduleExecution> { return this.transaction(() => updateStoredScheduleExecution(this.database, executionId, status, details)); }
  async listScheduleExecutions(scheduleId: string, limit?: number): Promise<readonly ScheduleExecution[]> { return listStoredScheduleExecutions(this.database, scheduleId, limit); }
  private identity(): Readonly<{ projectId?: string; domainId: string }> { return Object.freeze({ ...(this.projectId ? { projectId: this.projectId } : {}), domainId: this.domainId }); }
}
