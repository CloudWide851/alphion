import type { ToolContract } from "../domain/contracts.js";
import type { CapabilityPolicy, PolicyDecision } from "../ports/index.js";

export class DefaultCapabilityPolicy implements CapabilityPolicy {
  readonly revision = "default-capability-policy-v1";

  evaluate(tool: ToolContract): PolicyDecision {
    switch (tool.risk) {
      case "read":
        return { outcome: "allow" };
      case "write":
        return { outcome: "approval", reason: "Workspace mutation requires per-call approval." };
      case "process":
        return { outcome: "approval", reason: "Process execution requires per-call approval." };
    }
  }
}
