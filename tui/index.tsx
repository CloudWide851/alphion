import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { openLocalAlphionApplication } from "../adapters/local/local-application.js";
import type {
  AgentApplication,
  AgentSessionContract,
  AgentSessionRecord,
  HarnessPlan,
  DiagnosticReport,
  ProjectProfile,
  ProviderPreset,
  ProviderProfile,
  ProviderProfileInput,
  ApprovalPort,
  CompactionProjection,
} from "../src/index.js";
import { TuiApprovalPort } from "./approval-port.js";
import { sanitizeTerminalText } from "./run-projection.js";
import { TextEntry } from "./input.js";
import { RunView, type RunViewCommand } from "./run-view.js";
import { accent, AppShell, ChatHome, textColor, selectWorkbenchLayout, type ChatMessage, type WorkbenchSection } from "./shell.js";
import { EntryShell } from "./entry-shell.js";
import { PlatformTerminalLauncher, type TerminalLauncher } from "./terminal-launcher.js";
import { forkTuiSession } from "./session-fork.js";
import { AlternateScreenSurface, type TerminalSurface } from "./terminal-surface.js";
import { ProviderModelPicker } from "./provider-model-picker.js";
import { resolveTuiInput } from "./slash-dispatch.js";
import { HelpCard, ProjectCard } from "./workbench-cards.js";
import { ContextCard, GoalCard, SchedulesCard } from "./automation-cards.js";

export interface RunTuiOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
  readonly sessionId?: string;
  readonly terminalLauncher?: TerminalLauncher;
  readonly terminalSurface?: TerminalSurface;
}

export { AppShell, ChatHome, selectWorkbenchLayout } from "./shell.js";
export { ChatEntry, TextEntry } from "./input.js";
export type { WorkbenchLayout, WorkbenchSection } from "./shell.js";

type Screen = "workbench" | "provider-form" | "credential";

interface ProviderDraft {
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

interface WorkbenchSnapshot {
  readonly profile?: ProjectProfile;
  readonly diagnostics?: DiagnosticReport;
}


export async function runTui(options: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1;
  const terminalSurface = options.terminalSurface ?? new AlternateScreenSurface();
  terminalSurface.enter();
  let application: AgentApplication | undefined;
  try {
    application = await openLocalAlphionApplication(options);
    const initialSession = options.sessionId ? await application.sessions.get(options.sessionId) : undefined;
    const instance = render(<AlphionTui application={application} projectRoot={options.projectRoot} terminalLauncher={options.terminalLauncher ?? new PlatformTerminalLauncher()} {...(initialSession ? { initialSession } : {})} />, { exitOnCtrlC: false });
    await instance.waitUntilExit();
    return 0;
  } finally {
    try {
      await application?.close();
    } finally {
      terminalSurface.restore();
    }
  }
}

function AlphionTui({ application, projectRoot, initialSession, terminalLauncher }: Readonly<{ application: AgentApplication; projectRoot: string; initialSession?: AgentSessionContract; terminalLauncher: TerminalLauncher }>): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const layout = selectWorkbenchLayout(stdout.columns ?? 80, stdout.rows ?? 24);
  const colorEnabled = process.env.NO_COLOR === undefined;
  const [screen, setScreen] = useState<Screen>("workbench");
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
  const [runSession, setRunSession] = useState<AgentSessionContract | undefined>(initialSession);
  const [runCommand, setRunCommand] = useState<RunViewCommand>();
  const [chatSession, setChatSession] = useState<AgentSessionContract | undefined>(initialSession);
  const [chatMessages, setChatMessages] = useState<readonly ChatMessage[]>([]);
  const [compaction, setCompaction] = useState<CompactionProjection>({ count: 0 });
  const approval = useMemo(() => new TuiApprovalPort(), []);

