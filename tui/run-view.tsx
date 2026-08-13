import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentApplication, AgentRunHandle, AgentSessionContract } from "../src/index.js";
import { parseMarkdown, renderMarkdownText } from "../ui/markdown.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { TextEntry } from "./input.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "./run-projection.js";

export function RunView(props: Readonly<{ application: AgentApplication; approval: TuiApprovalPort; prompt: string; providerId?: string; session?: AgentSessionContract; onDone: (answer: string) => void; onExit: () => void }>): React.JSX.Element {
  const [projection, dispatch] = useReducer(reduceRunProjection, EMPTY_RUN_PROJECTION);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const handle = useRef<AgentRunHandle | undefined>(undefined);
  const started = useRef(false);
  const activeSession = useRef<AgentSessionContract | undefined>(props.session);
  const [queueMode, setQueueMode] = useState<"steer" | "follow-up" | undefined>();
  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (started.current) return;
    started.current = true; dispatch({ type: "reset" });
    let active = true; let flushTimer: ReturnType<typeof setTimeout> | undefined; let answerBuffer = ""; let lastFlush = Date.now();
    const flush = () => { if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined; if (!active) return; if (answerBuffer) { dispatch({ type: "answer-delta", delta: answerBuffer }); answerBuffer = ""; } lastFlush = Date.now(); };
    const scheduleFlush = () => { if (!active && !flushTimer) return; flushTimer ??= setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush))); };
    const resolveSession = props.session ? Promise.resolve(props.session) : props.application.sessions.create({ title: props.prompt.slice(0, 80), ...(props.providerId ? { providerId: props.providerId } : {}) });
    void resolveSession.then(async (session) => { activeSession.current = session; return session.send(props.prompt, { expectedRevision: (await session.get()).revision, idempotencyKey: `tui:send:${Date.now()}` }, props.approval); })
      .then(async (runHandle) => { handle.current = runHandle; for await (const event of runHandle.events) { if (event.kind === "model.delta" && typeof event.payload.delta === "string") { answerBuffer += event.payload.delta; scheduleFlush(); } else if (!("delivery" in event)) { flush(); dispatch({ type: "event", event }); } } flush(); await runHandle.result; })
      .catch((cause: unknown) => { if (active) dispatch({ type: "run-error", message: safeError(cause) }); });
    return () => { active = false; if (flushTimer) clearTimeout(flushTimer); handle.current?.cancel("TUI view closed."); };
  }, [props.application, props.approval, props.prompt, props.providerId, props.session]);
  useInput((input, key) => { if (queueMode) return; if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y"); else if (input === "s" && projection.status === "running") setQueueMode("steer"); else if (input === "f") setQueueMode("follow-up"); else if (key.ctrl && input === "c") { if (projection.status === "running") handle.current?.cancel("Cancelled from TUI."); else props.onExit(); } else if (key.return && projection.status !== "running") props.onDone(projection.answer); });
  if (queueMode) return <TextEntry label={queueMode === "steer" ? "注入下一模型边界（steer）" : "排队终态后续（follow-up）"} onCancel={() => setQueueMode(undefined)} onSubmit={(content) => queue(activeSession.current, queueMode, content, props.approval).then(() => setQueueMode(undefined)).catch((cause: unknown) => { dispatch({ type: "run-error", message: safeError(cause) }); setQueueMode(undefined); })} />;
  return <Box flexDirection="column" marginTop={1}>
    <Text bold>状态 · {projection.status}</Text><Text>{projection.answer ? renderMarkdownText(parseMarkdown(projection.answer), 88) : "◌ 等待模型输出…"}</Text>
    <Text dimColor>tokens 输入={projection.inputTokens} 输出={projection.outputTokens} 缓存={projection.cachedInputTokens}</Text>
    {projection.message ? <Text color={projection.status === "failed" && process.env.NO_COLOR === undefined ? "red" : undefined}>{projection.message}</Text> : null}
    {pendingApproval ? <Box flexDirection="column" borderStyle="round" borderColor={process.env.NO_COLOR === undefined ? "yellow" : undefined} paddingX={1}><Text bold>! 需要逐次审批：{sanitizeTerminalText(pendingApproval.request.toolName)}</Text><Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text><Text>y 批准此精确动作 · n 拒绝</Text></Box> : null}
    <Text dimColor>{projection.status === "running" ? "s steer · f follow-up · Ctrl+C 取消" : "f follow-up · Enter 返回对话"}</Text>
  </Box>;
}

async function queue(session: AgentSessionContract | undefined, mode: "steer" | "follow-up", content: string, approval: TuiApprovalPort): Promise<void> {
  if (!session) throw new Error("会话尚未准备好。");
  const record = await session.get(); const options = { expectedRevision: record.revision, idempotencyKey: `tui:${mode}:${Date.now()}` };
  if (mode === "steer") await session.steer(content, options); else await session.followUp(content, options, approval);
}
function safeError(value: unknown): string { return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。"); }
