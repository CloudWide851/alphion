import type { AgentMessage, ProviderMessage } from "../domain/contracts.js";

export function projectAgentMessages(messages: readonly AgentMessage[]): readonly ProviderMessage[] {
  const result: ProviderMessage[] = [];
  for (const message of messages) {
    switch (message.kind) {
      case "user": result.push({ role: "user", content: message.content }); break;
      case "assistant": result.push({ role: "assistant", content: message.content }); break;
      case "tool-call": result.push({ role: "assistant", content: "", toolCalls: [message.call] }); break;
      case "observation": result.push({ role: "tool", toolCallId: message.toolCallId, name: message.toolName, content: message.content }); break;
      case "memory": result.push({ role: "system", content: `Session memory (${message.digest}):\n${message.content}` }); break;
      case "system-event": result.push({ role: "system", content: `[${message.eventKind}] ${message.content}` }); break;
      case "human-approval": result.push({ role: "system", content: `Approval ${message.requestId}: ${message.approved ? "approved" : "denied"}. ${message.content}` }); break;
      case "agent": result.push({ role: "system", content: message.schemaVersion === 2
        ? `Session ${message.sourceSessionId} (${message.domainId}, hop ${message.hop}): ${message.content}`
        : `Agent ${message.agentId}: ${message.content}` }); break;
      case "workflow": result.push({ role: "system", content: `Workflow ${message.state}: ${message.content}` }); break;
    }
  }
  return Object.freeze(result);
}
