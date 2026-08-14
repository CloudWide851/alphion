export type GoalStatus = "active" | "completed" | "archived";
export type GoalRevisionActor = "user" | "agent" | "restore";

export interface GoalRevision {
  readonly schemaVersion: 1;
  readonly goalId: string;
  readonly revision: number;
  readonly parentRevision?: number;
  readonly actor: GoalRevisionActor;
  readonly rootGoal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly safetyConstraints: readonly string[];
  readonly progress: string;
  readonly subgoals: readonly string[];
  readonly nextStep?: string;
  readonly blockers: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly completionSuggested: boolean;
  readonly createdAt: string;
  readonly digest: string;
}

export interface GoalRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly domainId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly current: GoalRevision;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface GoalCreateRequest {
  readonly title: string;
  readonly rootGoal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly safetyConstraints?: readonly string[];
  readonly providerId?: string;
  readonly idempotencyKey: string;
}

export interface GoalRootUpdateRequest {
  readonly goalId: string;
  readonly rootGoal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly safetyConstraints: readonly string[];
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface GoalProgressRequest {
  readonly goalId: string;
  readonly progress: string;
  readonly subgoals?: readonly string[];
  readonly nextStep?: string;
  readonly blockers?: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly completionSuggested?: boolean;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly actor: "user" | "agent";
  readonly actorSessionId?: string;
  readonly actorRunId?: string;
}

export interface GoalWriteReceipt {
  readonly goal: GoalRecord;
  readonly replayed: boolean;
}

export type ScheduleExpression = Readonly<
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "interval"; readonly everyMinutes: number; readonly anchorAt?: string }
  | { readonly kind: "cron"; readonly expression: string }
>;

export type SchedulePayload = Readonly<
  | { readonly kind: "goal.review"; readonly goalId: string }
  | { readonly kind: "session.prompt"; readonly sessionId: string; readonly prompt: string }
>;

export type ScheduleStatus = "active" | "paused" | "completed";
export type ScheduleExecutionStatus = "claimed" | "running" | "queued" | "completed" | "failed" | "skipped";

export interface ScheduleRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly domainId: string;
  readonly title: string;
  readonly expression: ScheduleExpression;
  readonly timezone: string;
  readonly payload: SchedulePayload;
  readonly status: ScheduleStatus;
  readonly revision: number;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleExecution {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scheduleId: string;
  readonly dueAt: string;
  readonly status: ScheduleExecutionStatus;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly runId?: string;
  readonly missedCount: number;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleCreateRequest {
  readonly title: string;
  readonly expression: ScheduleExpression;
  readonly timezone: string;
  readonly payload: SchedulePayload;
  readonly idempotencyKey: string;
}

export interface ScheduleWriteOptions {
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface ScheduleClaim {
  readonly schedule: ScheduleRecord;
  readonly execution: ScheduleExecution;
  readonly replayed: boolean;
}
