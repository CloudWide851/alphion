import type { AgentIdentity, AgentShape, AgentShapeRequest, HarnessPlan, ProjectProfile, ResourceResolution, SessionBehavior } from "../domain/contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { AlphionError } from "./errors.js";
import { SystemPromptComposer } from "./system-prompt.js";

export interface AgentShaperOptions {
  readonly identity?: AgentIdentity;
  readonly capabilities: readonly string[];
  readonly policies: readonly string[];
  readonly tools: readonly string[];
  readonly toolCapabilities?: Readonly<Record<string, string>>;
  readonly composer?: SystemPromptComposer;
}

export class AgentShaper {
  readonly #identity: AgentIdentity;
  readonly #composer: SystemPromptComposer;
  constructor(private readonly options: AgentShaperOptions) {
    this.#identity = Object.freeze(options.identity ?? { id: "alphion", name: "Alphion", description: "Evidence-grounded project Agent" });
    this.#composer = options.composer ?? new SystemPromptComposer();
  }

  shape(input: Readonly<{ sessionId: string; revision: number; request: AgentShapeRequest; profile: ProjectProfile; resources: ResourceResolution; harness: HarnessPlan }>): AgentShape {
    const goal = input.request.goal.trim();
    if (!goal) throw new AlphionError("validation", "Agent shape goal cannot be empty.", { stage: "shape" });
    const harnessCapabilities = this.options.capabilities.filter((capability) => input.harness.capabilities.includes(capability));
    const capabilities = subset("capability", input.request.capabilities, harnessCapabilities);
    const policies = subset("policy", input.request.policies, this.options.policies);
    if (input.request.policies && this.options.policies.some((policy) => !policies.includes(policy))) throw new AlphionError("forbidden", "Agent shape cannot remove a root policy.", { stage: "shape" });
    const allowedTools = this.options.tools.filter((tool) => {
      const requiredCapability = this.options.toolCapabilities?.[tool];
      return !requiredCapability || capabilities.includes(requiredCapability);
    });
    const toolIds = subset("tool", input.request.toolIds, allowedTools);
    const requestedResources = selectResources(input.resources.resources, input.request.resourceIds);
    const unknownResources = (input.request.resourceIds ?? []).filter((id) => !input.resources.resources.some((item) => item.id === id));
    if (unknownResources.length > 0) throw new AlphionError("validation", `Unknown Agent shape resources: ${unknownResources.join(", ")}.`, { stage: "shape" });
    const behavior: SessionBehavior = Object.freeze({ compaction: input.request.behavior?.compaction ?? "hybrid", steering: input.request.behavior?.steering ?? true, followUps: input.request.behavior?.followUps ?? true });
    const promptPlan = this.#composer.compose({ sessionId: input.sessionId, identity: this.#identity, projectRevision: input.profile.projectRevision, goal, sessionBehavior: behavior, capabilities, policies, resources: requestedResources, harnessPlan: input.harness, ...(input.request.promptBudgetTokens ? { budgetTokens: input.request.promptBudgetTokens } : {}) });
    const base = {
      schemaVersion: 1 as const,
      sessionId: input.sessionId,
      revision: input.revision,
      goal,
      identity: this.#identity,
      systemPromptPlan: promptPlan,
      resources: Object.freeze(requestedResources),
      resourceIds: Object.freeze(requestedResources.map((item) => item.id)),
      resourceDigest: sha256(canonicalJson(requestedResources.map(({ id, kind, digest, dependencies, constraints, provenance }) => ({ id, kind, digest, dependencies, constraints, provenance })))),
      toolIds: Object.freeze(toolIds),
      capabilities: Object.freeze(capabilities),
      policies: Object.freeze(policies),
      behavior,
      ...(input.request.providerId ? { providerId: input.request.providerId } : {}),
      requiredProviderCapabilities: Object.freeze(toolIds.length > 0 ? ["tools" as const] : []),
      harnessPlan: input.harness,
      omissions: Object.freeze([...input.resources.omissions, ...promptPlan.omissions]),
      diagnostics: Object.freeze(input.resources.diagnostics.map((item) => item.code)),
    };
    return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) });
  }
}

function subset(label: string, requested: readonly string[] | undefined, allowed: readonly string[]): string[] { const values = [...new Set(requested ?? allowed)].sort(); const invalid = values.filter((item) => !allowed.includes(item)); if (invalid.length > 0) throw new AlphionError("forbidden", `Agent shape cannot widen ${label}: ${invalid.join(", ")}.`, { stage: "shape" }); return values; }

function selectResources(resources: ResourceResolution["resources"], requested: readonly string[] | undefined): readonly ResourceResolution["resources"][number][] {
  if (requested === undefined) return resources;
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const resource = byId.get(id);
    if (!resource) throw new AlphionError("validation", `Unknown Agent shape resources: ${id}.`, { stage: "shape" });
    for (const dependency of resource.dependencies) visit(dependency);
    selected.add(id);
  };
  for (const id of [...new Set(requested)].sort()) visit(id);
  return Object.freeze(resources.filter((resource) => selected.has(resource.id)));
}
