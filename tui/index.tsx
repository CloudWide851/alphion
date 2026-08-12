import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { openLocalAlphionApplication } from "../adapters/local/local-application.js";
import type {
  CacheStats,
  AgentApplication,
  AgentRunHandle,
  DiagnosticReport,
  ProjectProfile,
  ProviderPreset,
  ProviderProfile,
  ProviderProfileInput,
  VaultStatus,
} from "../src/index.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "./run-projection.js";

export interface RunTuiOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
}

type Screen = "loading" | "vault-setup" | "vault-unlock" | "workbench" | "provider-form" | "credential" | "prompt" | "run";
export type WorkbenchSection = "home" | "profile" | "providers" | "tasks" | "doctor";
export type WorkbenchLayout = "wide" | "narrow" | "compact";

interface ProviderDraft {
  readonly existing?: ProviderProfile;
  readonly presetId: string;
  readonly name: string;
  readonly kind: ProviderProfile["kind"];
  readonly protocol: ProviderProfile["protocol"];
  readonly model: string;
  readonly baseUrl: string;
}

interface WorkbenchSnapshot {
  readonly profile?: ProjectProfile;
  readonly diagnostics?: DiagnosticReport;
  readonly vault?: VaultStatus;
  readonly cache?: CacheStats;
}

const SECTIONS: readonly Readonly<{ id: WorkbenchSection; label: string; short: string }>[] = Object.freeze([
  { id: "home", label: "首页概览", short: "首页" },
  { id: "profile", label: "项目画像", short: "画像" },
  { id: "providers", label: "Provider / Vault", short: "Provider" },
  { id: "tasks", label: "任务运行", short: "运行" },
  { id: "doctor", label: "只读诊断", short: "诊断" },
]);
const BRAND_PURPLE = "#A377F6";

export async function runTui(options: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1;
  const application = await openLocalAlphionApplication(options);
  try {
    const instance = render(<AlphionTui application={application} projectRoot={options.projectRoot} />, { exitOnCtrlC: false });
    await instance.waitUntilExit();
    return 0;
  } finally {
    application.close();
  }
}

