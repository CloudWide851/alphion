import { AlphionError, normalizeError } from "../src/application/errors.js";
import type { AgentApplication, AgentRunHandle, ApprovalDecision, ApprovalPort, ApprovalRequest } from "../src/ports/index.js";
import type { AgentStreamEvent } from "../src/protocol/events.js";
import type { RpcInbound, RpcOutbound, RpcRequest } from "./protocol.js";

export interface DesktopTransport extends AsyncIterable<string> { send(message: RpcOutbound): Promise<void>; close(): Promise<void>; }
export interface DesktopHost { run(): Promise<void>; close(): Promise<void>; }

export function createDesktopHost(options: Readonly<{ application: AgentApplication; transport: DesktopTransport; approvalTimeoutMs?: number }>): DesktopHost {
  return new DefaultDesktopHost(options.application, options.transport, options.approvalTimeoutMs ?? 30_000);
}

class DefaultDesktopHost implements DesktopHost {
  readonly #runs = new Map<string, AgentRunHandle>();
  readonly #subscriptions = new Map<string, AbortController>();
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #approval: RpcApprovalPort;
  #negotiated = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(private readonly application: AgentApplication, private readonly transport: DesktopTransport, timeout: number) { this.#approval = new RpcApprovalPort(transport, timeout); }

