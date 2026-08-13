import { AlphionError, type AgentApplication, type AgentRunHandle, type ApprovalDecision, type ApprovalPort, type ApprovalRequest, type ProjectManager } from "../src/index.js";
import type { UiCommand, UiCommandClient, UiCommandEnvelope, UiCommandResult, UiEventEnvelope, UiEventFrame, UiEventPayload, UiSurfaceSnapshot } from "./contracts.js";
import { frameEvents, historyFrames, resyncFrame, UiFrameQueue } from "./event-frames.js";

export interface LocalUiCommandClientOptions {
  readonly application: () => AgentApplication;
  readonly projects?: ProjectManager;
  readonly activateProject?: (projectId: string) => Promise<void>;
  readonly approvalTimeoutMs?: number;
}

export class LocalUiCommandClient implements UiCommandClient {
  readonly #runs = new Map<string, AgentRunHandle>();
  readonly #events: UiEventEnvelope[] = [];
  readonly #subscribers = new Set<UiFrameQueue>();
  readonly #approval: LocalUiApprovalPort;
  readonly #pendingFrame: UiEventEnvelope[] = [];
  #cursor = 0;
  #frameTimer: NodeJS.Timeout | undefined;
  #closed = false;
  constructor(private readonly options: LocalUiCommandClientOptions) { this.#approval = new LocalUiApprovalPort((payload) => this.#publish(payload), options.approvalTimeoutMs ?? 30_000); }

  async execute(envelope: UiCommandEnvelope): Promise<UiCommandResult> {
    if (this.#closed) throw new AlphionError("conflict", "UI command client is closed.", { stage: "ui" });
    const command = envelope.command;
    const result = await this.#dispatch(command);
    const invalidation = invalidationFor(command, result);
    if (invalidation) this.#publish(invalidation);
    return Object.freeze({ schemaVersion: 1, requestId: envelope.requestId, status: command.kind === "session.send" ? "accepted" : "ok", result });
  }

  subscribe(afterCursor = 0): AsyncIterable<UiEventFrame> {
    const firstCursor = this.#events[0]?.cursor ?? this.#cursor + 1;
    const history = afterCursor > 0 && afterCursor < firstCursor - 1 ? [resyncFrame(firstCursor - 1)] : historyFrames(this.#events.filter((event) => event.cursor > afterCursor));
    const channel = new UiFrameQueue();
    this.#subscribers.add(channel);
    const subscribers = this.#subscribers;
    return { async *[Symbol.asyncIterator]() { try { yield* history; yield* channel; } finally { subscribers.delete(channel); channel.close(); } } };
  }

  async importProviderCredential(profileId: string, secret: string): Promise<void> {
    if (!profileId.trim() || !secret || secret.length > 16 * 1024) throw new AlphionError("validation", "A bounded Provider credential is required.", { stage: "ui" });
    try { await this.options.application().configuration.importCredential(profileId, secret); }
    finally { secret = ""; }
  }

  decideApproval(input: Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean }>): void { this.#approval.decide(input); }

  async close(): Promise<void> {
    if (this.#closed) return;
    for (const run of this.#runs.values()) run.cancel("UI command client closed.");
    this.#approval.close();
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#frameTimer = undefined;
    this.#flushFrame();
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#subscribers.clear();
    await Promise.allSettled([...this.#runs.values()].map((run) => run.result));
  }

  async #dispatch(command: UiCommand): Promise<unknown> {
    if (command.kind === "surface.snapshot") return this.#snapshot(command.selectedSessionId);
    if (command.kind === "project.list") return this.options.projects?.list() ?? [];
    if (command.kind === "project.inspect") return this.options.application().inspectProject({ ...(command.refresh === undefined ? {} : { refresh: command.refresh }) });
    if (command.kind === "project.activate") {
      if (!this.options.activateProject) throw new AlphionError("forbidden", "Project activation is unavailable.", { stage: "ui" });
      for (const run of this.#runs.values()) run.cancel("Project is switching.");
      this.#approval.close();
      await Promise.allSettled([...this.#runs.values()].map((run) => run.result));
      await this.options.activateProject(command.projectId);
      this.#publish({ kind: "stream.resync-required", cursor: this.#cursor });
      return { activated: command.projectId };
    }
    const application = this.options.application();
    switch (command.kind) {
      case "session.list": return application.sessions.list();
      case "session.create": return application.sessions.create({ title: command.title, idempotencyKey: command.idempotencyKey }).then((session) => session.get());
      case "session.show": return application.sessions.view(command.sessionId);
      case "session.steer": return application.sessions.steer(command.sessionId, command.message, writes(command));
      case "session.follow-up": return application.sessions.followUp(command.sessionId, command.message, writes(command), this.#approval);
      case "session.checkout": return application.sessions.checkout(command.sessionId, command.entryId, writes(command));
      case "session.reshape": return application.sessions.reshape(command.sessionId, { goal: command.goal }, writes(command));
      case "session.fork": return application.sessions.fork({ sourceSessionId: command.sessionId, ...(command.entryId ? { sourceEntryId: command.entryId } : {}), ...(command.title ? { title: command.title } : {}), ...writes(command) });
      case "session.send": {
        const handle = await application.sessions.send(command.sessionId, command.message, writes(command), this.#approval);
        this.#runs.set(handle.runId, handle);
        void this.#pump(handle);
        return { runId: handle.runId, sessionId: handle.sessionId };
      }
      case "run.cancel": { const run = this.#runs.get(command.runId); if (!run) throw new AlphionError("validation", "Unknown active run.", { stage: "ui" }); run.cancel(command.reason); return { cancelled: true }; }
      case "provider.list": return application.configuration.listProfiles().then((profiles) => profiles.map(({ auth: _auth, ...profile }) => profile));
      case "resource.list": return application.loadResources();
      case "doctor": return application.diagnose();
      case "harness.plan": return application.planHarness(command.prompt);
      default: return assertNever(command);
    }
  }

  async #pump(handle: AgentRunHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if ("delivery" in event) continue;
        if (event.kind === "model.delta" && typeof event.payload.delta === "string") this.#publish({ kind: "run.delta", runId: handle.runId, sessionId: handle.sessionId, delta: event.payload.delta });
        else this.#publish({ kind: "agent.event", event });
      }
      const result = await handle.result;
      this.#publish({ kind: "run.finished", runId: handle.runId, sessionId: handle.sessionId, status: result.status, finalText: result.finalText });
      this.#publish({ kind: "surface.invalidate", scopes: ["sessions", "session-view"], sessionIds: [handle.sessionId] });
    } catch {
      this.#publish({ kind: "run.finished", runId: handle.runId, sessionId: handle.sessionId, status: "failed", finalText: "" });
    } finally { this.#runs.delete(handle.runId); }
  }

  #publish(payload: UiEventPayload): void {
    const event = Object.freeze({ schemaVersion: 1 as const, cursor: ++this.#cursor, timestamp: new Date().toISOString(), payload });
    this.#events.push(event);
    if (this.#events.length > 1_000) this.#events.splice(0, this.#events.length - 1_000);
    this.#pendingFrame.push(event);
    if (!this.#frameTimer) { this.#frameTimer = setTimeout(() => this.#flushFrame(), 16); this.#frameTimer.unref(); }
  }

  async #snapshot(selectedSessionId?: string): Promise<UiSurfaceSnapshot> {
    const application = this.options.application();
    const watermark = this.#cursor;
    const [projects, project, sessions] = await Promise.all([this.options.projects?.list() ?? Promise.resolve([]), this.options.projects?.current() ?? Promise.resolve(undefined), application.sessions.list()]);
    const selected = sessions.find((item) => item.id === selectedSessionId) ?? sessions[0];
    const selectedView = selected ? await application.sessions.view(selected.id) : undefined;
    return Object.freeze({ schemaVersion: 1, cursor: watermark, ...(project ? { project } : {}), projects: Object.freeze(projects), sessions: Object.freeze(sessions), ...(selected ? { selectedSessionId: selected.id } : {}), ...(selectedView ? { selectedView } : {}) });
  }

  #flushFrame(): void {
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#frameTimer = undefined;
    const frame = frameEvents(this.#pendingFrame.splice(0));
    if (!frame) return;
    for (const subscriber of this.#subscribers) if (!subscriber.offer(frame)) subscriber.replace(resyncFrame(frame.cursorEnd));
  }
}

class LocalUiApprovalPort implements ApprovalPort {
  readonly revision = "local-ui-approval-v1";
  readonly #pending = new Map<string, Readonly<{ request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }>>();
  constructor(private readonly publish: (payload: UiEventPayload) => void, private readonly timeoutMs: number) {}
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (!request.shapeDigest) return Promise.resolve({ approved: false, reason: "UI approval requires a shape digest." });
    this.publish({ kind: "approval.challenge", requestId: request.requestId, runId: request.runId, toolName: request.toolName, actionDigest: request.actionDigest, shapeDigest: request.shapeDigest, summary: request.summary });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#pending.delete(request.requestId); resolve({ approved: false, reason: "UI approval timed out." }); }, this.timeoutMs); timer.unref();
      this.#pending.set(request.requestId, { request, resolve, timer });
      signal.addEventListener("abort", () => this.#resolve(request.requestId, false, "UI approval was cancelled."), { once: true });
    });
  }
  decide(input: Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean }>): void { const pending = this.#pending.get(input.requestId); if (!pending) throw new AlphionError("conflict", "Approval is no longer pending.", { stage: "approval" }); if (pending.request.actionDigest !== input.actionDigest || pending.request.shapeDigest !== input.shapeDigest) throw new AlphionError("forbidden", "Approval digest mismatch.", { stage: "approval" }); this.#resolve(input.requestId, input.approved, "UI decision for the exact invocation."); }
  close(): void { for (const id of this.#pending.keys()) this.#resolve(id, false, "UI approval client closed."); }
  #resolve(id: string, approved: boolean, reason: string): void { const pending = this.#pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.#pending.delete(id); pending.resolve({ approved, reason }); }
}

function writes(command: Extract<UiCommand, { readonly expectedRevision: number }>) { return { expectedRevision: command.expectedRevision, idempotencyKey: command.idempotencyKey }; }
function assertNever(value: never): never { throw new AlphionError("internal", `Unhandled UI command: ${JSON.stringify(value)}`, { stage: "ui" }); }

function invalidationFor(command: UiCommand, result: unknown): UiEventPayload | undefined {
  if (command.kind === "project.activate") return { kind: "surface.invalidate", scopes: ["projects", "sessions", "session-view"], sessionIds: [] };
  if (command.kind === "session.create") return { kind: "surface.invalidate", scopes: ["sessions"], sessionIds: [] };
  if (command.kind === "session.fork") { const sessionId = (result as { session?: { id?: unknown } }).session?.id; return { kind: "surface.invalidate", scopes: ["sessions", "session-view"], sessionIds: typeof sessionId === "string" ? [sessionId] : [] }; }
  switch (command.kind) {
    case "session.send": case "session.steer": case "session.follow-up": case "session.checkout": case "session.reshape":
      return { kind: "surface.invalidate", scopes: ["sessions", "session-view"], sessionIds: [command.sessionId] };
    default: break;
  }
  return undefined;
}
