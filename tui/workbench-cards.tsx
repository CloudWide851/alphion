import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProjectRecord } from "../src/index.js";
import { SLASH_COMMANDS } from "../ui/slash-commands.js";
import { sanitizeTerminalText } from "./run-projection.js";
import { accent, type WorkbenchSection } from "./shell.js";

const SETTINGS_SECTIONS: readonly Readonly<{ section: WorkbenchSection; label: string; description: string }>[] = Object.freeze([
  { section: "projects", label: "Projects", description: "创建、打开与切换项目" },
  { section: "sessions", label: "Sessions", description: "选择、Fork 与管理会话" },
  { section: "providers", label: "Provider", description: "模型、凭据与连接实测" },
  { section: "resources", label: "资源", description: "查看 Agent 资源解析" },
  { section: "context", label: "上下文", description: "查看自动压缩状态" },
  { section: "goals", label: "Goals", description: "长期目标与进度" },
  { section: "schedules", label: "Schedules", description: "定时复盘与提示" },
  { section: "doctor", label: "doctor", description: "运行只读诊断" },
]);

export function SettingsCard(props: Readonly<{ onSelect: (section: WorkbenchSection) => void }>): React.JSX.Element {
  const [selected, setSelected] = useState(0); const selectedRef = useRef(0);
  useInput((_input, key) => {
    if (key.upArrow) { selectedRef.current = Math.max(0, selectedRef.current - 1); setSelected(selectedRef.current); }
    else if (key.downArrow) { selectedRef.current = Math.min(SETTINGS_SECTIONS.length - 1, selectedRef.current + 1); setSelected(selectedRef.current); }
    else if (key.return) { const item = SETTINGS_SECTIONS[selectedRef.current]; if (item) props.onSelect(item.section); }
  });
  return <Box flexDirection="column">{SETTINGS_SECTIONS.map((item, index) => <Text key={item.section} {...(index === selected ? accent() : {})}>{index === selected ? "◆" : "◇"} {item.label} · {item.description}</Text>)}<Text dimColor>↑/↓ 选择 · Enter 打开 · Esc 返回对话</Text></Box>;
}

export function ProjectCard(props: Readonly<{ projectRoot: string; currentProjectId?: string; projects?: readonly ProjectRecord[]; backgroundRuns?: readonly Readonly<{ projectId: string; projectName: string; runId: string; title: string }>[]; onActivate?: (projectId: string) => void }>): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  useEffect(() => { const index = Math.max(0, props.projects?.findIndex((item) => item.id === props.currentProjectId) ?? 0); selectedRef.current = index; setSelected(index); }, [props.currentProjectId, props.projects]);
  useInput((_input, key) => {
    const projects = props.projects ?? [];
    if (key.upArrow) { selectedRef.current = Math.max(0, selectedRef.current - 1); setSelected(selectedRef.current); }
    else if (key.downArrow) { selectedRef.current = Math.min(Math.max(0, projects.length - 1), selectedRef.current + 1); setSelected(selectedRef.current); }
    else if (key.return) { const project = projects[selectedRef.current]; if (project) props.onActivate?.(project.id); }
  });
  return <Box flexDirection="column"><Text>当前项目</Text><Text dimColor>{sanitizeTerminalText(props.projectRoot)}</Text>
    {(props.projects ?? []).map((project, index) => <Text key={project.id}>{index === selected ? "◆" : "◇"} {sanitizeTerminalText(project.name)}{project.id === props.currentProjectId ? " · 当前" : ""}</Text>)}
    {(props.backgroundRuns ?? []).map((run) => <Text key={`${run.projectId}:${run.runId}`}>◌ 后台 · {sanitizeTerminalText(run.projectName)} · {sanitizeTerminalText(run.title)}</Text>)}
    <Text dimColor>↑/↓ 选择 · Enter 打开 · /new project 创建或复用目录</Text>
  </Box>;
}

export function HelpCard(): React.JSX.Element {
  return <Box flexDirection="column">
    <Text>{SLASH_COMMANDS.map((command) => `/${command.tokens.join(" ")}${command.argumentHint ? ` ${command.argumentHint}` : ""}`).join(" · ")}</Text>
    <Text>输入 / 筛选 · ↑/↓ 或 Tab 选择 · Enter 执行 · Esc 收起并保留草稿</Text>
  </Box>;
}
