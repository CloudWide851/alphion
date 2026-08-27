import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DefaultSessionManager } from "../src/application/session-manager.js";
import type { AgentSessionRecord } from "../src/domain/contracts.js";
import type { SessionActivity } from "../src/domain/session-activity.js";
import type { AgentSessionContract, SessionStore } from "../src/ports/index.js";
import type { AgentEvent } from "../src/protocol/events.js";
import { decodeUiCommandEnvelope, type UiCommandClient } from "../ui/contracts.js";
import { matchSlashCommands } from "../ui/slash-commands.js";
import { createWebUiServer } from "../webui/server.js";

test("v0.8 shared slash commands and automation envelopes decode centrally", () => {
  const names = matchSlashCommands("/").map((item) => item.descriptor.id);
  for (const name of ["context", "goals", "goal", "schedules"] as const) assert.ok(names.includes(name));
  const cases = [
    { kind: "session.compaction.list", sessionId: "session_0001", limit: 20 },
    { kind: "goal.create", title: "Release", rootGoal: "Ship", acceptanceCriteria: ["verified"], idempotencyKey: "goal_create_0001" },
    { kind: "goal.progress", goalId: "goal_0001", progress: "done", evidenceIds: [], expectedRevision: 1, idempotencyKey: "goal_progress_0001" },
    { kind: "schedule.create", title: "Review", expression: { kind: "cron", expression: "0 9 * * 1" }, timezone: "Asia/Hong_Kong", payload: { kind: "goal.review", goalId: "goal_0001" }, idempotencyKey: "schedule_create_0001" },
  ];
  for (const command of cases) assert.deepEqual(decodeUiCommandEnvelope({ schemaVersion: 1, requestId: `request_${command.kind.replaceAll(".", "_")}`, command }).command, command);
  assert.throws(() => decodeUiCommandEnvelope({ schemaVersion: 1, requestId: "request_bad_goal", command: { ...cases[1], actor: "agent" } }), /unknown .*field/iu);
});

test("Web favicon routes use image MIME types and canonical brand copies", async () => {
  const client: UiCommandClient = {
    execute: () => Promise.reject(new Error("unused")),
    subscribe: () => ({ async *[Symbol.asyncIterator]() { /* unused */ } }),
    importProviderCredential: () => Promise.reject(new Error("unused")),
    decideApproval: () => undefined,
    close: () => Promise.resolve(),
  };
  const server = await createWebUiServer({ client, assetsRoot: "webui/client/public" });
  try {
    const png = await fetch(`${server.origin}/favicon-32.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await png.arrayBuffer()).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const svg = await fetch(`${server.origin}/favicon.svg`);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.deepEqual(await svg.text(), await readFile("alphion-icon.svg", "utf8"));
  } finally { await server.close(); }
  const html = await readFile("webui/client/index.html", "utf8");
  const renderer = await readFile("webui/client/src/main.tsx", "utf8");
  const desktop = await readFile("desktop/main.ts", "utf8");
  const builder = await readFile("electron-builder.yml", "utf8");
  assert.match(html, /favicon\.svg/u);
  assert.match(renderer, /alphion-icon\.svg/u);
  assert.match(desktop, /assets["'],\s*["']alphion\.png/u);
  assert.match(builder, /icon:\s*alphion\.ico/u);
});

test("Session activity fan-out is bounded, non-blocking, and requests resync for a slow surface", async () => {
  const record: AgentSessionRecord = { schemaVersion: 3, id: "session_activity", domainId: "domain_activity", projectId: "project_activity", title: "Activity", revision: 1, status: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", auditOnly: false, shapeStatus: "shaped", shapeRevision: 1, shapeDigest: "a".repeat(64) };
  let publish: ((activity: SessionActivity) => void) | undefined;
  const store = { getSession: () => Promise.resolve(record) } as unknown as SessionStore;
  const manager = new DefaultSessionManager({ store, assertOpen: () => undefined, session: (id, emit) => { publish = emit; return { id, close: () => Promise.resolve() } as unknown as AgentSessionContract; } });
  await manager.get(record.id);
  const subscription = manager.subscribeActivity();
  const iterator = subscription[Symbol.asyncIterator]();
  const started = performance.now();
  for (let index = 1; index <= 1_000; index += 1) publish?.({ kind: "run.event", sessionId: record.id, runId: "run_activity", event: event(index) });
  assert.ok(performance.now() - started < 250);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.kind, "stream.resync-required");
  assert.equal(first.value?.sessionId, record.id);
  await iterator.return?.();
  await manager.close();
});

function event(sequence: number): AgentEvent {
  return { schemaVersion: 2, eventId: `event_${sequence}`, sequence, sessionSequence: sequence, runId: "run_activity", sessionId: "session_activity", correlationId: "correlation_activity", timestamp: new Date(sequence).toISOString(), kind: "run.started", payload: {}, previousDigest: sequence === 1 ? "" : "a".repeat(64), digest: "b".repeat(64) };
}
