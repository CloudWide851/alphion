import { AlphionError } from "../../src/application/errors.js";
import type { ModelSelectionRequest } from "../../src/domain/contracts.js";
import type { AgentProvider, ModelResolver, ProviderProfileStore, SecretResolver } from "../../src/ports/index.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export class LocalModelResolver implements ModelResolver {
  constructor(private readonly profiles: ProviderProfileStore, private readonly secrets: SecretResolver) {}

  async resolveModel(request: ModelSelectionRequest): Promise<AgentProvider> {
    const profile = request.providerId ? await this.profiles.getProfile(request.providerId) : await this.profiles.getActiveProfile();
    if (!profile) throw new AlphionError("validation", request.providerId ? `Unknown provider profile: ${request.providerId}` : "No active provider profile is configured.", { stage: "model-resolution" });
    for (const capability of request.requiredCapabilities) {
      if (!profile.capabilities[capability]) throw new AlphionError("validation", `Provider ${profile.name} does not support ${capability}.`, { stage: "model-resolution" });
    }
    return profile.kind === "deepseek" ? new DeepSeekProvider(profile, this.secrets) : new OpenAICompatibleProvider(profile, this.secrets);
  }
}
