import type {
  AgentBudgets,
  ProviderMessage,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCall,
  EvidenceRef,
  GroundingReport,
  ProviderEvent,
  ProviderRequest,
  ProviderUsage,
  ToolResult,
  WorkingMemorySnapshot,
} from "../domain/contracts.js";
import type {
  AgentProvider,
  AgentRunHandle,
  ApprovalPort,
  CapabilityPolicy,
  EventStore,
} from "../ports/index.js";
import type { AgentEvent, AgentEventDraft, AgentEventKind, AgentStreamEvent } from "../protocol/events.js";
import { emptyProviderUsage, isCriticalAgentEvent } from "../protocol/events.js";
import { canonicalJson, createId, sha256 } from "./canonical.js";
import { SingleFlight, TieredCache } from "./cache.js";
import { BoundedEventChannel } from "./event-channel.js";
import { AlphionError, normalizeError } from "./errors.js";
import { DefaultCapabilityPolicy } from "./policy.js";
import { containsPotentialSecret, sanitizeRecord } from "./sensitive-data.js";
import { ToolRegistry } from "./tool-registry.js";
import { summarizeContextPack } from "./context-pack.js";
import { validateJsonSchema } from "./json-schema.js";
import { EMPTY_WORKING_MEMORY, reduceWorkingMemory } from "./working-memory.js";

const DEFAULT_BUDGETS: AgentBudgets = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 32,
  maxOutputTokens: 4096,
  maxOutputBytes: 1024 * 1024,
  runTimeoutMs: 300_000,
  modelTimeoutMs: 60_000,
});

export interface AgentLoopOptions {
  readonly provider: AgentProvider;
  readonly tools: ToolRegistry;
  readonly eventStore: EventStore;
  readonly approval: ApprovalPort;
  readonly cache?: TieredCache;
  readonly policy?: CapabilityPolicy;
  readonly eventBufferCapacity?: number;
  readonly beforeModelBoundary?: (runId: string, signal: AbortSignal) => Promise<readonly ProviderMessage[]>;
}

interface RuntimeContext {
  readonly request: AgentRunRequest;
  readonly runId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly channel: BoundedEventChannel<AgentStreamEvent>;
  readonly budgets: AgentBudgets;
  mutationRevision: number;
  workingMemory: WorkingMemorySnapshot;
}

interface TurnOutcome {
  readonly text: string;
  readonly reasoningContent: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage: ProviderUsage;
}

interface ToolPipelineResult {
  readonly call: AgentToolCall;
  readonly result: ToolResult;
  readonly terminate: boolean;
}

