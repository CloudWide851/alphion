import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentApplication, AgentSessionContract, AgentSessionRecord, CompactionProjection, GoalRecord, ScheduleExpression, ScheduleRecord } from "../src/index.js";
import { createId } from "../src/application/canonical.js";
import { TextEntry } from "./input.js";
import { sanitizeTerminalText } from "./run-projection.js";
import { accent } from "./shell.js";

export function ContextCard({ session, onError }: Readonly<{ session?: AgentSessionContract; onError: (error: unknown) => void }>): React.JSX.Element {
  const [projection, setProjection] = useState<CompactionProjection>({ count: 0 });
  const [detail, setDetail] = useState("");
  const refresh = useCallback(() => { if (!session) { setProjection({ count: 0 }); return; } void session.compactionProjection().then(setProjection).catch(onError); }, [onError, session]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1_000); timer.unref(); return () => clearInterval(timer); }, [refresh]);
  useInput((input) => { if (input === "d" && session) void session.listCompactions(20).then((records) => setDetail(records.map((item) => `${item.createdAt} · ${item.originalTokens}→${item.compactedTokens} · ${item.modelId} · ${item.omissions.join(",") || "完整"}`).join("\n") || "暂无记录")).catch(onError); });
  return <Box flexDirection="column" borderStyle="round" paddingX={1} {...accent()}><Text bold>上下文优化</Text>{projection.latest ? <><Text>✓ 已优化上下文 · 累计 {projection.count} 次</Text><Text>{projection.latest.originalTokens} → {projection.latest.compactedTokens} tokens · {projection.latest.modelId}</Text><Text dimColor>最近 {projection.latest.createdAt} · digest {projection.latest.digest.slice(0, 12)}</Text></> : <Text dimColor>{session ? "尚未达到模型窗口压缩阈值。" : "当前没有 Session。"}</Text>}{detail ? <Text>{sanitizeTerminalText(detail)}</Text> : <Text dimColor>d 按需加载详细记录；内部摘要正文默认隐藏</Text>}</Box>;
}

