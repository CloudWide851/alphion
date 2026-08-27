import type { WorkingMemorySnapshot } from "../domain/contracts.js";
import type { AgentEvent } from "../protocol/events.js";
import { emptyProviderUsage } from "../protocol/events.js";

export const EMPTY_WORKING_MEMORY: WorkingMemorySnapshot = Object.freeze({
  schemaVersion: 1,
  phase: "idle",
  turns: 0,
  toolCalls: 0,
  evidenceIds: Object.freeze([]),
  errorCodes: Object.freeze([]),
  ...emptyProviderUsage(),
  lastEventSequence: 0,
});

export function reduceWorkingMemory(
  state: WorkingMemorySnapshot,
  event: AgentEvent,
): WorkingMemorySnapshot {
  let phase = state.phase;
  let turns = state.turns;
  let toolCalls = state.toolCalls;
  let evidenceIds = state.evidenceIds;
  let errorCodes = state.errorCodes;
  let inputTokens = state.inputTokens;
  let outputTokens = state.outputTokens;
  let cachedInputTokens = state.cachedInputTokens;

  switch (event.kind) {
    case "run.started":
    case "project.profiled":
      phase = "profiling";
      break;
    case "context.assembled":
      phase = "context";
      break;
    case "provider.started":
    case "provider.degraded":
    case "model.delta":
      phase = "model";
      break;
    case "model.usage": {
      phase = "model";
      const usage = recordValue(event.payload.usage);
      inputTokens += safeNumber(usage?.inputTokens, 0);
      outputTokens += safeNumber(usage?.outputTokens, 0);
      cachedInputTokens += safeNumber(usage?.cachedInputTokens, 0);
      break;
    }
    case "tool.requested":
      phase = "tools";
      toolCalls += 1;
      break;
    case "tool.completed": {
      phase = "tools";
      const evidence = recordValue(event.payload.evidence);
      const id = typeof evidence?.id === "string" ? evidence.id : undefined;
      if (id && !evidenceIds.includes(id)) evidenceIds = Object.freeze([...evidenceIds, id]);
      break;
    }
    case "run.completed":
      phase = "completed";
      turns = safeNumber(event.payload.turns, turns);
      ({ inputTokens, outputTokens, cachedInputTokens } = usageValues(
        event.payload.usage,
        inputTokens,
        outputTokens,
        cachedInputTokens,
      ));
      break;
    case "run.failed":
    case "run.cancelled": {
      phase = event.kind === "run.failed" ? "failed" : "cancelled";
      const code = typeof event.payload.code === "string" ? event.payload.code : undefined;
      if (code && !errorCodes.includes(code)) errorCodes = Object.freeze([...errorCodes, code]);
      break;
    }
    case "approval.requested":
    case "approval.resolved":
    case "cache.hit":
    case "cache.miss":
    case "cache.stored":
      break;
  }

  return Object.freeze({
    schemaVersion: 1,
    phase,
    turns,
    toolCalls,
    evidenceIds,
    errorCodes,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    lastEventSequence: event.sequence,
  });
}

function usageValues(value: unknown, input: number, output: number, cached: number) {
  const usage = recordValue(value);
  return {
    inputTokens: safeNumber(usage?.inputTokens, input),
    outputTokens: safeNumber(usage?.outputTokens, output),
    cachedInputTokens: safeNumber(usage?.cachedInputTokens, cached),
  };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
