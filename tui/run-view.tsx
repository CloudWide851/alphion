import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentApplication, AgentRunHandle, AgentSessionContract } from "../src/index.js";
import { reduceConversationRun, type ConversationRunState } from "../ui/conversation-run.js";
import { parseMarkdown, renderMarkdownText } from "../ui/markdown.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { accent, borderColor, textColor } from "./shell.js";
import { sanitizeTerminalText } from "./run-projection.js";

export interface RunViewCommand { readonly id: number; readonly kind: "steer" | "follow-up" | "cancel"; readonly content?: string; }

export function RunView(props: Readonly<{
  application: AgentApplication;
  approval: TuiApprovalPort;
  prompt: string;
  providerId?: string;
  session?: AgentSessionContract;
  command?: RunViewCommand;
  compact?: boolean;
  onSession?: (session: AgentSessionContract) => void;
  onDone: (answer: string) => void;
  onError?: (message: string) => void;
  onExit?: () => void;
}>): React.JSX.Element {
  const [projection, dispatch] = useReducer(reduceOptional, undefined);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const handle = useRef<AgentRunHandle | undefined>(undefined);
  const activeSession = useRef<AgentSessionContract | undefined>(props.session);
  const handledCommand = useRef(0);
  const started = useRef(false);

  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (projection?.status !== "waiting" || process.env.NO_COLOR !== undefined) return;
    const timer = setInterval(() => setTick((value) => (value + 1) % 4), 100); timer.unref();
    return () => clearInterval(timer);
  }, [projection?.status]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true; let buffer = ""; let timer: ReturnType<typeof setTimeout> | undefined; let lastFlush = Date.now();
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; if (!active || !buffer) return; dispatch({ kind: "delta", delta: sanitizeTerminalText(buffer) }); buffer = ""; lastFlush = Date.now(); };
    const schedule = () => { timer ??= setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush))); };
    const sessionPromise = props.session ? Promise.resolve(props.session) : props.application.sessions.create({ title: props.prompt.slice(0, 80), ...(props.providerId ? { providerId: props.providerId } : {}) });
    void sessionPromise.then(async (session) => {
      activeSession.current = session; props.onSession?.(session);
      const record = await session.get();
      return session.send(props.prompt, { expectedRevision: record.revision, idempotencyKey: `tui:send:${Date.now()}` }, props.approval);
    }).then(async (run) => {
      handle.current = run; dispatch({ kind: "start", runId: run.runId, sessionId: run.sessionId });
      for await (const event of run.events) {
        if (event.kind === "model.delta" && typeof event.payload.delta === "string") { buffer += event.payload.delta; schedule(); }
        else if (!("delivery" in event)) { flush(); dispatch({ kind: "agent-event", event }); }
      }
      flush(); const result = await run.result;
      if (active) { dispatch({ kind: "finish", status: result.status, finalText: result.finalText }); props.onDone(result.finalText); }
    }).catch((cause: unknown) => { const message = safeError(cause); if (active) { dispatch({ kind: "error", message }); props.onError?.(message); } });
    return () => { active = false; if (timer) clearTimeout(timer); handle.current?.cancel("TUI conversation closed."); };
  }, [props.application, props.approval, props.onDone, props.onError, props.onSession, props.prompt, props.providerId, props.session]);
  useEffect(() => {
    const command = props.command;
    if (!command || handledCommand.current === command.id) return;
    handledCommand.current = command.id;
    if (command.kind === "cancel") { handle.current?.cancel("Cancelled from TUI."); return; }
    const session = activeSession.current;
    if (!session || !command.content) { props.onError?.("会话尚未准备好。"); return; }
    void session.get().then((record) => command.kind === "steer"
      ? session.steer(command.content!, { expectedRevision: record.revision, idempotencyKey: `tui:steer:${command.id}` })
      : session.followUp(command.content!, { expectedRevision: record.revision, idempotencyKey: `tui:follow-up:${command.id}` }, props.approval))
      .catch((cause: unknown) => props.onError?.(safeError(cause)));
  }, [props.approval, props.command, props.onError]);
  useInput((input) => { if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y"); });

  const waiting = projection?.status === "waiting" ? (process.env.NO_COLOR === undefined ? `思考中${"·".repeat(tick + 1)}` : "等待模型输出…") : undefined;
  return <Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1} {...borderColor("#A377F6")}>
    <Text bold {...accent()}>Alphion</Text>
    <Text>{projection?.text ? renderMarkdownText(parseMarkdown(projection.text), props.compact ? 68 : 88) : waiting ?? "正在准备…"}{projection?.status === "streaming" && process.env.NO_COLOR === undefined ? " ▍" : ""}</Text>
    {projection ? <Text dimColor>{projection.statusText} · tokens {projection.usage.inputTokens}/{projection.usage.outputTokens}{projection.usage.cachedInputTokens ? ` · cache ${projection.usage.cachedInputTokens}` : ""}</Text> : null}
    {projection?.status === "failed" ? <Text {...textColor("red")}>✗ {projection.statusText}</Text> : null}
    {pendingApproval ? <Box flexDirection="column" borderStyle="round" paddingX={1} {...borderColor("yellow")}><Text bold>! {sanitizeTerminalText(pendingApproval.request.toolName)} 需要逐次审批</Text><Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text><Text>y 允许一次 · n 拒绝</Text></Box> : null}
  </Box>;
}

function reduceOptional(state: ConversationRunState | undefined, action: Parameters<typeof reduceConversationRun>[1]): ConversationRunState { return reduceConversationRun(state, action); }
function safeError(value: unknown): string { return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。"); }