/** Internal provider/tool loop. Public callers enter through Agent.execute(). */
export class AgentLoop {
  readonly #provider: AgentProvider;
  readonly #tools: ToolRegistry;
  readonly #eventStore: EventStore;
  readonly #approval: ApprovalPort;
  readonly #cache: TieredCache | undefined;
  readonly #policy: CapabilityPolicy;
  readonly #eventBufferCapacity: number;
  readonly #beforeModelBoundary: ((runId: string, signal: AbortSignal) => Promise<readonly ProviderMessage[]>) | undefined;
  readonly #providerFlights = new SingleFlight<readonly ProviderEvent[]>();
  readonly #toolFlights = new SingleFlight<ToolResult>();

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#eventStore = options.eventStore;
    this.#approval = options.approval;
    this.#cache = options.cache;
    this.#policy = options.policy ?? new DefaultCapabilityPolicy();
    this.#eventBufferCapacity = options.eventBufferCapacity ?? 256;
    this.#beforeModelBoundary = options.beforeModelBoundary;
  }

  execute(request: AgentRunRequest): AgentRunHandle {
    validateRunRequest(request);
    const runId = request.runId ?? createId("run");
    const sessionId = request.sessionId ?? createId("session");
    const correlationId = createId("correlation");
    const controller = new AbortController();
    const channel = new BoundedEventChannel<AgentStreamEvent>(this.#eventBufferCapacity);
    const budgets = mergeBudgets(request.budgets);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Run deadline exceeded.", "TimeoutError"));
    }, budgets.runTimeoutMs);
    const context: RuntimeContext = {
      request,
      runId,
      sessionId,
      correlationId,
      signal: controller.signal,
      channel,
      budgets,
      mutationRevision: 0,
      workingMemory: request.workingMemory ?? EMPTY_WORKING_MEMORY,
    };
    const result = this.#execute(context, () => timedOut).finally(() => {
      clearTimeout(timer);
      channel.close();
    });
    return {
      runId,
      sessionId,
      events: channel,
      result,
      cancel: (reason = "Cancelled by caller.") => controller.abort(new DOMException(reason, "AbortError")),
    };
  }

  async #execute(context: RuntimeContext, didTimeout: () => boolean): Promise<AgentRunResult> {
    let turns = 0;
    let toolCalls = 0;
    let usage = emptyProviderUsage();
    const evidence = new Map<string, EvidenceRef>();
    let finalText = "";
    try {
      await this.#emit(context, "run.started", {
        promptDigest: sha256(context.request.prompt),
        projectRevision: context.request.projectRevision,
        providerProfileId: this.#provider.profile.id,
        ...(context.request.shape ? { shapeRevision: context.request.shape.revision, shapeDigest: context.request.shape.digest } : {}),
      });
      if (context.request.projectProfile) {
        const profile = context.request.projectProfile;
        await this.#emit(context, "project.profiled", {
          projectRevision: profile.projectRevision,
          profileDigest: profile.digest,
          projectType: profile.projectType,
          scannedPaths: profile.scannedPaths,
          factCount: profile.facts.length,
          diagnosticCount: profile.diagnostics.length,
          truncated: profile.truncated,
        });
      }
      if (context.request.contextPack) {
        const pack = context.request.contextPack;
        await this.#emit(context, "context.assembled", {
          ...summarizeContextPack(pack),
          omissions: pack.omissions,
        });
      }
      const systemPromptPlan = context.request.systemPromptPlan;
      if (!systemPromptPlan?.rendered.trim()) throw new AlphionError("validation", "A versioned system prompt plan is required.", { stage: "context" });
      const messages: ProviderMessage[] = [
        { role: "system", content: systemPromptPlan.rendered },
        ...(context.request.contextPack
          ? [{ role: "system" as const, content: context.request.contextPack.rendered }]
          : []),
        ...(context.request.modelContextMessages ?? []),
        { role: "user", content: context.request.prompt },
      ];

      while (turns < context.budgets.maxTurns) {
        assertNotAborted(context.signal);
        const steering = await this.#beforeModelBoundary?.(context.runId, context.signal) ?? [];
        messages.push(...steering);
        turns += 1;
        const providerRequest = this.#createProviderRequest(messages, context);
        const outcome = await this.#runProviderTurn(providerRequest, context);
        usage = addUsage(usage, outcome.usage);
        if (outcome.toolCalls.length === 0) {
          finalText = outcome.text;
          const grounding = buildGroundingReport(finalText, [...evidence.keys()]);
          await this.#emit(context, "run.completed", {
            turns,
            toolCalls,
            usage,
            grounding,
          });
          return {
            runId: context.runId,
            sessionId: context.sessionId,
            status: "completed",
            finalText,
            turns,
            toolCalls,
            usage,
            grounding,
            ...(context.request.contextPack ? { context: summarizeContextPack(context.request.contextPack) } : {}),
            workingMemory: context.workingMemory,
          };
        }

        messages.push({
          role: "assistant",
          content: outcome.text,
          ...(outcome.reasoningContent ? { reasoningContent: outcome.reasoningContent } : {}),
          toolCalls: outcome.toolCalls,
        });
        toolCalls += outcome.toolCalls.length;
        if (toolCalls > context.budgets.maxToolCalls) throw new AlphionError("budget-exceeded", "Tool-call budget exceeded.", { stage: "tools" });
        const batch = await this.#executeToolBatch(outcome.toolCalls, context);
        for (const item of batch.results) {
          if (item.result.evidence) evidence.set(item.result.evidence.id, item.result.evidence);
          messages.push({ role: "tool", toolCallId: item.call.id, name: item.call.name, content: formatToolObservation(item.result) });
        }
        if (batch.terminate) {
          finalText = outcome.text || batch.results.map((item) => item.result.content).join("\n");
          const grounding = buildGroundingReport(finalText, [...evidence.keys()]);
          await this.#emit(context, "run.completed", { turns, toolCalls, usage, grounding, terminatedByToolBatch: true });
          return { runId: context.runId, sessionId: context.sessionId, status: "completed", finalText, turns, toolCalls, usage, grounding, ...(context.request.contextPack ? { context: summarizeContextPack(context.request.contextPack) } : {}), workingMemory: context.workingMemory };
        }
      }
      throw new AlphionError("budget-exceeded", "Agent turn budget exceeded.", { stage: "runtime" });
    } catch (error) {
      const normalized = didTimeout()
        ? new AlphionError("timeout", "Run deadline exceeded.", { stage: "runtime", cause: error })
        : normalizeError(error, "runtime");
      const cancelled = normalized.code === "cancelled";
      try {
        await this.#emit(context, cancelled ? "run.cancelled" : "run.failed", {
          code: normalized.code,
          stage: normalized.stage,
          retryable: normalized.retryable,
          message: normalized.message,
        });
      } catch {
        // A failed audit store is itself fail-closed; the result still reports failure.
      }
      return {
        runId: context.runId,
        sessionId: context.sessionId,
        status: cancelled ? "cancelled" : "failed",
        finalText,
        turns,
        toolCalls,
        usage,
        grounding: buildGroundingReport(finalText, [...evidence.keys()]),
        errorCode: normalized.code,
        ...(context.request.contextPack ? { context: summarizeContextPack(context.request.contextPack) } : {}),
        workingMemory: context.workingMemory,
      };
    }
  }

  #createProviderRequest(messages: readonly ProviderMessage[], context: RuntimeContext): ProviderRequest {
    const tools = this.#provider.profile.capabilities.tools ? this.#tools.definitions() : [];
    const stablePrefixDigest = sha256(
      canonicalJson({
        profileId: this.#provider.profile.id,
        profileRevision: this.#provider.profile.revision,
        system: messages[0],
        tools,
      }),
    );
    const base = {
      messages: [...messages],
      tools,
      maxOutputTokens: context.budgets.maxOutputTokens,
      temperature: 0,
    };
    return this.#provider.profile.capabilities.promptCaching
      ? { ...base, promptCacheKey: stablePrefixDigest }
      : base;
  }

  async #runProviderTurn(request: ProviderRequest, context: RuntimeContext): Promise<TurnOutcome> {
    const cacheSafe = !containsPotentialSecret(request);
    // Reasoning is in-run continuation state only and must never reach a durable cache.
    const cacheEnabled = context.request.cacheResponses !== false && cacheSafe && this.#cache !== undefined && !this.#provider.profile.capabilities.reasoning;
    const key = sha256(
      canonicalJson({
        adapter: `${this.#provider.profile.kind}-v2`,
        profile: {
          id: this.#provider.profile.id,
          revision: this.#provider.profile.revision,
          kind: this.#provider.profile.kind,
          protocol: this.#provider.profile.protocol,
          model: this.#provider.profile.model,
          reasoning: this.#provider.profile.capabilities.reasoning,
        },
        projectRevision: context.request.projectRevision,
        mutationRevision: context.mutationRevision,
        policyRevision: this.#policy.revision,
        permissionRevision: this.#approval.revision,
        shapeDigest: context.request.shape?.digest,
        request,
      }),
    );
    if (cacheEnabled) {
      const lookup = await this.#cache?.get("model-response", key);
      if (lookup?.entry) {
        const decoded = decodeProviderEvents(lookup.entry.value);
        if (decoded && !decoded.some((event) => event.type === "reasoning-delta") && !containsPotentialSecret(decoded) && areReusableProviderEvents(decoded, context.budgets.maxOutputBytes)) {
          await this.#emit(context, "cache.hit", { namespace: "model-response", tier: lookup.tier, key });
          return this.#consumeProviderEvents(decoded, context);
        }
      }
      await this.#emit(context, "cache.miss", { namespace: "model-response", key });
    }

    const flight = this.#providerFlights.acquire(key);
    if (!flight.owner) {
      const shared = await flight.promise;
      await this.#emit(context, "cache.hit", { namespace: "single-flight", tier: "l1", key });
      return this.#consumeProviderEvents(shared, context);
    }

    try {
      await this.#emit(context, "provider.started", {
        providerProfileId: this.#provider.profile.id,
        protocol: this.#provider.profile.protocol,
        model: this.#provider.profile.model,
      });
      const timeoutSignal = AbortSignal.timeout(context.budgets.modelTimeoutMs);
      const events: ProviderEvent[] = [];
      let outputBytes = 0;
      let doneEvents = 0;
      for await (const event of this.#provider.generate(request, AbortSignal.any([context.signal, timeoutSignal]))) {
        events.push(event);
        if (event.type === "text-delta" || event.type === "reasoning-delta") outputBytes += Buffer.byteLength(event.delta);
        else if (event.type === "done") doneEvents += 1;
        else if (event.type === "usage") assertValidUsage(event.usage);
        if (outputBytes > context.budgets.maxOutputBytes) {
          throw new AlphionError("budget-exceeded", "Provider output exceeded the configured byte limit.", { stage: "provider" });
        }
        if (doneEvents > 1) {
          throw new AlphionError("dependency-unavailable", "Provider returned ambiguous terminal events.", { stage: "provider" });
        }
        await this.#consumeProviderEvent(event, context);
      }
      if (doneEvents !== 1) {
        throw new AlphionError("dependency-unavailable", "Provider returned no terminal event.", { stage: "provider" });
      }
      flight.complete(events);
      if (cacheEnabled && !events.some((event) => event.type === "reasoning-delta") && !containsPotentialSecret(events)) {
        const now = Date.now();
        await this.#cache?.set({
          namespace: "model-response",
          key,
          value: JSON.stringify(events),
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
          provenance: canonicalJson({
            providerProfileId: this.#provider.profile.id,
            providerRevision: this.#provider.profile.revision,
            projectRevision: context.request.projectRevision,
            mutationRevision: context.mutationRevision,
            policyRevision: this.#policy.revision,
            permissionRevision: this.#approval.revision,
          }),
        });
        await this.#emit(context, "cache.stored", { namespace: "model-response", key });
      }
      return summarizeProviderEvents(events);
    } catch (error) {
      flight.fail(error);
      throw error;
    }
  }

  async #consumeProviderEvents(events: readonly ProviderEvent[], context: RuntimeContext): Promise<TurnOutcome> {
    assertProviderEventsWithinBudget(events, context.budgets.maxOutputBytes, true);
    for (const event of events) await this.#consumeProviderEvent(event, context);
    return summarizeProviderEvents(events);
  }

  async #consumeProviderEvent(event: ProviderEvent, context: RuntimeContext): Promise<void> {
    switch (event.type) {
      case "text-delta":
        await this.#emit(context, "model.delta", { delta: event.delta });
        return;
      case "reasoning-delta":
        await this.#emitTransientReasoning(context, event.delta);
        return;
      case "usage":
        await this.#emit(context, "model.usage", { usage: event.usage });
        return;
      case "degraded":
        await this.#emit(context, "provider.degraded", { reason: event.reason });
        return;
      case "tool-call":
      case "done":
        return;
    }
  }

  async #executeToolBatch(calls: readonly AgentToolCall[], context: RuntimeContext): Promise<Readonly<{ results: readonly ToolPipelineResult[]; terminate: boolean }>> {
    const results: ToolPipelineResult[] = [];
    for (let index = 0; index < calls.length;) {
      const first = calls[index];
      if (!first) break;
      const group: AgentToolCall[] = [first];
      if (this.#isParallelSafe(first)) {
        while (index + group.length < calls.length) {
          const candidate = calls[index + group.length];
          if (!candidate || !this.#isParallelSafe(candidate)) break;
          group.push(candidate);
        }
      }
      const settled = group.length === 1
        ? [await this.#executeTool(group[0] as AgentToolCall, context)]
        : await Promise.all(group.map((call) => {
            const updates: string[] = [];
            const completions: Readonly<Record<string, unknown>>[] = [];
            return this.#executeTool(call, context, updates, completions).then((result) => ({ result, updates, completions }));
          })).then(async (items) => {
            for (const item of items) {
              for (const content of item.updates) await this.#emit(context, "tool.updated", { toolCallId: item.result.call.id, toolName: item.result.call.name, content });
            }
            for (const item of items) {
              for (const payload of item.completions) await this.#emit(context, "tool.completed", payload);
            }
            return items.map((item) => item.result);
          });
      results.push(...settled);
      index += group.length;
    }
    return Object.freeze({ results: Object.freeze(results), terminate: results.some((item) => item.terminate) });
  }

  #isParallelSafe(call: AgentToolCall): boolean {
    const contract = this.#tools.get(call.name)?.contract;
    return contract?.executionMode === "parallel-safe"
      && contract.idempotent === true
      && contract.sideEffect === "none"
      && contract.risk === "read"
      && contract.approval === "never";
  }

  async #executeTool(
    call: AgentToolCall,
    context: RuntimeContext,
    bufferedUpdates?: string[],
    bufferedCompletions?: Readonly<Record<string, unknown>>[],
  ): Promise<ToolPipelineResult> {
    const complete = async (payload: Readonly<Record<string, unknown>>): Promise<void> => {
      if (bufferedCompletions) bufferedCompletions.push(payload);
      else await this.#emit(context, "tool.completed", payload);
    };
    const executor = this.#tools.get(call.name);
    if (!executor) {
      await this.#emit(context, "tool.requested", { toolCallId: call.id, toolName: call.name, arguments: call.arguments, final: true });
      const result = { content: `Unknown tool: ${call.name}`, isError: true } as const;
      await complete({ toolCallId: call.id, toolName: call.name, isError: true, code: "unknown-tool" });
      return { call, result, terminate: false };
    }
    let requestedPersisted = false;
    const persistRequested = async (argumentsValue: Readonly<Record<string, unknown>>) => {
      if (requestedPersisted) return;
      await this.#emit(context, "tool.requested", { toolCallId: call.id, toolName: call.name, arguments: argumentsValue, final: true });
      requestedPersisted = true;
    };
    try {
      validateJsonSchema(executor.contract.inputSchema, call.arguments);
      let finalArguments = call.arguments;
      let terminate = false;
      const toolContext = {
        projectRoot: context.request.projectRoot,
        signal: context.signal,
        reportUpdate: async (content: string) => {
          const safeContent = content.slice(0, 4096);
          if (bufferedUpdates) bufferedUpdates.push(safeContent);
          else await this.#emit(context, "tool.updated", { toolCallId: call.id, toolName: call.name, content: safeContent });
        },
      };
      for (const hook of executor.before ?? []) {
        const outcome = await hook(finalArguments, toolContext);
        if (outcome.action === "block" || outcome.action === "terminate") {
          await persistRequested(finalArguments);
          const result = { content: outcome.content, isError: outcome.action === "block" };
          await complete({ toolCallId: call.id, toolName: call.name, isError: result.isError, hookAction: outcome.action });
          return { call, result, terminate: outcome.action === "terminate" };
        }
        if (outcome.input) finalArguments = outcome.input;
      }
      validateJsonSchema(executor.contract.inputSchema, finalArguments);
      await persistRequested(finalArguments);
      const policy = this.#policy.evaluate(executor.contract, finalArguments);
      if (policy.outcome === "deny") {
        const result = { content: `Tool denied by policy: ${policy.reason}`, isError: true } as const;
        await complete({ toolCallId: call.id, toolName: call.name, isError: true, code: "policy-denied" });
        return { call, result, terminate: false };
      }
      const approvalRequired = executor.contract.approval === "always" || (executor.contract.approval !== "never" && policy.outcome === "approval");
      if (approvalRequired) {
      const actionDigest = sha256(canonicalJson({ tool: call.name, input: finalArguments, shapeDigest: context.request.shape?.digest }));
      const requestId = createId("approval");
      await this.#emit(context, "approval.requested", {
        requestId,
        toolName: call.name,
        actionDigest,
        ...(context.request.shape ? { shapeDigest: context.request.shape.digest } : {}),
        reason: policy.outcome === "approval" ? policy.reason : "Tool requires approval.",
      });
      const decision = await this.#approval.requestApproval(
        {
          requestId,
          runId: context.runId,
          toolName: call.name,
          risk: executor.contract.risk === "process" ? "process" : "write",
          actionDigest,
          ...(context.request.shape ? { shapeDigest: context.request.shape.digest } : {}),
          summary: `${call.name}: ${canonicalJson(finalArguments)}`,
          input: finalArguments,
        },
        context.signal,
      );
      await this.#emit(context, "approval.resolved", {
        requestId,
        approved: decision.approved,
        ...(context.request.shape ? { shapeDigest: context.request.shape.digest } : {}),
        reason: decision.reason,
      });
      if (!decision.approved) {
        const result = { content: `Tool approval denied: ${decision.reason}`, isError: true } as const;
        await complete({ toolCallId: call.id, toolName: call.name, isError: true, code: "approval-denied" });
        return { call, result, terminate: false };
      }
      }
      const toolCacheKey = executor.contract.cachePolicy === "content"
        ? sha256(canonicalJson({
            tool: executor.contract.name,
            schema: executor.contract.inputSchema,
            input: finalArguments,
            projectRevision: context.request.projectRevision,
            mutationRevision: context.mutationRevision,
            shapeDigest: context.request.shape?.digest,
          }))
        : undefined;
      let result: ToolResult;
      if (toolCacheKey && this.#cache) {
        const lookup = await this.#cache.get("tool-result", toolCacheKey);
        const cached = lookup.entry ? decodeToolResult(lookup.entry.value) : undefined;
        if (cached) {
          await this.#emit(context, "cache.hit", { namespace: "tool-result", tier: lookup.tier, key: toolCacheKey });
          result = cached;
        } else {
          await this.#emit(context, "cache.miss", { namespace: "tool-result", key: toolCacheKey });
          const flight = this.#toolFlights.acquire(toolCacheKey);
          if (flight.owner) {
            try {
              result = await this.#executeWithTimeout(executor, finalArguments, toolContext);
              flight.complete(result);
            } catch (error) {
              flight.fail(error);
              throw error;
            }
          } else {
            result = await flight.promise;
          }
          const now = Date.now();
          if (!containsPotentialSecret(result)) {
            await this.#cache.set({
              namespace: "tool-result",
              key: toolCacheKey,
              value: JSON.stringify(result),
              createdAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
              provenance: canonicalJson({
                projectRevision: context.request.projectRevision,
                mutationRevision: context.mutationRevision,
                shapeDigest: context.request.shape?.digest,
                tool: executor.contract.name,
              }),
            });
            await this.#emit(context, "cache.stored", { namespace: "tool-result", key: toolCacheKey });
          }
        }
      } else {
        result = await this.#executeWithTimeout(executor, finalArguments, toolContext);
      }
      const evidenceIdentity = result.evidence ? { id: result.evidence.id, digest: result.evidence.digest, kind: result.evidence.kind } : undefined;
      for (const hook of executor.after ?? []) {
        const outcome = await hook(result, toolContext);
        if (outcome.result) {
          if (evidenceIdentity && (!outcome.result.evidence || outcome.result.evidence.id !== evidenceIdentity.id || outcome.result.evidence.digest !== evidenceIdentity.digest || outcome.result.evidence.kind !== evidenceIdentity.kind)) {
            throw new AlphionError("integrity-failed", "After hook cannot replace Evidence identity or digest.", { stage: `tool:${call.name}` });
          }
          result = outcome.result;
        }
        terminate ||= outcome.terminate === true;
      }
      if (!result.isError && executor.contract.risk !== "read") context.mutationRevision += 1;
      await complete({
        toolCallId: call.id,
        toolName: call.name,
        isError: result.isError,
        content: result.content.slice(0, 16_384),
        ...(result.evidence ? { evidence: result.evidence } : {}),
      });
      return { call, result, terminate };
    } catch (error) {
      await persistRequested(call.arguments);
      const normalized = normalizeError(error, `tool:${call.name}`);
      await complete({
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        code: normalized.code,
      });
      return { call, result: { content: `${normalized.code}: ${normalized.message}`, isError: true }, terminate: false };
    }
  }

  async #executeWithTimeout(
    executor: NonNullable<ReturnType<ToolRegistry["get"]>>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<{ projectRoot: string; signal: AbortSignal; reportUpdate: (content: string) => Promise<void> }>,
  ): Promise<ToolResult> {
    const timeoutMs = executor.contract.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new AlphionError("validation", "Tool timeout must be 1-300000 ms.", { stage: "tools" });
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException("Tool execution deadline exceeded.", "TimeoutError")), timeoutMs);
    try {
      return await executor.execute(input, { ...context, signal: AbortSignal.any([context.signal, timeoutController.signal]) });
    } catch (error) {
      if (timeoutController.signal.aborted && !context.signal.aborted) throw new AlphionError("timeout", "Tool execution timed out.", { stage: `tool:${executor.contract.name}`, cause: error });
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #emit(
    context: RuntimeContext,
    kind: AgentEventKind,
    payload: Readonly<Record<string, unknown>>,
    causationId?: string,
  ): Promise<AgentEvent> {
    const draft: AgentEventDraft = {
      runId: context.runId,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
      kind,
      payload: sanitizeRecord(payload),
      ...(causationId ? { causationId } : {}),
    };
    const event = await this.#eventStore.append(draft);
    context.workingMemory = reduceWorkingMemory(context.workingMemory, event);
    await context.channel.push(event, isCriticalAgentEvent(kind));
    return event;
  }

  async #emitTransientReasoning(context: RuntimeContext, delta: string): Promise<void> {
    const event: AgentStreamEvent = Object.freeze({
      delivery: "transient",
      runId: context.runId,
      sessionId: context.sessionId,
      correlationId: context.correlationId,
      timestamp: new Date().toISOString(),
      kind: "model.reasoning.delta",
      payload: sanitizeRecord({ delta }),
    });
    await context.channel.push(event, false);
  }
}

