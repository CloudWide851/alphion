export type SlashCommandId =
  | "new" | "new-project" | "open-projects" | "open-sessions" | "settings" | "providers" | "resources" | "doctor" | "help" | "profile"
  | "harness" | "context" | "goals" | "goal" | "schedules" | "fork" | "steer" | "follow-up" | "cancel";
export type SlashCommandName = SlashCommandId;

export interface SlashCommandDescriptor {
  readonly id: SlashCommandId;
  readonly tokens: readonly string[];
  readonly aliases: readonly (readonly string[])[];
  readonly description: string;
  readonly argumentHint?: string;
}

export interface SlashCommandContext { readonly hasSession?: boolean; readonly sessionIdle?: boolean; readonly activeRunId?: string; }
export interface SlashCommandAvailability { readonly available: boolean; readonly reason?: string; }
export interface SlashCommandMatch { readonly descriptor: SlashCommandDescriptor; readonly availability: SlashCommandAvailability; }
export type SlashCommandParseResult =
  | Readonly<{ readonly kind: "not-command" }>
  | Readonly<{ readonly kind: "incomplete"; readonly matches: readonly SlashCommandMatch[] }>
  | Readonly<{ readonly kind: "unknown"; readonly input: string; readonly matches: readonly SlashCommandMatch[] }>
  | Readonly<{ readonly kind: "command"; readonly descriptor: SlashCommandDescriptor; readonly argument: string; readonly argumentTokens: readonly string[]; readonly availability: SlashCommandAvailability }>;

export const SLASH_COMMANDS: readonly SlashCommandDescriptor[] = Object.freeze([
  command("new-project", ["new", "project"], "创建或复用 Project", [], "<目录> [--name <名称>]"),
  command("open-projects", ["open", "projects"], "打开 Project 选择器", [["projects"], ["project"]]),
  command("open-sessions", ["open", "sessions"], "打开当前 Project 的 Session 选择器", [["sessions"], ["session"]]),
  command("new", ["new"], "开始新对话", [["clear"]]),
  command("settings", ["settings"], "打开统一设置与管理", [["setting"]]),
  command("providers", ["providers"], "配置 Provider 与 Project 加密凭据", [["provider"]]),
  command("resources", ["resources"], "查看 Agent 资源", [["resource"]]),
  command("doctor", ["doctor"], "运行只读 doctor", [["diagnose"]]),
  command("help", ["help"], "查看快捷命令", [["?"]]),
  command("profile", ["profile"], "检查当前 Project", [["inspect"]]),
  command("harness", ["harness"], "规划任务 Harness", [["plan"]], "[任务]"),
  command("context", ["context"], "查看自动上下文优化状态", [["compact"]]),
  command("goals", ["goals"], "浏览长期 Goal", [["goal-list"]]),
  command("goal", ["goal"], "创建、推进或确认 Goal", [], "[操作]"),
  command("schedules", ["schedules"], "管理定时复盘与 Session 提示", [["schedule"]]),
  command("fork", ["fork"], "Fork 当前空闲 Session", [], "[标题]"),
  command("steer", ["steer"], "注入当前 Run 的下一模型边界", [], "<消息>"),
  command("follow-up", ["follow-up"], "排队或开始后续消息", [["followup"]], "<消息>"),
  command("cancel", ["cancel"], "取消当前 Run", [["stop"]]),
]);

export function matchSlashCommands(input: string, context: SlashCommandContext = {}): readonly SlashCommandMatch[] {
  const trimmed = input.trimStart();
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const query = scanTokens(body).tokens.map((token) => token.value.toLocaleLowerCase());
  const matches = SLASH_COMMANDS.filter((descriptor) => {
    if (query.length === 0) return true;
    if (paths(descriptor).some((path) => pathMatches(path, query))) return true;
    return query.length === 1 && descriptor.description.toLocaleLowerCase().includes(query[0] ?? "");
  });
  return Object.freeze(matches.map((descriptor) => Object.freeze({ descriptor, availability: availabilityFor(descriptor.id, context) })));
}