function AlphionTui({ application, projectRoot }: Readonly<{ application: AgentApplication; projectRoot: string }>): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const layout = selectWorkbenchLayout(stdout.columns ?? 80, stdout.rows ?? 24);
  const colorEnabled = process.env.NO_COLOR === undefined;
  const [screen, setScreen] = useState<Screen>("loading");
  const [section, setSection] = useState<WorkbenchSection>("home");
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [presets] = useState(() => application.providerPresets());
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({});
  const [draft, setDraft] = useState<ProviderDraft>(() => presetDraft(presets[0]));
  const [runPrompt, setRunPrompt] = useState("");
  const [runProviderId, setRunProviderId] = useState<string | undefined>();
  const approval = useMemo(() => new TuiApprovalPort(), []);

  const refreshProfiles = useCallback(async () => {
    const next = await application.configuration.listProfiles();
    setProfiles(next);
    setSelected((value) => Math.min(value, Math.max(0, next.length - 1)));
    return next;
  }, [application]);
  const refreshSnapshot = useCallback(async (refresh = false) => {
    const [profile, diagnostics, vault, cache] = await Promise.all([
      application.inspectProject({ ...(refresh ? { refresh: true } : {}) }),
      application.diagnose(),
      application.configuration.vaultStatus(),
      application.cacheStats(),
    ]);
    setSnapshot({ profile, diagnostics, vault, cache });
  }, [application]);

  useEffect(() => {
    void (async () => {
      try {
        const [vault] = await Promise.all([application.configuration.vaultStatus(), refreshProfiles()]);
        setSnapshot((value) => ({ ...value, vault }));
        if (!vault.initialized) setScreen("vault-setup");
        else if (vault.locked) setScreen("vault-unlock");
        else {
          setScreen("workbench");
          await refreshSnapshot();
        }
      } catch (cause) {
        setError(safeError(cause));
        setScreen("workbench");
      }
    })();
  }, [application, refreshProfiles, refreshSnapshot]);

  useInput((input, key) => {
    if (key.ctrl && input === "c" && screen !== "run") { exit(); return; }
    if (screen !== "workbench") return;
    if (input === "?") { setHelp((value) => !value); return; }
    if (input === "q") { exit(); return; }
    if (key.escape) { setHelp(false); setSection("home"); return; }
    const numeric = Number.parseInt(input, 10);
    if (numeric >= 1 && numeric <= SECTIONS.length) setSection(SECTIONS[numeric - 1]?.id ?? "home");
    if (key.tab) {
      const index = SECTIONS.findIndex((entry) => entry.id === section);
      setSection(SECTIONS[(index + 1) % SECTIONS.length]?.id ?? "home");
    }
  });

  const current = profiles[selected];
  const activeProfile = profiles.find((profile) => profile.active);
  const beginRun = (prompt: string) => {
    setRunPrompt(prompt);
    setRunProviderId(current?.id);
    setScreen("run");
  };
  const completeVault = async (password: string) => {
    await application.configuration.initializeVault(password);
    setError("");
    setScreen("workbench");
    await refreshSnapshot();
  };

  if (screen === "loading") return <LoadingView colorEnabled={colorEnabled} />;
  if (screen === "vault-setup") {
    return <EntryShell title="初始化安全凭据库" colorEnabled={colorEnabled} error={error}>
      <VaultSetup onComplete={completeVault} onError={(cause) => setError(safeError(cause))} />
    </EntryShell>;
  }
  if (screen === "vault-unlock") {
    return <EntryShell title="解锁本地凭据库" colorEnabled={colorEnabled} error={error}>
      <TextEntry
        label="主密码"
        masked
        onSubmit={(password) => void application.configuration.unlockVault(password)
          .then(async () => { setError(""); setScreen("workbench"); await refreshSnapshot(); })
          .catch((cause: unknown) => setError(safeError(cause)))}
        onCancel={() => exit()}
      />
    </EntryShell>;
  }
  if (screen === "provider-form") {
    return <EntryShell title="Provider 配置" colorEnabled={colorEnabled} error={error}>
      <ProviderForm
        draft={draft}
        presets={presets}
        onSave={(value) => void application.configuration.upsertProfile(toProfileInput(value, profiles.length === 0))
          .then(async () => { await refreshProfiles(); await refreshSnapshot(); setError(""); setScreen("workbench"); setSection("providers"); })
          .catch((cause: unknown) => setError(safeError(cause)))}
        onCancel={() => setScreen("workbench")}
      />
    </EntryShell>;
  }
  if (screen === "credential" && current) {
    return <EntryShell title="导入加密凭据" colorEnabled={colorEnabled} error={error}>
      <TextEntry
        label={`${current.name} 的 API Key`}
        masked
        onSubmit={(value) => void application.configuration.importCredential(current.id, value)
          .then(async () => { await refreshProfiles(); await refreshSnapshot(); setError(""); setScreen("workbench"); })
          .catch((cause: unknown) => setError(safeError(cause)))}
        onCancel={() => setScreen("workbench")}
      />
    </EntryShell>;
  }
  if (screen === "prompt") {
    return <EntryShell title="创建一次 Agent 任务" colorEnabled={colorEnabled} error={error}>
      <TextEntry label="任务目标" onSubmit={beginRun} onCancel={() => setScreen("workbench")} />
    </EntryShell>;
  }
  if (screen === "run") {
    return <EntryShell title="任务运行" colorEnabled={colorEnabled} error={error}>
      <RunView
        application={application}
        approval={approval}
        projectRoot={projectRoot}
        prompt={runPrompt}
        {...(runProviderId ? { providerId: runProviderId } : {})}
        onDone={() => { setRunPrompt(""); setScreen("workbench"); setSection("tasks"); void refreshSnapshot(); }}
        onExit={() => exit()}
      />
    </EntryShell>;
  }

  return <AppShell section={section} layout={layout} colorEnabled={colorEnabled} projectRoot={projectRoot} error={error} help={help}>
    {section === "home" ? <HomeView snapshot={snapshot} profiles={profiles} compact={layout === "compact"} /> : null}
    {section === "profile" ? <ProjectProfileView {...(snapshot.profile ? { profile: snapshot.profile } : {})} onRefresh={() => void refreshSnapshot(true).catch((cause: unknown) => setError(safeError(cause)))} /> : null}
    {section === "providers" ? <ProviderList
      profiles={profiles}
      selected={selected}
      onSelected={setSelected}
      onNew={() => { setDraft(presetDraft(presets[0])); setScreen("provider-form"); }}
      onEdit={() => { if (current) { setDraft(profileDraft(current)); setScreen("provider-form"); } }}
      onActivate={() => current && void application.configuration.activateProfile(current.id).then(async () => { await refreshProfiles(); await refreshSnapshot(); }).catch((cause: unknown) => setError(safeError(cause)))}
      onCredential={() => current && setScreen("credential")}
      onRemoveCredential={() => current && void application.configuration.removeCredential(current.id).then(async () => { await refreshProfiles(); await refreshSnapshot(); }).catch((cause: unknown) => setError(safeError(cause)))}
      onRun={() => current && setScreen("prompt")}
      onLock={() => { application.configuration.lockVault(); setScreen("vault-unlock"); }}
      onExit={() => exit()}
    /> : null}
    {section === "tasks" ? <TaskLauncher {...(activeProfile ? { activeProfile } : {})} onStart={() => setScreen("prompt")} /> : null}
    {section === "doctor" ? <DoctorView {...(snapshot.diagnostics ? { report: snapshot.diagnostics } : {})} onRefresh={() => void refreshSnapshot().catch((cause: unknown) => setError(safeError(cause)))} /> : null}
  </AppShell>;
}

