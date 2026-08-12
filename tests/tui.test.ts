import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { TuiApprovalPort } from "../tui/approval-port.js";
import { AppShell, HarnessPlanView, ProviderList, SessionWorkbenchView, TextEntry, selectWorkbenchLayout } from "../tui/index.js";
import type { AgentApplication, AgentSessionContract } from "../src/index.js";
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
  assert.match(frame, /共享会话/);
  assert.match(frame, /HarnessPlan/);
  assert.match(frame, /画像内容/);
  view.unmount();
});

test("TUI exposes session create/show/send/checkout and HarnessPlan workflows", async () => {
  const calls: string[] = [];
  const record = { schemaVersion: 1 as const, id: "session-1", title: "共享工作", revision: 3, status: "idle" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auditOnly: false, shapeStatus: "unshaped" as const };
  const session = { id: record.id, get: () => Promise.resolve(record), view: () => Promise.resolve({ session: record, entries: [] }), getShape: () => Promise.resolve(undefined), reshape: async () => ({ sessionId: record.id, revision: 4, shapeRevision: 1, shapeDigest: "a".repeat(64), replayed: false }), checkout: () => { calls.push("checkout"); return Promise.resolve({ sessionId: record.id, revision: 4, replayed: false }); }, send: async () => { throw new Error("unused"); }, steer: async () => { throw new Error("unused"); }, followUp: async () => { throw new Error("unused"); }, subscribe: async function* () { /* empty */ }, close: () => Promise.resolve() } satisfies AgentSessionContract;
  const app = { sessions: { list: () => Promise.resolve([record]), get: () => Promise.resolve(session), create: () => { calls.push("create"); return Promise.resolve(session); } }, planHarness: () => Promise.resolve({ schemaVersion: 1 as const, task: "diagnose" as const, taskLabels: ["diagnose" as const], risk: "low" as const, capabilities: ["project.read"], reasons: [], permissions: ["project:read"], budgets: { operations: 1 }, evaluator: "quality-gate", omissions: [], digest: "digest" }) } as unknown as AgentApplication;
  const sessions = render(React.createElement(SessionWorkbenchView, { application: app, approval: { revision: "test", requestApproval: () => Promise.resolve({ approved: false, reason: "test" }) }, onSend: () => calls.push("send"), onError: (cause: unknown) => { throw cause; } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(sessions.lastFrame() ?? "", /共享工作/u);
  assert.match(sessions.lastFrame() ?? "", /创建.*查看.*checkout.*发送/u);
  sessions.unmount();
  const harness = render(React.createElement(HarnessPlanView, { application: app, onError: (cause: unknown) => { throw cause; } }));
  harness.stdin.write("diagnose\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.lastFrame() ?? "", /HarnessPlan|任务 diagnose|project\.read/u);
  harness.unmount();
});
