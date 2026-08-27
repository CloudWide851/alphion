import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AgentApplication, ProviderPreset, ProviderProfile, ProviderProfileInput } from "../src/index.js";
import { TextEntry } from "./input.js";
import { ProviderModelPicker } from "./provider-model-picker.js";
import { accent } from "./shell.js";

export interface ProviderDraft {
  readonly existing?: ProviderProfile;
  readonly presetId: string;
  readonly name: string;
  readonly kind: ProviderProfile["kind"];
  readonly protocol: ProviderProfile["protocol"];
  readonly model: string;
  readonly baseUrl?: string;
  readonly catalogModels?: readonly string[];
  readonly unlistedModel?: boolean;
}

export function ProviderList(props: Readonly<{
  profiles: readonly ProviderProfile[]; selected: number; onSelected: (index: number) => void;
  onNew: () => void; onEdit: () => void; onActivate: () => void; onCredential: () => void;
  onRemoveCredential: () => void; onTest: () => void; onTestAll: () => void; onRun: () => void; onExit: () => void;
}>): React.JSX.Element {
  useInput((input, key) => {
    if (key.upArrow) props.onSelected(Math.max(0, props.selected - 1));
    else if (key.downArrow) props.onSelected(Math.min(props.profiles.length - 1, props.selected + 1));
    else if (input === "n") props.onNew();
    else if (input === "e" && props.profiles.length > 0) props.onEdit();
    else if (input === "a" && props.profiles.length > 0) props.onActivate();
    else if (input === "k" && props.profiles.length > 0) props.onCredential();
    else if (input === "x" && props.profiles.length > 0) props.onRemoveCredential();
    else if (input === "t" && props.profiles.length > 0) props.onTest();
    else if (input === "y" && props.profiles.length > 0) props.onTestAll();
    else if ((input === "r" || key.return) && props.profiles.length > 0) props.onRun();
    else if (input === "q") props.onExit();
  });
  return <Box flexDirection="column">
    {props.profiles.length === 0 ? <Text dimColor>暂无 Provider。按 n 新建 DeepSeek 或 OpenAI 兼容配置。</Text> : null}
    {props.profiles.map((profile, index) => <Text key={profile.id} {...(index === props.selected ? accent(process.env.NO_COLOR === undefined) : {})}>
      {index === props.selected ? "◆" : "◇"} {profile.active ? "✓ 活动" : "  待用"} · {profile.name} · {profile.kind} · {profile.model} · {authLabel(profile)}
    </Text>)}
    <Text dimColor>↑↓ 选择 · n 新建 · e 编辑 · a 激活 · k 导入 Key · x 删除 Key · t 实测当前 · y 实测全部 · r 运行</Text>
  </Box>;
}

export function ProviderForm(props: Readonly<{ draft: ProviderDraft; presets: readonly ProviderPreset[]; onSave: (draft: ProviderDraft) => void; onCancel: () => void }>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0 && !value.existing && props.presets.length > 1) return <PresetPicker presets={props.presets} selectedId={value.presetId} onSelect={(preset) => { setValue(presetDraft(preset)); setStep(1); }} onCancel={props.onCancel} />;
  if (step <= 1) return <TextEntry label="配置名称" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(2); }} onCancel={props.onCancel} />;
  if (step === 2 && value.kind !== "custom-openai-compatible" && value.catalogModels && !value.unlistedModel) return <ProviderModelPicker models={value.catalogModels} selectedModel={value.model} onSelect={(model) => props.onSave({ ...value, model })} onAdvanced={() => setValue({ ...value, unlistedModel: true })} onCancel={() => setStep(1)} />;
  if (step === 2) return <TextEntry label={value.unlistedModel ? "高级自定义模型（不受 catalog 保证）" : "模型"} initialValue={value.model} onSubmit={(model) => { const next = { ...value, model }; if (next.kind === "custom-openai-compatible") { setValue(next); setStep(3); } else props.onSave(next); }} onCancel={() => setStep(1)} />;
  return <TextEntry label="Base URL（仅自定义 Provider）" {...(value.baseUrl === undefined ? {} : { initialValue: value.baseUrl })} onSubmit={(baseUrl) => props.onSave({ ...value, baseUrl })} onCancel={() => setStep(2)} />;
}

