import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { openLocalAlphionApplication } from "../adapters/local/local-application.js";
import type {
  CacheStats,
  AgentApplication,
  AgentSessionContract,
  AgentSessionRecord,
  HarnessPlan,
  AgentRunHandle,
  DiagnosticReport,
  ProjectProfile,
  ProviderPreset,
  ProviderProfile,
  ProviderProfileInput,
  ApprovalPort,
  VaultStatus,
} from "../src/index.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "./run-projection.js";

export interface RunTuiOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
}

type Screen = "loading" | "vault-setup" | "vault-unlock" | "workbench" | "provider-form" | "credential" | "prompt" | "run";
export type WorkbenchSection = "home" | "profile" | "providers" | "sessions" | "resources" | "harness" | "tasks" | "doctor";
export type WorkbenchLayout = "wide" | "narrow" | "compact";

interface ProviderDraft {
  readonly existing?: ProviderProfile;
  readonly presetId: string;
  readonly name: string;
  readonly kind: ProviderProfile["kind"];
  readonly protocol: ProviderProfile["protocol"];
  readonly model: string;
  readonly baseUrl?: string;
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
  { id: "sessions", label: "共享会话", short: "会话" },
  { id: "resources", label: "Agent 资源", short: "资源" },
  { id: "harness", label: "HarnessPlan", short: "Harness" },
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
    await application.close();
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
  const [runSession, setRunSession] = useState<AgentSessionContract | undefined>();
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
  const beginRun = (prompt: string, session?: AgentSessionContract) => {
    setRunPrompt(prompt);
    setRunSession(session);
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
        {...(runSession ? { session: runSession } : {})}
        {...(runProviderId ? { providerId: runProviderId } : {})}
        onDone={() => { setRunPrompt(""); setRunSession(undefined); setScreen("workbench"); setSection(runSession ? "sessions" : "tasks"); void refreshSnapshot(); }}
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
    {section === "sessions" ? <SessionWorkbenchView application={application} approval={approval} onSend={(session, prompt) => beginRun(prompt, session)} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "resources" ? <ResourceResolutionView application={application} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "harness" ? <HarnessPlanView application={application} onError={(cause) => setError(safeError(cause))} /> : null}
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
        <Text dimColor>工程工作台 · 0.4.0</Text>
        <Box flexDirection="column" marginTop={1}>
          {SECTIONS.map((entry, index) => <Text key={entry.id} {...(entry.id === props.section ? accent(props.colorEnabled) : {})}>{entry.id === props.section ? "◆" : "◇"} {index + 1}  {entry.label}</Text>)}
        </Box>
      </Box>
    : <Box flexDirection="column">
        <Text bold {...accent(props.colorEnabled)}>ALPHION <Text dimColor>工程工作台 · 0.4.0</Text></Text>
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

export function SessionWorkbenchView(props: Readonly<{ application: AgentApplication; approval: ApprovalPort; onSend: (session: AgentSessionContract, prompt: string) => void; onError: (cause: unknown) => void }>): React.JSX.Element {
  const [sessions, setSessions] = useState<readonly AgentSessionRecord[]>([]);
  const [selected, setSelected] = useState(0);
  const [session, setSession] = useState<AgentSessionContract | undefined>();
  const [detail, setDetail] = useState<string[]>([]);
  const [entry, setEntry] = useState<"create" | "send" | "steer" | "follow-up" | "checkout" | "reshape" | undefined>();
  const refresh = useCallback(async () => {
    const values = await props.application.sessions.list();
    setSessions(values);
    setSelected((value) => Math.min(value, Math.max(0, values.length - 1)));
  }, [props.application]);
  useEffect(() => { void refresh().catch(props.onError); }, [refresh]);
  const current = sessions[selected];
  useInput((input, key) => {
    if (entry) return;
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    else if (key.downArrow) setSelected((value) => Math.min(sessions.length - 1, value + 1));
    else if (input === "n") setEntry("create");
    else if (input === "s" && current) setEntry("send");
    else if (input === "o" && current) void props.application.sessions.get(current.id).then(async (value) => { setSession(value); const view = await value.view(); setDetail(view.entries.map((item) => `${item.id.slice(0, 12)} · ${item.message.kind}${"content" in item.message ? ` · ${sanitizeTerminalText(item.message.content).slice(0, 80)}` : ""}`)); }).catch(props.onError);
    else if (input === "c" && current) setEntry("checkout");
    else if (input === "t" && current) setEntry("steer");
    else if (input === "f" && current) setEntry("follow-up");
    else if (input === "p" && current?.status === "idle") setEntry("reshape");
    else if (input === "i" && current) void props.application.sessions.getShape(current.id).then((shape) => setDetail(shape ? [`Shape rev ${shape.revision} · ${shape.digest}`, `目标 · ${shape.goal}`, `能力 · ${shape.capabilities.join(", ") || "无"}`, `工具 · ${shape.toolIds.join(", ") || "无"}`] : ["尚未塑形；首次发送时将原子生成 Shape。"])).catch(props.onError);
    else if (input === "r") void refresh().catch(props.onError);
  });
  if (entry === "create") return <TextEntry label="新会话标题" onCancel={() => setEntry(undefined)} onSubmit={(title) => void props.application.sessions.create({ title }).then(async () => { setEntry(undefined); await refresh(); }).catch(props.onError)} />;
  if (entry === "send" && current) return <TextEntry label={`发送到 ${current.title}`} onCancel={() => setEntry(undefined)} onSubmit={(prompt) => void props.application.sessions.get(current.id).then((value) => props.onSend(value, prompt)).catch(props.onError)} />;
  if (entry === "steer" && current) return <TextEntry label={`转向 ${current.title}`} onCancel={() => setEntry(undefined)} onSubmit={(message) => void props.application.sessions.get(current.id).then(async (value) => { const record = await value.get(); await value.steer(message, { expectedRevision: record.revision, idempotencyKey: `tui:steer:${Date.now()}` }); setEntry(undefined); await refresh(); }).catch(props.onError)} />;
  if (entry === "follow-up" && current) return <TextEntry label={`后续消息 ${current.title}`} onCancel={() => setEntry(undefined)} onSubmit={(message) => void props.application.sessions.get(current.id).then(async (value) => { const record = await value.get(); await value.followUp(message, { expectedRevision: record.revision, idempotencyKey: `tui:follow-up:${Date.now()}` }, props.approval); setEntry(undefined); await refresh(); }).catch(props.onError)} />;
  if (entry === "checkout" && current) return <TextEntry label="checkout entry id（输入 root 回到根）" onCancel={() => setEntry(undefined)} onSubmit={(entryId) => void props.application.sessions.get(current.id).then(async (value) => { const record = await value.get(); await value.checkout(entryId === "root" ? undefined : entryId, { expectedRevision: record.revision, idempotencyKey: `tui:checkout:${Date.now()}` }); setEntry(undefined); await refresh(); }).catch(props.onError)} />;
  if (entry === "reshape" && current) return <TextEntry label="新的 Agent Shape 目标" onCancel={() => setEntry(undefined)} onSubmit={(goal) => void props.application.sessions.get(current.id).then(async (value) => { const record = await value.get(); await value.reshape({ goal }, { expectedRevision: record.revision, idempotencyKey: `tui:reshape:${Date.now()}` }); setEntry(undefined); await refresh(); }).catch(props.onError)} />;
  return <Box flexDirection="column">
    {sessions.length === 0 ? <Text dimColor>暂无会话。按 n 创建。</Text> : sessions.map((value, index) => <Text key={value.id} {...(index === selected ? accent(process.env.NO_COLOR === undefined) : {})}>{index === selected ? "◆" : "◇"} {value.status === "running" ? "◌ 运行中" : value.auditOnly ? "! 只读审计" : "✓ 空闲"} · {sanitizeTerminalText(value.title)} · {value.shapeStatus} · rev {value.revision}</Text>)}
    {session && detail.length > 0 ? <Box flexDirection="column" marginTop={1}><Text bold>当前分支</Text>{detail.slice(-10).map((line) => <Text key={line}>{line}</Text>)}</Box> : null}
    <Text dimColor>↑↓ 选择 · n 创建 · o 查看 · i Shape · p reshape(空闲) · c checkout · s 发送 · t 转向 · f 后续 · r 刷新</Text>
  </Box>;
}

export function ResourceResolutionView(props: Readonly<{ application: AgentApplication; onError: (cause: unknown) => void }>): React.JSX.Element {
  const [resolution, setResolution] = useState<Awaited<ReturnType<AgentApplication["loadResources"]>> | undefined>();
  useEffect(() => { void props.application.loadResources().then(setResolution).catch(props.onError); }, [props.application, props.onError]);
  if (!resolution) return <Text>◌ 正在解析四层 Agent 资源…</Text>;
  return <Box flexDirection="column">
    <Text>资源 {resolution.resources.length} · shadow {resolution.shadows.length} · omission {resolution.omissions.length}</Text>
    {resolution.resources.map((item) => <Text key={item.id}>✓ [{item.provenance.scope}] {item.kind}:{item.id} · {item.digest.slice(0, 12)}</Text>)}
    {resolution.diagnostics.map((item, index) => <Text key={`${item.code}-${index}`} {...(item.severity === "error" ? textColor("red") : item.severity === "warning" ? textColor("yellow") : {})}>{item.severity === "error" ? "✗" : item.severity === "warning" ? "!" : "·"} {sanitizeTerminalText(item.message)}</Text>)}
    <Text dimColor>digest {resolution.digest}</Text>
  </Box>;
}

export function HarnessPlanView(props: Readonly<{ application: AgentApplication; onError: (cause: unknown) => void }>): React.JSX.Element {
  const [prompt, setPrompt] = useState<string | undefined>();
  const [plan, setPlan] = useState<HarnessPlan | undefined>();
  if (prompt === undefined) return <TextEntry label="输入任务以生成只读 HarnessPlan" onSubmit={(value) => { setPrompt(value); void props.application.planHarness(value).then(setPlan).catch(props.onError); }} />;
  if (!plan) return <Text>◌ 正在规划任务能力与预算…</Text>;
  return <Box flexDirection="column">
    <Text>任务 {plan.task} · 风险 {plan.risk} · evaluator {plan.evaluator}</Text>
    <Text>能力：{plan.capabilities.join(", ") || "无"}</Text><Text>权限：{plan.permissions.join(", ") || "无"}</Text>
    <Text>预算：{JSON.stringify(plan.budgets)}</Text><Text>省略：{plan.omissions.join(", ") || "无"}</Text>
    <Text dimColor>digest {plan.digest}</Text>
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

export function ProviderForm(props: Readonly<{ draft: ProviderDraft; presets: readonly ProviderPreset[]; onSave: (draft: ProviderDraft) => void; onCancel: () => void }>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0 && !value.existing && props.presets.length > 1) {
    return <PresetPicker presets={props.presets} selectedId={value.presetId} onSelect={(preset) => { setValue(presetDraft(preset)); setStep(1); }} onCancel={props.onCancel} />;
  }
  if (step <= 1) return <TextEntry label="配置名称" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(2); }} onCancel={props.onCancel} />;
  if (step === 2) return <TextEntry label="模型" initialValue={value.model} onSubmit={(model) => {
    const next = { ...value, model };
    if (next.kind === "custom-openai-compatible") { setValue(next); setStep(3); }
    else props.onSave(next);
  }} onCancel={() => setStep(1)} />;
  return <TextEntry label="Base URL（仅自定义 Provider）" initialValue={value.baseUrl} onSubmit={(baseUrl) => props.onSave({ ...value, baseUrl })} onCancel={() => setStep(2)} />;
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

export function TextEntry(props: Readonly<{ label: string; initialValue?: string; masked?: boolean; clearOnSubmit?: boolean; resetKey?: string | number; onSubmit: (value: string) => void; onCancel?: () => void }>): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? "");
  useEffect(() => {
    setValue(props.initialValue ?? "");
    return () => setValue("");
  }, [props.initialValue, props.label, props.masked, props.resetKey]);
  useInput((input, key) => {
    if (key.return) {
      if (value.trim().length > 0) {
        const submitted = value;
        if (props.masked || props.clearOnSubmit) setValue("");
        props.onSubmit(submitted);
      }
      return;
    }
    if (key.escape) { setValue(""); props.onCancel?.(); return; }
    if (key.backspace || key.delete) { setValue((current) => current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) setValue((current) => current + input);
  });
  return <Box flexDirection="column" marginTop={1}><Text>{props.label}</Text><Text {...accent(process.env.NO_COLOR === undefined)}>› {props.masked ? "•".repeat(value.length) : sanitizeTerminalText(value)}</Text><Text dimColor>Enter 确认 · Esc 返回</Text></Box>;
}