function validateRunRequest(request: AgentRunRequest): void {
  if (request.prompt.trim().length === 0) {
    throw new AlphionError("validation", "Prompt must not be empty.", { stage: "request" });
  }
  if (request.projectRoot.trim().length === 0 || request.projectRevision.trim().length === 0) {
    throw new AlphionError("validation", "Project root and revision are required.", { stage: "request" });
  }
}

function mergeBudgets(overrides: Partial<AgentBudgets> | undefined): AgentBudgets {
  const budgets: AgentBudgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AlphionError("validation", `Budget ${name} must be a positive safe integer.`, { stage: "request" });
    }
  }
  return budgets;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled.", "AbortError");
}

function addUsage(left: ProviderUsage, right: ProviderUsage): ProviderUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}

function summarizeProviderEvents(events: readonly ProviderEvent[]): TurnOutcome {
  let text = "";
  let reasoningContent = "";
  let usage = emptyProviderUsage();
  const toolCalls: AgentToolCall[] = [];
  for (const event of events) {
    if (event.type === "text-delta") text += event.delta;
    else if (event.type === "reasoning-delta") reasoningContent += event.delta;
    else if (event.type === "tool-call") toolCalls.push(event.call);
    else if (event.type === "usage") usage = addUsage(usage, event.usage);
  }
  return { text, reasoningContent, toolCalls, usage };
}