export function selectWorkbenchLayout(columns: number, rows: number): WorkbenchLayout {
  if (rows < 18) return "compact";
  return columns >= 100 ? "wide" : "narrow";
}

export function AppShell(props: Readonly<{
  section: WorkbenchSection;
  layout: WorkbenchLayout;
  colorEnabled: boolean;
  projectRoot: string;
  error?: string;
  help?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  const navigation = props.layout === "wide"
    ? <Box width={24} flexDirection="column" borderStyle="round" {...(props.colorEnabled ? { borderColor: BRAND_PURPLE } : {})} paddingX={1}>
        <Text bold {...accent(props.colorEnabled)}>ALPHION</Text>
        <Text dimColor>工程工作台 · 0.3.1</Text>
        <Box flexDirection="column" marginTop={1}>
          {SECTIONS.map((entry, index) => <Text key={entry.id} {...(entry.id === props.section ? accent(props.colorEnabled) : {})}>{entry.id === props.section ? "◆" : "◇"} {index + 1}  {entry.label}</Text>)}
        </Box>
      </Box>
    : <Box flexDirection="column">
        <Text bold {...accent(props.colorEnabled)}>ALPHION <Text dimColor>工程工作台 · 0.3.1</Text></Text>
        <Box gap={2}>{SECTIONS.map((entry, index) => <Text key={entry.id} {...(entry.id === props.section ? accent(props.colorEnabled) : {})}>{entry.id === props.section ? "◆" : "◇"}{index + 1} {entry.short}</Text>)}</Box>
      </Box>;
  return <Box flexDirection="column" paddingX={1}>
    {props.layout === "wide" ? <Box gap={1}>{navigation}<Box flexDirection="column" flexGrow={1} paddingX={1}>{contentHeader(props)}{props.children}</Box></Box> : <>{navigation}{contentHeader(props)}{props.children}</>}
    {props.error ? <Box borderStyle="round" {...borderColor("red")} paddingX={1}><Text {...textColor("red")}>✗ {sanitizeTerminalText(props.error)}</Text></Box> : null}
    {props.help ? <Box borderStyle="round" paddingX={1}><Text>数字键 / Tab 切换区域 · Enter 确认 · Esc 返回首页 · ? 帮助 · q 退出 · Ctrl+C 取消/退出</Text></Box> : null}
    <Text dimColor>数字键/Tab 导航  ·  ? 帮助  ·  q 退出</Text>
  </Box>;
}

function contentHeader(props: Readonly<{ section: WorkbenchSection; layout: WorkbenchLayout; projectRoot: string }>): React.JSX.Element {
  const current = SECTIONS.find((entry) => entry.id === props.section);
  return <Box flexDirection="column" marginTop={props.layout === "compact" ? 0 : 1} marginBottom={props.layout === "compact" ? 0 : 1}>
    <Text bold>{current?.label ?? "工程工作台"}</Text>
    {props.layout === "compact" ? null : <Text dimColor>{sanitizeTerminalText(props.projectRoot)}</Text>}
  </Box>;
}

function LoadingView({ colorEnabled }: Readonly<{ colorEnabled: boolean }>): React.JSX.Element {
  return <Box flexDirection="column" paddingX={1}><Text bold {...accent(colorEnabled)}>ALPHION</Text><Text>◌ 正在加载本地工程状态…</Text></Box>;
}

function EntryShell(props: Readonly<{ title: string; colorEnabled: boolean; error?: string; children: React.ReactNode }>): React.JSX.Element {
  return <Box flexDirection="column" paddingX={1}><Text bold {...accent(props.colorEnabled)}>ALPHION · {props.title}</Text>{props.error ? <Text {...textColor("red")}>✗ {sanitizeTerminalText(props.error)}</Text> : null}{props.children}</Box>;
}

function HomeView(props: Readonly<{ snapshot: WorkbenchSnapshot; profiles: readonly ProviderProfile[]; compact: boolean }>): React.JSX.Element {
  const active = props.profiles.find((profile) => profile.active);
  const sqlite = props.snapshot.diagnostics?.checks.find((check) => check.id === "sqlite");
  return <Box flexDirection="column">
    <StatusLine label="项目" value={props.snapshot.profile ? `${props.snapshot.profile.projectType} · ${shortRevision(props.snapshot.profile.projectRevision)}` : "画像加载中"} status={props.snapshot.profile ? "pass" : "wait"} />
    <StatusLine label="Provider" value={active ? `${active.name} · ${active.model}` : "尚未激活"} status={active ? "pass" : "warning"} />
    <StatusLine label="Vault" value={props.snapshot.vault ? vaultLabel(props.snapshot.vault) : "状态加载中"} status={props.snapshot.vault?.initialized && !props.snapshot.vault.locked ? "pass" : "warning"} />
    <StatusLine label="缓存" value={props.snapshot.cache ? `${props.snapshot.cache.entries} 项 · ${formatBytes(props.snapshot.cache.bytes)} · 命中 ${props.snapshot.cache.hits}` : "统计加载中"} status="neutral" />
    <StatusLine label="最近诊断" value={sqlite?.summary ?? props.snapshot.diagnostics?.overall ?? "尚无结果"} status={props.snapshot.diagnostics?.overall === "healthy" ? "pass" : "warning"} />
    {props.compact ? null : <Box marginTop={1}><Text dimColor>Phase 1 已启用：确定性画像 → ContextPack → 运行期工作记忆</Text></Box>}
  </Box>;
}

function StatusLine(props: Readonly<{ label: string; value: string; status: "pass" | "warning" | "wait" | "neutral" }>): React.JSX.Element {
  const symbol = props.status === "pass" ? "✓" : props.status === "warning" ? "!" : props.status === "wait" ? "◌" : "·";
  const color = props.status === "pass" ? "green" : props.status === "warning" ? "yellow" : undefined;
  return <Text {...(color ? textColor(color) : {})}>{symbol} {props.label.padEnd(10, "　")} {sanitizeTerminalText(props.value)}</Text>;
}

function ProjectProfileView(props: Readonly<{ profile?: ProjectProfile; onRefresh: () => void }>): React.JSX.Element {
  if (!props.profile) return <Text>◌ 正在生成只读项目画像…</Text>;
  return <Box flexDirection="column">
    <Text>类型 {props.profile.projectType}  ·  revision {shortRevision(props.profile.projectRevision)}  ·  扫描 {props.profile.scannedPaths}</Text>
    {props.profile.facts.slice(0, 12).map((fact) => <Text key={fact.id}>✓ {fact.category} · {fact.name}: {sanitizeTerminalText(fact.value)}</Text>)}
    {props.profile.diagnostics.map((item, index) => <Text key={`${item.code}-${index}`} {...(item.severity === "warning" ? textColor("yellow") : {})}>! {sanitizeTerminalText(item.message)}</Text>)}
    <Text dimColor>r 刷新画像（绕过缓存）</Text>
    <RefreshKey onRefresh={props.onRefresh} />
  </Box>;
}

function DoctorView(props: Readonly<{ report?: DiagnosticReport; onRefresh: () => void }>): React.JSX.Element {
  if (!props.report) return <Text>◌ 正在执行只读诊断…</Text>;
  return <Box flexDirection="column">
    <Text>总体状态：{props.report.overall}</Text>
    {props.report.checks.map((check) => <Text key={check.id} {...textColor(check.status === "fail" ? "red" : check.status === "warning" || check.status === "unknown" ? "yellow" : "green")}>{check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "!"} {check.label} · {sanitizeTerminalText(check.summary)}</Text>)}
    <Text dimColor>r 重新运行只读诊断</Text>
    <RefreshKey onRefresh={props.onRefresh} />
  </Box>;
}

function RefreshKey({ onRefresh }: Readonly<{ onRefresh: () => void }>): null {
  useInput((input) => { if (input === "r") onRefresh(); });
  return null;
}

function TaskLauncher(props: Readonly<{ activeProfile?: ProviderProfile; onStart: () => void }>): React.JSX.Element {
  useInput((_input, key) => { if (key.return && props.activeProfile) props.onStart(); });
  return <Box flexDirection="column">
    {props.activeProfile ? <><Text>✓ 活动 Provider：{props.activeProfile.name} · {props.activeProfile.model}</Text><Text>按 Enter 创建一次受控 Agent 任务。</Text></> : <Text {...textColor("yellow")}>! 请先配置并激活 Provider。</Text>}
    <Text dimColor>运行前将自动生成画像和最多 2,048 estimated tokens 的 ContextPack。</Text>
  </Box>;
}

export function ProviderList(props: Readonly<{
  profiles: readonly ProviderProfile[];
  selected: number;
  onSelected: (index: number) => void;
  onNew: () => void;
  onEdit: () => void;
  onActivate: () => void;
  onCredential: () => void;
  onRemoveCredential: () => void;
  onRun: () => void;
  onLock: () => void;
  onExit: () => void;
}>): React.JSX.Element {
  useInput((input, key) => {
    if (key.upArrow) props.onSelected(Math.max(0, props.selected - 1));
    else if (key.downArrow) props.onSelected(Math.min(props.profiles.length - 1, props.selected + 1));
    else if (input === "n") props.onNew();
    else if (input === "e" && props.profiles.length > 0) props.onEdit();
    else if (input === "a" && props.profiles.length > 0) props.onActivate();
    else if (input === "k" && props.profiles.length > 0) props.onCredential();
    else if (input === "x" && props.profiles.length > 0) props.onRemoveCredential();
    else if ((input === "r" || key.return) && props.profiles.length > 0) props.onRun();
    else if (input === "l") props.onLock();
    else if (input === "q") props.onExit();
  });
  return <Box flexDirection="column">
    {props.profiles.length === 0 ? <Text dimColor>暂无 Provider。按 n 新建 DeepSeek 或 OpenAI 兼容配置。</Text> : null}
    {props.profiles.map((profile, index) => <Text key={profile.id} {...(index === props.selected ? accent(process.env.NO_COLOR === undefined) : {})}>
      {index === props.selected ? "◆" : "◇"} {profile.active ? "✓ 活动" : "  待用"} · {profile.name} · {profile.kind} · {profile.model} · {authLabel(profile)}
    </Text>)}
    <Text dimColor>↑↓ 选择 · n 新建 · e 编辑 · a 激活 · k 导入/轮换 Key · x 删除 Key · r 运行 · l 锁定 Vault</Text>
  </Box>;
}

function VaultSetup(props: Readonly<{ onComplete: (password: string) => Promise<void>; onError: (cause: unknown) => void }>): React.JSX.Element {
  const [first, setFirst] = useState<string | undefined>();
  return first === undefined
    ? <TextEntry label="创建主密码（至少 12 个字符）" masked onSubmit={setFirst} />
    : <TextEntry label="再次输入主密码" masked onSubmit={(second) => {
        if (second !== first) { props.onError(new Error("两次输入的主密码不一致。")); setFirst(undefined); return; }
        void props.onComplete(first).catch(props.onError);
      }} onCancel={() => setFirst(undefined)} />;
}

function ProviderForm(props: Readonly<{ draft: ProviderDraft; presets: readonly ProviderPreset[]; onSave: (draft: ProviderDraft) => void; onCancel: () => void }>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0 && !value.existing && props.presets.length > 1) {
    return <PresetPicker presets={props.presets} selectedId={value.presetId} onSelect={(preset) => { setValue(presetDraft(preset)); setStep(1); }} onCancel={props.onCancel} />;
  }
  if (step <= 1) return <TextEntry label="配置名称" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(2); }} onCancel={props.onCancel} />;
  if (step === 2) return <TextEntry label="模型" initialValue={value.model} onSubmit={(model) => { setValue({ ...value, model }); setStep(3); }} onCancel={() => setStep(1)} />;
  return <TextEntry label="Base URL" initialValue={value.baseUrl} onSubmit={(baseUrl) => props.onSave({ ...value, baseUrl })} onCancel={() => setStep(2)} />;
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