export function parseSlashCommand(input: string, context: SlashCommandContext = {}): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return Object.freeze({ kind: "not-command" });
  const body = trimmed.slice(1);
  const scanned = scanTokens(body);
  const matches = matchSlashCommands(trimmed, context);
  if (scanned.tokens.length === 0 || scanned.unterminated) return Object.freeze({ kind: "incomplete", matches });
  const values = scanned.tokens.map((token) => token.value.toLocaleLowerCase());
  const exact = SLASH_COMMANDS.flatMap((descriptor) => paths(descriptor).map((path) => ({ descriptor, path })))
    .filter((candidate) => candidate.path.every((token, index) => values[index] === token))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!exact) return matches.length ? Object.freeze({ kind: "incomplete", matches }) : Object.freeze({ kind: "unknown", input: trimmed, matches });
  const argumentTokens = scanned.tokens.slice(exact.path.length);
  if (!exact.descriptor.argumentHint && argumentTokens.length > 0) {
    const partialLonger = pathsForMatches(matches).some((path) => path.length > exact.path.length && pathMatches(path, values));
    return Object.freeze(partialLonger ? { kind: "incomplete", matches } : { kind: "unknown", input: trimmed, matches });
  }
  const start = argumentTokens[0]?.start;
  const argument = start === undefined ? "" : body.slice(start).trim();
  return Object.freeze({ kind: "command", descriptor: exact.descriptor, argument, argumentTokens: Object.freeze(argumentTokens.map((token) => token.value)), availability: availabilityFor(exact.descriptor.id, context) });
}

export function formatSlashCommand(descriptor: SlashCommandDescriptor, argument = ""): string {
  return `/${descriptor.tokens.join(" ")}${argument.trim() ? ` ${argument.trim()}` : ""}`;
}

export function parseNewProjectArguments(tokens: readonly string[]): Readonly<{ root: string; name?: string }> {
  if (tokens.length === 0) throw new Error("/new project 需要目录。");
  const root = tokens[0]?.trim() ?? "";
  let name: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    if (tokens[index] !== "--name" || name !== undefined || !tokens[index + 1]?.trim()) throw new Error("/new project 只支持 <目录> [--name <名称>]。");
    name = tokens[index + 1]!.trim(); index += 1;
  }
  return Object.freeze({ root, ...(name ? { name } : {}) });
}

function availabilityFor(id: SlashCommandId, context: SlashCommandContext): SlashCommandAvailability {
  if (context.activeRunId && !["steer", "follow-up", "cancel", "settings", "context", "goals", "goal", "schedules", "help"].includes(id)) return unavailable("运行期间请使用 /steer、/follow-up、/cancel 或只读状态命令");
  if (id === "fork") { if (!context.hasSession) return unavailable("需要当前 Session"); if (!context.sessionIdle) return unavailable("仅空闲 Session 可 Fork"); }
  if ((id === "steer" || id === "cancel") && !context.activeRunId) return unavailable("需要活动 Run");
  if (id === "follow-up" && !context.hasSession) return unavailable("需要当前 Session");
  return Object.freeze({ available: true });
}

function command(id: SlashCommandId, tokens: readonly string[], description: string, aliases: readonly (readonly string[])[], argumentHint?: string): SlashCommandDescriptor {
  return Object.freeze({ id, tokens: Object.freeze(tokens), aliases: Object.freeze(aliases.map((alias) => Object.freeze(alias))), description, ...(argumentHint ? { argumentHint } : {}) });
}
function paths(descriptor: SlashCommandDescriptor): readonly (readonly string[])[] { return [descriptor.tokens, ...descriptor.aliases]; }
function pathsForMatches(matches: readonly SlashCommandMatch[]): readonly (readonly string[])[] { return matches.flatMap((match) => paths(match.descriptor)); }
function pathMatches(path: readonly string[], query: readonly string[]): boolean {
  for (let index = 0; index < Math.min(path.length, query.length); index += 1) { const token = query[index] ?? ""; if (!path[index]?.includes(token)) return false; }
  return query.length <= path.length || path.every((token, index) => query[index] === token);
}
function unavailable(reason: string): SlashCommandAvailability { return Object.freeze({ available: false, reason }); }

function scanTokens(input: string): Readonly<{ tokens: readonly Readonly<{ value: string; start: number }>[]; unterminated: boolean }> {
  const tokens: Array<Readonly<{ value: string; start: number }>> = [];
  let index = 0; let unterminated = false;
  while (index < input.length) {
    while (/\s/u.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    const start = index; let value = ""; let quote: "\"" | "'" | undefined;
    while (index < input.length) {
      const character = input[index]!;
      if (!quote && /\s/u.test(character)) break;
      if (!quote && (character === "\"" || character === "'")) { quote = character; index += 1; continue; }
      if (quote && character === quote) { quote = undefined; index += 1; continue; }
      if (quote && character === "\\" && input[index + 1] === quote) { value += quote; index += 2; continue; }
      value += character; index += 1;
    }
    if (quote) unterminated = true;
    tokens.push(Object.freeze({ value, start }));
  }
  return Object.freeze({ tokens: Object.freeze(tokens), unterminated });
}
