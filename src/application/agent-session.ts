import type { AgentMessage, AgentRunResult, AgentSessionRecord, AgentShape, AgentShapeReceipt, AgentShapeRequest, CollaborationContext, HarnessPlan, SessionForkReceipt, SessionForkRequest, SessionMessageReceipt, SessionMessageRequest, SessionView, SessionWriteOptions, SessionWriteReceipt } from "../domain/contracts.js";
import type { AgentContract, AgentRunHandle, AgentSessionContract, ApprovalPort, CodeRecall, ModelResolver, SessionStore } from "../ports/index.js";
import type { AgentStreamEvent } from "../protocol/events.js";
import { BoundedEventChannel } from "./event-channel.js";
import { AlphionError } from "./errors.js";
import { compactSessionEntriesForModel } from "./compaction.js";
import { createId } from "./canonical.js";
import { canonicalJson } from "./canonical.js";
import { sanitizeRecord } from "./sensitive-data.js";
import type { ProjectProfile } from "../domain/contracts.js";
import type { AgentEnvironment } from "../domain/contracts.js";
import type { CompactionProjection, CompactionRecord } from "../domain/compaction-contracts.js";
import type { SessionActivity } from "../domain/session-activity.js";
import type { SessionMessageInput } from "../domain/attachment-contracts.js";
import { createUserMessage, normalizeSessionMessageInput, userMessageInput } from "./attachments.js";

export interface AgentSessionOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly agent: AgentContract;
  readonly projectRoot: string;
  readonly projectProfile: () => Promise<ProjectProfile>;
  readonly environment: (profile: ProjectProfile, shape: AgentShape) => Promise<AgentEnvironment>;
  readonly shape: (request: AgentShapeRequest, revision: number, profile: ProjectProfile, harness: HarnessPlan) => Promise<AgentShape>;
  readonly plan: (prompt: string) => HarnessPlan;
  readonly models?: ModelResolver;
  readonly recall?: CodeRecall;
  readonly deliverSessionMessage?: (request: SessionMessageRequest) => Promise<SessionMessageReceipt>;
  readonly publishActivity?: (activity: SessionActivity) => void;
}

export class AgentSession implements AgentSessionContract {
  readonly id: string;
  readonly #events = new Set<BoundedEventChannel<AgentStreamEvent>>();
  readonly #publicEvents = new Set<BoundedEventChannel<AgentStreamEvent>>();
  readonly #activeRuns = new Set<AgentRunHandle>();
  readonly #ownedTasks = new Set<Promise<unknown>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(private readonly options: AgentSessionOptions) { this.id = options.sessionId; }

  get(): Promise<AgentSessionRecord> {
    this.#assertOpen();
    return this.#own(this.#get());
  }

