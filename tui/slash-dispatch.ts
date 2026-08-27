import { parseNewProjectArguments, parseSlashCommand, type SlashCommandContext } from "../ui/slash-commands.js";
import type { WorkbenchSection } from "./shell.js";

export type TuiSlashAction =
  | Readonly<{ readonly kind: "message"; readonly content: string }>
  | Readonly<{ readonly kind: "navigate"; readonly section: WorkbenchSection }>
  | Readonly<{ readonly kind: "new" }>
  | Readonly<{ readonly kind: "new-project"; readonly root: string; readonly name?: string }>
  | Readonly<{ readonly kind: "fork"; readonly title?: string }>
  | Readonly<{ readonly kind: "steer" | "follow-up"; readonly content: string }>
  | Readonly<{ readonly kind: "cancel" }>
  | Readonly<{ readonly kind: "error"; readonly message: string }>;

const SECTIONS: Readonly<Partial<Record<string, WorkbenchSection>>> = Object.freeze({
  settings: "settings", "open-projects": "projects", "open-sessions": "sessions", providers: "providers", resources: "resources",
  doctor: "doctor", help: "help", profile: "profile", harness: "harness", context: "context", goals: "goals", goal: "goal", schedules: "schedules",
});

export function resolveTuiInput(input: string, context: SlashCommandContext = {}): TuiSlashAction {
  const parsed = parseSlashCommand(input, context);
  if (parsed.kind === "not-command") return Object.freeze({ kind: "message", content: input.trim() });
  if (parsed.kind !== "command") return Object.freeze({ kind: "error", message: `未知快捷命令：${input.trim()}` });
  if (!parsed.availability.available) return Object.freeze({ kind: "error", message: parsed.availability.reason ?? "命令当前不可用。" });
  const id = parsed.descriptor.id;
  if (id === "new") return Object.freeze({ kind: "new" });
  if (id === "new-project") { try { return Object.freeze({ kind: "new-project", ...parseNewProjectArguments(parsed.argumentTokens) }); } catch (error) { return Object.freeze({ kind: "error", message: error instanceof Error ? error.message : "Project 参数无效。" }); } }
  if (id === "fork") return Object.freeze({ kind: "fork", ...(parsed.argument ? { title: parsed.argument } : {}) });
  if (id === "cancel") return Object.freeze({ kind: "cancel" });
  if (id === "steer" || id === "follow-up") return parsed.argument
    ? Object.freeze({ kind: id, content: parsed.argument })
    : Object.freeze({ kind: "error", message: `/${id} 需要消息参数。` });
  const section = SECTIONS[id];
  return section ? Object.freeze({ kind: "navigate", section }) : Object.freeze({ kind: "error", message: `无法执行 ${parsed.descriptor.tokens.join(" ")}。` });
}