export function TextEntry(props: Readonly<{ label: string; initialValue?: string; masked?: boolean; onSubmit: (value: string) => void; onCancel?: () => void }>): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? "");
  useInput((input, key) => {
    if (key.return) { if (value.trim().length > 0) props.onSubmit(value); return; }
    if (key.escape) { props.onCancel?.(); return; }
    if (key.backspace || key.delete) { setValue((current) => current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) setValue((current) => current + input);
  });
  return <Box flexDirection="column" marginTop={1}><Text>{props.label}</Text><Text {...accent(process.env.NO_COLOR === undefined)}>› {props.masked ? "•".repeat(value.length) : sanitizeTerminalText(value)}</Text><Text dimColor>Enter 确认 · Esc 返回</Text></Box>;
}

function RunView(props: Readonly<{ application: AgentApplication; approval: TuiApprovalPort; projectRoot: string; prompt: string; providerId?: string; onDone: () => void; onExit: () => void }>): React.JSX.Element {
  const [projection, dispatch] = useReducer(reduceRunProjection, EMPTY_RUN_PROJECTION);
  const [showReasoning, setShowReasoning] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const handle = useRef<AgentRunHandle | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dispatch({ type: "reset" });
    let active = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let answerBuffer = "";
    let reasoningBuffer = "";
    let lastFlush = Date.now();
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!active) return;
      if (answerBuffer) { dispatch({ type: "answer-delta", delta: answerBuffer }); answerBuffer = ""; }
      if (reasoningBuffer) { dispatch({ type: "reasoning-delta", delta: reasoningBuffer }); reasoningBuffer = ""; }
      lastFlush = Date.now();
    };
    const scheduleFlush = () => {
      if (!active || flushTimer) return;
      flushTimer = setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush)));
    };
    void props.application.startRun({ prompt: props.prompt, projectRoot: props.projectRoot, ...(props.providerId ? { providerId: props.providerId } : {}) }, props.approval)
      .then(async (runHandle) => {
        handle.current = runHandle;
        for await (const event of runHandle.events) {
          if (event.kind === "model.delta" && typeof event.payload.delta === "string") { answerBuffer += event.payload.delta; scheduleFlush(); }
          else if (event.kind === "model.reasoning.delta" && typeof event.payload.delta === "string") { reasoningBuffer += event.payload.delta; scheduleFlush(); }
          else { flush(); dispatch({ type: "event", event }); }
        }
        flush();
        await runHandle.result;
      })
      .catch((cause: unknown) => { if (active) dispatch({ type: "run-error", message: safeError(cause) }); });
    return () => { active = false; if (flushTimer) clearTimeout(flushTimer); handle.current?.cancel("TUI view closed."); };
  }, [props.application, props.approval, props.projectRoot, props.prompt, props.providerId]);

  useInput((input, key) => {
    if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y");
    else if (input === "t") setShowReasoning((value) => !value);
    else if (key.ctrl && input === "c") { if (projection.status === "running") handle.current?.cancel("Cancelled from TUI."); else props.onExit(); }
    else if (key.return && projection.status !== "running") props.onDone();
  });

  return <Box flexDirection="column" marginTop={1}>
    <Text bold>状态 · {projection.status}</Text>
    {projection.reasoning ? <Box flexDirection="column"><Text {...textColor("yellow")}>模型推理（非事实证据）· {showReasoning ? "t 折叠" : "t 展开"}</Text>{showReasoning ? <Text dimColor>{projection.reasoning}</Text> : <Text dimColor>[已折叠 · {projection.reasoning.length} 字符]</Text>}</Box> : null}
    <Text>{projection.answer || "◌ 等待模型输出…"}</Text>
    <Text dimColor>tokens 输入={projection.inputTokens} 输出={projection.outputTokens} 缓存={projection.cachedInputTokens}</Text>
    {projection.message ? <Text {...(projection.status === "failed" ? textColor("red") : {})}>{projection.message}</Text> : null}
    {pendingApproval ? <Box flexDirection="column" borderStyle="round" {...borderColor("yellow")} paddingX={1}><Text bold>! 需要逐次审批：{sanitizeTerminalText(pendingApproval.request.toolName)}</Text><Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text><Text>y 批准此精确动作 · n 拒绝</Text></Box> : null}
    <Text dimColor>{projection.status === "running" ? "Ctrl+C 取消 · t 查看推理" : "Enter 返回工作台"}</Text>
  </Box>;
}