function RunView(props: Readonly<{ application: AgentApplication; approval: TuiApprovalPort; projectRoot: string; prompt: string; providerId?: string; session?: AgentSessionContract; onDone: () => void; onExit: () => void }>): React.JSX.Element {
  const [projection, dispatch] = useReducer(reduceRunProjection, EMPTY_RUN_PROJECTION);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const handle = useRef<AgentRunHandle | undefined>(undefined);
  const started = useRef(false);
  const activeSession = useRef<AgentSessionContract | undefined>(props.session);
  const [queueMode, setQueueMode] = useState<"steer" | "follow-up" | undefined>();

  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dispatch({ type: "reset" });
    let active = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let answerBuffer = "";
    let lastFlush = Date.now();
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!active) return;
      if (answerBuffer) { dispatch({ type: "answer-delta", delta: answerBuffer }); answerBuffer = ""; }
      lastFlush = Date.now();
    };
    const scheduleFlush = () => {
      if (!active || flushTimer) return;
      flushTimer = setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush)));
    };
    const resolveSession = props.session ? Promise.resolve(props.session) : props.application.sessions.create({ title: props.prompt.slice(0, 80), ...(props.providerId ? { providerId: props.providerId } : {}) });
    void resolveSession
      .then(async (session) => { activeSession.current = session; return session.send(props.prompt, { expectedRevision: (await session.get()).revision, idempotencyKey: `tui:send:${Date.now()}` }, props.approval); })
      .then(async (runHandle) => {
        handle.current = runHandle;
        for await (const event of runHandle.events) {
          if (event.kind === "model.delta" && typeof event.payload.delta === "string") { answerBuffer += event.payload.delta; scheduleFlush(); }
          else if (!("delivery" in event)) { flush(); dispatch({ type: "event", event }); }
        }
        flush();
        await runHandle.result;
      })
      .catch((cause: unknown) => { if (active) dispatch({ type: "run-error", message: safeError(cause) }); });
    return () => { active = false; if (flushTimer) clearTimeout(flushTimer); handle.current?.cancel("TUI view closed."); };
  }, [props.application, props.approval, props.projectRoot, props.prompt, props.providerId]);

  useInput((input, key) => {
    if (queueMode) return;
    if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y");
    else if (input === "s" && projection.status === "running") setQueueMode("steer");
    else if (input === "f") setQueueMode("follow-up");
    else if (key.ctrl && input === "c") { if (projection.status === "running") handle.current?.cancel("Cancelled from TUI."); else props.onExit(); }
    else if (key.return && projection.status !== "running") props.onDone();
  });

  if (queueMode) return <TextEntry label={queueMode === "steer" ? "注入下一模型边界（steer）" : "排队终态后续（follow-up）"} onCancel={() => setQueueMode(undefined)} onSubmit={(content) => {
    const value = activeSession.current;
    if (!value) { dispatch({ type: "run-error", message: "会话尚未准备好。" }); setQueueMode(undefined); return; }
    void value.get().then((record) => queueMode === "steer"
      ? value.steer(content, { expectedRevision: record.revision, idempotencyKey: `tui:steer:${Date.now()}` })
      : value.followUp(content, { expectedRevision: record.revision, idempotencyKey: `tui:follow-up:${Date.now()}` }, props.approval))
      .then(() => { setQueueMode(undefined); })
      .catch((cause: unknown) => { dispatch({ type: "run-error", message: safeError(cause) }); setQueueMode(undefined); });
  }} />;

  return <Box flexDirection="column" marginTop={1}>
    <Text bold>状态 · {projection.status}</Text>
    <Text>{projection.answer || "◌ 等待模型输出…"}</Text>
    <Text dimColor>tokens 输入={projection.inputTokens} 输出={projection.outputTokens} 缓存={projection.cachedInputTokens}</Text>
    {projection.message ? <Text {...(projection.status === "failed" ? textColor("red") : {})}>{projection.message}</Text> : null}
    {pendingApproval ? <Box flexDirection="column" borderStyle="round" {...borderColor("yellow")} paddingX={1}><Text bold>! 需要逐次审批：{sanitizeTerminalText(pendingApproval.request.toolName)}</Text><Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text><Text>y 批准此精确动作 · n 拒绝</Text></Box> : null}
    <Text dimColor>{projection.status === "running" ? "s steer · f follow-up · Ctrl+C 取消" : "f follow-up · Enter 返回工作台"}</Text>
  </Box>;
}

