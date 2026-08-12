import type { ModelDescriptor, ModelRouteCandidate, ModelSelectionRequest, ProviderProfile } from "../domain/contracts.js";
import type { ModelMetadataRegistry, ModelRegistry, RoutingPolicy } from "../ports/index.js";
import { AlphionError } from "./errors.js";

export class ProfileModelRegistry implements ModelRegistry {
  constructor(private readonly profiles: Readonly<{ listProfiles(): Promise<readonly ProviderProfile[]>; getProfile(idOrName: string): Promise<ProviderProfile | undefined>; getActiveProfile(): Promise<ProviderProfile | undefined> }>) {}
  list(): Promise<readonly ProviderProfile[]> { return this.profiles.listProfiles(); }
  get(idOrName: string): Promise<ProviderProfile | undefined> { return this.profiles.getProfile(idOrName); }
  active(): Promise<ProviderProfile | undefined> { return this.profiles.getActiveProfile(); }
}

export class InMemoryModelMetadataRegistry implements ModelMetadataRegistry {
  readonly #models: readonly ModelDescriptor[];
  constructor(models: readonly ModelDescriptor[]) { this.#models = Object.freeze([...models].sort((left, right) => left.id.localeCompare(right.id))); }
  listModels(): Promise<readonly ModelDescriptor[]> { return Promise.resolve(this.#models); }
  getModel(id: string): Promise<ModelDescriptor | undefined> { return Promise.resolve(this.#models.find((model) => model.id === id)); }
}

export class DeterministicRoutingPolicy implements RoutingPolicy {
  route(request: ModelSelectionRequest, profiles: readonly ProviderProfile[]): readonly ModelRouteCandidate[] {
    const compatible = profiles.filter((profile) => request.requiredCapabilities.every((capability) => profile.capabilities[capability]));
    if (request.providerId) {
      const requested = compatible.find((profile) => profile.id === request.providerId || profile.name === request.providerId);
      const fallbacks = compatible.filter((profile) => profile.id !== requested?.id).sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));
      return Object.freeze([
        ...(requested ? [Object.freeze({ profileId: requested.id, reason: "session-preference", rank: 0 })] : []),
        ...fallbacks.map((profile, index) => Object.freeze({ profileId: profile.id, reason: requested ? (profile.active ? "active-profile-fallback" : "deterministic-fallback") : "requested-profile-unavailable-fallback", rank: index + (requested ? 1 : 0) })),
      ]);
    }
    return Object.freeze(compatible
      .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id))
      .map((profile, rank) => Object.freeze({ profileId: profile.id, reason: profile.active ? "active-profile" : "deterministic-fallback", rank })));
  }
}

export function assertRouteAvailable(request: ModelSelectionRequest, candidates: readonly ModelRouteCandidate[]): void {
  if (candidates.length > 0) return;
  throw new AlphionError("validation", request.providerId ? `Requested provider is missing or lacks required capabilities: ${request.providerId}.` : "No compatible provider profile is configured.", { stage: "model-resolution" });
}
