import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ImageAttachmentRef, ProviderProfile } from "../src/index.js";
import { parseMarkdown, renderMarkdownText } from "../ui/markdown.js";
import { ChatEntry } from "./input.js";
import { sanitizeTerminalText } from "./run-projection.js";
import type { SlashCommandContext } from "../ui/slash-commands.js";
import { projectChatRows, selectChatViewport } from "../ui/chat-viewport.js";

export type WorkbenchSection = "home" | "settings" | "projects" | "profile" | "providers" | "sessions" | "resources" | "harness" | "context" | "goals" | "goal" | "schedules" | "doctor" | "help";
export type WorkbenchLayout = "wide" | "narrow" | "compact";
export interface ChatMessage { readonly id: string; readonly role: "user" | "assistant"; readonly content: string; readonly attachments?: readonly ImageAttachmentRef[]; }

export const BRAND_PURPLE = "#A377F6";
const SECTIONS: readonly Readonly<{ id: WorkbenchSection; label: string }>[] = Object.freeze([
  { id: "home", label: "对话" }, { id: "settings", label: "设置" }, { id: "projects", label: "项目" },
  { id: "profile", label: "项目画像" }, { id: "providers", label: "Provider" }, { id: "sessions", label: "共享会话" },
  { id: "resources", label: "Agent 资源" }, { id: "harness", label: "HarnessPlan" }, { id: "context", label: "上下文优化" },
  { id: "goals", label: "长期 Goal" }, { id: "goal", label: "Goal 操作" }, { id: "schedules", label: "定时任务" }, { id: "doctor", label: "只读诊断" }, { id: "help", label: "快捷命令" },
]);
const LOGO = Object.freeze([" █████╗ ██╗     ██████╗ ██╗  ██╗██╗ ██████╗ ███╗   ██╗", "██╔══██╗██║     ██╔══██╗██║  ██║██║██╔═══██╗████╗  ██║", "███████║██║     ██████╔╝███████║██║██║   ██║██╔██╗ ██║", "██╔══██║██║     ██╔═══╝ ██╔══██║██║██║   ██║██║╚██╗██║", "██║  ██║███████╗██║     ██║  ██║██║╚██████╔╝██║ ╚████║", "╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝"]);