export function GoalCard({ application, actionMode, onError }: Readonly<{ application: AgentApplication; actionMode?: boolean; onError: (error: unknown) => void }>): React.JSX.Element {
  const [goals, setGoals] = useState<readonly GoalRecord[]>([]);
  const [selected, setSelected] = useState(0); const selectedRef = useRef(0);
  const [form, setForm] = useState<"title" | "root" | "acceptance" | "progress" | "edit-root" | "edit-acceptance" | "restore" | undefined>();
  const [draft, setDraft] = useState({ title: "", root: "" });
  const [sessionStatus, setSessionStatus] = useState<ReadonlyMap<string, string>>(new Map());
  const refresh = useCallback(() => { void Promise.all([application.goals.list(true), application.sessions.list()]).then(([items, sessions]) => { setGoals(items); setSessionStatus(new Map(sessions.map((session) => [session.id, session.status]))); const next = Math.min(selectedRef.current, Math.max(0, items.length - 1)); selectedRef.current = next; setSelected(next); }).catch(onError); }, [application, onError]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1_000); timer.unref(); return () => clearInterval(timer); }, [refresh]);
  const current = goals[selected];
  const currentIdle = current ? sessionStatus.get(current.sessionId) === "idle" : false;
  useInput((input, key) => {
    if (form) return;
    if (key.upArrow) { selectedRef.current = Math.max(0, selectedRef.current - 1); setSelected(selectedRef.current); }
    else if (key.downArrow) { selectedRef.current = Math.min(goals.length - 1, selectedRef.current + 1); setSelected(selectedRef.current); }
    else if (input === "n") setForm("title");
    else if (input === "p" && current?.status === "active") setForm("progress");
    else if (input === "e" && current?.status === "active" && currentIdle) { setDraft({ title: current.title, root: current.current.rootGoal }); setForm("edit-root"); }
    else if (input === "r" && current && currentIdle) setForm("restore");
    else if (input === "c" && current && current.status === "active" && currentIdle) void application.goals.confirmCompletion(current.id, current.revision, createId("goal-confirm")).then(refresh).catch(onError);
    else if (input === "x" && current && current.status !== "archived" && currentIdle) void application.goals.archive(current.id, current.revision, createId("goal-archive")).then(refresh).catch(onError);
  });
  if (form === "title") return <TextEntry label="Goal 标题" onSubmit={(title) => { setDraft({ title, root: "" }); setForm("root"); }} onCancel={() => setForm(undefined)} />;
  if (form === "root") return <TextEntry label="根目标" onSubmit={(root) => { setDraft((value) => ({ ...value, root })); setForm("acceptance"); }} onCancel={() => setForm(undefined)} />;
  if (form === "acceptance") return <TextEntry label="验收条件（使用分号分隔）" onSubmit={(value) => { const acceptanceCriteria = value.split(";").map((item) => item.trim()).filter(Boolean); void application.goals.create({ title: draft.title, rootGoal: draft.root, acceptanceCriteria, idempotencyKey: createId("goal-create") }).then(() => { setForm(undefined); refresh(); }).catch(onError); }} onCancel={() => setForm(undefined)} />;
  if (form === "progress" && current) return <TextEntry label="追加进度（用户更新，可不引用 Evidence）" onSubmit={(progress) => void application.goals.appendProgress({ goalId: current.id, progress, evidenceIds: [], expectedRevision: current.revision, idempotencyKey: createId("goal-progress"), actor: "user" }).then(() => { setForm(undefined); refresh(); }).catch(onError)} onCancel={() => setForm(undefined)} />;
  if (form === "edit-root" && current) return <TextEntry label="修改根目标" initialValue={current.current.rootGoal} onSubmit={(root) => { setDraft((value) => ({ ...value, root })); setForm("edit-acceptance"); }} onCancel={() => setForm(undefined)} />;
  if (form === "edit-acceptance" && current) return <TextEntry label="修改验收条件（使用分号分隔）" initialValue={current.current.acceptanceCriteria.join(";")} onSubmit={(value) => { const acceptanceCriteria = value.split(";").map((item) => item.trim()).filter(Boolean); void application.goals.updateRoot({ goalId: current.id, rootGoal: draft.root, acceptanceCriteria, safetyConstraints: current.current.safetyConstraints, expectedRevision: current.revision, idempotencyKey: createId("goal-root") }).then(() => { setForm(undefined); refresh(); }).catch(onError); }} onCancel={() => setForm(undefined)} />;
  if (form === "restore" && current) return <TextEntry label="恢复到 revision" onSubmit={(value) => { const sourceRevision = Number(value); if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) { onError(new Error("revision 必须是正整数")); return; } void application.goals.restoreRevision(current.id, sourceRevision, current.revision, createId("goal-restore")).then(() => { setForm(undefined); refresh(); }).catch(onError); }} onCancel={() => setForm(undefined)} />;
  return <Box flexDirection="column" borderStyle="round" paddingX={1} {...accent()}><Text bold>{actionMode ? "Goal 操作" : "长期 Goals"}</Text>{goals.length === 0 ? <Text dimColor>暂无 Goal。按 n 创建。</Text> : goals.map((goal, index) => <Text key={goal.id} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} {goal.title} · r{goal.revision} · {goal.status}</Text>)}{current ? <Box flexDirection="column" marginTop={1}><Text>目标：{sanitizeTerminalText(current.current.rootGoal)}</Text><Text>验收：{current.current.acceptanceCriteria.join("；")}</Text><Text>进度：{sanitizeTerminalText(current.current.progress || "暂无")}</Text><Text>下一步：{sanitizeTerminalText(current.current.nextStep ?? "暂无")}</Text><Text>阻塞：{current.current.blockers.join("；") || "无"}</Text><Text>Evidence：{current.current.evidenceIds.join(", ") || "暂无"}</Text>{current.current.completionSuggested ? <Text>! Agent 已建议完成；仍需用户按 c 确认</Text> : null}{!currentIdle ? <Text dimColor>Goal Session 运行中：根目标、确认、归档和恢复已禁用</Text> : null}</Box> : null}<Text dimColor>↑↓ 选择 · n 创建 · e 编辑根目标 · p 推进 · r 恢复 · c 确认 · x 归档</Text></Box>;
}

