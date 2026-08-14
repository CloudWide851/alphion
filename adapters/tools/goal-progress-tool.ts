import { AlphionError } from "../../src/application/errors.js";
import type { GoalManager, ToolExecutor } from "../../src/ports/index.js";

export class GoalProgressTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "goal.progress",
    description: "Append Evidence-backed progress to the Goal owned by the current dedicated Session. Root Goal and acceptance criteria cannot be changed.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        goalId: Object.freeze({ type: "string", minLength: 1, maxLength: 200 }),
        progress: Object.freeze({ type: "string", minLength: 1, maxLength: 8_000 }),
        subgoals: Object.freeze({ type: "array", items: Object.freeze({ type: "string", minLength: 1, maxLength: 2_000 }), maxItems: 64 }),
        nextStep: Object.freeze({ type: "string", minLength: 1, maxLength: 4_000 }),
        blockers: Object.freeze({ type: "array", items: Object.freeze({ type: "string", minLength: 1, maxLength: 2_000 }), maxItems: 64 }),
        evidenceIds: Object.freeze({ type: "array", items: Object.freeze({ type: "string", minLength: 1, maxLength: 200 }), minItems: 1, maxItems: 64 }),
        completionSuggested: Object.freeze({ type: "boolean" }),
        expectedRevision: Object.freeze({ type: "integer", minimum: 1 }),
        idempotencyKey: Object.freeze({ type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }),
      }),
      required: Object.freeze(["goalId", "progress", "evidenceIds", "expectedRevision", "idempotencyKey"]),
      additionalProperties: false,
    }),
    risk: "write",
    cachePolicy: "none",
    executionMode: "serial",
    sideEffect: "write",
    idempotent: true,
    approval: "never",
    timeoutMs: 10_000,
  } as const);

  constructor(private readonly goals: GoalManager) {}

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    const receipt = await this.goals.appendProgress({
      goalId: text(input.goalId, "goalId"),
      progress: text(input.progress, "progress"),
      evidenceIds: texts(input.evidenceIds, "evidenceIds"),
      expectedRevision: integer(input.expectedRevision, "expectedRevision"),
      idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
      actor: "agent",
      actorSessionId: context.sessionId,
      actorRunId: context.runId,
      ...(input.subgoals ? { subgoals: texts(input.subgoals, "subgoals") } : {}),
      ...(input.nextStep ? { nextStep: text(input.nextStep, "nextStep") } : {}),
      ...(input.blockers ? { blockers: texts(input.blockers, "blockers") } : {}),
      ...(typeof input.completionSuggested === "boolean" ? { completionSuggested: input.completionSuggested } : {}),
    });
    return { content: `Goal ${receipt.goal.id} advanced to revision ${receipt.goal.revision}${receipt.goal.current.completionSuggested ? "; completion remains a user decision" : ""}.`, isError: false };
  }
}

function text(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw invalid(label); return value.trim(); }
function texts(value: unknown, label: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw invalid(label); return Object.freeze(value.map((item) => (item as string).trim())); }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(label); return Number(value); }
function invalid(label: string): AlphionError { return new AlphionError("validation", `${label} is invalid.`, { stage: "tool:goal.progress" }); }
