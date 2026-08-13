import type { AgentMessage, ProviderMessage } from "../domain/contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { AlphionError } from "./errors.js";

export interface ProviderConversationPlan {
  readonly schemaVersion: 1;
  readonly messages: readonly ProviderMessage[];
  readonly digest: string;
  readonly omissions: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface ProviderConversationPlanInput {
  readonly history: readonly AgentMessage[];
  readonly currentPrompt: string;
  readonly contextualMessages?: readonly ProviderMessage[];
}

/** Builds the only Provider-visible conversation line from durable domain messages. */
export function planProviderConversation(input: ProviderConversationPlanInput): ProviderConversationPlan {
  const prompt = input.currentPrompt.trim();
  if (!prompt) throw new AlphionError("validation", "Provider conversation prompt cannot be empty.", { stage: "context" });
  const contextual: ProviderMessage[] = [...(input.contextualMessages ?? [])];
  const conversation: ProviderMessage[] = [];
  const omissions: string[] = [];
  const diagnostics: string[] = [];
  const toolCallIds = new Set<string>();
  let pendingCalls: Extract<AgentMessage, { readonly kind: "tool-call" }>[] = [];
  let pendingResults = 0;

  const assertBatchComplete = (): void => {
    if (pendingCalls.length > 0 && pendingResults !== pendingCalls.length) {
      diagnostics.push("tool-result-sequence-invalid");
      throw new AlphionError("integrity-failed", "Provider conversation contains an incomplete ToolCall batch.", { stage: "context" });
    }
    pendingCalls = [];
    pendingResults = 0;
  };

  for (const message of input.history) {
    switch (message.kind) {
      case "memory":
        assertBatchComplete();
        contextual.push({ role: "system", content: `Session memory (${message.digest}):\n${message.content}` });
        break;
      case "agent":
        assertBatchComplete();
        contextual.push({ role: "system", content: message.schemaVersion === 2
          ? `Session ${message.sourceSessionId} (${message.domainId}, hop ${message.hop}): ${message.content}`
          : `Agent ${message.agentId}: ${message.content}` });
        break;
      case "workflow":
        assertBatchComplete();
        contextual.push({ role: "system", content: `Workflow ${message.state}: ${message.content}` });
        break;
      case "system-event":
      case "human-approval":
        omissions.push(`${message.kind}:${message.id}:audit-only`);
        break;
      case "user":
        assertBatchComplete();
        conversation.push({ role: "user", content: message.content });
        break;
      case "assistant":
        assertBatchComplete();
        conversation.push({ role: "assistant", content: message.content });
        break;
      case "tool-call":
        if (pendingResults > 0) assertBatchComplete();
        if (toolCallIds.has(message.call.id)) {
          diagnostics.push("duplicate-tool-call");
          throw new AlphionError("integrity-failed", "Provider conversation contains a duplicate ToolCall identity.", { stage: "context" });
        }
        toolCallIds.add(message.call.id);
        pendingCalls.push(message);
        break;
      case "observation": {
        const expected = pendingCalls[pendingResults];
        if (!expected || expected.call.id !== message.toolCallId || expected.call.name !== message.toolName) {
          diagnostics.push("orphaned-or-out-of-order-tool-result");
          throw new AlphionError("integrity-failed", "Provider conversation contains an orphaned or out-of-order Tool result.", { stage: "context" });
        }
        if (pendingResults === 0) conversation.push({ role: "assistant", content: "", toolCalls: Object.freeze(pendingCalls.map((item) => item.call)) });
        conversation.push({ role: "tool", toolCallId: message.toolCallId, name: message.toolName, content: message.content });
        pendingResults += 1;
        break;
      }
    }
  }
  assertBatchComplete();
  const messages = Object.freeze([...contextual, ...conversation, { role: "user" as const, content: prompt }]);
  const digest = sha256(canonicalJson({ schemaVersion: 1, messages, omissions }));
  return Object.freeze({ schemaVersion: 1, messages, digest, omissions: Object.freeze(omissions), diagnostics: Object.freeze(diagnostics) });
}

/** Compatibility projection for non-Run callers; audit-only messages are intentionally omitted. */
export function projectAgentMessages(messages: readonly AgentMessage[]): readonly ProviderMessage[] {
  const plan = planProviderConversation({ history: messages, currentPrompt: "Compatibility projection boundary." });
  return Object.freeze(plan.messages.slice(0, -1));
}
