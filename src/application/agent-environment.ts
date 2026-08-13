import type { AgentEnvironment, AgentIdentity, HarnessPlan, ResourceResolution, SessionBehavior, SystemPromptPlan } from "../domain/contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { SystemPromptComposer } from "./system-prompt.js";

export function createAgentEnvironment(input: Readonly<{
  identity?: AgentIdentity;
  sessionId?: string;
  projectRoot: string;
  projectRevision: string;
  capabilities: readonly string[];
  policies: readonly string[];
  loaded: ResourceResolution;
  goal?: string;
  behavior?: SessionBehavior;
  harnessPlan?: HarnessPlan;
  promptBudgetTokens?: number;
  systemPromptPlan?: SystemPromptPlan;
}>): AgentEnvironment {
  const identity = Object.freeze(input.identity ?? { id: "alphion", name: "Alphion", description: "Evidence-grounded project Agent" });
  const skills = Object.freeze(input.loaded.resources.filter((item) => item.kind === "skill"));
  const resources = Object.freeze([...input.loaded.resources]);
  const behavior = input.behavior ?? Object.freeze({ compaction: "hybrid" as const, steering: true, followUps: true });
  const systemPromptPlan = input.systemPromptPlan ?? new SystemPromptComposer().compose({ sessionId: input.sessionId ?? "unbound", identity, projectRevision: input.projectRevision, goal: input.goal ?? "Assist with the current project task.", sessionBehavior: behavior, capabilities: input.capabilities, policies: input.policies, resources, ...(input.harnessPlan ? { harnessPlan: input.harnessPlan } : {}), ...(input.promptBudgetTokens ? { budgetTokens: input.promptBudgetTokens } : {}) });
  const base = { identity, projectRoot: input.projectRoot, projectRevision: input.projectRevision, capabilities: Object.freeze([...input.capabilities]), policies: Object.freeze([...input.policies]), skills, resources, systemPromptPlan };
  return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) });
}