export function SchedulesCard({ application, onError }: Readonly<{ application: AgentApplication; onError: (error: unknown) => void }>): React.JSX.Element {
  const [schedules, setSchedules] = useState<readonly ScheduleRecord[]>([]); const [goals, setGoals] = useState<readonly GoalRecord[]>([]); const [sessions, setSessions] = useState<readonly AgentSessionRecord[]>([]);
  const [selected, setSelected] = useState(0); const selectedRef = useRef(0);
  const [form, setForm] = useState<"title" | "kind" | "expression" | "target" | "target-item" | "prompt" | undefined>();
  const [choice, setChoice] = useState(0); const choiceRef = useRef(0);
  const [draft, setDraft] = useState<Readonly<{ title: string; kind: "once" | "interval" | "cron"; expression: string; target: "goal" | "session"; targetId?: string }>>({ title: "", kind: "interval", expression: "", target: "goal" });
  const [detail, setDetail] = useState("");
  const refresh = useCallback(() => { void Promise.all([application.schedules.list(), application.goals.list(), application.sessions.list()]).then(([nextSchedules, nextGoals, nextSessions]) => { setSchedules(nextSchedules); setGoals(nextGoals); setSessions(nextSessions.filter((item) => !item.auditOnly)); const next = Math.min(selectedRef.current, Math.max(0, nextSchedules.length - 1)); selectedRef.current = next; setSelected(next); }).catch(onError); }, [application, onError]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1_000); timer.unref(); return () => clearInterval(timer); }, [refresh]);
  const current = schedules[selected];
  useInput((input, key) => {
    if (form === "kind") {
      if (key.escape) { setForm(undefined); return; }
      if (key.upArrow) choiceRef.current = Math.max(0, choiceRef.current - 1);
      if (key.downArrow) choiceRef.current = Math.min(2, choiceRef.current + 1);
      setChoice(choiceRef.current);
      if (key.return) { const kind = (["once", "interval", "cron"] as const)[choiceRef.current] ?? "interval"; setDraft((value) => ({ ...value, kind })); setForm("expression"); }
      return;
    }
    if (form === "target") {
      if (key.escape) { setForm(undefined); return; }
      if (key.upArrow) choiceRef.current = Math.max(0, choiceRef.current - 1);
      if (key.downArrow) choiceRef.current = Math.min(1, choiceRef.current + 1);
      setChoice(choiceRef.current);
      if (key.return) { const target = choiceRef.current === 0 ? "goal" : "session"; const items = target === "goal" ? goals : sessions; if (items.length === 0) { onError(new Error(target === "goal" ? "没有可用 Goal" : "没有可用 Session")); return; } choiceRef.current = 0; setChoice(0); setDraft((value) => ({ ...value, target })); setForm("target-item"); }
      return;
    }
    if (form === "target-item") {
      if (key.escape) { setForm(undefined); return; }
      const items = draft.target === "goal" ? goals : sessions;
      if (key.upArrow) choiceRef.current = Math.max(0, choiceRef.current - 1);
      if (key.downArrow) choiceRef.current = Math.min(Math.max(0, items.length - 1), choiceRef.current + 1);
      setChoice(choiceRef.current);
      if (key.return) { const targetId = items[choiceRef.current]?.id; if (!targetId) return; setDraft((value) => ({ ...value, targetId })); if (draft.target === "session") setForm("prompt"); else createSchedule({ ...draft, targetId }, ""); }
      return;
    }
    if (form) return;
    if (key.upArrow) { selectedRef.current = Math.max(0, selectedRef.current - 1); setSelected(selectedRef.current); }
    else if (key.downArrow) { selectedRef.current = Math.min(schedules.length - 1, selectedRef.current + 1); setSelected(selectedRef.current); }
    else if (input === "n") setForm("title");
    else if (input === "p" && current) { const action = current.status === "paused" ? application.schedules.resume(current.id, { expectedRevision: current.revision, idempotencyKey: createId("schedule-resume") }) : application.schedules.pause(current.id, { expectedRevision: current.revision, idempotencyKey: createId("schedule-pause") }); void action.then(refresh).catch(onError); }
    else if (input === "d" && current) void application.schedules.executions(current.id, 50).then((items) => setDetail(items.map((item) => `${item.dueAt} · ${item.status} · ${item.reason ?? item.runId ?? "-"}`).join("\n") || "暂无执行记录")).catch(onError);
    else if (key.return && current) void application.schedules.runNow(current.id, { expectedRevision: current.revision, idempotencyKey: createId("schedule-run") }).then(refresh).catch(onError);
  });
  function createSchedule(value: typeof draft, prompt: string): void {
    if (!value.targetId) return;
    const expression: ScheduleExpression = value.kind === "once" ? { kind: "once", at: value.expression } : value.kind === "cron" ? { kind: "cron", expression: value.expression } : { kind: "interval", everyMinutes: Number(value.expression) };
    const payload = value.target === "goal" ? { kind: "goal.review" as const, goalId: value.targetId } : { kind: "session.prompt" as const, sessionId: value.targetId, prompt };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    void application.schedules.create({ title: value.title, expression, timezone, payload, idempotencyKey: createId("schedule-create") }).then(() => { setForm(undefined); refresh(); }).catch(onError);
  }
  if (form === "title") return <TextEntry label="Schedule 标题" onSubmit={(title) => { setDraft((value) => ({ ...value, title })); choiceRef.current = 0; setChoice(0); setForm("kind"); }} onCancel={() => setForm(undefined)} />;
  if (form === "kind") return <ChoiceCard title="计划类型" items={["一次性时间", "固定间隔", "五段 Cron"]} selected={choice} />;
  if (form === "expression") return <TextEntry label={draft.kind === "once" ? "ISO 时间" : draft.kind === "cron" ? "五段 Cron" : "间隔分钟（至少 5）"} onSubmit={(expression) => { setDraft((value) => ({ ...value, expression })); choiceRef.current = 0; setChoice(0); setForm("target"); }} onCancel={() => setForm(undefined)} />;
  if (form === "target") return <ChoiceCard title="执行目标" items={["Goal 复盘", "Session prompt"]} selected={choice} />;
  if (form === "target-item") return <ChoiceCard title={draft.target === "goal" ? "选择 Goal" : "选择 Session"} items={(draft.target === "goal" ? goals : sessions).map((item) => item.title)} selected={choice} />;
  if (form === "prompt") return <TextEntry label="固定 Session prompt" onSubmit={(prompt) => createSchedule(draft, prompt)} onCancel={() => setForm(undefined)} />;
  return <Box flexDirection="column" borderStyle="round" paddingX={1} {...accent()}><Text bold>定时任务</Text>{schedules.length === 0 ? <Text dimColor>暂无计划。按 n 创建。</Text> : schedules.map((schedule, index) => <Text key={schedule.id} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} {schedule.title} · {schedule.status} · {schedule.nextRunAt ?? "无下次"}</Text>)}{detail ? <Text>{sanitizeTerminalText(detail)}</Text> : null}<Text dimColor>↑↓ 选择 · n 创建 once/interval/Cron · p 暂停/恢复 · d 执行记录 · Enter 立即运行</Text></Box>;
}

function ChoiceCard({ title, items, selected }: Readonly<{ title: string; items: readonly string[]; selected: number }>): React.JSX.Element {
  return <Box flexDirection="column" borderStyle="round" paddingX={1} {...accent()}><Text bold>{title}</Text>{items.map((item, index) => <Text key={`${index}:${item}`} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} {sanitizeTerminalText(item)}</Text>)}<Text dimColor>↑↓ 选择 · Enter 确认 · Esc 取消</Text></Box>;
}