function presetDraft(preset: ProviderPreset | undefined): ProviderDraft {
  const fallback: ProviderPreset = { id: "deepseek", label: "DeepSeek（中国大陆）", kind: "deepseek", region: "mainland", requiresBaseUrl: false, models: ["deepseek-chat"], protocol: "chat-completions" };
  const value = preset ?? fallback;
  return { presetId: value.id, name: value.label, kind: value.kind, protocol: value.protocol, model: value.models[0] ?? "", ...(value.requiresBaseUrl ? { baseUrl: "" } : {}) };
}

function profileDraft(profile: ProviderProfile): ProviderDraft {
  return { existing: profile, presetId: profile.kind === "custom-openai-compatible" ? profile.kind : profile.presetId, name: profile.name, kind: profile.kind, protocol: profile.protocol, model: profile.model, ...(profile.kind === "custom-openai-compatible" ? { baseUrl: profile.baseUrl } : {}) };
}

function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const id = draft.existing?.id ?? toProfileId(draft.name);
  const common = {
    schemaVersion: 2,
    id,
    name: draft.name.trim(),
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
  return draft.kind === "custom-openai-compatible"
    ? { ...common, kind: draft.kind, baseUrl: draft.baseUrl?.trim() ?? "" }
    : { ...common, kind: draft.kind, presetId: draft.presetId };
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