function PresetPicker(props: Readonly<{ presets: readonly ProviderPreset[]; selectedId: string; onSelect: (preset: ProviderPreset) => void; onCancel: () => void }>): React.JSX.Element {
  const initial = Math.max(0, props.presets.findIndex((preset) => preset.id === props.selectedId));
  const [selected, setSelected] = useState(initial);
  useInput((_input, key) => {
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(props.presets.length - 1, value + 1));
    else if (key.return) { const preset = props.presets[selected]; if (preset) props.onSelect(preset); }
    else if (key.escape) props.onCancel();
  });
  return <Box flexDirection="column"><Text>选择 Provider 预设</Text>{props.presets.map((preset, index) => <Text key={preset.id} {...(index === selected ? accent(process.env.NO_COLOR === undefined) : {})}>{index === selected ? "◆" : "◇"} {preset.label}</Text>)}</Box>;
}

export function presetDraft(preset: ProviderPreset | undefined): ProviderDraft {
  const fallback: ProviderPreset = { id: "deepseek", label: "DeepSeek（中国大陆）", kind: "deepseek", region: "mainland", requiresBaseUrl: false, models: ["deepseek-chat"], protocol: "chat-completions" };
  const value = preset ?? fallback;
  return { presetId: value.id, name: value.label, kind: value.kind, protocol: value.protocol, model: value.models[0] ?? "", catalogModels: value.models, ...(value.requiresBaseUrl ? { baseUrl: "" } : {}) };
}

export function profileDraft(profile: ProviderProfile, presets: readonly ProviderPreset[]): ProviderDraft {
  const catalogModels = profile.kind === "custom-openai-compatible" ? undefined : presets.find((preset) => preset.id === profile.presetId)?.models;
  return { existing: profile, presetId: profile.kind === "custom-openai-compatible" ? profile.kind : profile.presetId, name: profile.name, kind: profile.kind, protocol: profile.protocol, model: profile.model, ...(catalogModels ? { catalogModels } : {}), ...(profile.capabilities.unlistedModel ? { unlistedModel: true } : {}), ...(profile.kind === "custom-openai-compatible" ? { baseUrl: profile.baseUrl } : {}) };
}

export function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const common = { schemaVersion: 2 as const, id: draft.existing?.id ?? toProfileId(draft.name), name: draft.name.trim(), model: draft.model.trim(), protocol: draft.kind === "deepseek" ? "chat-completions" as const : draft.protocol, auth: draft.existing?.auth ?? { mode: "none" as const }, capabilities: { streaming: draft.existing?.capabilities.streaming ?? true, tools: draft.existing?.capabilities.tools ?? true, promptCaching: draft.existing?.capabilities.promptCaching ?? false, reasoning: draft.kind === "deepseek" && draft.model.trim() === "deepseek-reasoner", ...(draft.unlistedModel ? { unlistedModel: true } : {}) }, active: draft.existing?.active ?? firstProfile };
  return draft.kind === "custom-openai-compatible" ? { ...common, kind: draft.kind, baseUrl: draft.baseUrl?.trim() ?? "" } : { ...common, kind: draft.kind, presetId: draft.presetId };
}

export function providerTestLabel(result: Awaited<ReturnType<AgentApplication["providerTests"]["test"]>>): string {
  return result.status === "success" ? `实测成功 · ${result.model} · ${result.latencyMs}ms · ${result.response ?? "无文本"}` : `实测失败 · ${result.errorReason ?? result.errorCode ?? "未知错误"}`;
}

function toProfileId(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "provider"; }
function authLabel(profile: ProviderProfile): string { if (profile.auth.mode === "encrypted-project") return "✓ Project 独立加密"; if (profile.auth.mode === "bearer-env") return `✓ 环境引用 ${profile.auth.environmentVariable}`; return "! 未配置凭据"; }
