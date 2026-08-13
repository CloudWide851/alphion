import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { accent } from "./shell.js";

export function ProviderModelPicker(props: Readonly<{
  models: readonly string[];
  selectedModel: string;
  onSelect: (model: string) => void;
  onAdvanced: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const initial = Math.max(0, props.models.indexOf(props.selectedModel));
  const [selected, setSelected] = useState(initial);
  useInput((input, key) => {
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(props.models.length - 1, value + 1));
    else if (key.return) { const model = props.models[selected]; if (model) props.onSelect(model); }
    else if (input === "a") props.onAdvanced();
    else if (key.escape) props.onCancel();
  });
  return <Box flexDirection="column">
    <Text>选择 catalog 模型</Text>
    {props.models.map((model, index) => <Text key={model} {...(index === selected ? accent(process.env.NO_COLOR === undefined) : {})}>{index === selected ? "◆" : "◇"} {model}</Text>)}
    <Text dimColor>↑↓ 选择 · Enter 确认 · a 高级自定义（有兼容风险）</Text>
  </Box>;
}
