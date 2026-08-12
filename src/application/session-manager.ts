import type { AgentSessionRecord, AgentShape, AgentShapeReceipt, AgentShapeRequest, SessionView, SessionWriteOptions, SessionWriteReceipt } from "../domain/contracts.js";
import type { AgentRunHandle, AgentSessionContract, ApprovalPort, SessionManager, SessionStore } from "../ports/index.js";
import type { AgentStreamEvent } from "../protocol/events.js";
import { createId } from "./canonical.js";
import { AlphionError } from "./errors.js";

export interface DefaultSessionManagerOptions {
  readonly store: SessionStore;
  readonly session: (sessionId: string) => AgentSessionContract;
  readonly assertOpen: () => void;
}

export class DefaultSessionManager implements SessionManager {
  readonly #sessions = new Map<string, AgentSessionContract>();
  readonly #ownedTasks = new Set<Promise<unknown>>();
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

  get(sessionId: string): Promise<AgentSessionContract> {
    this.options.assertOpen();
    return this.#own(this.#get(sessionId));
  }

  async #get(sessionId: string): Promise<AgentSessionContract> {
    if (!await this.options.store.getSession(sessionId)) throw new AlphionError("validation", `Unknown session: ${sessionId}`, { stage: "session" });
    return this.#session(sessionId);
  }

  view(sessionId: string): Promise<SessionView> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.view())); }
  getShape(sessionId: string): Promise<AgentShape | undefined> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.getShape())); }
  reshape(sessionId: string, request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.reshape(request, options))); }
  checkout(sessionId: string, entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.checkout(entryId, options))); }
  send(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.send(content, options, approval))); }
  steer(sessionId: string, content: string, options: SessionWriteOptions): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.steer(content, options))); }
  followUp(sessionId: string, content: string, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt> { this.options.assertOpen(); return this.#own(this.#get(sessionId).then((session) => session.followUp(content, options, approval))); }
  subscribe(sessionId: string, afterSessionSequence = 0): AsyncIterable<AgentStreamEvent> {
    this.options.assertOpen();
    const subscription = this.#own(this.#get(sessionId).then((session) => session.subscribe(afterSessionSequence)));
    return { async *[Symbol.asyncIterator]() { yield* await subscription; } };
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
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
    const session = this.options.session(sessionId);
    this.#sessions.set(sessionId, session);
    if (this.#closed) void session.close();
    return session;
  }

  #own<T>(task: Promise<T>): Promise<T> {
    this.#ownedTasks.add(task);
    void task.finally(() => this.#ownedTasks.delete(task)).catch(() => undefined);
    return task;
  }
}
