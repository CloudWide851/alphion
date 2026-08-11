import type { AgentEvent } from "../src/protocol/events.js";

export interface TuiRunProjection {
  readonly answer: string;
  readonly reasoning: string;
  readonly status: "idle" | "running" | "completed" | "failed" | "cancelled";
  readonly message: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export const EMPTY_RUN_PROJECTION: TuiRunProjection = Object.freeze({
  answer: "",
  reasoning: "",
  status: "idle",
  message: "",
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

export type TuiProjectionAction =
  | Readonly<{ readonly type: "event"; readonly event: AgentEvent }>
  | Readonly<{ readonly type: "answer-delta"; readonly delta: string }>
  | Readonly<{ readonly type: "reasoning-delta"; readonly delta: string }>
  | Readonly<{ readonly type: "run-error"; readonly message: string }>
  | Readonly<{ readonly type: "reset" }>;

export function reduceRunProjection(state: TuiRunProjection, action: TuiProjectionAction): TuiRunProjection {
  if (action.type === "reset") return { ...EMPTY_RUN_PROJECTION, status: "running" };
  if (action.type === "answer-delta") return { ...state, answer: state.answer + sanitizeTerminalText(action.delta) };
  if (action.type === "reasoning-delta") {
    return { ...state, reasoning: state.reasoning + sanitizeTerminalText(action.delta) };
  }
  if (action.type === "run-error") {
    return { ...state, status: "failed", message: sanitizeTerminalText(action.message) };
  }
  const { event } = action;
  switch (event.kind) {
    case "run.started":
      return { ...state, status: "running", message: "Agent started." };
    case "model.usage": {
      const usage = isRecord(event.payload.usage) ? event.payload.usage : undefined;
      return usage
        ? {
            ...state,
            inputTokens: numberOrZero(usage.inputTokens),
            outputTokens: numberOrZero(usage.outputTokens),
            cachedInputTokens: numberOrZero(usage.cachedInputTokens),
          }
        : state;
    }
    case "provider.degraded":
      return { ...state, message: stringOr(event.payload.reason, "Provider degraded.") };
    case "run.completed":
      return {
        ...state,
        ...usageProjection(event.payload.usage, state),
        status: "completed",
        message: "Run completed.",
      };
    case "run.failed":
      return { ...state, status: "failed", message: stringOr(event.payload.message, "Run failed.") };
    case "run.cancelled":
      return { ...state, status: "cancelled", message: stringOr(event.payload.message, "Run cancelled.") };
    default:
      return state;
  }
}

export function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageProjection(value: unknown, fallback: TuiRunProjection): Pick<TuiRunProjection, "inputTokens" | "outputTokens" | "cachedInputTokens"> {
  if (!isRecord(value)) {
    return {
      inputTokens: fallback.inputTokens,
      outputTokens: fallback.outputTokens,
      cachedInputTokens: fallback.cachedInputTokens,
    };
  }
  return {
    inputTokens: numberOrZero(value.inputTokens),
    outputTokens: numberOrZero(value.outputTokens),
    cachedInputTokens: numberOrZero(value.cachedInputTokens),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? sanitizeTerminalText(value) : fallback;
}
