import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiApprovalPort } from "../tui/approval-port.js";
import { AppShell, ChatEntry, ChatHome, HarnessPlanView, ProviderForm, ProviderList, SessionWorkbenchView, TextEntry, selectWorkbenchLayout } from "../tui/index.js";
import type { AgentApplication, AgentSessionContract } from "../src/index.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "../tui/run-projection.js";

const IMAGE_REF = Object.freeze({ schemaVersion: 1 as const, id: "attachment_tui_0001", domainId: "domain_tui_0001", digest: "b".repeat(64), mediaType: "image/png" as const, byteSize: 8, width: 1, height: 1, fileName: "pasted.png" });

test("TUI strips terminal controls without exposing reasoning", () => {
  assert.equal(sanitizeTerminalText("safe\u001b[31m red\u0000"), "safe[31m red");
  const running = reduceRunProjection(EMPTY_RUN_PROJECTION, { type: "reset" });
  const answered = reduceRunProjection(running, { type: "answer-delta", delta: "observed answer" });
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
  assert.doesNotMatch(view.lastFrame() ?? "", /•+/u);
  view.stdin.write("next-secret");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame() ?? "", /•+/u);
  view.unmount();
});

test("TUI entry resets when its purpose changes and preserves ordinary drafts after submit", async () => {
  const submitted: string[] = [];
  const view = render(React.createElement(TextEntry, { label: "名称", onSubmit: (value: string) => submitted.push(value) }));
  view.stdin.write("draft");
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(submitted, ["draft"]);
  assert.match(view.lastFrame() ?? "", /draft/u);
  view.rerender(React.createElement(TextEntry, { label: "模型", onSubmit: (value: string) => submitted.push(value) }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(view.lastFrame() ?? "", /draft/u);
  view.unmount();
});

test("provider list keyboard navigation dispatches adapter intents", async () => {
  let selected = 0;
  let created = 0;
  const profile = {
    schemaVersion: 3 as const,
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek" as const,
    presetId: "deepseek",
    model: "deepseek-chat",
    protocol: "chat-completions" as const,
    auth: { mode: "none" as const },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false },
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
    onTest: () => undefined,
    onTestAll: () => undefined,
    onRun: () => undefined,
    onExit: () => undefined,
  }));
  view.stdin.write("n");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(created, 1);
  assert.match(view.lastFrame() ?? "", /DeepSeek/);
  view.unmount();
});

test("built-in Provider form saves without asking for a Base URL", async () => {
  let saved: unknown;
  const view = render(React.createElement(ProviderForm, {
    draft: { presetId: "kimi", name: "Kimi", kind: "kimi", protocol: "chat-completions", model: "moonshot-v1-8k", catalogModels: ["moonshot-v1-8k", "kimi-k2-0711-preview"] },
    presets: [],
    onSave: (value: unknown) => { saved = value; },
    onCancel: () => undefined,
  }));
  assert.doesNotMatch(view.lastFrame() ?? "", /Base URL/u);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame() ?? "", /catalog|moonshot-v1-8k/u);
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(saved, { presetId: "kimi", name: "Kimi", kind: "kimi", protocol: "chat-completions", model: "moonshot-v1-8k", catalogModels: ["moonshot-v1-8k", "kimi-k2-0711-preview"], contextWindowTokens: 32_768, vision: false });
  assert.doesNotMatch(view.lastFrame() ?? "", /Base URL/u);
  view.unmount();
});

test("TUI chat shell selects wide, narrow and compact layouts without the workbench sidebar", () => {
  assert.equal(selectWorkbenchLayout(120, 30), "wide");
  assert.equal(selectWorkbenchLayout(99, 30), "narrow");
  assert.equal(selectWorkbenchLayout(120, 17), "compact");
  const view = render(React.createElement(AppShell, {
    section: "home",
    layout: "wide",
    colorEnabled: false,
    projectRoot: "C:\\项目\\alphion",
    children: React.createElement(ChatHome, { compact: false, onSubmit: () => undefined }),
  }));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /ALPHION/u);
  assert.match(frame, /请输入内容/u);
  assert.doesNotMatch(frame, /工程工作台|首页概览|HarnessPlan/u);
  view.unmount();
});

test("TUI chat viewport keeps the composer fixed and scrolls history by line", async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: `message_${index}`, role: (index % 2 ? "assistant" : "user") as "user" | "assistant", content: `line ${index}\nmore ${index}` }));
  const view = render(React.createElement(ChatHome, { compact: true, heightRows: 12, viewportRows: 4, contentWidth: 30, messages, onSubmit: () => undefined }));
  assert.match(view.lastFrame() ?? "", /请输入内容/u);
  assert.match(view.lastFrame() ?? "", /line 7/u);
  view.stdin.write("\u001b[A");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(view.lastFrame() ?? "", /正在查看历史/u);
  assert.match(view.lastFrame() ?? "", /请输入内容/u);
  view.stdin.write("\u001b[4~");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.doesNotMatch(view.lastFrame() ?? "", /正在查看历史/u);
  view.unmount();
});

