import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderProfile } from "../src/index.js";
import { parseMarkdown, renderMarkdownText } from "../ui/markdown.js";
import { ChatEntry } from "./input.js";
import { sanitizeTerminalText } from "./run-projection.js";
import type { SlashCommandContext } from "../ui/slash-commands.js";

export type WorkbenchSection = "home" | "settings" | "projects" | "profile" | "providers" | "sessions" | "resources" | "harness" | "context" | "goals" | "goal" | "schedules" | "doctor" | "help";
export type WorkbenchLayout = "wide" | "narrow" | "compact";
export interface ChatMessage { readonly id: string; readonly role: "user" | "assistant"; readonly content: string; }

export const BRAND_PURPLE = "#A377F6";
const SECTIONS: readonly Readonly<{ id: WorkbenchSection; label: string }>[] = Object.freeze([
  { id: "home", label: "对话" }, { id: "settings", label: "设置" }, { id: "projects", label: "项目" },
  { id: "profile", label: "项目画像" }, { id: "providers", label: "Provider / 设备凭据" }, { id: "sessions", label: "共享会话" },
  { id: "resources", label: "Agent 资源" }, { id: "harness", label: "HarnessPlan" }, { id: "context", label: "上下文优化" },
  { id: "goals", label: "长期 Goal" }, { id: "goal", label: "Goal 操作" }, { id: "schedules", label: "定时任务" }, { id: "doctor", label: "只读诊断" }, { id: "help", label: "快捷命令" },
]);
const LOGO = Object.freeze([" █████╗ ██╗     ██████╗ ██╗  ██╗██╗ ██████╗ ███╗   ██╗", "██╔══██╗██║     ██╔══██╗██║  ██║██║██╔═══██╗████╗  ██║", "███████║██║     ██████╔╝███████║██║██║   ██║██╔██╗ ██║", "██╔══██║██║     ██╔═══╝ ██╔══██║██║██║   ██║██║╚██╗██║", "██║  ██║███████╗██║     ██║  ██║██║╚██████╔╝██║ ╚████║", "╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝"]);

export function selectWorkbenchLayout(columns: number, rows: number): WorkbenchLayout { if (rows < 18) return "compact"; return columns >= 100 ? "wide" : "narrow"; }
export function AppShell(props: Readonly<{ section: WorkbenchSection; layout: WorkbenchLayout; colorEnabled: boolean; projectRoot: string; error?: string; help?: boolean; children: React.ReactNode }>): React.JSX.Element {
  const current = SECTIONS.find((entry) => entry.id === props.section);
  return <Box flexDirection="column" paddingX={1}>
    {props.section === "home" ? null : <Box flexDirection="column" marginTop={props.layout === "compact" ? 0 : 1} marginBottom={props.layout === "compact" ? 0 : 1}><Text bold {...accent(props.colorEnabled)}>ALPHION · {current?.label ?? "对话"}</Text>{props.layout === "compact" ? null : <Text dimColor>{sanitizeTerminalText(props.projectRoot)}</Text>}</Box>}
    {props.children}
    {props.error ? <Box borderStyle="round" {...borderColor("red")} paddingX={1}><Text {...textColor("red")}>✗ {sanitizeTerminalText(props.error)}</Text></Box> : null}
    {props.help ? <Box borderStyle="round" paddingX={1}><Text>↑/↓ 选择 · Enter 确认 · Esc 返回对话 · ? 帮助 · q 退出 · Ctrl+C 取消/退出</Text></Box> : null}
    {props.section === "home" ? null : <Text dimColor>Esc 返回对话 · ↑/↓ 选择 · Enter 确认 · ? 帮助 · q 退出</Text>}
  </Box>;
}
export function ChatHome(props: Readonly<{ activeProfile?: ProviderProfile; messages?: readonly ChatMessage[]; activeBubble?: React.ReactNode; compactionCount?: number; compact: boolean; slashContext?: SlashCommandContext; onSubmit: (value: string) => boolean | void }>): React.JSX.Element {
  const messages = props.messages ?? [];
  return <Box flexDirection="column" minHeight={props.compact ? 10 : 18} justifyContent="space-between">
    {messages.length === 0 && !props.activeBubble ? <Box flexDirection="column" alignItems="center" marginTop={props.compact ? 0 : 2}>{props.compact ? null : LOGO.map((line) => <Text key={line} bold {...accent()}>{line}</Text>)}<Text bold {...accent()}>ALPHION</Text><Text dimColor>{props.activeProfile ? `${props.activeProfile.name} · ${props.activeProfile.model}` : "请先使用 /providers 配置 Provider"}</Text></Box> : <Box flexDirection="column">{messages.slice(props.compact ? -4 : -10).map((message) => <Box key={message.id} flexDirection="column" marginBottom={1} borderStyle="round" paddingX={1} {...(message.role === "assistant" ? borderColor(BRAND_PURPLE) : {})}><Text bold {...(message.role === "assistant" ? accent() : {})}>{message.role === "assistant" ? "Alphion" : "你"}</Text><Text>{renderMarkdownText(parseMarkdown(message.content), 88)}</Text></Box>)}{props.activeBubble}</Box>}
    {props.compactionCount ? <Text dimColor>✓ 已优化上下文 · {props.compactionCount} 次</Text> : null}<ChatEntry {...(props.slashContext ? { slashContext: props.slashContext } : {})} onSubmit={props.onSubmit} />
  </Box>;
}
export function SettingsCard(props: Readonly<{ onSelect: (section: WorkbenchSection) => void }>): React.JSX.Element {
  const items = SECTIONS.filter((entry) => !["home", "settings"].includes(entry.id)); const [selected, setSelected] = useState(0); const selectedRef = useRef(0); const select = (value: number) => { selectedRef.current = value; setSelected(value); };
  useInput((_input, key) => { if (key.upArrow) select(Math.max(0, selectedRef.current - 1)); else if (key.downArrow) select(Math.min(items.length - 1, selectedRef.current + 1)); else if (key.return) { const item = items[selectedRef.current]; if (item) props.onSelect(item.id); } });
  return <Box flexDirection="column" borderStyle="round" paddingX={1} {...borderColor(BRAND_PURPLE)}>{items.map((item, index) => <Text key={item.id} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} /{item.id} · {item.label}</Text>)}</Box>;
}
export function accent(enabled = process.env.NO_COLOR === undefined): Readonly<{ color?: string }> { return enabled ? { color: BRAND_PURPLE } : {}; }
export function textColor(color: string): Readonly<{ color?: string }> { return process.env.NO_COLOR === undefined ? { color } : {}; }
export function borderColor(color: string): Readonly<{ borderColor?: string }> { return process.env.NO_COLOR === undefined ? { borderColor: color } : {}; }