function presetDraft(preset: ProviderPreset | undefined): ProviderDraft {
  const fallback: ProviderPreset = { id: "deepseek", label: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com", models: ["deepseek-chat"], protocol: "chat-completions" };
  const value = preset ?? fallback;
  return { presetId: value.id, name: value.label, kind: value.kind, protocol: value.protocol, model: value.models[0] ?? "", baseUrl: value.baseUrl };
}

function profileDraft(profile: ProviderProfile): ProviderDraft {
  return { existing: profile, presetId: profile.kind, name: profile.name, kind: profile.kind, protocol: profile.protocol, model: profile.model, baseUrl: profile.baseUrl };
}

function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const id = draft.existing?.id ?? toProfileId(draft.name);
  return {
    schemaVersion: 2,
    id,
    name: draft.name.trim(),
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    protocol: draft.kind === "deepseek" ? "chat-completions" : draft.protocol,
    auth: draft.existing?.auth ?? { mode: "none" },
    capabilities: {
      streaming: draft.existing?.capabilities.streaming ?? true,
      tools: draft.existing?.capabilities.tools ?? true,
      promptCaching: draft.existing?.capabilities.promptCaching ?? false,
      reasoning: draft.kind === "deepseek" && draft.model.trim() === "deepseek-reasoner",
    },
    active: draft.existing?.active ?? firstProfile,
  };
}

function toProfileId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "") || "provider";
}

function authLabel(profile: ProviderProfile): string {
  if (profile.auth.mode === "encrypted-sqlite") return "✓ 已加密配置";
  if (profile.auth.mode === "bearer-env") return `✓ 环境引用 ${profile.auth.environmentVariable}`;
  return "! 未配置凭据";
}

function vaultLabel(status: VaultStatus): string {
  if (!status.initialized) return "未初始化";
  return status.locked ? `已锁定 · ${status.secretCount} 个凭据` : `已解锁 · ${status.secretCount} 个凭据`;
}

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function accent(enabled: boolean): Readonly<{ color?: string }> {
  return enabled ? { color: BRAND_PURPLE } : {};
}

function textColor(color: string): Readonly<{ color?: string }> {
  return process.env.NO_COLOR === undefined ? { color } : {};
}

function borderColor(color: string): Readonly<{ borderColor?: string }> {
  return process.env.NO_COLOR === undefined ? { borderColor: color } : {};
}

function safeError(value: unknown): string {
  return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。");
}
