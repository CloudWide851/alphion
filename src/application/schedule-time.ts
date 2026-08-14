import type { ScheduleExpression, ScheduleRecord } from "../domain/automation-contracts.js";
import { AlphionError } from "./errors.js";

const MINUTE_MS = 60_000;
const MAX_CRON_SCAN_MINUTES = 600_000;

export interface DueOccurrence { readonly dueAt: string; readonly nextRunAt?: string; readonly missedCount: number; }

export function nextScheduleOccurrence(expression: ScheduleExpression, timezone: string, after: Date): Date | undefined {
  validateTimezone(timezone);
  if (!Number.isFinite(after.getTime())) throw invalid("Schedule cursor is invalid.");
  if (expression.kind === "once") { const at = parseInstant(expression.at, "One-time schedule"); return at.getTime() > after.getTime() ? at : undefined; }
  if (expression.kind === "interval") {
    if (!Number.isSafeInteger(expression.everyMinutes) || expression.everyMinutes < 5) throw invalid("Schedule interval must be at least five minutes.");
    const anchor = expression.anchorAt ? parseInstant(expression.anchorAt, "Interval anchor") : new Date(after.getTime());
    const step = expression.everyMinutes * MINUTE_MS;
    const periods = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / step) + 1);
    return new Date(anchor.getTime() + periods * step);
  }
  const cron = parseCron(expression.expression);
  let cursor = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let index = 0; index < MAX_CRON_SCAN_MINUTES; index += 1) {
    if (matchesCron(cron, localParts(cursor, timezone))) return cursor;
    cursor = new Date(cursor.getTime() + MINUTE_MS);
  }
  throw new AlphionError("budget-exceeded", "No Cron occurrence was found within the bounded scan horizon.", { stage: "scheduler" });
}

export function assertScheduleCadence(expression: ScheduleExpression, timezone: string, now: Date): string {
  const first = nextScheduleOccurrence(expression, timezone, new Date(now.getTime() - 1));
  if (!first) throw invalid("Schedule has no future occurrence.");
  if (expression.kind === "cron") {
    const second = nextScheduleOccurrence(expression, timezone, first);
    if (second && second.getTime() - first.getTime() < 5 * MINUTE_MS) throw invalid("Cron schedules must be at least five minutes apart.");
  }
  return first.toISOString();
}

export function latestDueOccurrence(schedule: ScheduleRecord, now: Date): DueOccurrence | undefined {
  if (!schedule.nextRunAt) return undefined;
  const first = parseInstant(schedule.nextRunAt, "Stored next run");
  if (first.getTime() > now.getTime()) return undefined;
  if (schedule.expression.kind === "once") return Object.freeze({ dueAt: first.toISOString(), missedCount: 0 });
  if (schedule.expression.kind === "interval") {
    const step = schedule.expression.everyMinutes * MINUTE_MS;
    const missedCount = Math.max(0, Math.floor((now.getTime() - first.getTime()) / step));
    const due = new Date(first.getTime() + missedCount * step);
    return Object.freeze({ dueAt: due.toISOString(), nextRunAt: new Date(due.getTime() + step).toISOString(), missedCount });
  }
  let due = first;
  let next = nextScheduleOccurrence(schedule.expression, schedule.timezone, due);
  let missedCount = 0;
  for (let index = 0; next && next.getTime() <= now.getTime(); index += 1) {
    if (index >= MAX_CRON_SCAN_MINUTES) throw new AlphionError("budget-exceeded", "Cron missed-run calculation exceeded its bound.", { stage: "scheduler" });
    due = next; missedCount += 1; next = nextScheduleOccurrence(schedule.expression, schedule.timezone, due);
  }
  return Object.freeze({ dueAt: due.toISOString(), ...(next ? { nextRunAt: next.toISOString() } : {}), missedCount });
}

interface CronParts { readonly minutes: ReadonlySet<number>; readonly hours: ReadonlySet<number>; readonly days: ReadonlySet<number>; readonly months: ReadonlySet<number>; readonly weekdays: ReadonlySet<number>; readonly dayWildcard: boolean; readonly weekdayWildcard: boolean; }
interface LocalParts { readonly minute: number; readonly hour: number; readonly day: number; readonly month: number; readonly weekday: number; }

function parseCron(value: string): CronParts { const fields = value.trim().split(/\s+/u); if (fields.length !== 5) throw invalid("Cron expression must contain exactly five fields."); const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields; return Object.freeze({ minutes: parseField(minute, 0, 59), hours: parseField(hour, 0, 23), days: parseField(day, 1, 31), months: parseField(month, 1, 12), weekdays: parseField(weekday, 0, 6, true), dayWildcard: day === "*", weekdayWildcard: weekday === "*" }); }
function parseField(value: string, minimum: number, maximum: number, sundaySeven = false): ReadonlySet<number> { const result = new Set<number>(); for (const part of value.split(",")) { const [rangeText = "", stepText] = part.split("/"); const step = stepText === undefined ? 1 : Number(stepText); if (!Number.isSafeInteger(step) || step < 1) throw invalid("Cron step is invalid."); let start: number; let end: number; if (rangeText === "*") { start = minimum; end = maximum; } else if (rangeText.includes("-")) { const values = rangeText.split("-").map(Number); start = values[0] ?? -1; end = values[1] ?? -1; } else { start = Number(rangeText); end = start; } if (sundaySeven && start === 7) start = 0; if (sundaySeven && end === 7) end = 0; if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < minimum || start > maximum || end < minimum || end > maximum || end < start) throw invalid("Cron field is out of range."); for (let valueAt = start; valueAt <= end; valueAt += step) result.add(valueAt); } return result; }
function matchesCron(cron: CronParts, value: LocalParts): boolean { if (!cron.minutes.has(value.minute) || !cron.hours.has(value.hour) || !cron.months.has(value.month)) return false; const day = cron.days.has(value.day); const weekday = cron.weekdays.has(value.weekday); return cron.dayWildcard ? weekday : cron.weekdayWildcard ? day : day || weekday; }
function localParts(value: Date, timezone: string): LocalParts { const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(value); const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? ""; const weekdays: Readonly<Record<string, number>> = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }); const weekday = weekdays[field("weekday")]; if (weekday === undefined) throw invalid("Timezone weekday could not be resolved."); return { minute: Number(field("minute")), hour: Number(field("hour")), day: Number(field("day")), month: Number(field("month")), weekday }; }
function validateTimezone(value: string): void { if (!value || value.length > 100) throw invalid("IANA timezone is invalid."); try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0)); } catch (error) { throw new AlphionError("validation", "IANA timezone is invalid.", { stage: "scheduler", cause: error }); } }
function parseInstant(value: string, label: string): Date { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw invalid(`${label} timestamp is invalid.`); return result; }
function invalid(message: string): AlphionError { return new AlphionError("validation", message, { stage: "scheduler" }); }
