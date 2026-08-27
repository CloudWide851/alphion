import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentApplication, AgentRunHandle, AgentSessionContract, ImageAttachmentRef } from "../src/index.js";
import { reduceConversationRun, type ConversationRunState } from "../ui/conversation-run.js";
import { parseMarkdown, renderMarkdownText } from "../ui/markdown.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { accent, borderColor, textColor } from "./shell.js";
import { sanitizeTerminalText } from "./run-projection.js";

export interface RunViewCommand { readonly id: number; readonly kind: "steer" | "follow-up" | "cancel"; readonly content?: string; readonly attachments?: readonly ImageAttachmentRef[]; }

export function RunView(props: Readonly<{
  application: AgentApplication;
  approval: TuiApprovalPort;
  prompt: string;
  attachments?: readonly ImageAttachmentRef[];
  providerId?: string;
  session?: AgentSessionContract;
  command?: RunViewCommand;
  compact?: boolean;
  onSession?: (session: AgentSessionContract) => void;
  onAccepted?: () => void;
  onCommandAccepted?: (commandId: number) => void;
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
  const callbacks = useRef({ onSession: props.onSession, onAccepted: props.onAccepted, onCommandAccepted: props.onCommandAccepted, onDone: props.onDone, onError: props.onError });
  const request = useRef({ application: props.application, prompt: props.prompt, attachments: props.attachments, providerId: props.providerId, session: props.session, approval: props.approval });
  callbacks.current = { onSession: props.onSession, onAccepted: props.onAccepted, onCommandAccepted: props.onCommandAccepted, onDone: props.onDone, onError: props.onError };

  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (!projection || !["waiting", "streaming", "tool"].includes(projection.status) || process.env.NO_COLOR !== undefined) return;
    const timer = setInterval(() => setTick((value) => (value + 1) % 4), 100); timer.unref();
    return () => clearInterval(timer);
  }, [projection?.status]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true; let buffer = ""; let timer: ReturnType<typeof setTimeout> | undefined; let lastFlush = Date.now();
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; if (!active || !buffer) return; dispatch({ kind: "delta", delta: sanitizeTerminalText(buffer) }); buffer = ""; lastFlush = Date.now(); };
    const schedule = () => { timer ??= setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush))); };
    const start = request.current;
    dispatch({ kind: "submit", submissionId: `tui:${Date.now()}`, ...(start.session ? { sessionId: start.session.id } : {}) });
    const sessionPromise = start.session ? Promise.resolve(start.session) : start.application.sessions.create({ title: start.prompt.slice(0, 80), ...(start.providerId ? { providerId: start.providerId } : {}) });
    void sessionPromise.then(async (session) => {
      activeSession.current = session; callbacks.current.onSession?.(session);
      const record = await session.get();
      return session.send({ schemaVersion: 1, ...(start.prompt ? { text: start.prompt } : {}), ...(start.attachments?.length ? { attachments: start.attachments } : {}) }, { expectedRevision: record.revision, idempotencyKey: `tui:send:${Date.now()}` }, start.approval);
    }).then(async (run) => {
      handle.current = run; callbacks.current.onAccepted?.(); dispatch({ kind: "start", runId: run.runId, sessionId: run.sessionId });
      for await (const event of run.events) {
        if (event.kind === "model.delta" && typeof event.payload.delta === "string") { buffer += event.payload.delta; schedule(); }
        else if (!("delivery" in event)) { flush(); dispatch({ kind: "agent-event", event }); }
      }
      flush(); const result = await run.result;
      if (active) { dispatch({ kind: "finish", status: result.status, finalText: result.finalText }); callbacks.current.onDone(result.finalText); }
    }).catch((cause: unknown) => { const message = safeError(cause); if (active) { dispatch({ kind: "error", message }); callbacks.current.onError?.(message); } });
    return () => { active = false; if (timer) clearTimeout(timer); handle.current?.cancel("TUI conversation closed."); };
  }, []);
  useEffect(() => {
    const command = props.command;
    if (!command || handledCommand.current === command.id) return;
    handledCommand.current = command.id;
    if (command.kind === "cancel") { handle.current?.cancel("Cancelled from TUI."); return; }
    const session = activeSession.current;
    if (!session || (!command.content?.trim() && !command.attachments?.length)) { callbacks.current.onError?.("会话尚未准备好。"); return; }
    const message = { schemaVersion: 1 as const, ...(command.content?.trim() ? { text: command.content } : {}), ...(command.attachments?.length ? { attachments: command.attachments } : {}) };
    void session.get().then((record) => command.kind === "steer"
      ? session.steer(message, { expectedRevision: record.revision, idempotencyKey: `tui:steer:${command.id}` })
      : session.followUp(message, { expectedRevision: record.revision, idempotencyKey: `tui:follow-up:${command.id}` }, props.approval))
      .then(() => callbacks.current.onCommandAccepted?.(command.id))
      .catch((cause: unknown) => callbacks.current.onError?.(safeError(cause)));
  }, [props.approval, props.command]);
  useInput((input) => { if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y"); });

  const active = projection ? ["waiting", "streaming", "tool"].includes(projection.status) : true;
  const spinner = process.env.NO_COLOR === undefined ? ["|", "/", "-", "\\"][tick] : "|";
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold {...accent()}>{active ? `${spinner} ` : ""}Alphion</Text>
    <Text>{projection?.text ? renderMarkdownText(parseMarkdown(projection.text), props.compact ? 68 : 88) : projection?.statusText ?? "准备上下文…"}</Text>
    {projection ? <Text dimColor>{projection.statusText}{projection.usage.inputTokens || projection.usage.outputTokens ? ` · tokens ${projection.usage.inputTokens}↓ / ${projection.usage.outputTokens}↑` : ""}{projection.contextUsage ? ` · 上下文 ${projection.contextUsage.source === "estimated" ? "≈" : ""}${projection.contextUsage.occupiedTokens}/${projection.contextUsage.contextWindowTokens} · ${Math.min(100, Math.round(projection.contextUsage.occupiedTokens / projection.contextUsage.contextWindowTokens * 100))}%` : ""}</Text> : null}
    {projection?.status === "failed" ? <Text {...textColor("red")}>✗ {projection.statusText}</Text> : null}
    {pendingApproval ? <Box flexDirection="column" borderStyle="round" paddingX={1} {...borderColor("yellow")}><Text bold>! {sanitizeTerminalText(pendingApproval.request.toolName)} 需要逐次审批</Text><Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text><Text>y 允许一次 · n 拒绝</Text></Box> : null}
  </Box>;
}

function reduceOptional(state: ConversationRunState | undefined, action: Parameters<typeof reduceConversationRun>[1]): ConversationRunState { return reduceConversationRun(state, action); }
function safeError(value: unknown): string { return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。"); }
