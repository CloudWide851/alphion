import React from "react";
import { Box, Text } from "ink";
import { SLASH_COMMANDS } from "../ui/slash-commands.js";
import { sanitizeTerminalText } from "./run-projection.js";

export function ProjectCard({ projectRoot }: Readonly<{ projectRoot: string }>): React.JSX.Element {
  return <Box flexDirection="column"><Text>当前项目</Text><Text dimColor>{sanitizeTerminalText(projectRoot)}</Text><Text>项目注册与切换可使用 /projects。</Text></Box>;
}

export function HelpCard(): React.JSX.Element {
  return <Box flexDirection="column">
    <Text>{SLASH_COMMANDS.map((command) => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`).join(" · ")}</Text>
    <Text>输入 / 筛选 · ↑/↓ 或 Tab 选择 · Enter 执行 · Esc 收起并保留草稿</Text>
  </Box>;
}
