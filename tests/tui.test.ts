import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { TuiApprovalPort } from "../tui/approval-port.js";
import { AppShell, ProviderList, TextEntry, selectWorkbenchLayout } from "../tui/index.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "../tui/run-projection.js";

test("TUI strips terminal controls and keeps reasoning separate from the answer", () => {
  assert.equal(sanitizeTerminalText("safe\u001b[31m red\u0000"), "safe[31m red");
  const running = reduceRunProjection(EMPTY_RUN_PROJECTION, { type: "reset" });
  const reasoned = reduceRunProjection(running, { type: "reasoning-delta", delta: "private\u001b[2J thought" });
  const answered = reduceRunProjection(reasoned, { type: "answer-delta", delta: "observed answer" });
  assert.equal(answered.reasoning, "private[2J thought");
  assert.equal(answered.answer, "observed answer");
  const failed = reduceRunProjection(answered, { type: "run-error", message: "failed\u001b[2J safely" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "failed[2J safely");
});

test("TUI approval port resolves only the displayed exact request", async () => {
  const port = new TuiApprovalPort();
  let decide: ((approved: boolean) => void) | undefined;
  port.subscribe((pending) => { decide = pending?.decide; });
  const result = port.requestApproval(
    {
      requestId: "approval_1",
      runId: "run_1",
      toolName: "write",
      risk: "write",
      actionDigest: "a".repeat(64),
      summary: "write: exact payload",
      input: { path: "file.txt" },
    },
    new AbortController().signal,
  );
  assert.ok(decide);
  decide(true);
  assert.deepEqual(await result, { approved: true, reason: "Approved in the TUI for this exact invocation." });
});

test("masked TUI entry never renders the entered credential", async () => {
  let submitted = "";
  const view = render(React.createElement(TextEntry, {
    label: "API key",
    masked: true,
    onSubmit: (value: string) => { submitted = value; },
  }));
  view.stdin.write("secret-value");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(view.lastFrame() ?? "", /secret-value/);
  assert.match(view.lastFrame() ?? "", /•+/u);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(submitted, "secret-value");
  view.unmount();
});

test("provider list keyboard navigation dispatches adapter intents", async () => {
  let selected = 0;
  let created = 0;
  const profile = {
    schemaVersion: 2 as const,
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek" as const,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    protocol: "chat-completions" as const,
    auth: { mode: "none" as const },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
    revision: 1,
    active: true,
  };
  const view = render(React.createElement(ProviderList, {
    profiles: [profile],
    selected,
    onSelected: (value: number) => { selected = value; },
    onNew: () => { created += 1; },
    onEdit: () => undefined,
    onActivate: () => undefined,
    onCredential: () => undefined,
    onRemoveCredential: () => undefined,
    onRun: () => undefined,
    onLock: () => undefined,
    onExit: () => undefined,
  }));
  view.stdin.write("n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(created, 1);
  assert.match(view.lastFrame() ?? "", /DeepSeek/);
  view.unmount();
});

test("TUI workbench selects wide, narrow and compact layouts and renders Chinese navigation without color", () => {
  assert.equal(selectWorkbenchLayout(120, 30), "wide");
  assert.equal(selectWorkbenchLayout(99, 30), "narrow");
  assert.equal(selectWorkbenchLayout(120, 17), "compact");
  const view = render(React.createElement(AppShell, {
    section: "profile",
    layout: "wide",
    colorEnabled: false,
    projectRoot: "C:\\项目\\alphion",
    children: React.createElement(Text, null, "画像内容"),
  }));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /工程工作台/);
  assert.match(frame, /项目画像/);
  assert.match(frame, /只读诊断/);
  assert.match(frame, /画像内容/);
  view.unmount();
});
