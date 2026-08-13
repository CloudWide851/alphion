import { parseSlashCommand, type SlashCommandContext } from "../ui/slash-commands.js";
import type { WorkbenchSection } from "./shell.js";

export type TuiSlashAction =
  | Readonly<{ readonly kind: "message"; readonly content: string }>
  | Readonly<{ readonly kind: "navigate"; readonly section: WorkbenchSection }>
  | Readonly<{ readonly kind: "new" }>
  | Readonly<{ readonly kind: "fork"; readonly title?: string }>
  | Readonly<{ readonly kind: "steer" | "follow-up"; readonly content: string }>
  | Readonly<{ readonly kind: "cancel" }>
  | Readonly<{ readonly kind: "error"; readonly message: string }>;

const SECTIONS: Readonly<Partial<Record<string, WorkbenchSection>>> = Object.freeze({
  settings: "settings", projects: "projects", sessions: "sessions", providers: "providers", resources: "resources",
  doctor: "doctor", help: "help", profile: "profile", harness: "harness",
});

export function resolveTuiInput(input: string, context: SlashCommandContext = {}): TuiSlashAction {
  const parsed = parseSlashCommand(input, context);
  if (parsed.kind === "not-command") return Object.freeze({ kind: "message", content: input.trim() });
  if (parsed.kind !== "command") return Object.freeze({ kind: "error", message: `未知快捷命令：${input.trim()}` });
  if (!parsed.availability.available) return Object.freeze({ kind: "error", message: parsed.availability.reason ?? "命令当前不可用。" });
  const name = parsed.descriptor.name;
  if (name === "new") return Object.freeze({ kind: "new" });
  if (name === "fork") return Object.freeze({ kind: "fork", ...(parsed.argument ? { title: parsed.argument } : {}) });
  if (name === "cancel") return Object.freeze({ kind: "cancel" });
  if (name === "steer" || name === "follow-up") return parsed.argument
    ? Object.freeze({ kind: name, content: parsed.argument })
    : Object.freeze({ kind: "error", message: `/${name} 需要消息参数。` });
  const section = SECTIONS[name];
  return section ? Object.freeze({ kind: "navigate", section }) : Object.freeze({ kind: "error", message: `无法执行 /${name}。` });
}