export function selectWorkbenchLayout(columns: number, rows: number): WorkbenchLayout { if (rows < 18) return "compact"; return columns >= 100 ? "wide" : "narrow"; }
export function AppShell(props: Readonly<{ section: WorkbenchSection; layout: WorkbenchLayout; colorEnabled: boolean; projectRoot: string; error?: string; help?: boolean; children: React.ReactNode }>): React.JSX.Element {
  const current = SECTIONS.find((entry) => entry.id === props.section);
  return <Box flexDirection="column" paddingX={1}>
    {props.section === "home" ? null : <Box flexDirection="column" marginTop={props.layout === "compact" ? 0 : 1} marginBottom={props.layout === "compact" ? 0 : 1}><Text bold {...accent(props.colorEnabled)}>ALPHION · {current?.label ?? "对话"}</Text>{props.layout === "compact" ? null : <Text dimColor>{sanitizeTerminalText(props.projectRoot)}</Text>}</Box>}
    {props.error ? <Text {...textColor("red")}>✗ {sanitizeTerminalText(props.error)}</Text> : null}
    {props.help ? <Text dimColor>↑/↓ 选择 · Enter 确认 · Esc 返回对话 · ? 帮助 · q 退出 · Ctrl+C 取消/退出</Text> : null}
    {props.children}
    {props.section === "home" ? null : <Text dimColor>Esc 返回对话 · ↑/↓ 选择 · Enter 确认 · ? 帮助 · q 退出</Text>}
  </Box>;
}
export function ChatHome(props: Readonly<{ activeProfile?: ProviderProfile; messages?: readonly ChatMessage[]; activeBubble?: React.ReactNode; attachments?: readonly ImageAttachmentRef[]; compactionCount?: number; compact: boolean; heightRows?: number; viewportRows?: number; contentWidth?: number; draft?: string; slashContext?: SlashCommandContext; onDraftChange?: (value: string) => void; onPasteImage?: () => void; onRemoveLastAttachment?: () => void; onSubmit: (value: string) => boolean | void }>): React.JSX.Element {
  const messages = props.messages ?? [];
  const viewportRows = props.viewportRows ?? (props.compact ? 5 : 12);
  const rendered = useMemo(() => messages.map((message) => ({ id: message.id, role: message.role, displayText: `${message.attachments?.map((item, index) => `[图片 ${index + 1}：${item.fileName}]`).join("\n") ?? ""}${message.attachments?.length && message.content ? "\n" : ""}${renderMarkdownText(parseMarkdown(message.content), props.contentWidth ?? 88)}` })), [messages, props.contentWidth]);
  const rows = useMemo(() => projectChatRows(rendered, props.contentWidth ?? 88), [props.contentWidth, rendered]);
  const [offset, setOffset] = useState(0); const offsetRef = useRef(0); const previousRows = useRef(rows.length); const [unseen, setUnseen] = useState(0); const [paletteOpen, setPaletteOpen] = useState(false);
  const move = (next: number) => { const bounded = Math.min(Math.max(0, rows.length - viewportRows), Math.max(0, next)); offsetRef.current = bounded; setOffset(bounded); if (bounded === 0) setUnseen(0); };
  useEffect(() => { const added = Math.max(0, rows.length - previousRows.current); previousRows.current = rows.length; if (offsetRef.current > 0 && added > 0) setUnseen((value) => value + added); }, [rows.length]);
  useInput((_input, key) => { if (paletteOpen) return; if (key.upArrow) move(offsetRef.current + 1); else if (key.downArrow) move(offsetRef.current - 1); else if (key.pageUp) move(offsetRef.current + viewportRows); else if (key.pageDown) move(offsetRef.current - viewportRows); else if (key.end) move(0); });
  const selection = selectChatViewport(rows, viewportRows, offset);
  return <Box flexDirection="column" height={props.heightRows ?? (props.compact ? 12 : 22)} justifyContent="space-between" overflowY="hidden">
    {messages.length === 0 && !props.activeBubble ? <Box flexDirection="column" alignItems="center" marginTop={props.compact ? 0 : 2}>{props.compact ? null : LOGO.map((line) => <Text key={line} bold {...accent()}>{line}</Text>)}<Text bold {...accent()}>ALPHION</Text><Text dimColor>{props.activeProfile ? `${props.activeProfile.name} · ${props.activeProfile.model}` : "请先使用 /providers 配置 Provider"}</Text></Box> : <Box flexDirection="column" height={viewportRows} overflowY="hidden">{selection.segments.map((message) => <Box key={`${message.id}:${message.continued ? "continued" : "start"}`} width={props.compact ? "94%" : "78%"} alignSelf={message.role === "user" ? "flex-end" : "flex-start"} flexDirection="column" marginBottom={1}><Text bold {...(message.role === "assistant" ? accent() : {})}>{message.role === "assistant" ? "Alphion" : "你"}{message.continued ? " · 续" : ""}</Text><Text>{message.text}</Text></Box>)}{offset === 0 ? props.activeBubble : null}</Box>}
    {offset > 0 ? <Text dimColor>↑ 正在查看历史 · {unseen ? `${unseen} 行新内容 · ` : ""}End 返回最新</Text> : null}
    {props.compactionCount ? <Text dimColor>✓ 已优化上下文 · {props.compactionCount} 次</Text> : null}<ChatEntry {...(props.draft === undefined ? {} : { value: props.draft })} {...(props.attachments ? { attachments: props.attachments })} {...(props.slashContext ? { slashContext: props.slashContext })} {...(props.onDraftChange ? { onChange: props.onDraftChange })} {...(props.onPasteImage ? { onPasteImage: props.onPasteImage })} {...(props.onRemoveLastAttachment ? { onRemoveLastAttachment: props.onRemoveLastAttachment })} onPaletteOpenChange={setPaletteOpen} onSubmit={props.onSubmit} />
  </Box>;
}
export function accent(enabled = process.env.NO_COLOR === undefined): Readonly<{ color?: string }> { return enabled ? { color: BRAND_PURPLE } : {}; }
export function textColor(color: string): Readonly<{ color?: string }> { return process.env.NO_COLOR === undefined ? { color } : {}; }
export function borderColor(color: string): Readonly<{ borderColor?: string }> { return process.env.NO_COLOR === undefined ? { borderColor: color } : {}; }
