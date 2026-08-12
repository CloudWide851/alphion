import type { AgentEnvironment, AgentIdentity, ResourceLoadResult } from "../domain/contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";

export function createAgentEnvironment(input: Readonly<{
  identity?: AgentIdentity;
  projectRoot: string;
  projectRevision: string;
  capabilities: readonly string[];
  policies: readonly string[];
  loaded: ResourceLoadResult;
}>): AgentEnvironment {
  const identity = Object.freeze(input.identity ?? { id: "alphion", name: "Alphion", description: "Evidence-grounded project Agent" });
  const skills = Object.freeze(input.loaded.resources.filter((item) => item.kind === "skill"));
  const resources = Object.freeze([...input.loaded.resources]);
  const systemPrompt = renderAgentEnvironment({ identity, projectRevision: input.projectRevision, capabilities: input.capabilities, policies: input.policies, resources });
  const base = { identity, projectRoot: input.projectRoot, projectRevision: input.projectRevision, capabilities: Object.freeze([...input.capabilities]), policies: Object.freeze([...input.policies]), skills, resources, systemPrompt };
  return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) });
}

function renderAgentEnvironment(input: Readonly<{ identity: AgentIdentity; projectRevision: string; capabilities: readonly string[]; policies: readonly string[]; resources: AgentEnvironment["resources"] }>): string {
  const resources = input.resources.filter((item) => item.kind === "prompt" || item.kind === "context" || item.kind === "skill")
    .map((item) => `## ${item.kind}:${item.id}\n${item.content}`).join("\n\n");
  return [`# Identity\n${input.identity.name}: ${input.identity.description}`, `# Workspace\nrevision=${input.projectRevision}`, `# Capabilities\n${input.capabilities.join("\n") || "none"}`, `# Policies\n${input.policies.join("\n") || "default-deny"}`, resources].filter(Boolean).join("\n\n");
}
