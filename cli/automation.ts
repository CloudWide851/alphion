import { AlphionError } from "../src/application/errors.js";
import type { ScheduleExpression, SchedulePayload } from "../src/domain/automation-contracts.js";
import type { LocalAlphionApplication } from "../adapters/local/local-application.js";

export interface AutomationCliArguments {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

export async function automationCommand(group: string, command: string | undefined, parsed: AutomationCliArguments, application: LocalAlphionApplication): Promise<number> {
  if (group === "context") return contextCommand(command, parsed, application);
  if (group === "goal") return goalCommand(command, parsed, application);
  if (group === "schedule") return scheduleCommand(command, parsed, application);
  throw new AlphionError("validation", "Unknown automation command.", { stage: "cli" });
}

async function contextCommand(command: string | undefined, parsed: AutomationCliArguments, application: LocalAlphionApplication): Promise<number> {
  const sessionId = requiredPosition(parsed, 2, `context ${command ?? "command"} requires SESSION_ID.`);
  if (command === "list") return output(await application.sessions.listCompactions(sessionId, optionalInteger(parsed, "limit")));
  if (command === "show") {
    const compactionId = requiredPosition(parsed, 3, "context show requires COMPACTION_ID.");
    return output(await application.sessions.getCompaction(sessionId, compactionId) ?? null);
  }
  throw new AlphionError("validation", "context command must be list or show.", { stage: "cli" });
}

async function goalCommand(command: string | undefined, parsed: AutomationCliArguments, application: LocalAlphionApplication): Promise<number> {
  if (command === "list") return output(await application.goals.list(hasFlag(parsed, "archived")));
  if (command === "create") {
    const providerId = flagValue(parsed, "provider");
    return output(await application.goals.create({
      title: requiredFlag(parsed, "title"), rootGoal: requiredFlag(parsed, "root"), acceptanceCriteria: requiredMany(parsed, "acceptance"),
      ...(parsed.flags.has("safety") ? { safetyConstraints: parsed.flags.get("safety") ?? [] } : {}),
      ...(providerId ? { providerId } : {}), idempotencyKey: commandKey(parsed, "goal-create"),
    }));
  }
  const goalId = requiredPosition(parsed, 2, `goal ${command ?? "command"} requires GOAL_ID.`);
  if (command === "show") return output(await application.goals.get(goalId));
  const goal = await application.goals.get(goalId);
  const expectedRevision = integerFlag(parsed, "revision", goal.revision);
  const idempotencyKey = commandKey(parsed, `goal-${command}`);
  if (command === "update") return output(await application.goals.updateRoot({ goalId, rootGoal: requiredFlag(parsed, "root"), acceptanceCriteria: requiredMany(parsed, "acceptance"), safetyConstraints: parsed.flags.get("safety") ?? goal.current.safetyConstraints, expectedRevision, idempotencyKey }));
  if (command === "progress") { const nextStep = flagValue(parsed, "next"); return output(await application.goals.appendProgress({ goalId, progress: requiredFlag(parsed, "progress"), evidenceIds: parsed.flags.get("evidence")?.filter((value) => value !== "true") ?? [], actor: "user", ...(parsed.flags.has("subgoal") ? { subgoals: parsed.flags.get("subgoal") ?? [] } : {}), ...(nextStep ? { nextStep } : {}), ...(parsed.flags.has("blocker") ? { blockers: parsed.flags.get("blocker") ?? [] } : {}), ...(hasFlag(parsed, "suggest-completion") ? { completionSuggested: true } : {}), expectedRevision, idempotencyKey })); }
  if (command === "confirm") return output(await application.goals.confirmCompletion(goalId, expectedRevision, idempotencyKey));
  if (command === "archive") return output(await application.goals.archive(goalId, expectedRevision, idempotencyKey));
  if (command === "restore") return output(await application.goals.restoreRevision(goalId, integerFlag(parsed, "source-revision"), expectedRevision, idempotencyKey));
  throw new AlphionError("validation", "goal command must be create, list, show, update, progress, confirm, archive, or restore.", { stage: "cli" });
}

async function scheduleCommand(command: string | undefined, parsed: AutomationCliArguments, application: LocalAlphionApplication): Promise<number> {
  if (command === "list") return output(await application.schedules.list());
  if (command === "create") return output(await application.schedules.create({ title: requiredFlag(parsed, "title"), expression: scheduleExpression(parsed), timezone: flagValue(parsed, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone, payload: schedulePayload(parsed), idempotencyKey: commandKey(parsed, "schedule-create") }));
  const scheduleId = requiredPosition(parsed, 2, `schedule ${command ?? "command"} requires SCHEDULE_ID.`);
  if (command === "show") return output(await application.schedules.get(scheduleId));
  if (command === "executions") return output(await application.schedules.executions(scheduleId, optionalInteger(parsed, "limit")));
  const schedule = await application.schedules.get(scheduleId);
  const options = { expectedRevision: integerFlag(parsed, "revision", schedule.revision), idempotencyKey: commandKey(parsed, `schedule-${command}`) };
  if (command === "pause") return output(await application.schedules.pause(scheduleId, options));
  if (command === "resume") return output(await application.schedules.resume(scheduleId, options));
  if (command === "run-now") return output(await application.schedules.runNow(scheduleId, options));
  throw new AlphionError("validation", "schedule command must be create, list, show, pause, resume, run-now, or executions.", { stage: "cli" });
}

function scheduleExpression(parsed: AutomationCliArguments): ScheduleExpression {
  const once = flagValue(parsed, "once"); const interval = flagValue(parsed, "interval-minutes"); const cron = flagValue(parsed, "cron");
  if ([once, interval, cron].filter(Boolean).length !== 1) throw new AlphionError("validation", "Exactly one of --once, --interval-minutes, or --cron is required.", { stage: "cli" });
  if (once) return Object.freeze({ kind: "once", at: once });
  if (interval) return Object.freeze({ kind: "interval", everyMinutes: integerValue(interval, "--interval-minutes") });
  return Object.freeze({ kind: "cron", expression: cron! });
}

function schedulePayload(parsed: AutomationCliArguments): SchedulePayload {
  const goalId = flagValue(parsed, "goal"); const sessionId = flagValue(parsed, "session");
  if (goalId && !sessionId) return Object.freeze({ kind: "goal.review", goalId });
  if (sessionId && !goalId) return Object.freeze({ kind: "session.prompt", sessionId, prompt: requiredFlag(parsed, "prompt") });
  throw new AlphionError("validation", "Use either --goal GOAL_ID or --session SESSION_ID with --prompt.", { stage: "cli" });
}

function flagValue(parsed: AutomationCliArguments, name: string): string | undefined { const value = parsed.flags.get(name)?.at(-1); return value && value !== "true" ? value : undefined; }
function hasFlag(parsed: AutomationCliArguments, name: string): boolean { return parsed.flags.has(name); }
function requiredFlag(parsed: AutomationCliArguments, name: string): string { const value = flagValue(parsed, name); if (!value) throw new AlphionError("validation", `--${name} is required.`, { stage: "cli" }); return value; }
function requiredMany(parsed: AutomationCliArguments, name: string): readonly string[] { const values = parsed.flags.get(name)?.filter((value) => value !== "true") ?? []; if (!values.length) throw new AlphionError("validation", `At least one --${name} is required.`, { stage: "cli" }); return values; }
function requiredPosition(parsed: AutomationCliArguments, index: number, message: string): string { const value = parsed.positionals[index]; if (!value) throw new AlphionError("validation", message, { stage: "cli" }); return value; }
function optionalInteger(parsed: AutomationCliArguments, name: string): number | undefined { const value = flagValue(parsed, name); return value ? integerValue(value, `--${name}`) : undefined; }
function integerFlag(parsed: AutomationCliArguments, name: string, fallback?: number): number { const value = flagValue(parsed, name); if (!value && fallback !== undefined) return fallback; if (!value) throw new AlphionError("validation", `--${name} is required.`, { stage: "cli" }); return integerValue(value, `--${name}`); }
function integerValue(value: string, label: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AlphionError("validation", `${label} must be a positive integer.`, { stage: "cli" }); return parsed; }
function commandKey(parsed: AutomationCliArguments, action: string): string { return flagValue(parsed, "idempotency-key") ?? `cli:${action}:${process.pid}:${Date.now()}`; }
function output(value: unknown): number { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return 0; }
