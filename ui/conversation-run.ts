import type { AgentEvent, ProviderContextUsage, ProviderUsage } from "../src/index.js";

export type ConversationRunStatus = "waiting" | "streaming" | "tool" | "completed" | "failed" | "cancelled";

export interface ConversationRunState {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly sessionId: string;
  readonly status: ConversationRunStatus;
  readonly text: string;
  readonly usage: ProviderUsage;
  readonly contextUsage?: ProviderContextUsage;
  readonly statusText: string;
  readonly firstTokenReceived: boolean;
}

export type ConversationRunAction =
  | Readonly<{ readonly kind: "submit"; readonly submissionId: string; readonly sessionId?: string }>
  | Readonly<{ readonly kind: "start"; readonly runId: string; readonly sessionId: string }>
  | Readonly<{ readonly kind: "delta"; readonly delta: string }>
  | Readonly<{ readonly kind: "agent-event"; readonly event: AgentEvent }>
  | Readonly<{ readonly kind: "finish"; readonly status: string; readonly finalText: string }>
  | Readonly<{ readonly kind: "error"; readonly message: string }>;

const EMPTY_USAGE: ProviderUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

export function createConversationRunState(runId: string, sessionId: string): ConversationRunState {
  return Object.freeze({ schemaVersion: 2, runId, sessionId, status: "waiting", text: "", usage: EMPTY_USAGE, statusText: "等待模型输出", firstTokenReceived: false });
}

export function createSubmittedConversationRunState(submissionId: string, sessionId = "pending"): ConversationRunState {
  return Object.freeze({ schemaVersion: 2, runId: `pending:${submissionId}`, sessionId, status: "waiting", text: "", usage: EMPTY_USAGE, statusText: "准备上下文", firstTokenReceived: false });
}

export function reduceConversationRun(state: ConversationRunState | undefined, action: ConversationRunAction): ConversationRunState {
  if (action.kind === "submit") return createSubmittedConversationRunState(action.submissionId, action.sessionId);
  if (action.kind === "start") return createConversationRunState(action.runId, action.sessionId);
  if (!state) throw new Error("Conversation Run must start before updates are reduced.");
  if (action.kind === "delta") return Object.freeze({ ...state, status: "streaming", text: state.text + action.delta, statusText: "正在输出", firstTokenReceived: true });
  if (action.kind === "error") return Object.freeze({ ...state, status: "failed", statusText: safeText(action.message, "运行失败") });
  if (action.kind === "finish") {
    const status = terminalStatus(action.status);
    return Object.freeze({ ...state, status, text: state.text || action.finalText, statusText: terminalText(status) });
  }
  const event = action.event;
  switch (event.kind) {
    case "provider.started": return Object.freeze({ ...state, status: "waiting", statusText: "模型已连接", ...contextUsageProjection(event.payload.contextUsage) });
    case "tool.requested": case "tool.updated": case "approval.requested": return Object.freeze({ ...state, status: "tool", statusText: toolText(event) });
    case "tool.completed": case "approval.resolved": return Object.freeze({ ...state, status: state.firstTokenReceived ? "streaming" : "waiting", statusText: event.kind === "tool.completed" ? "工具已完成" : "审批已处理" });
    case "model.usage": return Object.freeze({ ...state, usage: addUsage(state.usage, decodeUsage(event.payload.usage, EMPTY_USAGE)), ...contextUsageProjection(event.payload.contextUsage) });
    case "run.completed": return Object.freeze({ ...state, status: "completed", usage: decodeUsage(event.payload.usage, state.usage), statusText: "已完成" });
    case "run.failed": return Object.freeze({ ...state, status: "failed", statusText: safeText(event.payload.message, "运行失败") });
    case "run.cancelled": return Object.freeze({ ...state, status: "cancelled", statusText: safeText(event.payload.message, "已取消") });
    default: return state;
  }
}

function terminalStatus(status: string): Extract<ConversationRunStatus, "completed" | "failed" | "cancelled"> { return status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed"; }
function terminalText(status: ConversationRunStatus): string { return status === "completed" ? "已完成" : status === "cancelled" ? "已取消" : "运行失败"; }
function toolText(event: AgentEvent): string { const name = safeText(event.payload.toolName, "工具"); return event.kind === "approval.requested" ? `${name} 等待审批` : `${name} 执行中`; }
function safeText(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500) : fallback; }
function decodeUsage(value: unknown, fallback: ProviderUsage): ProviderUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const usage = value as Readonly<Record<string, unknown>>;
  return Object.freeze({ inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), cachedInputTokens: count(usage.cachedInputTokens) });
}
function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage { return Object.freeze({ inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens }); }
function contextUsageProjection(value: unknown): Readonly<{ contextUsage?: ProviderContextUsage }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = value as Readonly<Record<string, unknown>>;
  if (usage.schemaVersion !== 1 || (usage.source !== "estimated" && usage.source !== "actual")) return {};
  const projected: ProviderContextUsage = { schemaVersion: 1, source: usage.source, inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), cachedInputTokens: count(usage.cachedInputTokens), occupiedTokens: count(usage.occupiedTokens), contextWindowTokens: count(usage.contextWindowTokens) };
  return projected.contextWindowTokens >= 4_096 ? { contextUsage: Object.freeze(projected) } : {};
}
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
