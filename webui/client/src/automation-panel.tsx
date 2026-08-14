import React, { useRef, useState } from "react";
import type { CompactionProjection, GoalRecord, ScheduleRecord } from "../../../src/index.js";
import type { SurfaceClient } from "./surface-client.js";

export interface AutomationPanelProps {
  readonly client: SurfaceClient;
  readonly sessionId?: string;
  readonly compaction?: CompactionProjection;
  readonly goals: readonly GoalRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly sessions: readonly Readonly<{ id: string; status: string }>[];
  readonly reload: () => void;
}

export function AutomationPanel(props: AutomationPanelProps): React.JSX.Element {
  const [detail, setDetail] = useState("");
  const root = useRef<HTMLInputElement>(null);
  const acceptance = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const scheduleTitle = useRef<HTMLInputElement>(null); const scheduleKind = useRef<HTMLSelectElement>(null); const scheduleValue = useRef<HTMLInputElement>(null);
  const scheduleTarget = useRef<HTMLSelectElement>(null); const scheduleTargetId = useRef<HTMLInputElement>(null); const schedulePrompt = useRef<HTMLInputElement>(null);
  const safely = async (action: () => Promise<void>, success?: string): Promise<void> => {
    try { await action(); if (success) setDetail(success); }
    catch (error) { setDetail(safeError(error)); }
  };
  const createGoal = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const rootGoal = root.current?.value.trim() ?? "";
    const criteria = acceptance.current?.value.split(";").map((item) => item.trim()).filter(Boolean) ?? [];
    if (!rootGoal || criteria.length === 0) { setDetail("根目标和至少一条验收条件为必填。"); return; }
    await safely(async () => {
      await props.client.execute({ kind: "goal.create", title: title.current?.value.trim() || rootGoal.slice(0, 80), rootGoal, acceptanceCriteria: criteria, idempotencyKey: id("goal") });
      if (root.current) root.current.value = ""; if (acceptance.current) acceptance.current.value = ""; if (title.current) title.current.value = "";
      props.reload();
    }, "Goal 已创建。");
  };
  const showContext = async (): Promise<void> => {
    if (!props.sessionId) { setDetail("当前没有 Session。"); return; }
    await safely(async () => { const result = await props.client.execute({ kind: "session.compaction.list", sessionId: props.sessionId!, limit: 20 }); setDetail(JSON.stringify(result.result, null, 2)); });
  };
  const goalAction = async (goal: GoalRecord, action: "confirm" | "archive"): Promise<void> => safely(async () => { await props.client.execute({ kind: action === "confirm" ? "goal.confirm" : "goal.archive", goalId: goal.id, expectedRevision: goal.revision, idempotencyKey: id(`goal-${action}`) }); props.reload(); }, action === "confirm" ? "Goal 已确认完成。" : "Goal 已归档。");
  const updateGoal = async (goal: GoalRecord): Promise<void> => { const rootGoal = prompt("新的根目标", goal.current.rootGoal)?.trim(); if (!rootGoal) return; const criteria = prompt("验收条件（使用分号分隔）", goal.current.acceptanceCriteria.join(";"))?.split(";").map((item) => item.trim()).filter(Boolean); if (!criteria?.length) return; await safely(async () => { await props.client.execute({ kind: "goal.update-root", goalId: goal.id, rootGoal, acceptanceCriteria: criteria, safetyConstraints: goal.current.safetyConstraints, expectedRevision: goal.revision, idempotencyKey: id("goal-root") }); props.reload(); }, "Goal 根目标已更新。"); };
  const progressGoal = async (goal: GoalRecord): Promise<void> => { const progress = prompt("追加 Goal 进度")?.trim(); if (!progress) return; await safely(async () => { await props.client.execute({ kind: "goal.progress", goalId: goal.id, progress, evidenceIds: [], expectedRevision: goal.revision, idempotencyKey: id("goal-progress") }); props.reload(); }, "Goal 进度已追加。"); };
  const restoreGoal = async (goal: GoalRecord): Promise<void> => { const value = Number(prompt("要恢复的 revision")); if (!Number.isSafeInteger(value) || value < 1) return; await safely(async () => { await props.client.execute({ kind: "goal.restore", goalId: goal.id, sourceRevision: value, expectedRevision: goal.revision, idempotencyKey: id("goal-restore") }); props.reload(); }, `已追加基于 revision ${value} 的恢复版本。`); };
  const createReview = async (goal: GoalRecord): Promise<void> => safely(async () => { const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; await props.client.execute({ kind: "schedule.create", title: `${goal.title} · 每日复盘`, expression: { kind: "interval", everyMinutes: 1_440 }, timezone, payload: { kind: "goal.review", goalId: goal.id }, idempotencyKey: id("schedule") }); props.reload(); }, "每日 Goal 复盘已创建。");
  const scheduleAction = async (schedule: ScheduleRecord, action: "pause" | "resume" | "run-now"): Promise<void> => safely(async () => { await props.client.execute({ kind: `schedule.${action}` as "schedule.pause" | "schedule.resume" | "schedule.run-now", scheduleId: schedule.id, expectedRevision: schedule.revision, idempotencyKey: id(`schedule-${action}`) }); props.reload(); }, action === "run-now" ? "Schedule 已受理。" : `Schedule 已${action === "pause" ? "暂停" : "恢复"}。`);
  const createSchedule = async (event: React.FormEvent): Promise<void> => { event.preventDefault(); const kind = scheduleKind.current?.value ?? "interval"; const value = scheduleValue.current?.value.trim() ?? ""; const expression = kind === "once" ? { kind: "once" as const, at: value } : kind === "cron" ? { kind: "cron" as const, expression: value } : { kind: "interval" as const, everyMinutes: Number(value) }; const target = scheduleTarget.current?.value ?? "goal"; const targetId = scheduleTargetId.current?.value.trim() || (target === "goal" ? props.goals[0]?.id : props.sessionId); if (!targetId) { setDetail("请选择有效的 Goal 或 Session。"); return; } const payload = target === "goal" ? { kind: "goal.review" as const, goalId: targetId } : { kind: "session.prompt" as const, sessionId: targetId, prompt: schedulePrompt.current?.value.trim() ?? "" }; await safely(async () => { await props.client.execute({ kind: "schedule.create", title: scheduleTitle.current?.value.trim() || "计划任务", expression, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", payload, idempotencyKey: id("schedule") }); props.reload(); }, "Schedule 已创建。"); };
  const showExecutions = async (schedule: ScheduleRecord): Promise<void> => safely(async () => { const result = await props.client.execute({ kind: "schedule.executions", scheduleId: schedule.id, limit: 50 }); setDetail(JSON.stringify(result.result, null, 2)); });
  return <section className="automation-panel">
    <div className="automation-row"><strong>上下文</strong><span>{props.compaction?.count ? `已优化 ${props.compaction.count} 次 · 最近 ${props.compaction.latest?.originalTokens ?? 0} → ${props.compaction.latest?.compactedTokens ?? 0} tokens` : "尚未触发自动优化"}</span><button onClick={() => void showContext()}>详情</button></div>
    <div className="automation-list"><strong>Goals</strong>{props.goals.map((goal) => { const idle = props.sessions.find((session) => session.id === goal.sessionId)?.status === "idle"; return <div className="automation-row" key={goal.id}><span>{goal.title} · r{goal.revision} · {goal.status}</span><button disabled={goal.status !== "active" || !idle} title={!idle ? "Goal Session 运行期间不能修改根目标" : ""} onClick={() => void updateGoal(goal)}>编辑根目标</button><button disabled={goal.status !== "active"} onClick={() => void progressGoal(goal)}>推进</button><button disabled={goal.status !== "active"} onClick={() => void createReview(goal)}>每日复盘</button><button disabled={goal.status !== "active" || !idle} onClick={() => void goalAction(goal, "confirm")}>确认完成</button><button disabled={!idle} onClick={() => void restoreGoal(goal)}>恢复 revision</button><button disabled={goal.status === "archived" || !idle} onClick={() => void goalAction(goal, "archive")}>归档</button></div>; })}</div>
    <form className="automation-form" onSubmit={(event) => void createGoal(event)}><input ref={title} aria-label="Goal 标题" placeholder="Goal 标题" /><input ref={root} aria-label="根目标" placeholder="根目标" required /><input ref={acceptance} aria-label="验收条件" placeholder="验收条件；用分号分隔" required /><button type="submit">创建 Goal</button></form>
    <div className="automation-list"><strong>Schedules</strong>{props.schedules.map((schedule) => <div className="automation-row" key={schedule.id}><span>{schedule.title} · {schedule.status} · {schedule.nextRunAt ?? "无下次"}</span><button onClick={() => void scheduleAction(schedule, schedule.status === "paused" ? "resume" : "pause")}>{schedule.status === "paused" ? "恢复" : "暂停"}</button><button onClick={() => void scheduleAction(schedule, "run-now")}>立即运行</button><button onClick={() => void showExecutions(schedule)}>执行记录</button></div>)}</div>
    <form className="automation-form schedule-form" onSubmit={(event) => void createSchedule(event)}><input ref={scheduleTitle} aria-label="Schedule 标题" placeholder="Schedule 标题" /><select ref={scheduleKind} aria-label="计划类型"><option value="interval">固定间隔（分钟）</option><option value="once">一次性（ISO 时间）</option><option value="cron">Cron（五段）</option></select><input ref={scheduleValue} aria-label="计划表达式" placeholder="例如 1440 / ISO / 0 9 * * 1" required /><select ref={scheduleTarget} aria-label="计划目标"><option value="goal">Goal 复盘</option><option value="session">Session prompt</option></select><input ref={scheduleTargetId} aria-label="目标 ID" placeholder="Goal/Session ID（可留空使用当前项）" /><input ref={schedulePrompt} aria-label="Session prompt" placeholder="Session prompt（Goal 复盘可留空）" /><button type="submit">创建 Schedule</button></form>
    {detail ? <details className="automation-detail" open><summary aria-label="自动化详情">!</summary><pre>{detail}</pre></details> : null}
  </section>;
}

function id(prefix: string): string { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : "操作失败，请重试。").replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").slice(0, 512); }
