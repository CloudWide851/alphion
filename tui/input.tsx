import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminalText } from "./run-projection.js";
import { formatSlashCommand, matchSlashCommands, parseSlashCommand, type SlashCommandContext } from "../ui/slash-commands.js";

const BRAND_PURPLE = "#A377F6";

export function TextEntry(props: Readonly<{ label: string; initialValue?: string; masked?: boolean; clearOnSubmit?: boolean; resetKey?: string | number; onSubmit: (value: string) => void; onCancel?: () => void }>): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? "");
  const valueRef = useRef(props.initialValue ?? "");
  const replaceValue = (next: string) => { valueRef.current = next; setValue(next); };
  useEffect(() => {
    replaceValue(props.initialValue ?? "");
    return () => { valueRef.current = ""; };
  }, [props.initialValue, props.label, props.masked, props.resetKey]);
  useInput((input, key) => {
    if (key.return) {
      if (valueRef.current.trim().length > 0) {
        const submitted = valueRef.current;
        if (props.masked || props.clearOnSubmit) replaceValue("");
        props.onSubmit(submitted);
      }
      return;
    }
    if (key.escape) { replaceValue(""); props.onCancel?.(); return; }
    if (key.backspace || key.delete) { replaceValue(valueRef.current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) replaceValue(valueRef.current + input);
  });
  return <Box flexDirection="column" marginTop={1}><Text>{props.label}</Text><Text {...accent()}>› {props.masked ? "•".repeat(value.length) : sanitizeTerminalText(value)}</Text><Text dimColor>Enter 确认 · Esc 返回</Text></Box>;
}

export function ChatEntry(props: Readonly<{ disabled?: boolean; slashContext?: SlashCommandContext; onPaletteOpenChange?: (open: boolean) => void; onSubmit: (value: string) => boolean | void }>): React.JSX.Element {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const valueRef = useRef("");
  const selectedRef = useRef(0);
  const replaceValue = (next: string) => { valueRef.current = next; setValue(next); setPaletteDismissed(false); setSelected(0); selectedRef.current = 0; };
  const matches = value.startsWith("/") && !paletteDismissed ? matchSlashCommands(value, props.slashContext) : [];
  const move = (next: number) => { const bounded = matches.length ? (next + matches.length) % matches.length : 0; selectedRef.current = bounded; setSelected(bounded); };
  useEffect(() => () => { valueRef.current = ""; }, []);
  useEffect(() => { props.onPaletteOpenChange?.(matches.length > 0); return () => props.onPaletteOpenChange?.(false); }, [matches.length, props.onPaletteOpenChange]);
  useInput((input, key) => {
    if (matches.length && (key.upArrow || key.downArrow || key.tab)) { move(selectedRef.current + (key.upArrow ? -1 : 1)); return; }
    if (matches.length && key.escape) { setPaletteDismissed(true); return; }
    if ((key.meta && key.return) || (key.ctrl && input === "j")) { replaceValue(`${valueRef.current}\n`); return; }
    if (key.return) {
      if (!valueRef.current.trim()) return;
      if (props.disabled && !valueRef.current.trimStart().startsWith("/")) return;
      const match = matches[selectedRef.current];
      if (match) {
        if (!match.availability.available) return;
        const parsed = parseSlashCommand(valueRef.current, props.slashContext);
        const argument = parsed.kind === "command" && parsed.descriptor.id === match.descriptor.id ? parsed.argument : "";
        const submitted = formatSlashCommand(match.descriptor, argument);
        if (props.onSubmit(submitted) !== false) replaceValue(""); return;
      }
      const submitted = valueRef.current; if (props.onSubmit(submitted) !== false) replaceValue(""); return;
    }
    if (key.backspace || key.delete) { replaceValue(valueRef.current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) replaceValue(valueRef.current + input);
  });
  return <Box flexDirection="column" marginTop={1}>
    {matches.length ? <Box flexDirection="column" borderStyle="round" paddingX={1} {...border()}>{matches.slice(0, 8).map((match, index) => <Text key={match.descriptor.id} dimColor={!match.availability.available} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} {formatSlashCommand(match.descriptor)}{match.descriptor.argumentHint ? ` ${match.descriptor.argumentHint}` : ""} · {match.availability.reason ?? match.descriptor.description}</Text>)}</Box> : null}
    <Box flexDirection="column" borderStyle="round" paddingX={1} {...border()}>
    <Text {...accent()}>› {sanitizeTerminalText(value) || "请输入内容…"}</Text>
    <Text dimColor>{matches.length ? "↑/↓ 或 Tab 选择 · Enter 执行 · Esc 收起" : "Enter 发送 · Alt+Enter / Ctrl+J 换行"}</Text>
    </Box>
  </Box>;
}

function accent(): Readonly<{ color?: string }> { return process.env.NO_COLOR === undefined ? { color: BRAND_PURPLE } : {}; }
function border(): Readonly<{ borderColor?: string }> { return process.env.NO_COLOR === undefined ? { borderColor: BRAND_PURPLE } : {}; }
