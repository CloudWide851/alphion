import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminalText } from "./run-projection.js";

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

export function ChatEntry(props: Readonly<{ disabled?: boolean; onSubmit: (value: string) => void }>): React.JSX.Element {
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const replaceValue = (next: string) => { valueRef.current = next; setValue(next); };
  useEffect(() => () => { valueRef.current = ""; }, []);
  useInput((input, key) => {
    if (props.disabled) return;
    if ((key.meta && key.return) || (key.ctrl && input === "j")) { replaceValue(`${valueRef.current}\n`); return; }
    if (key.return) { if (valueRef.current.trim()) { const submitted = valueRef.current; replaceValue(""); props.onSubmit(submitted); } return; }
    if (key.backspace || key.delete) { replaceValue(valueRef.current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) replaceValue(valueRef.current + input);
  });
  return <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1} {...border()}>
    <Text {...accent()}>› {props.disabled ? "先使用 /providers 配置并激活 Provider" : sanitizeTerminalText(value) || "输入消息，或使用 /settings"}</Text>
    <Text dimColor>Enter 发送 · Alt+Enter / Ctrl+J 换行</Text>
  </Box>;
}

function accent(): Readonly<{ color?: string }> { return process.env.NO_COLOR === undefined ? { color: BRAND_PURPLE } : {}; }
function border(): Readonly<{ borderColor?: string }> { return process.env.NO_COLOR === undefined ? { borderColor: BRAND_PURPLE } : {}; }
