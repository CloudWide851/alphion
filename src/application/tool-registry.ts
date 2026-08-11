import type { ProviderToolDefinition } from "../domain/contracts.js";
import type { ToolExecutor } from "../ports/index.js";
import { AlphionError } from "./errors.js";

export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, ToolExecutor>;

  constructor(tools: readonly ToolExecutor[]) {
    const entries = new Map<string, ToolExecutor>();
    for (const tool of tools) {
      if (entries.has(tool.contract.name)) {
        throw new AlphionError("validation", `Duplicate tool name: ${tool.contract.name}`, { stage: "tools" });
      }
      entries.set(tool.contract.name, tool);
    }
    this.#tools = entries;
  }

  get(name: string): ToolExecutor | undefined {
    return this.#tools.get(name);
  }

  definitions(): readonly ProviderToolDefinition[] {
    return [...this.#tools.values()].map(({ contract }) => ({
      name: contract.name,
      description: contract.description,
      inputSchema: contract.inputSchema,
    }));
  }
}