  const refreshProfiles = useCallback(async () => {
    const next = await application.configuration.listProfiles();
    setProfiles(next);
    setSelected((value) => Math.min(value, Math.max(0, next.length - 1)));
    return next;
  }, [application]);
  const refreshSnapshot = useCallback(async (refresh = false) => {
    const [profile, diagnostics] = await Promise.all([
      application.inspectProject({ ...(refresh ? { refresh: true } : {}) }),
      application.diagnose(),
    ]);
    setSnapshot({ profile, diagnostics });
  }, [application]);
  const acceptRunSession = useCallback((session: AgentSessionContract) => { setChatSession(session); void session.compactionProjection().then(setCompaction); }, []);
  const finishRun = useCallback((answer: string) => {
    if (answer.trim()) setChatMessages((messages) => [...messages, { id: `assistant:${Date.now()}`, role: "assistant", content: answer }]);
    const completedSession = runSession ?? chatSession;
    if (completedSession) void completedSession.compactionProjection().then(setCompaction);
    setRunPrompt(""); setRunSession(undefined); setRunCommand(undefined); void refreshSnapshot();
  }, [chatSession, refreshSnapshot, runSession]);

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([refreshProfiles(), refreshSnapshot()]);
      } catch (cause) {
        setError(safeError(cause));
      }
    })();
  }, [application, refreshProfiles, refreshSnapshot]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { if (runPrompt) setRunCommand({ id: Date.now(), kind: "cancel" }); else exit(); return; }
    if (screen !== "workbench") return;
    if (section !== "home" && input === "?") { setHelp((value) => !value); return; }
    if (section !== "home" && input === "q") { exit(); return; }
    if (key.escape) { setHelp(false); setSection("home"); return; }
  });

  const current = profiles[selected];
  const activeProfile = profiles.find((profile) => profile.active);
  const beginRun = (prompt: string, session?: AgentSessionContract) => {
    if (session) setChatSession(session);
    setChatMessages((messages) => [...messages, { id: `user:${Date.now()}`, role: "user", content: prompt }]);
    setRunPrompt(prompt);
    setRunSession(session ?? chatSession);
    setRunProviderId(activeProfile?.id);
  };
  const submitChat = (value: string): boolean | void => {
    const action = resolveTuiInput(value, { hasSession: chatSession !== undefined, sessionIdle: !runPrompt, ...(runPrompt ? { activeRunId: "active-tui-run" } : {}) });
    if (action.kind === "message") {
      if (!activeProfile) { setError("请先配置并激活 Provider；当前输入已保留。"); setSection("providers"); return false; }
      if (runPrompt) { if (chatSession) setRunCommand({ id: Date.now(), kind: "follow-up", content: action.content }); else setError("会话尚未准备好。"); }
      else beginRun(action.content);
      return;
    }
    if (action.kind === "fork") {
      if (!chatSession) { setError("/fork 需要当前会话；可使用 alphion tui --session <ID> 打开。"); return; }
      void forkTuiSession(chatSession, action.title, terminalLauncher).then((outcome) => setError(outcome.message)).catch((cause: unknown) => setError(safeError(cause)));
      return;
    }
    if (action.kind === "new") { setChatSession(undefined); setChatMessages([]); setError(""); return; }
    if (action.kind === "new-project") { setError(`将创建 Project：${action.root}${action.name ? `（${action.name}）` : ""}`); setSection("projects"); return; }
    if (action.kind === "navigate") { setError(""); setSection(action.section); return; }
    if (action.kind === "steer" || action.kind === "follow-up" || action.kind === "cancel") { setRunCommand({ id: Date.now(), kind: action.kind, ...(action.kind === "cancel" ? {} : { content: action.content }) }); setError(""); return; }
    setError(action.kind === "error" ? action.message : "命令需要活动 Run。");
  };
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
  return <AppShell section={section} layout={layout} colorEnabled={colorEnabled} projectRoot={projectRoot} error={error} help={help}>
    {section === "home" ? <ChatHome {...(activeProfile ? { activeProfile } : {})} messages={chatMessages} compactionCount={compaction.count} activeBubble={runPrompt ? <RunView application={application} approval={approval} prompt={runPrompt} {...(runSession ? { session: runSession } : {})} {...(runProviderId ? { providerId: runProviderId } : {})} {...(runCommand ? { command: runCommand } : {})} compact={layout === "compact"} onSession={acceptRunSession} onError={setError} onDone={finishRun} /> : null} compact={layout === "compact"} heightRows={Math.max(10, (stdout.rows ?? 24) - 2)} viewportRows={Math.max(4, (stdout.rows ?? 24) - (layout === "compact" ? 8 : 11))} contentWidth={Math.max(20, Math.min(88, (stdout.columns ?? 80) - 8))} slashContext={{ hasSession: chatSession !== undefined, sessionIdle: !runPrompt, ...(runPrompt ? { activeRunId: "active-tui-run" } : {}) }} onSubmit={submitChat} /> : null}
    {section === "projects" ? <ProjectCard projectRoot={projectRoot} /> : null}
    {section === "profile" ? <ProjectProfileView {...(snapshot.profile ? { profile: snapshot.profile } : {})} onRefresh={() => void refreshSnapshot(true).catch((cause: unknown) => setError(safeError(cause)))} /> : null}
    {section === "providers" ? <ProviderList
      profiles={profiles}
      selected={selected}
      onSelected={setSelected}
      onNew={() => { setDraft(presetDraft(presets[0])); setScreen("provider-form"); }}
      onEdit={() => { if (current) { setDraft(profileDraft(current, presets)); setScreen("provider-form"); } }}
      onActivate={() => current && void application.configuration.activateProfile(current.id).then(async () => { await refreshProfiles(); await refreshSnapshot(); }).catch((cause: unknown) => setError(safeError(cause)))}
      onCredential={() => current && setScreen("credential")}
      onRemoveCredential={() => current && void application.configuration.removeCredential(current.id).then(async () => { await refreshProfiles(); await refreshSnapshot(); }).catch((cause: unknown) => setError(safeError(cause)))}
      onRun={() => current && setSection("home")}
      onExit={() => exit()}
    /> : null}
    {section === "sessions" ? <SessionWorkbenchView application={application} approval={approval} onSend={(session, prompt) => beginRun(prompt, session)} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "resources" ? <ResourceResolutionView application={application} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "harness" ? <HarnessPlanView application={application} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "context" ? <ContextCard {...(chatSession ? { session: chatSession } : {})} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "goals" ? <GoalCard application={application} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "goal" ? <GoalCard application={application} actionMode onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "schedules" ? <SchedulesCard application={application} onError={(cause) => setError(safeError(cause))} /> : null}
    {section === "doctor" ? <DoctorView {...(snapshot.diagnostics ? { report: snapshot.diagnostics } : {})} onRefresh={() => void refreshSnapshot().catch((cause: unknown) => setError(safeError(cause)))} /> : null}
    {section === "help" ? <HelpCard /> : null}
  </AppShell>;
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
  useEffect(() => {
    if (!current) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const iterator = props.application.sessions.subscribe(current.id)[Symbol.asyncIterator]();
    void (async () => {
      try {
        while (!disposed) {
          const next = await iterator.next();
          if (next.done || disposed) break;
          if (timer) continue;
          timer = setTimeout(() => { timer = undefined; if (!disposed) void refresh().catch(props.onError); }, 33);
        }
      } catch (cause) { if (!disposed) props.onError(cause); }
    })();
    return () => { disposed = true; if (timer) clearTimeout(timer); void iterator.return?.(); };
  }, [current?.id, props.application, props.onError, refresh]);
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
    else if (input === "q") props.onExit();
  });
  return <Box flexDirection="column">
    {props.profiles.length === 0 ? <Text dimColor>暂无 Provider。按 n 新建 DeepSeek 或 OpenAI 兼容配置。</Text> : null}
    {props.profiles.map((profile, index) => <Text key={profile.id} {...(index === props.selected ? accent(process.env.NO_COLOR === undefined) : {})}>
      {index === props.selected ? "◆" : "◇"} {profile.active ? "✓ 活动" : "  待用"} · {profile.name} · {profile.kind} · {profile.model} · {authLabel(profile)}
    </Text>)}
    <Text dimColor>↑↓ 选择 · n 新建 · e 编辑 · a 激活 · k 导入/轮换 Key · x 删除 Key · r 运行</Text>
  </Box>;
}

