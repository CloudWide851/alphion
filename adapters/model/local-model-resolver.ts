import { DeterministicRoutingPolicy, ProfileModelRegistry } from "../../src/application/model-routing.js";
import type { ModelDescriptor, ProviderProfile } from "../../src/domain/contracts.js";
import type { AgentProvider, AttachmentReader, ModelResolver, ProviderFactory, ProviderProfileStore, SecretResolver } from "../../src/ports/index.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { LocalProviderResolver } from "./provider-resolver.js";
import { describeProviderModel } from "./provider-catalog.js";

/** Concrete SDK construction stays in the adapter composition boundary. */
export class LocalProviderFactory implements ProviderFactory {
  constructor(private readonly secrets: SecretResolver, private readonly attachments?: AttachmentReader) {}
  create(profile: ProviderProfile): AgentProvider { return profile.kind === "deepseek" ? new DeepSeekProvider(profile, this.secrets, { ...(this.attachments ? { attachments: this.attachments } : {}) }) : new OpenAICompatibleProvider(profile, this.secrets, this.attachments); }
}

/** @deprecated Prefer injecting LocalProviderResolver through the ProviderResolver port. */
export class LocalModelResolver extends LocalProviderResolver implements ModelResolver {
  constructor(profiles: ProviderProfileStore, secrets: SecretResolver, attachments?: AttachmentReader) {
    super(new ProfileModelRegistry(profiles), new DeterministicRoutingPolicy(), new LocalProviderFactory(secrets, attachments));
  }
  describeModel(provider: AgentProvider): Promise<ModelDescriptor> { return Promise.resolve(describeProviderModel(provider.profile)); }
}
