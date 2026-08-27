import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ChatEntry } from "../tui/input.js";
import { resolveTuiInput } from "../tui/slash-dispatch.js";
import { decodeUiCommandEnvelope } from "../ui/contracts.js";
import { LocalUiCommandClient } from "../ui/local-command-client.js";
import { SLASH_COMMANDS, formatSlashCommand, matchSlashCommands, parseSlashCommand } from "../ui/slash-commands.js";
import { createConversationRunState, createSubmittedConversationRunState, reduceConversationRun } from "../ui/conversation-run.js";
import type { AgentEvent, AgentEventKind } from "../src/index.js";
import { projectChatRows, selectChatViewport } from "../ui/chat-viewport.js";

test("shared slash registry matches names aliases and descriptions deterministically", () => {
  assert.equal(SLASH_COMMANDS.length, 19);
  assert.deepEqual(matchSlashCommands("/prov").map((item) => item.descriptor.id), ["providers"]);
  assert.equal(matchSlashCommands("/inspect")[0]?.descriptor.id, "profile");
  assert.equal(matchSlashCommands("/凭据")[0]?.descriptor.id, "providers");
  assert.equal(formatSlashCommand(SLASH_COMMANDS.find((item) => item.id === "fork")!, "安全分支"), "/fork 安全分支");
});

test("slash parsing keeps disabled commands visible with stable reasons", () => {
  const fork = parseSlashCommand("/fork next");
  assert.equal(fork.kind, "command");
  if (fork.kind === "command") {
    assert.equal(fork.argument, "next");
    assert.equal(fork.availability.available, false);
    assert.equal(fork.availability.reason, "需要当前 Session");
  }
  const enabled = parseSlashCommand("/followup continue", { hasSession: true });
  assert.equal(enabled.kind, "command");
  if (enabled.kind === "command") assert.deepEqual([enabled.descriptor.id, enabled.argument], ["follow-up", "continue"]);
  const settings = parseSlashCommand("/settings", { activeRunId: "run_0001" });
  assert.equal(settings.kind, "command");
  if (settings.kind === "command") assert.equal(settings.availability.available, true);
  const project = parseSlashCommand("/new project \"C:\\work space\\demo\" --name \"Demo Project\"");
  assert.equal(project.kind, "command");
  if (project.kind === "command") assert.deepEqual([project.descriptor.id, ...project.argumentTokens], ["new-project", "C:\\work space\\demo", "--name", "Demo Project"]);
});

test("TUI slash dispatcher separates commands from Session history messages", () => {
  assert.deepEqual(resolveTuiInput("hello"), { kind: "message", content: "hello" });
  assert.deepEqual(resolveTuiInput("/open sessions"), { kind: "navigate", section: "sessions" });
  assert.deepEqual(resolveTuiInput("/settings"), { kind: "navigate", section: "settings" });
  assert.deepEqual(resolveTuiInput("/new project \"C:\\work space\\demo\" --name Demo"), { kind: "new-project", root: "C:\\work space\\demo", name: "Demo" });
  assert.deepEqual(resolveTuiInput("/steer revise", { activeRunId: "run_0001" }), { kind: "steer", content: "revise" });
  assert.deepEqual(resolveTuiInput("/cancel"), { kind: "error", message: "需要活动 Run" });
});

test("TUI slash palette opens on slash and executes keyboard selection", async () => {
  const submitted: string[] = [];
  const view = render(React.createElement(ChatEntry, { onSubmit: (value: string) => { submitted.push(value); } }));
  view.stdin.write("/");
  await pause();
  assert.match(view.lastFrame() ?? "", /\/new project.*创建或复用 Project/u);
  view.stdin.write("\u001b[B");
  view.stdin.write("\r");
  await pause();
  assert.deepEqual(submitted, ["/open projects"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /\/new project.*创建或复用 Project/u);
  view.unmount();
});

test("project.inspect uses exact schema v1 and delegates to read-only application inspection", async () => {
  const command = decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_inspect_0001", command: { kind: "project.inspect", refresh: true } }).command;
  assert.deepEqual(command, { kind: "project.inspect", refresh: true });
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_inspect_0002", command: { kind: "project.inspect", refresh: "yes" } }), /boolean/u);
  const calls: unknown[] = [];
  const application = {
    sessions: { subscribeActivity: () => ({ async *[Symbol.asyncIterator]() { /* no activity */ } }) },
    inspectProject: (options: unknown) => { calls.push(options); return Promise.resolve({ revision: "r1" }); },
  };
  const client = new LocalUiCommandClient({ application: () => application as never });
  try {
    const result = await client.execute({ schemaVersion: 1, requestId: "request_inspect_0003", command: { kind: "project.inspect", refresh: true } });
    assert.deepEqual(result.result, { revision: "r1" });
    assert.deepEqual(calls, [{ refresh: true }]);
  } finally { await client.close(); }
});

function pause(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 15)); }

test("ConversationRunState projects waiting streaming tool usage and terminal states", () => {
  const submitted = createSubmittedConversationRunState("request_0001");
  assert.equal(submitted.statusText, "准备上下文");
  assert.equal(submitted.runId, "pending:request_0001");
  const waiting = createConversationRunState("run_0001", "session_0001");
  assert.deepEqual([waiting.status, waiting.firstTokenReceived, waiting.text], ["waiting", false, ""]);
  const streaming = reduceConversationRun(waiting, { kind: "delta", delta: "hello" });
  assert.deepEqual([streaming.status, streaming.firstTokenReceived, streaming.text], ["streaming", true, "hello"]);
  const tool = reduceConversationRun(streaming, { kind: "agent-event", event: agentEvent("tool.requested", { toolName: "read" }) });
  assert.deepEqual([tool.status, tool.statusText], ["tool", "read 执行中"]);
  const usage = reduceConversationRun(tool, { kind: "agent-event", event: agentEvent("model.usage", { usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } }) });
  assert.deepEqual(usage.usage, { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 });
  const completed = reduceConversationRun(usage, { kind: "finish", status: "completed", finalText: "fallback" });
  assert.deepEqual([completed.status, completed.text], ["completed", "hello"]);
});

test("ConversationRunState requires a start and strips controls from failures", () => {
  assert.throws(() => reduceConversationRun(undefined, { kind: "delta", delta: "orphan" }), /must start/u);
  const failed = reduceConversationRun(createConversationRunState("run_0002", "session_0002"), { kind: "error", message: "bad\u001b[2J" });
  assert.deepEqual([failed.status, failed.statusText], ["failed", "bad[2J"]);
});

test("shared chat viewport scrolls deterministic wrapped rows", () => {
  const rows = projectChatRows([{ id: "user_1", role: "user", displayText: "123456789" }, { id: "agent_1", role: "assistant", displayText: "answer" }], 4);
  const latest = selectChatViewport(rows, 4, 0);
  assert.equal(latest.offset, 0);
  assert.equal(latest.segments.at(-1)?.role, "assistant");
  const history = selectChatViewport(rows, 4, 2);
  assert.equal(history.offset, 2);
  assert.ok(history.segments.some((segment) => segment.role === "user"));
});

function agentEvent(kind: AgentEventKind, payload: Readonly<Record<string, unknown>>): AgentEvent {
  return { schemaVersion: 2, eventId: "event_0001", sequence: 1, sessionSequence: 1, runId: "run_0001", sessionId: "session_0001", correlationId: "correlation_0001", timestamp: new Date(0).toISOString(), kind, payload, previousDigest: "0".repeat(64), digest: "1".repeat(64) };
}
