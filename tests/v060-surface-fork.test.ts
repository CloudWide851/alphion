import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentApplication, AgentRunHandle, AgentSessionContract, SessionForkReceipt } from "../src/index.js";
import { forkTuiSession } from "../tui/session-fork.js";
import { PlatformTerminalLauncher, terminalCandidates, type TerminalCandidate, type TerminalLauncher } from "../tui/terminal-launcher.js";
import { AlternateScreenSurface } from "../tui/terminal-surface.js";
import { RunView } from "../tui/run-view.js";
import { TuiApprovalPort } from "../tui/approval-port.js";
import { decodeUiCommandEnvelope, type UiCommandResult } from "../ui/contracts.js";
import { forkAndSelectSession, type SurfaceSession } from "../ui/session-actions.js";

test("UI fork decoder is exact and preserves optional branch selection", () => {
  const command = { kind: "session.fork", sessionId: "session_0001", entryId: "entry_0001", title: "branch", expectedRevision: 7, idempotencyKey: "fork_request_0001" } as const;
  assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_fork_0001", command }).command, command);
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_fork_0002", command: { ...command, projectId: "project_0001" } }), /unknown/ui);
});

test("TUI terminal launcher uses argv candidates and falls back without a shell string", async () => {
  const calls: TerminalCandidate[] = [];
  const launcher = new PlatformTerminalLauncher("alphion.cmd", "win32", async (candidate) => {
    calls.push(candidate);
    if (candidate.executable === "wt.exe") throw new Error("missing");
  });
  const receipt = await launcher.launchSession("session_0001");
  assert.equal(receipt.launched, true);
  assert.equal(receipt.terminal, "cmd.exe");
  assert.deepEqual(receipt.manualCommand, ["alphion.cmd", "tui", "--session", "session_0001"]);
  assert.deepEqual(calls, terminalCandidates("win32", receipt.manualCommand));
});

test("TUI alternate screen clears on entry and restores exactly once", () => {
  let output = "";
  const surface = new AlternateScreenSurface({ write: (value) => { output += String(value); return true; } });
  surface.enter();
  surface.enter();
  assert.equal(output, "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25h");
  surface.restore();
  surface.restore();
  assert.equal(output, "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25h\u001b[?25h\u001b[?1049l");
});

test("TUI fork remains durable when terminal launch fails", async () => {
  const receipt = forkReceipt("session_target_0001");
  const launcher: TerminalLauncher = { launchSession: (sessionId) => Promise.resolve({ launched: false, sessionId, manualCommand: ["alphion", "tui", "--session", sessionId] }) };
  const outcome = await forkTuiSession(fakeSession("idle", receipt), "branch", launcher, "fork_request_0003");
  assert.equal(outcome.receipt.session.id, "session_target_0001");
  assert.match(outcome.message, /Session session_target_0001/u);
  assert.match(outcome.message, /alphion tui --session session_target_0001/u);
  await assert.rejects(() => forkTuiSession(fakeSession("running", receipt), undefined, launcher), /空闲/u);
});

test("RunView reports a newly created Session to the chat shell", async () => {
  const session = fakeSession("idle", forkReceipt("session_unused_0001"));
  const run = fakeRun("session_created_0001");
  const usable = { ...session, id: "session_created_0001", send: () => Promise.resolve(run) } as AgentSessionContract;
  const application = { sessions: { create: () => Promise.resolve(usable) } } as unknown as AgentApplication;
  let selected = "";
  const view = render(React.createElement(RunView, { application, approval: new TuiApprovalPort(), prompt: "hello", onSession: (value) => { selected = value.id; }, onDone: () => undefined, onExit: () => undefined }));
  await waitUntil(() => selected === "session_created_0001");
  assert.equal(selected, "session_created_0001");
  view.unmount();
});