export function ProviderForm(props: Readonly<{ draft: ProviderDraft; presets: readonly ProviderPreset[]; onSave: (draft: ProviderDraft) => void; onCancel: () => void }>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0 && !value.existing && props.presets.length > 1) {
    return <PresetPicker presets={props.presets} selectedId={value.presetId} onSelect={(preset) => { setValue(presetDraft(preset)); setStep(1); }} onCancel={props.onCancel} />;
  }
  if (step <= 1) return <TextEntry label="配置名称" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(2); }} onCancel={props.onCancel} />;
  if (step === 2 && value.kind !== "custom-openai-compatible" && value.catalogModels && !value.unlistedModel) {
    return <ProviderModelPicker models={value.catalogModels} selectedModel={value.model} onSelect={(model) => props.onSave({ ...value, model })} onAdvanced={() => { setValue({ ...value, unlistedModel: true }); }} onCancel={() => setStep(1)} />;
  }
  if (step === 2) return <TextEntry label={value.unlistedModel ? "高级自定义模型（不受 catalog 保证）" : "模型"} initialValue={value.model} onSubmit={(model) => {
    const next = { ...value, model };
    if (next.kind === "custom-openai-compatible") { setValue(next); setStep(3); }
    else props.onSave(next);
  }} onCancel={() => setStep(1)} />;
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

function presetDraft(preset: ProviderPreset | undefined): ProviderDraft {
  const fallback: ProviderPreset = { id: "deepseek", label: "DeepSeek（中国大陆）", kind: "deepseek", region: "mainland", requiresBaseUrl: false, models: ["deepseek-chat"], protocol: "chat-completions" };
  const value = preset ?? fallback;
  return { presetId: value.id, name: value.label, kind: value.kind, protocol: value.protocol, model: value.models[0] ?? "", catalogModels: value.models, ...(value.requiresBaseUrl ? { baseUrl: "" } : {}) };
}

function profileDraft(profile: ProviderProfile, presets: readonly ProviderPreset[]): ProviderDraft {
  const catalogModels = profile.kind === "custom-openai-compatible" ? undefined : presets.find((preset) => preset.id === profile.presetId)?.models;
  return { existing: profile, presetId: profile.kind === "custom-openai-compatible" ? profile.kind : profile.presetId, name: profile.name, kind: profile.kind, protocol: profile.protocol, model: profile.model, ...(catalogModels ? { catalogModels } : {}), ...(profile.capabilities.unlistedModel ? { unlistedModel: true } : {}), ...(profile.kind === "custom-openai-compatible" ? { baseUrl: profile.baseUrl } : {}) };
}

function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const id = draft.existing?.id ?? toProfileId(draft.name);
  const common = {
    schemaVersion: 2 as const,
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
      ...(draft.unlistedModel ? { unlistedModel: true } : {}),
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
  if (profile.auth.mode === "encrypted-project") return "✓ Project 独立加密";
  if (profile.auth.mode === "bearer-env") return `✓ 环境引用 ${profile.auth.environmentVariable}`;
  return "! 未配置凭据";
}

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function safeError(value: unknown): string {
  return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。");
}
