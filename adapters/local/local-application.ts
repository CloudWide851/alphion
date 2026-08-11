import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRuntime } from "../../src/application/agent-runtime.js";
import { TieredCache } from "../../src/application/cache.js";
import { AlphionError } from "../../src/application/errors.js";
import { ProviderConfigurationManager } from "../../src/application/provider-configuration.js";
import { ToolRegistry } from "../../src/application/tool-registry.js";
import type { AgentApplicationRunRequest } from "../../src/domain/contracts.js";
import type {
  AgentApplication,
  AgentProvider,
  AgentRunHandle,
  ApprovalPort,
  ProviderConfigurationService,
} from "../../src/ports/index.js";
import { MemoryLruCache } from "../cache/memory-cache.js";
import { DeepSeekProvider } from "../model/deepseek.js";
import { OpenAICompatibleProvider } from "../model/openai-compatible.js";
import { projectRevision } from "../project/project-revision.js";
import { CompositeSecretResolver } from "../secrets/composite-secret.js";
import { EnvironmentSecretResolver } from "../secrets/environment-secret.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { EditTool, GrepTool, ReadTool, ShellTool, WriteTool } from "../tools/index.js";

export interface LocalApplicationOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
}

export class LocalAlphionApplication implements AgentApplication {
  readonly configuration: ProviderConfigurationService;
  readonly #projectRoot: string;
  readonly #store: SqliteStore;
  readonly #secrets: CompositeSecretResolver;
  #closed = false;

  private constructor(projectRoot: string, store: SqliteStore) {
    this.#projectRoot = projectRoot;
    this.#store = store;
    this.#secrets = new CompositeSecretResolver([new EnvironmentSecretResolver(), store]);
    this.configuration = new ProviderConfigurationManager(store, store);
  }

  static async open(options: LocalApplicationOptions): Promise<LocalAlphionApplication> {
    const projectRoot = await realpath(resolve(options.projectRoot));
    const statePath = resolve(options.statePath ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
    return new LocalAlphionApplication(projectRoot, new SqliteStore({ path: statePath }));
  }

  async startRun(request: AgentApplicationRunRequest, approval: ApprovalPort): Promise<AgentRunHandle> {
    this.#assertOpen();
    const profile = request.providerId
      ? await this.#store.getProfile(request.providerId)
      : await this.#store.getActiveProfile();
    if (!profile) {
      throw new AlphionError(
        "validation",
        request.providerId ? `Unknown provider profile: ${request.providerId}` : "No active provider profile is configured.",
        { stage: "config" },
      );
    }
    const provider: AgentProvider = profile.kind === "deepseek"
      ? new DeepSeekProvider(profile, this.#secrets)
      : new OpenAICompatibleProvider(profile, this.#secrets);
    const runtime = new AgentRuntime({
      provider,
      approval,
      cache: new TieredCache(new MemoryLruCache(), this.#store),
      eventStore: this.#store,
      tools: new ToolRegistry([
        new ReadTool(),
        new GrepTool(),
        new EditTool(),
        new WriteTool(),
        new ShellTool(this.#store),
      ]),
    });
    return runtime.start({
      prompt: request.prompt,
      projectRoot: this.#projectRoot,
      projectRevision: await projectRevision(this.#projectRoot),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.systemInstructions ? { systemInstructions: request.systemInstructions } : {}),
      ...(request.budgets ? { budgets: request.budgets } : {}),
      ...(request.cacheResponses !== undefined ? { cacheResponses: request.cacheResponses } : {}),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new AlphionError("conflict", "Local Alphion application is closed.", { stage: "application" });
  }
}

export function openLocalAlphionApplication(options: LocalApplicationOptions): Promise<LocalAlphionApplication> {
  return LocalAlphionApplication.open(options);
}
