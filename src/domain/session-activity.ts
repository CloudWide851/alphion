import type { AgentRunResult } from "./contracts.js";
import type { AgentStreamEvent } from "../protocol/events.js";

/** Live-only application activity. It never becomes Session history or SQLite state. */
export type SessionActivity =
  | Readonly<{ readonly kind: "run.event"; readonly sessionId: string; readonly runId: string; readonly event: AgentStreamEvent }>
  | Readonly<{ readonly kind: "run.finished"; readonly sessionId: string; readonly runId: string; readonly status: AgentRunResult["status"]; readonly finalText: string }>
  | Readonly<{ readonly kind: "stream.resync-required"; readonly sessionId?: string }>;