function assertProviderEventsWithinBudget(
  events: readonly ProviderEvent[],
  maxOutputBytes: number,
  requireDone: boolean,
): void {
  let outputBytes = 0;
  let doneEvents = 0;
  for (const event of events) {
    if (event.type === "text-delta" || event.type === "reasoning-delta") outputBytes += Buffer.byteLength(event.delta);
    else if (event.type === "done") doneEvents += 1;
    else if (event.type === "usage") assertValidUsage(event.usage);
  }
  if (outputBytes > maxOutputBytes) {
    throw new AlphionError("budget-exceeded", "Provider output exceeded the configured byte limit.", { stage: "provider" });
  }
  if (doneEvents > 1 || (requireDone && doneEvents !== 1)) {
    throw new AlphionError("dependency-unavailable", "Provider returned an incomplete or ambiguous terminal event.", {
      stage: "provider",
    });
  }
}

function assertValidUsage(usage: ProviderUsage): void {
  const values = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new AlphionError("dependency-unavailable", "Provider returned invalid usage values.", { stage: "provider" });
  }
}

function areReusableProviderEvents(events: readonly ProviderEvent[], maxOutputBytes: number): boolean {
  try {
    assertProviderEventsWithinBudget(events, maxOutputBytes, true);
    return true;
  } catch {
    return false;
  }
}

