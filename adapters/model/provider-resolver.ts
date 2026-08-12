import { AlphionError } from "../../src/application/errors.js";
import { assertRouteAvailable } from "../../src/application/model-routing.js";
import type { ModelSelectionRequest, ProviderProfile } from "../../src/domain/contracts.js";
import type { AgentProvider, ModelRegistry, ProviderFactory, ProviderResolver, RoutingPolicy } from "../../src/ports/index.js";

export class LocalProviderResolver implements ProviderResolver {
  constructor(private readonly registry: ModelRegistry, private readonly routing: RoutingPolicy, private readonly factory: ProviderFactory) {}

  async resolve(request: ModelSelectionRequest): Promise<Readonly<{ provider: AgentProvider; reasons: readonly string[] }>> {
    const profiles = await this.registry.list();
    const candidates = this.routing.route(request, profiles);
    assertRouteAvailable(request, candidates);
    const reasons = candidates.map((item) => `${item.rank}:${item.profileId}:${item.reason}`);
    const failures: string[] = [];
    for (const selected of candidates) {
      const profile = profiles.find((item) => item.id === selected.profileId);
      if (!profile) throw new AlphionError("internal", "Routed provider profile disappeared.", { stage: "model-resolution" });
      assertCapabilities(profile, request);
      try { return Object.freeze({ provider: this.factory.create(profile), reasons: Object.freeze([...reasons, ...failures]) }); }
      catch (error) {
        const safe = error instanceof AlphionError ? error : undefined;
        if (!safe || !["validation", "forbidden", "dependency-unavailable"].includes(safe.code)) throw error;
        failures.push(`unavailable:${profile.id}:${safe.code}`);
      }
    }
    throw new AlphionError("dependency-unavailable", "No routed Provider could be constructed before execution.", { stage: "model-resolution" });
  }

  async resolveModel(request: ModelSelectionRequest): Promise<AgentProvider> { return (await this.resolve(request)).provider; }
}

function assertCapabilities(profile: ProviderProfile, request: ModelSelectionRequest): void {
  const missing = request.requiredCapabilities.filter((capability) => !profile.capabilities[capability]);
  if (missing.length > 0) throw new AlphionError("validation", `Provider ${profile.name} lacks required capabilities: ${missing.join(", ")}.`, { stage: "model-resolution" });
}
