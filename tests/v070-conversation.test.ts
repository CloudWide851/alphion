import assert from "node:assert/strict";
import test from "node:test";
import { planProviderConversation } from "../src/application/message-projection.js";
import { AlphionError } from "../src/application/errors.js";
import type { AgentMessage } from "../src/domain/contracts.js";

test("ProviderConversationPlan appends the current prompt once and isolates audit state", () => {
  const plan = planProviderConversation({
    history: [
      message("user", "previous question"),
      message("assistant", "previous answer"),
      message("system-event", "provider.started"),
      message("human-approval", "approved"),
      toolCall("call_1", "read"),
      toolCall("call_2", "search"),
      observation("call_1", "read", "file"),
      observation("call_2", "search", "matches"),
    ],
    currentPrompt: "current question",
  });
  assert.equal(plan.messages.filter((item) => item.role === "user" && item.content === "current question").length, 1);
  assert.equal(JSON.stringify(plan.messages).includes("provider.started"), false);
  assert.equal(JSON.stringify(plan.messages).includes("approved"), false);
  const batch = plan.messages.find((item) => item.role === "assistant" && item.toolCalls);
  assert.deepEqual(batch?.role === "assistant" ? batch.toolCalls?.map((call) => call.id) : [], ["call_1", "call_2"]);
  assert.deepEqual(plan.messages.filter((item) => item.role === "tool").map((item) => item.role === "tool" ? item.toolCallId : ""), ["call_1", "call_2"]);
  assert.equal(plan.omissions.length, 2);
  assert.match(plan.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(plan, planProviderConversation({ history: [message("user", "previous question"), message("assistant", "previous answer"), message("system-event", "provider.started"), message("human-approval", "approved"), toolCall("call_1", "read"), toolCall("call_2", "search"), observation("call_1", "read", "file"), observation("call_2", "search", "matches")], currentPrompt: "current question" }));
});

test("ProviderConversationPlan rejects orphaned, duplicate, and incomplete Tool results", () => {
  for (const history of [
    [observation("call_1", "read", "orphan")],
    [toolCall("call_1", "read"), toolCall("call_1", "read")],
    [toolCall("call_1", "read")],
    [toolCall("call_1", "read"), observation("call_2", "read", "wrong")],
  ]) {
    assert.throws(() => planProviderConversation({ history, currentPrompt: "continue" }), (error) => error instanceof AlphionError && error.code === "integrity-failed");
  }
});

function base(kind: AgentMessage["kind"]): Readonly<{ schemaVersion: 1; kind: AgentMessage["kind"]; id: string; createdAt: string }> {
  return { schemaVersion: 1, kind, id: `message_${kind}`, createdAt: new Date(0).toISOString() };
}

function message(kind: "user" | "assistant" | "system-event" | "human-approval", content: string): AgentMessage {
  if (kind === "user" || kind === "assistant") return { ...base(kind), kind, content };
  if (kind === "system-event") return { ...base(kind), kind, eventKind: content, content };
  return { ...base(kind), kind, requestId: "approval_0001", approved: true, content };
}

function toolCall(id: string, name: string): AgentMessage {
  return { ...base("tool-call"), id: `message_${id}`, kind: "tool-call", call: { id, name, arguments: {} } };
}

function observation(toolCallId: string, toolName: string, content: string): AgentMessage {
  return { ...base("observation"), id: `message_${toolCallId}_result`, kind: "observation", toolCallId, toolName, content, isError: false };
}
