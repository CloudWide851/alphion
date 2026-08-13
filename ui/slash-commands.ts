export type SlashCommandName =
  | "new" | "settings" | "projects" | "sessions" | "providers" | "resources" | "doctor" | "help" | "profile"
  | "harness" | "fork" | "steer" | "follow-up" | "cancel";

export interface SlashCommandDescriptor {
  readonly name: SlashCommandName;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
}

export interface SlashCommandContext {
  readonly hasSession?: boolean;
  readonly sessionIdle?: boolean;
  readonly activeRunId?: string;
}

export interface SlashCommandAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface SlashCommandMatch {
  readonly descriptor: SlashCommandDescriptor;
  readonly availability: SlashCommandAvailability;
}

export type SlashCommandParseResult =
  | Readonly<{ readonly kind: "not-command" }>
  | Readonly<{ readonly kind: "incomplete"; readonly matches: readonly SlashCommandMatch[] }>
  | Readonly<{ readonly kind: "unknown"; readonly input: string; readonly matches: readonly SlashCommandMatch[] }>
  | Readonly<{ readonly kind: "command"; readonly descriptor: SlashCommandDescriptor; readonly argument: string; readonly availability: SlashCommandAvailability }>;

export const SLASH_COMMANDS: readonly SlashCommandDescriptor[] = Object.freeze([
  command("new", "开始新对话", ["clear"]),
  command("settings", "打开设置", ["set"]),
  command("projects", "管理 Project", ["project"]),
  command("sessions", "浏览 Session", ["session"]),
  command("providers", "配置 Provider、Vault 与凭据", ["provider"]),
  command("resources", "查看 Agent 资源", ["resource"]),
  command("doctor", "运行只读 doctor", ["diagnose"]),
  command("help", "查看快捷命令", ["?"]),
  command("profile", "检查当前 Project", ["inspect"]),
  command("harness", "规划任务 Harness", ["plan"], "[任务]"),
  command("fork", "Fork 当前空闲 Session", [], "[标题]"),
  command("steer", "注入当前 Run 的下一模型边界", [], "<消息>"),
  command("follow-up", "排队或开始后续消息", ["followup"], "<消息>"),
  command("cancel", "取消当前 Run", ["stop"]),
]);

export function matchSlashCommands(input: string, context: SlashCommandContext = {}): readonly SlashCommandMatch[] {
  const query = commandToken(input).toLocaleLowerCase();
  const matches = SLASH_COMMANDS.filter((item) => !query || searchable(item).some((value) => value.includes(query)));
  return Object.freeze(matches.map((descriptor) => Object.freeze({ descriptor, availability: availabilityFor(descriptor.name, context) })));
}

export function parseSlashCommand(input: string, context: SlashCommandContext = {}): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return Object.freeze({ kind: "not-command" });
  const token = commandToken(trimmed).toLocaleLowerCase();
  const matches = matchSlashCommands(trimmed, context);
  if (!token) return Object.freeze({ kind: "incomplete", matches });
  const descriptor = SLASH_COMMANDS.find((item) => item.name === token || item.aliases.includes(token));
  if (!descriptor) return Object.freeze({ kind: "unknown", input: trimmed, matches });
  const separator = trimmed.search(/\s/u);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  return Object.freeze({ kind: "command", descriptor, argument, availability: availabilityFor(descriptor.name, context) });
}

export function formatSlashCommand(descriptor: SlashCommandDescriptor, argument = ""): string {
  return `/${descriptor.name}${argument.trim() ? ` ${argument.trim()}` : ""}`;
}

function availabilityFor(name: SlashCommandName, context: SlashCommandContext): SlashCommandAvailability {
  if (context.activeRunId && !["steer", "follow-up", "cancel"].includes(name)) return unavailable("运行期间请使用 /steer、/follow-up 或 /cancel");
  if (name === "fork") {
    if (!context.hasSession) return unavailable("需要当前 Session");
    if (!context.sessionIdle) return unavailable("仅空闲 Session 可 Fork");
  }
  if (name === "steer" || name === "cancel") {
    if (!context.activeRunId) return unavailable("需要活动 Run");
  }
  if (name === "follow-up" && !context.hasSession) return unavailable("需要当前 Session");
  return Object.freeze({ available: true });
}

function command(name: SlashCommandName, description: string, aliases: readonly string[], argumentHint?: string): SlashCommandDescriptor {
  return Object.freeze({ name, aliases: Object.freeze(aliases), description, ...(argumentHint ? { argumentHint } : {}) });
}

function unavailable(reason: string): SlashCommandAvailability { return Object.freeze({ available: false, reason }); }
function commandToken(input: string): string { return input.trimStart().replace(/^\//u, "").split(/\s/u, 1)[0] ?? ""; }
function searchable(item: SlashCommandDescriptor): readonly string[] { return [item.name, ...item.aliases, item.description.toLocaleLowerCase()]; }
