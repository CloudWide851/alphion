import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderPreset, ProviderProfile, ProviderProfileInput, ProviderTestResult } from "../src/index.js";
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
  readonly catalogContextWindows?: Readonly<Record<string, number>>;
  readonly catalogVisionModels?: readonly string[];
  readonly unlistedModel?: boolean;
  readonly contextWindowTokens?: number;
  readonly vision?: boolean;
}

export type ProviderTestFeedback =
  | Readonly<{ tone: "success"; message: string }>
  | Readonly<{ tone: "warning"; message: string }>
  | Readonly<{ tone: "error"; message: string }>;

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
      {index === props.selected ? "◆" : "◇"} {profile.active ? "✓ 活动" : "  待用"} · {profile.name} · {profile.kind} · {profile.model} · {profile.contextWindowTokens ? `${profile.contextWindowTokens} tokens` : "catalog 上下文"} · {profile.capabilities.vision ? "图片" : "纯文本"} · {authLabel(profile)}
    </Text>)}
    <Text dimColor>↑↓ 选择 · n 新建 · e 编辑 · a 激活 · k 导入 Key · x 删除 Key · t 实测当前 · y 实测全部 · r 运行</Text>
  </Box>;
}

export function ProviderForm(props: Readonly<{ draft: ProviderDraft; presets: readonly ProviderPreset[]; onSave: (draft: ProviderDraft) => void; onCancel: () => void }>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0 && !value.existing && props.presets.length > 1) return <PresetPicker presets={props.presets} selectedId={value.presetId} onSelect={(preset) => { setValue(presetDraft(preset)); setStep(1); }} onCancel={props.onCancel} />;
  if (step <= 1) return <TextEntry label="配置名称" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(2); }} onCancel={props.onCancel} />;
  const acceptModel = (model: string) => { const next = withModelDefaults({ ...value, model }); setValue(next); setStep(next.kind === "custom-openai-compatible" ? 3 : 4); };
  if (step === 2 && value.kind !== "custom-openai-compatible" && value.catalogModels && !value.unlistedModel) return <ProviderModelPicker models={value.catalogModels} selectedModel={value.model} onSelect={acceptModel} onAdvanced={() => setValue({ ...value, unlistedModel: true })} onCancel={() => setStep(1)} />;
  if (step === 2) return <TextEntry label={value.unlistedModel ? "高级自定义模型（不受 catalog 保证）" : "模型"} initialValue={value.model} onSubmit={acceptModel} onCancel={() => setStep(1)} />;
  if (step === 3) return <TextEntry label="Base URL（仅自定义 Provider）" {...(value.baseUrl === undefined ? {} : { initialValue: value.baseUrl })} onSubmit={(baseUrl) => { setValue({ ...value, baseUrl }); setStep(4); }} onCancel={() => setStep(2)} />;
  if (step === 4) return <TextEntry label="上下文窗口 tokens（4096–4194304）" initialValue={String(value.contextWindowTokens ?? 32_768)} onSubmit={(raw) => { const contextWindowTokens = Number(raw); if (Number.isSafeInteger(contextWindowTokens) && contextWindowTokens >= 4_096 && contextWindowTokens <= 4_194_304) { setValue({ ...value, contextWindowTokens }); setStep(5); } }} onCancel={() => setStep(value.kind === "custom-openai-compatible" ? 3 : 2)} />;
  return <TextEntry label="支持图片（yes/no）" initialValue={value.vision ? "yes" : "no"} onSubmit={(raw) => { const normalized = raw.trim().toLowerCase(); if (["yes", "y", "no", "n"].includes(normalized)) props.onSave({ ...value, vision: normalized === "yes" || normalized === "y" }); }} onCancel={() => setStep(4)} />;
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
  return withModelDefaults({ presetId: value.id, name: value.label, kind: value.kind, protocol: value.protocol, model: value.models[0] ?? "", catalogModels: value.models, ...(value.contextWindows ? { catalogContextWindows: value.contextWindows } : {}), ...(value.visionModels ? { catalogVisionModels: value.visionModels } : {}), ...(value.requiresBaseUrl ? { baseUrl: "" } : {}) });
}

