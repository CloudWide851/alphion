import assert from "node:assert/strict";
import { test } from "node:test";
import { frameEvents, historyFrames, resyncFrame, UiFrameQueue } from "../ui/event-frames.js";
import type { UiEventEnvelope } from "../ui/contracts.js";
import { LocalUiCommandClient } from "../ui/local-command-client.js";

test("UI frames coalesce run deltas and Session invalidations with cursor ranges", () => {
  const frame = frameEvents([
    event(1, { kind: "run.delta", runId: "run-1", sessionId: "session-1", delta: "a" }),
    event(2, { kind: "run.delta", runId: "run-1", sessionId: "session-1", delta: "b" }),
    event(3, { kind: "surface.invalidate", scopes: ["sessions"], sessionIds: ["session-1"] }),
    event(4, { kind: "surface.invalidate", scopes: ["session-view"], sessionIds: ["session-2"] }),
  ]);
  assert.equal(frame?.cursorStart, 1);
  assert.equal(frame?.cursorEnd, 4);
  assert.equal(frame?.events.length, 2);
  assert.deepEqual(frame?.events[0]?.payload, { kind: "run.delta", runId: "run-1", sessionId: "session-1", delta: "ab" });
  assert.deepEqual(frame?.events[1]?.payload, { kind: "surface.invalidate", scopes: ["sessions", "session-view"], sessionIds: ["session-1", "session-2"] });
});

test("frame history is bounded and slow consumers can be replaced with resync", async () => {
  const events = Array.from({ length: 1_000 }, (_, index) => event(index + 1, { kind: "run.delta", runId: `run-${index % 4}`, sessionId: "session-1", delta: "x".repeat(64) }));
  const history = historyFrames(events);
  assert.equal(history.length, 16);
  assert.equal(history.at(-1)?.cursorEnd, 1_000);
  const queue = new UiFrameQueue();
  for (let index = 0; index < 256; index += 1) assert.equal(queue.offer(frameEvents([event(index + 1, { kind: "run.delta", runId: `run-${index}`, sessionId: "session-1", delta: "x" })])!), true);
  const overflow = frameEvents([event(300, { kind: "approval.challenge", requestId: "approval-1", runId: "run-1", toolName: "write", actionDigest: "a".repeat(64), summary: "approve" })])!;
  assert.equal(queue.offer(overflow), false);
  queue.replace(resyncFrame(300));
  const next = await queue.next();
  assert.equal(next.value?.events[0]?.payload.kind, "stream.resync-required");
  queue.close();
});

test("Local UI snapshot returns one watermark and selected Session view", async () => {
  const session = { schemaVersion: 3 as const, id: "session-0001", domainId: "domain-0001", title: "selected", revision: 1, status: "idle" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), auditOnly: false, shapeStatus: "shaped" as const, shapeRevision: 1, shapeDigest: "a".repeat(64) };
  const application = { sessions: { list: () => Promise.resolve([session]), view: () => Promise.resolve({ session, entries: [] }) } };
  const client = new LocalUiCommandClient({ application: () => application as never });
  try {
    const result = await client.execute({ schemaVersion: 1, requestId: "request-snapshot-0001", command: { kind: "surface.snapshot", selectedSessionId: session.id } });
    const snapshot = result.result as { cursor: number; selectedSessionId?: string; selectedView?: { session: { id: string } } };
    assert.equal(snapshot.cursor, 0);
    assert.equal(snapshot.selectedSessionId, session.id);
    assert.equal(snapshot.selectedView?.session.id, session.id);
  } finally { await client.close(); }
});

function event(cursor: number, payload: UiEventEnvelope["payload"]): UiEventEnvelope {
  return Object.freeze({ schemaVersion: 1, cursor, timestamp: new Date(cursor).toISOString(), payload });
}