  async #get(): Promise<AgentSessionRecord> {
    const value = await this.options.store.getSession(this.id);
    if (!value) throw new AlphionError("validation", `Unknown session: ${this.id}`, { stage: "session" });
    return value;
  }

  view(): Promise<SessionView> {
    this.#assertOpen();
    return this.#own(this.#view());
  }

  getShape(): Promise<AgentShape | undefined> { this.#assertOpen(); return this.#own(this.options.store.getSessionShape(this.id)); }
  listCompactions(limit?: number): Promise<readonly CompactionRecord[]> { this.#assertOpen(); return this.#own(this.options.store.listCompactions(this.id, limit)); }
  compactionProjection(): Promise<CompactionProjection> { this.#assertOpen(); return this.#own(this.options.store.getCompactionProjection(this.id)); }
  async getCompaction(compactionId: string): Promise<CompactionRecord | undefined> {
    this.#assertOpen();
    const record = await this.#own(this.options.store.getCompaction(compactionId));
    return record?.sessionId === this.id ? record : undefined;
  }

  reshape(request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt> {
    this.#assertOpen(); return this.#own(this.#reshape(request, options));
  }

  fork(request: Omit<SessionForkRequest, "sourceSessionId">): Promise<SessionForkReceipt> {
    this.#assertOpen();
    return this.#own(this.options.store.forkSession({ ...request, sourceSessionId: this.id }));
  }

  async #reshape(request: AgentShapeRequest, options: SessionWriteOptions): Promise<AgentShapeReceipt> {
    const session = await this.#get();
    if (session.status !== "idle" || session.activeRunId) throw new AlphionError("conflict", "A Session can be reshaped only while idle.", { stage: "shape" });
    const profile = await this.options.projectProfile();
    const harness = this.options.plan(request.goal);
    const shape = await this.options.shape(request, (session.shapeRevision ?? 0) + 1, profile, harness);
    return this.options.store.reshapeSession(this.id, shape, options);
  }

  async #view(): Promise<SessionView> {
    const value = await this.options.store.getSessionView(this.id);
    if (!value) throw new AlphionError("validation", `Unknown session: ${this.id}`, { stage: "session" });
    return value;
  }

  checkout(entryId: string | undefined, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    this.#assertOpen();
    return this.#own(this.options.store.checkoutSession(this.id, entryId, options));
  }

  send(content: string | SessionMessageInput, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle> {
    this.#assertOpen();
    return this.#own(this.#send(content, options, approval));
  }

  async #send(content: string | SessionMessageInput, options: SessionWriteOptions, approval: ApprovalPort): Promise<AgentRunHandle> {
    const input = normalizeSessionMessageInput(content);
    const prompt = promptForInput(input);
    const session = await this.#get();
    const user = userMessage(input);
    const runId = createId("run");
    let initialShape: AgentShape | undefined;
    if (session.shapeStatus === "legacy-unshaped") throw new AlphionError("conflict", "This migrated Session must be explicitly reshaped before send.", { stage: "shape" });
    if (session.shapeStatus === "unshaped") {
      const profile = await this.options.projectProfile();
      const harness = this.options.plan(prompt);
      initialShape = await this.options.shape({ goal: prompt, ...(session.providerId ? { providerId: session.providerId } : {}) }, 1, profile, harness);
    }
    const runProviderId = await this.#assertVisionSupport(input, initialShape?.providerId ?? session.providerId, initialShape ?? await this.options.store.getSessionShape(this.id));
    const started = await this.options.store.beginShapedSessionRun(this.id, runId, user, initialShape, options);
    if (started.receipt.replayed) throw new AlphionError("conflict", "This send command was already applied; subscribe to the session instead of starting it again.", { stage: "session" });
    let handle: AgentRunHandle;
    try {
      handle = await this.#executeLeased(input, prompt, runId, runProviderId ?? started.session.providerId, started.shape, approval, Object.freeze({ correlationId: createId("correlation"), hop: 0 }));
    } catch (error) {
      await this.options.store.releaseRunLease(this.id, runId);
      throw error;
    }
    const publicEvents = subscriberChannel();
    this.#publicEvents.add(publicEvents);
    this.#activeRuns.add(handle);
    if (this.#closed) handle.cancel("Session is closing.");
    const result = this.#own(this.#observe(handle, publicEvents, approval));
    return { runId: handle.runId, sessionId: handle.sessionId, events: publicEvents, result, cancel: (reason?: string) => handle.cancel(reason) };
  }

  steer(content: string | SessionMessageInput, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    this.#assertOpen();
    return this.#own(this.#steer(content, options));
  }
  async #steer(content: string | SessionMessageInput, options: SessionWriteOptions): Promise<SessionWriteReceipt> {
    const input = normalizeSessionMessageInput(content);
    const session = await this.#get();
    await this.#assertVisionSupport(input, session.providerId, await this.options.store.getSessionShape(this.id));
    return this.options.store.enqueuePending(this.id, "steer", userMessage(input), options);
  }
  followUp(content: string | SessionMessageInput, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt> {
    this.#assertOpen();
    return this.#own(this.#followUp(content, options, approval));
  }

  async #followUp(content: string | SessionMessageInput, options: SessionWriteOptions, approval: ApprovalPort): Promise<SessionWriteReceipt> {
    const input = normalizeSessionMessageInput(content);
    const current = await this.#get();
    await this.#assertVisionSupport(input, current.providerId, await this.options.store.getSessionShape(this.id));
    const receipt = await this.options.store.enqueuePending(this.id, "follow-up", userMessage(input), options);
    const session = await this.#get();
    if (!this.#closed && session.status === "idle") {
      this.#launchQueuedFollowUps(approval);
    }
    return receipt;
  }

  resumePending(approval: ApprovalPort): void {
    this.#assertOpen();
    this.#launchQueuedFollowUps(approval);
  }

  subscribe(afterSessionSequence = 0): AsyncIterable<AgentStreamEvent> {
    this.#assertOpen();
    const channel = subscriberChannel();
    this.#events.add(channel);
    const store = this.options.store;
    const subscribers = this.#events;
    const sessionId = this.id;
    const history = this.#own(store.listSessionEvents(sessionId, afterSessionSequence));
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = afterSessionSequence;
        try {
          for (const event of await history) {
            cursor = Math.max(cursor, event.sessionSequence ?? cursor);
            yield event;
          }
          for await (const event of channel) {
            if ("delivery" in event) {
              yield event;
              if (event.delivery === "control") return;
              continue;
            }
            if ((event.sessionSequence ?? 0) <= cursor) continue;
            cursor = event.sessionSequence ?? cursor;
            yield event;
          }
        } finally { subscribers.delete(channel); channel.close(); }
      },
    };
  }

  async #observe(handle: AgentRunHandle, publicEvents: BoundedEventChannel<AgentStreamEvent> | undefined, approval: ApprovalPort): Promise<AgentRunResult> {
    let completed: AgentRunResult | undefined;
    try {
      for await (const event of handle.events) {
        if ("delivery" in event) {
          if (event.delivery === "transient") {
            fanOut(publicEvents, event, 0);
            for (const channel of this.#events) fanOut(channel, event, 0);
          }
          continue;
        }
        const projected = projectEvent(event);
        if (projected) {
          const session = await this.#get();
          await this.options.store.appendSessionEntry(this.id, projected, { expectedRevision: session.revision, idempotencyKey: `event:${event.eventId}` }, event.runId);
        }
        fanOut(publicEvents, event, event.sessionSequence ?? 0);
        for (const channel of this.#events) fanOut(channel, event, event.sessionSequence ?? 0);
        this.options.publishActivity?.(Object.freeze({ kind: "run.event", sessionId: this.id, runId: handle.runId, event }));
      }
      const result = await handle.result;
      if (result.finalText) {
        const session = await this.#get();
        const assistant: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "assistant", id: createId("message"), createdAt: new Date().toISOString(), content: result.finalText, evidenceIds: Object.freeze(result.grounding.referencedEvidenceIds) });
        await this.options.store.appendSessionEntry(this.id, assistant, { expectedRevision: session.revision, idempotencyKey: `run:${handle.runId}:assistant` }, handle.runId);
      }
      completed = result;
      return result;
    } finally {
      await this.options.store.releaseRunLease(this.id, handle.runId).catch(() => undefined);
      this.#activeRuns.delete(handle);
      if (publicEvents) this.#publicEvents.delete(publicEvents);
      publicEvents?.close();
      if (completed) this.options.publishActivity?.(Object.freeze({ kind: "run.finished", sessionId: this.id, runId: handle.runId, status: completed.status, finalText: completed.finalText }));
      if (!this.#closed) this.#launchQueuedFollowUps(approval);
    }
  }

  async #executeLeased(input: SessionMessageInput, prompt: string, runId: string, providerId: string | undefined, shape: AgentShape, approval: ApprovalPort, collaboration: CollaborationContext): Promise<AgentRunHandle> {
    let activeCollaboration = collaboration;
    const branch = await this.#view();
    const profile = await this.options.projectProfile();
    const environment = await this.options.environment(profile, shape);
    const recall = await this.options.recall?.recall({ projectRoot: this.options.projectRoot, projectRevision: profile.projectRevision, query: prompt, limit: 20 }, new AbortController().signal);
    const selectedProviderId = shape.providerId ?? providerId;
    const compactionProvider = this.options.models
      ? await this.options.models.resolveModel({ sessionId: this.id, ...(selectedProviderId ? { providerId: selectedProviderId } : {}), requiredCapabilities: shape.requiredProviderCapabilities })
      : undefined;
    const priorEntries = branch.entries.filter((entry) => entry.runId !== runId && entry.message.kind !== "system-event" && entry.message.kind !== "human-approval");
    const model = compactionProvider && this.options.models?.describeModel ? await this.options.models.describeModel(compactionProvider) : undefined;
    const compaction = await compactSessionEntriesForModel(priorEntries, compactionProvider, AbortSignal.timeout(15_000), {
      sessionId: this.id,
      runId,
      ...(model ? { model } : {}),
      toolReserveTokens: Math.min(8_192, shape.toolIds.length * 512),
    });
    if (compaction.record) await this.options.store.appendCompaction(compaction.record);
    const history = compaction.messages;
    const effectiveProviderId = selectedProviderId ?? compactionProvider?.profile.id;
    return this.options.agent.execute({ prompt, currentInput: input, runId, sessionId: this.id, projectRoot: this.options.projectRoot, projectRevision: profile.projectRevision, ...(effectiveProviderId ? { providerId: effectiveProviderId } : {}), projectProfile: profile, history, environment, harnessPlan: shape.harnessPlan, shape, collaboration, ...(recall ? { recall } : {}) }, approval, {
      drainSteering: async (activeRunId, signal) => {
        if (signal.aborted) throw signal.reason ?? new DOMException("Steering drain cancelled.", "AbortError");
        const drained = await this.options.store.drainPending(this.id, "steer", activeRunId);
        const messages: AgentMessage[] = [];
        try {
          for (const pending of drained) {
            if (pending.message.kind === "user") {
              const current = await this.#get();
              await this.options.store.appendSessionEntry(this.id, pending.message, { expectedRevision: current.revision, idempotencyKey: `drain:${activeRunId}:${pending.id}` }, activeRunId);
            } else if (pending.message.schemaVersion === 2) {
              activeCollaboration = Object.freeze({ correlationId: pending.message.correlationId, causationId: pending.message.id, hop: pending.message.hop });
            }
            messages.push(pending.message);
          }
          await this.options.store.acknowledgePending(this.id, "steer", activeRunId, drained.map((item) => item.id));
        } catch (error) {
          await this.options.store.releasePendingClaims(this.id, "steer", activeRunId).catch(() => undefined);
          throw error;
        }
        return Object.freeze(messages);
      },
      ...(this.options.deliverSessionMessage ? { deliverSessionMessage: (targetSessionId: string, content: string, idempotencyKey: string) => this.options.deliverSessionMessage!({ sourceSessionId: this.id, sourceRunId: runId, targetSessionId, domainId: (branch.session).domainId, shapeDigest: shape.digest, idempotencyKey, correlationId: activeCollaboration.correlationId, ...(activeCollaboration.causationId ? { causationId: activeCollaboration.causationId } : {}), hop: activeCollaboration.hop + 1, content }) } : {}),
    });
  }

  async #startQueuedFollowUps(approval: ApprovalPort): Promise<void> {
    if (this.#closed) return;
    const session = await this.#get();
    if (this.#closed || session.status !== "idle") return;
    const runId = createId("run");
    let leased: AgentSessionRecord;
    try { leased = await this.options.store.acquireRunLease(this.id, runId, session.revision); }
    catch (error) {
      if (error instanceof AlphionError && error.code === "conflict") return;
      throw error;
    }
      const pending = await this.options.store.drainPending(this.id, "follow-up", runId);
    if (pending.length === 0) { await this.options.store.releaseRunLease(this.id, runId); return; }
    try {
      for (const item of pending) if (item.message.kind === "user") {
        const current = await this.#get();
        await this.options.store.appendSessionEntry(this.id, item.message, { expectedRevision: current.revision, idempotencyKey: `drain:${runId}:${item.id}` }, runId);
      }
      await this.options.store.acknowledgePending(this.id, "follow-up", runId, pending.map((item) => item.id));
      const input = mergePendingInput(pending.map((item) => item.message));
      const prompt = promptForInput(input);
      const shape = await this.options.store.getSessionShape(this.id);
      if (!shape) throw new AlphionError("conflict", "Queued follow-up requires a shaped Session.", { stage: "shape" });
      const inbound = [...pending].reverse().find((item) => item.message.kind === "agent" && item.message.schemaVersion === 2)?.message;
      const collaboration: CollaborationContext = inbound && inbound.kind === "agent" && inbound.schemaVersion === 2
        ? Object.freeze({ correlationId: inbound.correlationId, causationId: inbound.id, hop: inbound.hop })
        : Object.freeze({ correlationId: createId("correlation"), hop: 0 });
      const providerId = await this.#assertVisionSupport(input, leased.providerId, shape);
      const handle = await this.#executeLeased(input, prompt, runId, providerId ?? leased.providerId, shape, approval, collaboration);
      this.#activeRuns.add(handle);
      if (this.#closed) handle.cancel("Session is closing.");
      await this.#observe(handle, undefined, approval);
    } catch (error) {
      await this.options.store.releasePendingClaims(this.id, "follow-up", runId).catch(() => undefined);
      await this.options.store.releaseRunLease(this.id, runId).catch(() => undefined);
      throw error;
    }
  }

  #launchQueuedFollowUps(approval: ApprovalPort): void {
    if (this.#closed) return;
    void this.#own(this.#startQueuedFollowUps(approval).catch((error: unknown) => this.#recordAutomationFailure(error)));
  }

  async #recordAutomationFailure(error: unknown): Promise<void> {
    if (this.#closed) return;
    const session = await this.#get();
    const message: AgentMessage = Object.freeze({ schemaVersion: 1, kind: "system-event", id: createId("message"), createdAt: new Date().toISOString(), eventKind: "follow-up.failed", content: error instanceof AlphionError ? `${error.code}: ${error.message}` : "internal: Automatic follow-up failed." });
    await this.options.store.appendSessionEntry(this.id, message, { expectedRevision: session.revision, idempotencyKey: `follow-up-failed:${message.id}` }).catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const channel of this.#events) channel.close();
    for (const channel of this.#publicEvents) channel.close();
    for (const handle of this.#activeRuns) handle.cancel("Session is closing.");
    this.#closePromise = (async () => {
      while (this.#ownedTasks.size > 0) {
        await Promise.allSettled([...this.#ownedTasks]);
      }
    })();
    return this.#closePromise;
  }

  #own<T>(task: Promise<T>): Promise<T> {
    this.#ownedTasks.add(task);
    void task.finally(() => this.#ownedTasks.delete(task)).catch(() => undefined);
    return task;
  }

  #assertOpen(): void {
    if (this.#closed) throw new AlphionError("conflict", "Agent session is closed.", { stage: "session" });
  }

  async #assertVisionSupport(input: SessionMessageInput, providerId: string | undefined, shape: AgentShape | undefined): Promise<string | undefined> {
    if (!input.attachments?.length) return providerId;
    if (!this.options.models) throw new AlphionError("dependency-unavailable", "Image messages require a configured vision Provider.", { stage: "attachment" });
    const provider = await this.options.models.resolveModel({ sessionId: this.id, ...(providerId ? { providerId } : {}), requiredCapabilities: shape?.requiredProviderCapabilities ?? [] });
    if (!provider.profile.capabilities.vision) throw new AlphionError("validation", "The selected Provider does not support image messages. Remove the image or switch Provider.", { stage: "attachment", reason: "provider-vision-required" });
    return provider.profile.id;
  }
}

function projectEvent(event: AgentStreamEvent): AgentMessage | undefined {
  if ("delivery" in event) return undefined;
  const base = { schemaVersion: 1 as const, id: `message_${event.eventId}`, createdAt: event.timestamp };
  const payload = sanitizeRecord(event.payload);
  switch (event.kind) {
    case "tool.requested": {
      const callId = payloadString(event, "toolCallId");
      const name = payloadString(event, "toolName");
      const args = payload.arguments;
      if (!callId || !name || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
      return Object.freeze({ ...base, kind: "tool-call", call: Object.freeze({ id: callId, name, arguments: args as Readonly<Record<string, unknown>> }) });
    }
    case "tool.updated": return undefined;
    case "tool.completed": {
      const callId = payloadString(event, "toolCallId");
      const name = payloadString(event, "toolName");
      if (!callId || !name) return undefined;
      const evidence = payload.evidence;
      const safeEvidence = isEvidence(evidence) ? evidence : undefined;
      const content = recordString(payload, "content") ?? recordString(payload, "code") ?? (payload.isError === true ? "Tool failed without durable output." : "Tool completed without durable output.");
      return Object.freeze({ ...base, kind: "observation", toolCallId: callId, toolName: name, content, ...(safeEvidence ? { evidence: safeEvidence } : {}), isError: payload.isError === true });
    }
    case "approval.requested": {
      const requestId = payloadString(event, "requestId");
      if (!requestId) return undefined;
      return Object.freeze({ ...base, kind: "human-approval", requestId, approved: false, content: `requested:${payloadString(event, "toolName") ?? "tool"}:${payloadString(event, "actionDigest") ?? "unknown"}` });
    }
    case "approval.resolved": {
      const requestId = payloadString(event, "requestId");
      if (!requestId) return undefined;
      return Object.freeze({ ...base, kind: "human-approval", requestId, approved: payload.approved === true, content: recordString(payload, "reason") ?? (payload.approved === true ? "approved" : "denied") });
    }
    case "run.failed":
    case "run.cancelled":
    case "run.started":
    case "project.profiled":
    case "context.assembled":
    case "provider.started":
    case "provider.degraded":
    case "run.completed":
      return Object.freeze({ ...base, kind: "system-event", eventKind: event.kind, content: canonicalJson(payload).slice(0, 16_384) });
    default:
      return undefined;
  }
}

function payloadString(event: AgentStreamEvent, key: string): string | undefined {
  return recordString(sanitizeRecord(event.payload), key);
}

function recordString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function isEvidence(value: unknown): value is NonNullable<Extract<AgentMessage, { readonly kind: "observation" }>["evidence"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Readonly<Record<string, unknown>>;
  return typeof item.id === "string" && typeof item.digest === "string" && typeof item.summary === "string" && ["file", "search", "change", "process"].includes(String(item.kind));
}

function userMessage(input: SessionMessageInput): Extract<AgentMessage, { readonly kind: "user" }> { return createUserMessage(input, createId("message"), new Date().toISOString()); }
function promptForInput(input: SessionMessageInput): string { return input.text ?? `User supplied ${input.attachments?.length ?? 0} image attachment(s): ${(input.attachments ?? []).map((item) => item.fileName).join(", ")}.`; }
function mergePendingInput(messages: readonly Extract<AgentMessage, { readonly kind: "user" | "agent" }>[]): SessionMessageInput {
  const text = messages.map((message) => message.kind === "user" ? userMessageInput(message).text ?? "" : message.content).filter(Boolean).join("\n\n");
  const attachments = messages.flatMap((message) => message.kind === "user" ? [...(userMessageInput(message).attachments ?? [])] : []);
  return normalizeSessionMessageInput({ schemaVersion: 1, ...(text ? { text } : {}), ...(attachments.length ? { attachments } : {}) });
}

const SUBSCRIBER_BYTES = 1024 * 1024;

function subscriberChannel(): BoundedEventChannel<AgentStreamEvent> {
  return new BoundedEventChannel<AgentStreamEvent>(256, { maxBytes: SUBSCRIBER_BYTES, measure: eventBytes });
}

function fanOut(channel: BoundedEventChannel<AgentStreamEvent> | undefined, event: AgentStreamEvent, cursor: number): void {
  if (!channel) return;
  const critical = !("delivery" in event) && event.kind !== "model.delta" && event.kind !== "tool.updated";
  const accepted = channel.offer(event, critical, critical ? undefined : (previous) => mergeStreamProgress(previous, event));
  if (!accepted) {
    channel.replace(Object.freeze({ delivery: "control", sessionId: event.sessionId, timestamp: new Date().toISOString(), kind: "stream.resync-required", payload: Object.freeze({ afterSessionSequence: cursor, reason: "slow-consumer" }) }));
    channel.close();
  }
}

function mergeStreamProgress(previous: AgentStreamEvent, next: AgentStreamEvent): AgentStreamEvent | undefined {
  if ("delivery" in previous || "delivery" in next || previous.kind !== next.kind || previous.runId !== next.runId) return undefined;
  if (next.kind === "model.delta") {
    const left = typeof previous.payload.delta === "string" ? previous.payload.delta : "";
    const right = typeof next.payload.delta === "string" ? next.payload.delta : "";
    return Object.freeze({ ...next, payload: Object.freeze({ ...next.payload, delta: `${left}${right}` }) });
  }
  if (next.kind === "tool.updated" && previous.payload.toolCallId === next.payload.toolCallId) return next;
  return undefined;
}

function eventBytes(event: AgentStreamEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