export function profileDraft(profile: ProviderProfile, presets: readonly ProviderPreset[]): ProviderDraft {
  const catalogModels = profile.kind === "custom-openai-compatible" ? undefined : presets.find((preset) => preset.id === profile.presetId)?.models;
  const preset = profile.kind === "custom-openai-compatible" ? undefined : presets.find((item) => item.id === profile.presetId);
  return { existing: profile, presetId: profile.kind === "custom-openai-compatible" ? profile.kind : profile.presetId, name: profile.name, kind: profile.kind, protocol: profile.protocol, model: profile.model, contextWindowTokens: profile.contextWindowTokens ?? preset?.contextWindows?.[profile.model] ?? 32_768, vision: profile.capabilities.vision, ...(catalogModels ? { catalogModels } : {}), ...(preset?.contextWindows ? { catalogContextWindows: preset.contextWindows } : {}), ...(preset?.visionModels ? { catalogVisionModels: preset.visionModels } : {}), ...(profile.capabilities.unlistedModel ? { unlistedModel: true } : {}), ...(profile.kind === "custom-openai-compatible" ? { baseUrl: profile.baseUrl } : {}) };
}

export function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const common = { schemaVersion: 3 as const, id: draft.existing?.id ?? toProfileId(draft.name), name: draft.name.trim(), model: draft.model.trim(), protocol: draft.kind === "deepseek" ? "chat-completions" as const : draft.protocol, auth: draft.existing?.auth ?? { mode: "none" as const }, capabilities: { streaming: draft.existing?.capabilities.streaming ?? true, tools: draft.existing?.capabilities.tools ?? true, promptCaching: draft.existing?.capabilities.promptCaching ?? false, reasoning: draft.kind === "deepseek" && draft.model.trim() === "deepseek-reasoner", vision: draft.vision ?? false, ...(draft.unlistedModel ? { unlistedModel: true } : {}) }, ...(draft.contextWindowTokens ? { contextWindowTokens: draft.contextWindowTokens } : {}), active: draft.existing?.active ?? firstProfile };
  return draft.kind === "custom-openai-compatible" ? { ...common, kind: draft.kind, baseUrl: draft.baseUrl?.trim() ?? "" } : { ...common, kind: draft.kind, presetId: draft.presetId };
}

export function providerTestFeedback(result: ProviderTestResult): ProviderTestFeedback {
  return result.status === "success"
    ? Object.freeze({ tone: "success", message: `实测成功 · ${result.model} · ${result.latencyMs}ms · ${result.response || "无文本"}` })
    : Object.freeze({ tone: "error", message: `实测失败 · ${result.errorReason ?? result.errorCode ?? "未知错误"}` });
}

export function providerTestBatchFeedback(results: readonly ProviderTestResult[]): ProviderTestFeedback {
  const succeeded = results.filter((item) => item.status === "success").length;
  const message = results.length === 0 ? "没有可实测的 Provider。" : `实测完成：${succeeded}/${results.length} 成功`;
  if (results.length === 0) return Object.freeze({ tone: "warning", message });
  if (succeeded === results.length) return Object.freeze({ tone: "success", message });
  if (succeeded === 0) return Object.freeze({ tone: "error", message });
  return Object.freeze({ tone: "warning", message });
}

function toProfileId(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "provider"; }
function withModelDefaults(draft: ProviderDraft): ProviderDraft { return { ...draft, contextWindowTokens: draft.contextWindowTokens ?? draft.catalogContextWindows?.[draft.model] ?? 32_768, vision: draft.vision ?? draft.catalogVisionModels?.includes(draft.model) ?? false }; }
function authLabel(profile: ProviderProfile): string { if (profile.auth.mode === "encrypted-project") return "✓ Project 独立加密"; if (profile.auth.mode === "bearer-env") return `✓ 环境引用 ${profile.auth.environmentVariable}`; return "! 未配置凭据"; }
