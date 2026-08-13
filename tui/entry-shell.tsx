import React from "react";
import { Box, Text } from "ink";
import { sanitizeTerminalText } from "./run-projection.js";
import { accent, textColor } from "./shell.js";

export function LoadingView({ colorEnabled }: Readonly<{ colorEnabled: boolean }>): React.JSX.Element {
  return <Box flexDirection="column" paddingX={1}>
    <Text bold {...accent(colorEnabled)}>ALPHION</Text>
    <Text>◌ 正在准备对话…</Text>
  </Box>;
}

export function EntryShell(props: Readonly<{
  title: string;
  colorEnabled: boolean;
  error?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return <Box flexDirection="column" paddingX={1}>
    <Text bold {...accent(props.colorEnabled)}>ALPHION · {props.title}</Text>
    {props.error ? <Text {...textColor("red")}>✗ {sanitizeTerminalText(props.error)}</Text> : null}
    {props.children}
  </Box>;
}
