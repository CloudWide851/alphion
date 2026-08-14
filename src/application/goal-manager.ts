import type { GoalCreateRequest, GoalProgressRequest, GoalRecord, GoalRootUpdateRequest, GoalWriteReceipt } from "../domain/automation-contracts.js";
import type { AutomationStore, GoalManager } from "../ports/index.js";
import { AlphionError } from "./errors.js";

export class DefaultGoalManager implements GoalManager {
  constructor(private readonly store: AutomationStore, private readonly assertOpen: () => void) {}
  create(request: GoalCreateRequest): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.createGoal(request); }
  list(includeArchived?: boolean): Promise<readonly GoalRecord[]> { this.assertOpen(); return this.store.listGoals(includeArchived); }
  async get(goalId: string): Promise<GoalRecord> { this.assertOpen(); const goal = await this.store.getGoal(goalId); if (!goal) throw new AlphionError("validation", "Unknown Goal.", { stage: "goal" }); return goal; }
  updateRoot(request: GoalRootUpdateRequest): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.updateGoalRoot(request); }
  appendProgress(request: GoalProgressRequest): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.appendGoalProgress(request); }
  suggestCompletion(request: Omit<GoalProgressRequest, "completionSuggested">): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.appendGoalProgress({ ...request, completionSuggested: true }); }
  confirmCompletion(goalId: string, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.setGoalStatus(goalId, "completed", expectedRevision, idempotencyKey); }
  archive(goalId: string, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.setGoalStatus(goalId, "archived", expectedRevision, idempotencyKey); }
  restoreRevision(goalId: string, sourceRevision: number, expectedRevision: number, idempotencyKey: string): Promise<GoalWriteReceipt> { this.assertOpen(); return this.store.restoreGoalRevision(goalId, sourceRevision, expectedRevision, idempotencyKey); }
}