test("TUI chat input clears after every successful send", async () => {
  const submitted: string[] = [];
  const view = render(React.createElement(ChatEntry, { onSubmit: (value: string) => { submitted.push(value); } }));
  view.stdin.write("first message");
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(submitted, ["first message"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /first message/u);
  view.unmount();
});

test("TUI image drafts render placeholders and support paste and empty-input removal", async () => {
  let pasted = 0; let removed = 0;
  const view = render(React.createElement(ChatEntry, { attachments: [IMAGE_REF], onPasteImage: () => { pasted += 1; }, onRemoveLastAttachment: () => { removed += 1; }, onSubmit: () => undefined }));
  assert.match(view.lastFrame() ?? "", /\[图片 1：pasted\.png\]/u);
  assert.match(view.lastFrame() ?? "", /请输入内容/u);
  view.stdin.write("\u007f"); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(removed, 1);
  view.stdin.write("\u0016"); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(pasted, 1);
  view.unmount();
  const history = render(React.createElement(ChatHome, { compact: true, messages: [{ id: "image-message", role: "user", content: "", attachments: [IMAGE_REF] }], onSubmit: () => undefined }));
  assert.match(history.lastFrame() ?? "", /\[图片 1：pasted\.png\]/u); history.unmount();
});

test("TUI controlled chat input restores a Project and Session scoped draft", async () => {
  const submitted: string[] = [];
  function Controlled(): React.JSX.Element { const [value, setValue] = React.useState("已保存草稿"); return React.createElement(ChatEntry, { value, onChange: setValue, onSubmit: (next: string) => { submitted.push(next); } }); }
  const view = render(React.createElement(Controlled));
  assert.match(view.lastFrame() ?? "", /已保存草稿/u);
  view.stdin.write("继续"); view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(submitted, ["已保存草稿继续"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /已保存草稿|继续/u);
  view.unmount();
});

test("TUI exposes session create/show/send/checkout and HarnessPlan workflows", async () => {
  const calls: string[] = [];
  const record = { schemaVersion: 3 as const, id: "session-1", domainId: "domain-test", title: "共享工作", revision: 3, status: "idle" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auditOnly: false, shapeStatus: "unshaped" as const };
  const session = { id: record.id, get: () => Promise.resolve(record), view: () => Promise.resolve({ session: record, entries: [] }), getShape: () => Promise.resolve(undefined), reshape: async () => ({ sessionId: record.id, revision: 4, shapeRevision: 1, shapeDigest: "a".repeat(64), replayed: false }), fork: async () => { throw new Error("unused"); }, checkout: () => { calls.push("checkout"); return Promise.resolve({ sessionId: record.id, revision: 4, replayed: false }); }, send: async () => { throw new Error("unused"); }, steer: async () => { throw new Error("unused"); }, followUp: async () => { throw new Error("unused"); }, resumePending: () => undefined, subscribe: async function* () { /* empty */ }, listCompactions: () => Promise.resolve([]), getCompaction: () => Promise.resolve(undefined), compactionProjection: () => Promise.resolve({ count: 0 }), close: () => Promise.resolve() } satisfies AgentSessionContract;
  const app = { sessions: { list: () => Promise.resolve([record]), get: () => Promise.resolve(session), create: () => { calls.push("create"); return Promise.resolve(session); } }, planHarness: () => Promise.resolve({ schemaVersion: 1 as const, task: "diagnose" as const, taskLabels: ["diagnose" as const], risk: "low" as const, capabilities: ["project.read"], reasons: [], permissions: ["project:read"], budgets: { operations: 1 }, evaluator: "quality-gate", omissions: [], digest: "digest" }) } as unknown as AgentApplication;
  const sessions = render(React.createElement(SessionWorkbenchView, { application: app, approval: { revision: "test", requestApproval: () => Promise.resolve({ approved: false, reason: "test" }) }, onSend: () => calls.push("send"), onError: (cause: unknown) => { throw cause; } }));
  await waitUntil(() => /共享工作/u.test(sessions.lastFrame() ?? ""));
  assert.match(sessions.lastFrame() ?? "", /共享工作/u);
  assert.match(sessions.lastFrame() ?? "", /创建.*查看.*checkout.*发送/u);
  sessions.unmount();
  const harness = render(React.createElement(HarnessPlanView, { application: app, onError: (cause: unknown) => { throw cause; } }));
  harness.stdin.write("diagnose\r");
  await waitUntil(() => /HarnessPlan|任务 diagnose|project\.read/u.test(harness.lastFrame() ?? ""));
  assert.match(harness.lastFrame() ?? "", /HarnessPlan|任务 diagnose|project\.read/u);
  harness.unmount();
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}
