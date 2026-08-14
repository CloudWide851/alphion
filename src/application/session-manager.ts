import type { AgentSessionRecord, AgentShape, AgentShapeReceipt, AgentShapeRequest, SessionForkReceipt, SessionForkRequest, SessionMessageReceipt, SessionMessageRequest, SessionView, SessionWriteOptions, SessionWriteReceipt } from "../domain/contracts.js";
import type { AgentRunHandle, AgentSessionContract, ApprovalPort, SessionManager, SessionStore } from "../ports/index.js";
import type { AgentStreamEvent } from "../protocol/events.js";
import type { CompactionProjection, CompactionRecord } from "../domain/compaction-contracts.js";
import { createId } from "./canonical.js";
import { AlphionError } from "./errors.js";
import { BoundedEventChannel } from "./event-channel.js";
import type { SessionActivity } from "../domain/session-activity.js";

export interface DefaultSessionManagerOptions {
  readonly store: SessionStore;
  readonly session: (sessionId: string, publishActivity: (activity: SessionActivity) => void) => AgentSessionContract;
  readonly assertOpen: () => void;
}

export class DefaultSessionManager implements SessionManager {
  readonly #sessions = new Map<string, AgentSessionContract>();
  readonly #ownedTasks = new Set<Promise<unknown>>();
  readonly #activitySubscribers = new Set<BoundedEventChannel<SessionActivity>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(private readonly options: DefaultSessionManagerOptions) {}

  create(input: Readonly<{ title?: string; providerId?: string; idempotencyKey?: string }> = {}): Promise<AgentSessionContract> {
    this.options.assertOpen();
    return this.#own(this.#create(input));
  }

  async #create(input: Readonly<{ title?: string; providerId?: string; idempotencyKey?: string }>): Promise<AgentSessionContract> {
    const record = await this.options.store.createSession({ title: input.title ?? "新会话", ...(input.providerId ? { providerId: input.providerId } : {}), idempotencyKey: input.idempotencyKey ?? createId("command") });
    return this.#session(record.id);
  }

  list(): Promise<readonly AgentSessionRecord[]> { this.options.assertOpen(); return this.#own(this.options.store.listSessions()); }
  fork(request: SessionForkRequest): Promise<SessionForkReceipt> { this.options.assertOpen(); return this.#own(this.#get(request.sourceSessionId).then((session) => session.fork(request))); }

  get(sessionId: string): Promise<AgentSessionContract> {
    this.options.assertOpen();
    return this.#own(this.#get(sessionId));
  }

  async #get(sessionId: string): Promise<AgentSessionContract> {
    if (!await this.options.store.getSession(sessionId)) throw new AlphionError("validation", `Unknown session: ${sessionId}`, { stage: "session" });
    return this.#session(sessionId);
  }

  view(sessionId: string): Promise<SessionView> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.view())); }
  listCompactions(sessionId: string, limit?: number): Promise<readonly CompactionRecord[]> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.listCompactions(limit))); }
  getCompaction(sessionId: string, compactionId: string): Promise<CompactionRecord | undefined> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.getCompaction(compactionId))); }
  getCompactionProjection(sessionId: string): Promise<CompactionProjection> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.compactionProjection())); }
  getShape(sessionId: string): Promise<AgentShape | undefined> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.getShape())); }
  reshape(sessionId: string, request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.reshape(request, options))); }
  checkout(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.checkout(entryId, options))); }
  send(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.send(content, options, approval))); }
  steer(sessionId: string, content: string, options: SessionWriteOptions): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.steer(content, options))); }
  followUp(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.followUp(content, options, approval))); }
  deliver(request: SessionMessageRequest): Promise<SessionMessageReceipt> { this.options.assertOpen(); return this.#own(this.#deliver(request)); }

  async #deliver(request: SessionMessageRequest): Promise<SessionMessageReceipt> {
    const receipt = await this.options.store.deliverSessionMessage(request);
    if (receipt.delivery === "follow-up") this.#session(receipt.targetSessionId).resumePending(DENY_UNATTENDED_APPROVAL);
    return receipt;
  }
  subscribe(sessionId: string, afterSessionSequence = 0): AsyncIterable<AgentStreamEvent> {
    this.options.assertOpen();
    const subscription = this.#own(this.#get(sessionId).then((session) => session.subscribe(afterSessionSequence)));
    return { async *[Symbol.asyncIterator]() { yield* await subscription; } };
  }

  subscribeActivity(): AsyncIterable<SessionActivity> {
    this.options.assertOpen();
    const channel = activityChannel();
    this.#activitySubscribers.add(channel);
    const subscribers = this.#activitySubscribers;
    return { async *[Symbol.asyncIterator]() { try { yield* channel; } finally { subscribers.delete(channel); channel.close(); } } };
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const channel of this.#activitySubscribers) channel.close();
    this.#activitySubscribers.clear();
    this.#closePromise = (async () => {
      while (this.#ownedTasks.size > 0) {
        await Promise.allSettled([...this.#ownedTasks]);
      }
      await Promise.allSettled([...this.#sessions.values()].map((session) => session.close()));
    })();
    return this.#closePromise;
  }

  #session(sessionId: string): AgentSessionContract {
    const cached = this.#sessions.get(sessionId);
    if (cached) return cached;
    const session = this.options.session(sessionId, (activity) => this.#publishActivity(activity));
    this.#sessions.set(sessionId, session);
    if (this.#closed) void session.close();
    return session;
  }

  #own<T>(task: Promise<T>): Promise<T> {
    this.#ownedTasks.add(task);
    void task.finally(() => this.#ownedTasks.delete(task)).catch(() => undefined);
    return task;
  }

  #publishActivity(activity: SessionActivity): void {
    for (const channel of this.#activitySubscribers) {
      const merge = activity.kind === "run.event" && !("delivery" in activity.event) && activity.event.kind === "model.delta"
        ? (previous: SessionActivity) => mergeActivityDelta(previous, activity)
        : undefined;
      const accepted = channel.offer(activity, activity.kind === "run.finished", merge);
      if (!accepted) channel.replace(Object.freeze({
        kind: "stream.resync-required",
        ...("sessionId" in activity ? { sessionId: activity.sessionId } : {}),
      }));
    }
  }
}

const DENY_UNATTENDED_APPROVAL: ApprovalPort = Object.freeze({
  revision: "unattended-deny-v1",
  requestApproval: () => Promise.resolve(Object.freeze({ approved: false, reason: "No approval client is attached to this automatically started Run." })),
});

function activityChannel(): BoundedEventChannel<SessionActivity> {
  return new BoundedEventChannel<SessionActivity>(256, { maxBytes: 1024 * 1024, measure: (activity) => Buffer.byteLength(JSON.stringify(activity), "utf8") });
}

function mergeActivityDelta(previous: SessionActivity, next: Extract<SessionActivity, { readonly kind: "run.event" }>): SessionActivity | undefined {
  if (previous.kind !== "run.event" || previous.runId !== next.runId || "delivery" in previous.event || "delivery" in next.event || previous.event.kind !== "model.delta" || next.event.kind !== "model.delta") return undefined;
  const left = typeof previous.event.payload.delta === "string" ? previous.event.payload.delta : "";
  const right = typeof next.event.payload.delta === "string" ? next.event.payload.delta : "";
  return Object.freeze({ ...next, event: Object.freeze({ ...next.event, payload: Object.freeze({ ...next.event.payload, delta: `${left}${right}` }) }) });
}