function formatToolObservation(result: ToolResult): string {
  const evidence = result.evidence ? `\nEvidence: [evidence:${result.evidence.id}] ${result.evidence.summary}` : "";
  return `${result.isError ? "ERROR" : "OK"}: ${result.content}${evidence}`;
}

function buildGroundingReport(text: string, availableIds: readonly string[]): GroundingReport {
  const references = new Set<string>();
  for (const match of text.matchAll(/\[evidence:([A-Za-z0-9_-]+)\]/g)) {
    const id = match[1];
    if (id) references.add(id);
  }
  const available = new Set(availableIds);
  return {
    availableEvidenceIds: [...available],
    referencedEvidenceIds: [...references].filter((id) => available.has(id)),
    missingEvidenceIds: [...references].filter((id) => !available.has(id)),
    unreferencedEvidenceIds: [...available].filter((id) => !references.has(id)),
  };
}

function decodeProviderEvents(serialized: string): readonly ProviderEvent[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const decoded: ProviderEvent[] = [];
  for (const item of value) {
    const event = decodeProviderEvent(item);
    if (!event) return undefined;
    decoded.push(event);
  }
  return decoded;
}

function decodeProviderEvent(value: unknown): ProviderEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "text-delta":
      return typeof value.delta === "string" ? { type: "text-delta", delta: value.delta } : undefined;
    case "reasoning-delta":
      return typeof value.delta === "string" ? { type: "reasoning-delta", delta: value.delta } : undefined;
    case "degraded":
      return typeof value.reason === "string" ? { type: "degraded", reason: value.reason } : undefined;
    case "done":
      return typeof value.finishReason === "string" ? { type: "done", finishReason: value.finishReason } : undefined;
    case "usage": {
      const usage = decodeUsage(value.usage);
      return usage ? { type: "usage", usage } : undefined;
    }
    case "tool-call": {
      const call = decodeToolCall(value.call);
      return call ? { type: "tool-call", call } : undefined;
    }
    default:
      return undefined;
  }
}

function decodeUsage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { inputTokens, outputTokens, cachedInputTokens } = value;
  return typeof inputTokens === "number" && typeof outputTokens === "number" && typeof cachedInputTokens === "number"
    ? { inputTokens, outputTokens, cachedInputTokens }
    : undefined;
}

function decodeToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !isRecord(value.arguments)) {
    return undefined;
  }
  return { id: value.id, name: value.name, arguments: value.arguments };
}

function decodeToolResult(serialized: string): ToolResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.content !== "string" || typeof value.isError !== "boolean") return undefined;
  if (value.evidence === undefined) return { content: value.content, isError: value.isError };
  const evidence = value.evidence;
  if (
    !isRecord(evidence) ||
    typeof evidence.id !== "string" ||
    typeof evidence.kind !== "string" ||
    !["file", "search", "change", "process"].includes(evidence.kind) ||
    typeof evidence.digest !== "string" ||
    typeof evidence.summary !== "string"
  ) {
    return undefined;
  }
  return {
    content: value.content,
    isError: value.isError,
    evidence: {
      id: evidence.id,
      kind: evidence.kind as EvidenceRef["kind"],
      digest: evidence.digest,
      summary: evidence.summary,
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
