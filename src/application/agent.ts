import type { AgentExecutionRequest } from "../domain/contracts.js";
import type { AgentContract, AgentExecutionHooks, AgentRunHandle, ApprovalPort, EventStore, ModelResolver } from "../ports/index.js";
import { AgentLoop } from "./agent-runtime.js";
import type { TieredCache } from "./cache.js";
import type { ToolRegistry } from "./tool-registry.js";
import { projectAgentMessages } from "./message-projection.js";

export interface AgentOptions { readonly models: ModelResolver; readonly tools: ToolRegistry; readonly eventStore: EventStore; readonly cache?: TieredCache; }

/** Shared, session-neutral Agent. All session state arrives in execute(). */
export class Agent implements AgentContract {
  constructor(private readonly options: AgentOptions) {}

  async execute(request: AgentExecutionRequest, approval: ApprovalPort, hooks?: AgentExecutionHooks): Promise<AgentRunHandle> {
    const provider = await this.options.models.resolveModel({ sessionId: request.sessionId ?? "unbound", ...(request.providerId ? { providerId: request.providerId } : {}), requiredCapabilities: this.options.tools.definitions().length > 0 ? ["tools"] : [] });
    const runtime = new AgentLoop({
      provider,
      tools: this.options.tools,
      eventStore: this.options.eventStore,
      approval,
      ...(this.options.cache ? { cache: this.options.cache } : {}),
      ...(hooks ? { beforeModelBoundary: async (runId, signal) => projectAgentMessages(await hooks.drainSteering(runId, signal)) } : {}),
    });
    const history = projectAgentMessages(request.history).map((message) => `${message.role}: ${message.content}`).join("\n");
    return runtime.execute({ ...request, systemInstructions: [
      request.environment.systemPrompt,
      request.recall ? `# Code Recall\ndegraded=${request.recall.degraded}\ndiagnostics=${request.recall.diagnostics.join(";")}\n${request.recall.items.map((item) => `[${item.source}] ${item.path} confidence=${item.confidence} evidence=${item.evidence}\n${item.excerpt}`).join("\n\n")}` : "",
      `# HarnessPlan\ndigest=${request.harnessPlan.digest}\ntask=${request.harnessPlan.task}\nrisk=${request.harnessPlan.risk}\ncapabilities=${request.harnessPlan.capabilities.join(",")}\npermissions=${request.harnessPlan.permissions.join(",")}\nbudgets=${JSON.stringify(request.harnessPlan.budgets)}\nevaluator=${request.harnessPlan.evaluator}\nreasons=${request.harnessPlan.reasons.join(";")}\nomissions=${request.harnessPlan.omissions.join(",")}`,
      history ? `Current session branch:\n${history}` : "",
      request.systemInstructions,
    ].filter(Boolean).join("\n\n") });
  }
}
