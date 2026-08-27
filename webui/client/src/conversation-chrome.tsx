import React from "react";
import type { ConversationRunState } from "../../../ui/conversation-run.js";

const ACTIVE_STATUSES = new Set<ConversationRunState["status"]>(["waiting", "streaming", "tool"]);

export function SpeakerLabel(props: Readonly<{ role: "user" | "assistant"; run?: ConversationRunState }>): React.JSX.Element {
  if (props.role === "user") return <span className="speaker">你</span>;
  const answering = props.run ? ACTIVE_STATUSES.has(props.run.status) : false;
  return <span className="speaker assistant-label">{answering ? <span className="answer-spinner" role="status" aria-label={props.run?.statusText ?? "正在回答"} /> : null}<span>Alphion</span></span>;
}

export function ConversationStatus(props: Readonly<{ status: string; run?: ConversationRunState }>): React.JSX.Element {
  const text = props.run && ACTIVE_STATUSES.has(props.run.status) ? props.run.statusText : props.status;
  return <div className="conversation-status" role="status">{text}</div>;
}

export function ConversationUsage(props: Readonly<{ run?: ConversationRunState }>): React.JSX.Element | null {
  const usage = props.run?.usage;
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return null;
  return <div className="conversation-usage">tokens {compact(usage.inputTokens)}↓ / {compact(usage.outputTokens)}↑{usage.cachedInputTokens ? ` · cache ${compact(usage.cachedInputTokens)}` : ""}</div>;
}

function compact(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return `${Number((value / 1_000_000).toFixed(1))}m`;
}