  async run(): Promise<void> {
    try {
      for await (const line of this.transport) {
        if (this.#closed) break;
        let message: RpcInbound;
        try { message = (await import("./protocol.js")).decodeRpcLine(line); }
        catch (error) { await this.#sendError("unknown", error); continue; }
        if (!this.#negotiated) {
          if (message.type !== "rpc.hello" || !message.supportedVersions.includes(1)) { await this.#sendError(message.requestId, new AlphionError("incompatible-schema", "rpc.hello with schema 1 is required first.", { stage: "rpc" })); continue; }
          this.#negotiated = true;
          await this.transport.send({ schemaVersion: 1, type: "rpc.response", requestId: message.requestId, status: "ok", result: { selectedVersion: 1, capabilities: ["sessions", "shapes", "resources", "approvals", "subscriptions"] } });
          continue;
        }
        if (message.type === "rpc.hello") { await this.#sendError(message.requestId, new AlphionError("conflict", "RPC handshake is already complete.", { stage: "rpc" })); continue; }
        if (message.kind === "rpc.shutdown") {
          try { await this.#dispatch(message); } catch (error) { await this.#sendError(message.requestId, error); }
        } else this.#own(this.#dispatch(message).catch((error: unknown) => this.#sendError(message.requestId, error)));
      }
    } finally { await this.close(); }
  }

  async #dispatch(request: RpcRequest): Promise<void> {
    switch (request.kind) {
      case "session.create": return this.#ok(request, await this.application.sessions.create({ ...request.payload, ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}) }).then((session) => session.get()));
      case "session.list": return this.#ok(request, await this.application.sessions.list());
      case "session.show": return this.#ok(request, await this.application.sessions.view(requireSession(request)));
      case "session.shape": return this.#ok(request, await this.application.sessions.getShape(requireSession(request)));
      case "session.checkout": return this.#ok(request, await this.application.sessions.checkout(requireSession(request), request.payload.entryId, writes(request)));
      case "session.steer": return this.#ok(request, await this.application.sessions.steer(requireSession(request), request.payload.message, writes(request)));
      case "session.follow-up": return this.#ok(request, await this.application.sessions.followUp(requireSession(request), request.payload.message, writes(request), this.#approval));
      case "session.reshape": return this.#ok(request, await this.application.sessions.reshape(requireSession(request), request.payload, writes(request)));
      case "session.send": {
        const handle = await this.application.sessions.send(requireSession(request), request.payload.message, writes(request), this.#approval);
        this.#runs.set(handle.runId, handle); await this.#accepted(request, { runId: handle.runId }); this.#own(this.#pumpRun(request.requestId, handle)); return;
      }
      case "run.cancel": { const run = this.#runs.get(request.payload.runId); if (!run) throw invalid("Unknown active run."); run.cancel(request.payload.reason); return this.#ok(request, { cancelled: true }); }
      case "session.subscribe": { const id = request.payload.subscriptionId; if (this.#subscriptions.has(id)) throw invalid("Subscription already exists."); const controller = new AbortController(); this.#subscriptions.set(id, controller); this.#own(this.#pumpSubscription(id, request.requestId, requireSession(request), request.payload.afterSessionSequence ?? 0, controller.signal)); return this.#accepted(request, { subscriptionId: id }); }
      case "session.unsubscribe": { const id = request.payload.subscriptionId; this.#subscriptions.get(id)?.abort(); this.#subscriptions.delete(id); return this.#ok(request, { unsubscribed: true }); }
      case "approval.decide": { this.#approval.decide({ ...request.payload, reason: request.payload.reason ?? "RPC client decision." }); return this.#ok(request, { resolved: true }); }
      case "harness.plan": return this.#ok(request, await this.application.planHarness(request.payload.prompt, request.payload.overlay));
      case "resource.list": case "resource.doctor": return this.#ok(request, await this.application.loadResources(request.payload));
      case "project.inspect": return this.#ok(request, await this.application.inspectProject(request.payload));
      case "diagnose": return this.#ok(request, await this.application.diagnose());
      case "cache.stats": return this.#ok(request, await this.application.cacheStats());
      case "cache.clear": return this.#ok(request, { deleted: await this.application.clearCache(request.payload.namespace) });
      case "provider.list": return this.#ok(request, await this.application.configuration.listProfiles().then((profiles) => profiles.map(({ auth: _auth, ...safe }) => safe)));
      case "rpc.shutdown": await this.#ok(request, { shuttingDown: true }); this.#closed = true; return;
    }
  }

  async #pumpRun(correlationId: string, handle: AgentRunHandle): Promise<void> { try { for await (const event of handle.events) await this.transport.send({ schemaVersion: 1, type: "rpc.event", subscriptionId: `run:${handle.runId}`, correlationId, event }); await handle.result; } finally { this.#runs.delete(handle.runId); } }
  async #pumpSubscription(id: string, correlationId: string, sessionId: string, afterSessionSequence: number, signal: AbortSignal): Promise<void> {
    const iterator = this.application.sessions.subscribe(sessionId, afterSessionSequence)[Symbol.asyncIterator]();
    const aborted = new Promise<IteratorResult<AgentStreamEvent>>((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true }));
    try {
      while (!signal.aborted) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        await this.transport.send({ schemaVersion: 1, type: "rpc.event", subscriptionId: id, correlationId, event: next.value });
      }
    } finally { await iterator.return?.(); this.#subscriptions.delete(id); }
  }
  #own(task: Promise<unknown>): void { this.#tasks.add(task); void task.finally(() => this.#tasks.delete(task)).catch(() => undefined); }
  #ok(request: RpcRequest, result: unknown): Promise<void> { return this.transport.send({ schemaVersion: 1, type: "rpc.response", requestId: request.requestId, status: "ok", result }); }
  #accepted(request: RpcRequest, result: unknown): Promise<void> { return this.transport.send({ schemaVersion: 1, type: "rpc.response", requestId: request.requestId, status: "accepted", result }); }
  async #sendError(requestId: string, error: unknown): Promise<void> { const safe = normalizeError(error, "rpc"); await this.transport.send({ schemaVersion: 1, type: "rpc.response", requestId, status: "error", error: { code: safe.code, message: safe.message, stage: safe.stage, retryable: safe.retryable } }); }
  close(): Promise<void> { if (this.#closePromise) return this.#closePromise; this.#closed = true; this.#closePromise = (async () => { for (const run of this.#runs.values()) run.cancel("Desktop host closed."); for (const controller of this.#subscriptions.values()) controller.abort(); this.#approval.close(); await Promise.allSettled([...this.#tasks]); await this.application.close(); await this.transport.close(); })(); return this.#closePromise; }
}

class RpcApprovalPort implements ApprovalPort {
  readonly revision = "desktop-rpc-approval-v1";
  readonly #pending = new Map<string, Readonly<{ request: ApprovalRequest; resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }>>();
  constructor(private readonly transport: DesktopTransport, private readonly timeoutMs: number) {}
  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (!request.shapeDigest) return { approved: false, reason: "Desktop RPC approval requires a Session shape digest." };
    await this.transport.send({ schemaVersion: 1, type: "rpc.event", subscriptionId: "approvals", correlationId: request.runId, event: { kind: "approval.challenge", requestId: request.requestId, toolName: request.toolName, actionDigest: request.actionDigest, shapeDigest: request.shapeDigest, summary: request.summary, timeoutMs: this.timeoutMs } });
    return new Promise((resolve) => { const timer = setTimeout(() => { this.#pending.delete(request.requestId); resolve({ approved: false, reason: "RPC approval timed out." }); }, this.timeoutMs); timer.unref(); this.#pending.set(request.requestId, { request, resolve, timer }); signal.addEventListener("abort", () => { const pending = this.#pending.get(request.requestId); if (!pending) return; clearTimeout(pending.timer); this.#pending.delete(request.requestId); resolve({ approved: false, reason: "RPC approval was cancelled." }); }, { once: true }); });
  }
  decide(input: Readonly<{ requestId: string; actionDigest: string; shapeDigest?: string; approved: boolean; reason: string }>): void { const pending = this.#pending.get(input.requestId); if (!pending) throw invalid("Approval challenge is not pending."); if (input.actionDigest !== pending.request.actionDigest || input.shapeDigest !== pending.request.shapeDigest) throw new AlphionError("forbidden", "Approval digest does not match the pending action.", { stage: "approval" }); clearTimeout(pending.timer); this.#pending.delete(input.requestId); pending.resolve({ approved: input.approved, reason: input.reason }); }
  close(): void { for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.resolve({ approved: false, reason: "Desktop host closed." }); this.#pending.delete(id); } }
}

function requireSession(request: RpcRequest): string { if (!request.sessionId) throw invalid("sessionId is required."); return request.sessionId; }
function writes(request: RpcRequest) { if (request.expectedRevision === undefined || !request.idempotencyKey) throw invalid("expectedRevision and idempotencyKey are required."); return { expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey }; }
function invalid(message: string): AlphionError { return new AlphionError("validation", message, { stage: "rpc" }); }