test("RunView survives parent refresh after reporting a newly created Session", async () => {
  let releaseResult!: () => void;
  let cancelCount = 0;
  let completed = "";
  const resultReady = new Promise<void>((resolve) => { releaseResult = resolve; });
  const session = fakeSession("idle", forkReceipt("session_unused_0002"));
  const result = { runId: "run_parent_refresh_0001", sessionId: "session_parent_refresh_0001", status: "completed" as const, finalText: "refresh survived", turns: 1, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 }, grounding: { availableEvidenceIds: [], referencedEvidenceIds: [], missingEvidenceIds: [], unreferencedEvidenceIds: [] } };
  const run = { runId: result.runId, sessionId: result.sessionId, events: { async *[Symbol.asyncIterator]() { await resultReady; } }, result: resultReady.then(() => result), cancel: () => { cancelCount += 1; } } as AgentRunHandle;
  const usable = { ...session, id: result.sessionId, send: () => Promise.resolve(run) } as AgentSessionContract;
  const application = { sessions: { create: () => Promise.resolve(usable) } } as unknown as AgentApplication;
  function Parent(): React.JSX.Element {
    const [selected, setSelected] = React.useState("");
    return React.createElement(RunView, { application, approval: new TuiApprovalPort(), prompt: "hello", onSession: (value: AgentSessionContract) => setSelected(`${value.id}:${Date.now()}`), onDone: (answer: string) => { completed = `${selected}:${answer}`; } });
  }
  const view = render(React.createElement(Parent));
  await waitUntil(() => view.lastFrame()?.includes("等待模型输出") === true);
  assert.equal(cancelCount, 0);
  releaseResult();
  await waitUntil(() => completed.endsWith(":refresh survived"));
  assert.equal(cancelCount, 0);
  assert.match(view.lastFrame() ?? "", /已完成/u);
  view.unmount();
});

test("shared Web/Desktop fork action selects the new Session in the current surface", async () => {
  const source: SurfaceSession = { id: "session_source_0001", title: "source", revision: 4, status: "idle" };
  const target: SurfaceSession = { id: "session_target_0002", title: "source（分支）", revision: 1, status: "idle" };
  let selected = "";
  const execute = (command: Parameters<Parameters<typeof forkAndSelectSession>[0]>[0]): Promise<UiCommandResult> => {
    assert.deepEqual(command, { kind: "session.fork", sessionId: source.id, title: "source（分支）", expectedRevision: 4, idempotencyKey: "fork_request_0004" });
    return Promise.resolve({ schemaVersion: 1, requestId: "request_fork_0004", status: "ok", result: { session: target } });
  };
  assert.equal((await forkAndSelectSession(execute, source, "fork_request_0004", async (sessionId) => { selected = sessionId; })).id, target.id);
  assert.equal(selected, target.id);
  await assert.rejects(() => forkAndSelectSession(execute, { ...source, status: "running" }, "fork_request_0005", async () => undefined), /idle/u);
});

function fakeSession(status: "idle" | "running", receipt: SessionForkReceipt): AgentSessionContract {
  return {
    id: "session_source_0001",
    get: () => Promise.resolve({ schemaVersion: 3, id: "session_source_0001", domainId: "domain_0001", title: "source", revision: 4, status, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auditOnly: false, shapeStatus: "shaped", shapeRevision: 1, shapeDigest: "a".repeat(64) }),
    fork: () => Promise.resolve(receipt),
  } as unknown as AgentSessionContract;
}

function forkReceipt(targetId: string): SessionForkReceipt {
  const provenance = { schemaVersion: 1 as const, sourceSessionId: "session_source_0001", sourceRevision: 4, branchDigest: "b".repeat(64), forkedAt: new Date(0).toISOString() };
  return { session: { schemaVersion: 3, id: targetId, domainId: "domain_0001", title: "branch", revision: 1, status: "idle", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auditOnly: false, shapeStatus: "shaped", shapeRevision: 1, shapeDigest: "c".repeat(64), forkProvenance: provenance }, provenance, entryMapping: [], replayed: false };
}

function fakeRun(sessionId: string): AgentRunHandle {
  const result = { runId: "run_created_0001", sessionId, status: "completed" as const, finalText: "done", turns: 1, toolCalls: 0, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, grounding: { availableEvidenceIds: [], referencedEvidenceIds: [], missingEvidenceIds: [], unreferencedEvidenceIds: [] } };
  return { runId: result.runId, sessionId, events: { async *[Symbol.asyncIterator]() { /* no events */ } }, result: Promise.resolve(result), cancel: () => undefined };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("condition timed out");
}
