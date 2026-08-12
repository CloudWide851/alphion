import type { CapabilityDescriptor, HarnessPlan, HarnessTaskOverlay, TaskLabel } from "../domain/contracts.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { AlphionError } from "./errors.js";

const LABEL_RULES: readonly Readonly<{ label: TaskLabel; pattern: RegExp }>[] = Object.freeze([
  { label: "release", pattern: /\b(?:release|publish|version|tag)\b|发布|版本/iu },
  { label: "implement", pattern: /\b(?:implement|build|create|change|fix|refactor|add)\b|实现|构建|修改|修复|新增/iu },
  { label: "diagnose", pattern: /\b(?:diagnose|debug|why|cause|investigate)\b|诊断|调试|原因|排查/iu },
  { label: "verify", pattern: /\b(?:verify|test|check|review|audit)\b|验证|测试|检查|审查/iu },
  { label: "explain", pattern: /.*/u },
]);

export class CapabilityRegistry {
  readonly #capabilities: ReadonlyMap<string, CapabilityDescriptor>;

  constructor(capabilities: readonly CapabilityDescriptor[]) {
    const entries = new Map<string, CapabilityDescriptor>();
    for (const capability of capabilities) {
      if (!/^[a-z][a-z0-9.-]*$/u.test(capability.id) || entries.has(capability.id)) {
        throw new AlphionError("validation", `Invalid or duplicate capability: ${capability.id}`, { stage: "harness" });
      }
      entries.set(capability.id, Object.freeze({ ...capability, taskLabels: Object.freeze([...capability.taskLabels]), permissions: Object.freeze([...capability.permissions]) }));
    }
    this.#capabilities = entries;
  }

  list(): readonly CapabilityDescriptor[] { return Object.freeze([...this.#capabilities.values()].sort((a, b) => a.id.localeCompare(b.id))); }
}

export function classifyTask(prompt: string): Readonly<{ label: TaskLabel; labels: readonly TaskLabel[]; risk: "low" | "medium" | "high"; reasons: readonly string[] }> {
  const normalized = prompt.trim();
  if (!normalized) throw new AlphionError("validation", "Harness prompt cannot be empty.", { stage: "harness" });
  const matched = LABEL_RULES.filter((rule) => rule.label !== "explain" && rule.pattern.test(normalized)).map((rule) => rule.label);
  const labels = Object.freeze(matched.length > 0 ? [...new Set(matched)] : ["explain" as const]);
  const label = labels[0] ?? "explain";
  const high = /\b(?:delete|credential|secret|publish|deploy|production|migration)\b|删除|凭据|密钥|生产|迁移/iu.test(normalized);
  const medium = label === "implement" || label === "release" || /\b(?:write|shell|command)\b|写入|命令/iu.test(normalized);
  const risk = high ? "high" : medium ? "medium" : "low";
  return Object.freeze({ label, labels, risk, reasons: Object.freeze(labels.map((item) => `task:${item}`).concat(`risk:${risk}`)) });
}

export function planHarness(prompt: string, registry: CapabilityRegistry, overlay?: HarnessTaskOverlay): HarnessPlan {
  const classified = classifyTask(prompt);
  const eligible = registry.list().filter((item) => item.taskLabels.some((label) => classified.labels.includes(label)));
  const baseCapabilities = eligible.map((item) => item.id);
  const requestedCapabilities = normalizedList(overlay?.capabilities);
  assertSubset("capability", requestedCapabilities, baseCapabilities);
  const capabilities = requestedCapabilities ?? baseCapabilities;
  const selected = eligible.filter((item) => capabilities.includes(item.id));
  const basePermissions = [...new Set(selected.flatMap((item) => item.permissions))].sort();
  const requestedPermissions = normalizedList(overlay?.permissions);
  assertSubset("permission", requestedPermissions, basePermissions);
  const permissions = requestedPermissions ?? basePermissions;
  const baseBudgets: Readonly<Record<string, number>> = { operations: selected.reduce((sum, item) => sum + item.defaultBudget, 0), maxRecallItems: 20 };
  const requestedBudgets = overlay?.budgets === undefined ? undefined : Object.fromEntries(Object.entries(overlay.budgets).sort(([a], [b]) => a.localeCompare(b)));
  for (const [key, value] of Object.entries(requestedBudgets ?? {})) {
    if (!(key in baseBudgets) || !Number.isFinite(value) || value < 0 || value > (baseBudgets[key] ?? -1)) {
      throw new AlphionError("validation", `Harness overlay cannot widen budget: ${key}`, { stage: "harness" });
    }
  }
  const budgets = Object.freeze({ ...baseBudgets, ...requestedBudgets });
  const effectiveOverlay = overlay === undefined ? undefined : Object.freeze({
    ...(requestedCapabilities ? { capabilities: Object.freeze(requestedCapabilities) } : {}),
    ...(requestedPermissions ? { permissions: Object.freeze(requestedPermissions) } : {}),
    ...(requestedBudgets ? { budgets: Object.freeze(requestedBudgets) } : {}),
    ...(overlay.evaluator ? { evaluator: overlay.evaluator } : {}),
  });
  const base = {
    schemaVersion: 1 as const,
    task: classified.label,
    taskLabels: classified.labels,
    risk: classified.risk,
    capabilities: Object.freeze(capabilities),
    reasons: Object.freeze([...classified.reasons, ...(overlay ? ["overlay:narrowed"] : [])]),
    permissions: Object.freeze(permissions),
    budgets,
    evaluator: overlay?.evaluator ?? (classified.label === "verify" ? "quality-gate" : "acceptance-criteria"),
    ...(effectiveOverlay ? { overlay: effectiveOverlay } : {}),
    omissions: Object.freeze(registry.list().filter((item) => !capabilities.includes(item.id)).map((item) => item.id)),
  };
  return Object.freeze({ ...base, digest: sha256(canonicalJson(base)) });
}

function normalizedList(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...new Set(values)].sort();
}

function assertSubset(label: string, requested: readonly string[] | undefined, allowed: readonly string[]): void {
  const widened = requested?.filter((value) => !allowed.includes(value));
  if (widened && widened.length > 0) throw new AlphionError("validation", `Harness overlay cannot widen ${label}: ${widened.join(", ")}`, { stage: "harness" });
}
