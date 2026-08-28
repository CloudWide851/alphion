import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { WorkspaceController, type ActiveProjectSnapshot } from "../adapters/project/active-project-controller.js";
import type {
  AgentApplication,
  AgentSessionContract,
  AgentSessionRecord,
  HarnessPlan,
  DiagnosticReport,
  ProjectProfile,
  ProjectRecord,
  ProviderProfile,
  ApprovalPort,
  CompactionProjection,
  ImageAttachmentRef,
} from "../src/index.js";
import { TuiApprovalPort } from "./approval-port.js";
import { sanitizeTerminalText } from "./run-projection.js";
import { TextEntry } from "./input.js";
import { RunView, type RunViewCommand } from "./run-view.js";
import { accent, AppShell, ChatHome, textColor, selectWorkbenchLayout, type ChatMessage, type TuiNotice, type WorkbenchSection } from "./shell.js";
import { EntryShell } from "./entry-shell.js";
import { PlatformTerminalLauncher, type TerminalLauncher } from "./terminal-launcher.js";
import { forkTuiSession } from "./session-fork.js";
import { AlternateScreenSurface, type TerminalSurface } from "./terminal-surface.js";
import { ProviderForm, ProviderList, presetDraft, profileDraft, providerTestBatchFeedback, providerTestFeedback, toProfileInput, type ProviderDraft, type ProviderTestFeedback } from "./provider-views.js";
import { resolveTuiInput } from "./slash-dispatch.js";
import { HelpCard, ProjectCard, SettingsCard } from "./workbench-cards.js";
import { ContextCard, GoalCard, SchedulesCard } from "./automation-cards.js";
import { readClipboardImage } from "./clipboard-image.js";

export interface RunTuiOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
  readonly sessionId?: string;
  readonly terminalLauncher?: TerminalLauncher;
  readonly terminalSurface?: TerminalSurface;
}

export { AppShell, ChatHome, selectWorkbenchLayout } from "./shell.js";
export { ChatEntry, TextEntry } from "./input.js";
export { ProviderForm, ProviderList, providerTestBatchFeedback, providerTestFeedback } from "./provider-views.js";
export type { WorkbenchLayout, WorkbenchSection } from "./shell.js";

type Screen = "workbench" | "provider-form" | "credential";

interface WorkbenchSnapshot {
  readonly profile?: ProjectProfile;
  readonly diagnostics?: DiagnosticReport;
}


export async function runTui(options: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1;
  const terminalSurface = options.terminalSurface ?? new AlternateScreenSurface();
  terminalSurface.enter();
  const workspace = new WorkspaceController();
  try {
    const initialWorkspace = await workspace.openProject({ root: options.projectRoot, ...(options.statePath ? { statePath: options.statePath } : {}) });
    const initialSession = options.sessionId ? await initialWorkspace.application.sessions.get(options.sessionId) : undefined;
    const initialMessages = initialSession ? chatMessagesFromView(await initialSession.view()) : [];
    const initialCompaction = initialSession ? await initialSession.compactionProjection() : { count: 0 };
    const instance = render(<AlphionTui workspace={workspace} initialWorkspace={initialWorkspace} initialMessages={initialMessages} initialCompaction={initialCompaction} terminalLauncher={options.terminalLauncher ?? new PlatformTerminalLauncher()} {...(initialSession ? { initialSession } : {})} />, { exitOnCtrlC: false });
    await instance.waitUntilExit();
    return 0;
  } finally {
    try {
      await workspace.close();
    } finally {
      terminalSurface.restore();
    }
  }
}

function AlphionTui({ workspace, initialWorkspace, initialSession, initialMessages, initialCompaction, terminalLauncher }: Readonly<{ workspace: WorkspaceController; initialWorkspace: ActiveProjectSnapshot; initialSession?: AgentSessionContract; initialMessages: readonly ChatMessage[]; initialCompaction: CompactionProjection; terminalLauncher: TerminalLauncher }>): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const layout = selectWorkbenchLayout(stdout.columns ?? 80, stdout.rows ?? 24);
  const colorEnabled = process.env.NO_COLOR === undefined;
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(initialWorkspace);
  const [registeredProjects, setRegisteredProjects] = useState<readonly ProjectRecord[]>([]);
  const [backgroundRuns, setBackgroundRuns] = useState<Awaited<ReturnType<WorkspaceController["backgroundRuns"]>>>([]);
  const application = workspaceSnapshot.application;
  const projectRoot = workspaceSnapshot.project?.root ?? "无归属域";
  const [screen, setScreen] = useState<Screen>("workbench");
  const [section, setSection] = useState<WorkbenchSection>("home");
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [presets] = useState(() => application.providerPresets());
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<TuiNotice>();
  const [help, setHelp] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({});
  const [draft, setDraft] = useState<ProviderDraft>(() => presetDraft(presets[0]));
  const [runPrompt, setRunPrompt] = useState("");
  const [runAttachments, setRunAttachments] = useState<readonly ImageAttachmentRef[]>([]);
  const [runProviderId, setRunProviderId] = useState<string | undefined>();
  const [runSession, setRunSession] = useState<AgentSessionContract | undefined>(initialSession);
  const [runCommand, setRunCommand] = useState<RunViewCommand>();
  const [chatSession, setChatSession] = useState<AgentSessionContract | undefined>(initialSession);
  const [chatMessages, setChatMessages] = useState<readonly ChatMessage[]>(initialMessages);
  const [compaction, setCompaction] = useState<CompactionProjection>(initialCompaction);
  const [chatDraft, setChatDraft] = useState("");
  const [chatAttachments, setChatAttachments] = useState<readonly ImageAttachmentRef[]>([]);
  const drafts = useRef(new Map<string, string>());
  const attachmentDrafts = useRef(new Map<string, readonly ImageAttachmentRef[]>());
  const approval = useMemo(() => new TuiApprovalPort(), []);

  const refreshProjects = useCallback(async () => { const [values, running] = await Promise.all([workspace.projects.list(), workspace.backgroundRuns()]); setRegisteredProjects(values); setBackgroundRuns(running); return values; }, [workspace]);
  const selectWorkspace = useCallback(async (next: ActiveProjectSnapshot) => {
    drafts.current.set(tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id), chatDraft);
    attachmentDrafts.current.set(tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id), chatAttachments);
    const key = tuiDraftKey(next.project?.id); setWorkspaceSnapshot(next); setChatSession(undefined); setChatMessages([]); setChatDraft(drafts.current.get(key) ?? ""); setChatAttachments(attachmentDrafts.current.get(key) ?? []); setCompaction({ count: 0 }); setSection("sessions"); setError(""); await refreshProjects();
  }, [chatAttachments, chatDraft, chatSession?.id, refreshProjects, workspaceSnapshot.project?.id]);
  const activateProject = useCallback((projectId: string) => { void workspace.activate(projectId).then(selectWorkspace).catch((cause: unknown) => setError(safeError(cause))); }, [selectWorkspace, workspace]);

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
  const acceptRunSession = useCallback((session: AgentSessionContract) => { const oldKey = tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id); drafts.current.set(oldKey, chatDraft); attachmentDrafts.current.set(oldKey, chatAttachments); const key = tuiDraftKey(workspaceSnapshot.project?.id, session.id); setChatSession(session); setChatDraft(drafts.current.get(key) ?? chatDraft); setChatAttachments(attachmentDrafts.current.get(key) ?? chatAttachments); void session.compactionProjection().then(setCompaction); }, [chatAttachments, chatDraft, chatSession?.id, workspaceSnapshot.project?.id]);
  const finishRun = useCallback((answer: string) => {
    if (answer.trim()) setChatMessages((messages) => [...messages, { id: `assistant:${Date.now()}`, role: "assistant", content: answer }]);
    const completedSession = runSession ?? chatSession;
    if (completedSession) void completedSession.compactionProjection().then(setCompaction);
    setRunPrompt(""); setRunAttachments([]); setRunSession(undefined); setRunCommand(undefined); void refreshSnapshot();
  }, [chatSession, refreshSnapshot, runSession]);

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([refreshProfiles(), refreshSnapshot(), refreshProjects()]);
      } catch (cause) {
        setError(safeError(cause));
      }
    })();
  }, [application, refreshProfiles, refreshProjects, refreshSnapshot]);
  useEffect(() => { const timer = setInterval(() => { void workspace.backgroundRuns().then(setBackgroundRuns).catch(() => undefined); }, 1_000); timer.unref(); return () => clearInterval(timer); }, [workspace]);
  useEffect(() => { setNotice(undefined); }, [application, section]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { if (runPrompt) setRunCommand({ id: Date.now(), kind: "cancel" }); else exit(); return; }
    if (screen !== "workbench") return;
    if (section !== "home" && input === "?") { setHelp((value) => !value); return; }
    if (section !== "home" && input === "q") { exit(); return; }
    if (key.escape) { setHelp(false); setSection("home"); return; }
  });

  const current = profiles[selected];
  const activeProfile = profiles.find((profile) => profile.active);
  const showProviderTestFeedback = (feedback: ProviderTestFeedback): void => {
    if (feedback.tone === "error") { setNotice(undefined); setError(feedback.message); return; }
    setError(""); setNotice(feedback);
  };
  const beginRun = (prompt: string, session?: AgentSessionContract, images = chatAttachments) => {
    if (session) setChatSession(session);
    setChatMessages((messages) => [...messages, { id: `user:${Date.now()}`, role: "user", content: prompt, ...(images.length ? { attachments: images } : {}) }]);
    setRunPrompt(prompt || " "); setRunAttachments(images);
    setRunSession(session ?? chatSession);
    setRunProviderId(activeProfile?.id);
  };
  const submitChat = (value: string): boolean | void => {
    const action = resolveTuiInput(value, { hasSession: chatSession !== undefined, sessionIdle: !runPrompt, ...(runPrompt ? { activeRunId: "active-tui-run" } : {}) });
    if (action.kind === "message") {
      const path = droppedImagePath(action.content); if (path) { if (chatAttachments.length >= 8) { setError("每条消息最多 8 张图片。"); return false; } void application.attachments.importFile(path).then((image) => { setChatAttachments((items) => items.length >= 8 ? items : [...items, image]); setError(""); }).catch((cause: unknown) => setError(safeError(cause))); return false; }
      if (!activeProfile) { setError("请先配置并激活 Provider；当前输入已保留。"); setSection("providers"); return false; }
      if (runPrompt) { if (chatSession) setRunCommand({ id: Date.now(), kind: "follow-up", content: action.content, ...(chatAttachments.length ? { attachments: chatAttachments } : {}) }); else setError("会话尚未准备好。"); }
      else beginRun(action.content);
      return false;
    }
    if (action.kind === "fork") {
      if (!chatSession) { setError("/fork 需要当前会话；可使用 alphion tui --session <ID> 打开。"); return; }
      void forkTuiSession(chatSession, action.title, terminalLauncher).then((outcome) => setError(outcome.message)).catch((cause: unknown) => setError(safeError(cause)));
      return;
    }
    if (action.kind === "new") { const oldKey = tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id); const nextKey = tuiDraftKey(workspaceSnapshot.project?.id); drafts.current.set(oldKey, chatDraft); attachmentDrafts.current.set(oldKey, chatAttachments); setChatSession(undefined); setChatMessages([]); setChatDraft(drafts.current.get(nextKey) ?? ""); setChatAttachments(attachmentDrafts.current.get(nextKey) ?? []); setError(""); return; }
    if (action.kind === "new-project") { setError("正在创建或打开 Project…"); void workspace.openProject({ root: action.root, create: true, ...(action.name ? { name: action.name } : {}) }).then(selectWorkspace).catch((cause: unknown) => setError(safeError(cause))); return; }
    if (action.kind === "navigate") { setError(""); setSection(action.section); return; }
    if (action.kind === "steer" || action.kind === "follow-up" || action.kind === "cancel") { setRunCommand({ id: Date.now(), kind: action.kind, ...(action.kind === "cancel" ? {} : { content: action.content, ...(chatAttachments.length ? { attachments: chatAttachments } : {}) }) }); setError(""); return; }
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
  return <AppShell section={section} layout={layout} colorEnabled={colorEnabled} projectRoot={projectRoot} error={error} {...(notice ? { notice } : {})} help={help}>
    {section === "home" ? <ChatHome {...(activeProfile ? { activeProfile } : {})} messages={chatMessages} attachments={chatAttachments} draft={chatDraft} onDraftChange={(value) => { drafts.current.set(tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id), value); setChatDraft(value); }} onPasteImage={() => { if (chatAttachments.length >= 8) { setError("每条消息最多 8 张图片。"); return; } void readClipboardImage().then((input) => application.attachments.importBytes(input)).then((image) => setChatAttachments((items) => items.length >= 8 ? items : [...items, image])).catch((cause: unknown) => setError(safeError(cause))); }} onRemoveLastAttachment={() => setChatAttachments((items) => items.slice(0, -1))} compactionCount={compaction.count} activeBubble={runPrompt ? <RunView application={application} approval={approval} prompt={runPrompt} attachments={runAttachments} {...(runSession ? { session: runSession } : {})} {...(runProviderId ? { providerId: runProviderId } : {})} {...(runCommand ? { command: runCommand } : {})} compact={layout === "compact"} onSession={acceptRunSession} onAccepted={() => { setChatDraft(""); setChatAttachments([]); }} onCommandAccepted={(commandId) => { if (runCommand?.id === commandId) { setChatDraft(""); setChatAttachments([]); } }} onError={setError} onDone={finishRun} /> : null} compact={layout === "compact"} heightRows={Math.max(10, (stdout.rows ?? 24) - 2)} viewportRows={Math.max(4, (stdout.rows ?? 24) - (layout === "compact" ? 8 : 11))} contentWidth={Math.max(20, Math.min(88, (stdout.columns ?? 80) - 8))} slashContext={{ hasSession: chatSession !== undefined, sessionIdle: !runPrompt, ...(runPrompt ? { activeRunId: "active-tui-run" } : {}) }} onSubmit={submitChat} /> : null}
    {section === "settings" ? <SettingsCard onSelect={setSection} /> : null}
    {section === "projects" ? <ProjectCard projectRoot={projectRoot} projects={registeredProjects} backgroundRuns={backgroundRuns} {...(workspaceSnapshot.project ? { currentProjectId: workspaceSnapshot.project.id } : {})} onActivate={activateProject} /> : null}
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
      onTest={() => current && void application.providerTests.test(current.id).then((result) => showProviderTestFeedback(providerTestFeedback(result))).catch((cause: unknown) => { setNotice(undefined); setError(safeError(cause)); })}
      onTestAll={() => void application.providerTests.testAll().then((results) => showProviderTestFeedback(providerTestBatchFeedback(results))).catch((cause: unknown) => { setNotice(undefined); setError(safeError(cause)); })}
      onRun={() => current && setSection("home")}
      onExit={() => exit()}
    /> : null}
    {section === "sessions" ? <SessionWorkbenchView application={application} approval={approval} onSelect={(session, messages) => { const oldKey = tuiDraftKey(workspaceSnapshot.project?.id, chatSession?.id); const nextKey = tuiDraftKey(workspaceSnapshot.project?.id, session.id); drafts.current.set(oldKey, chatDraft); attachmentDrafts.current.set(oldKey, chatAttachments); setChatSession(session); setChatMessages(messages); setChatDraft(drafts.current.get(nextKey) ?? ""); setChatAttachments(attachmentDrafts.current.get(nextKey) ?? []); void session.compactionProjection().then(setCompaction); setSection("home"); }} onSend={(session, prompt) => beginRun(prompt, session)} onError={(cause) => setError(safeError(cause))} /> : null}
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

export function SessionWorkbenchView(props: Readonly<{ application: AgentApplication; approval: ApprovalPort; onSelect?: (session: AgentSessionContract, messages: readonly ChatMessage[]) => void; onSend: (session: AgentSessionContract, prompt: string) => void; onError: (cause: unknown) => void }>): React.JSX.Element {
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
    else if (key.return && current) void props.application.sessions.get(current.id).then(async (value) => { props.onSelect?.(value, chatMessagesFromView(await value.view())); }).catch(props.onError);
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
    <Text dimColor>↑↓ 选择 · Enter 打开 · n 创建 · o 查看 · i Shape · p reshape(空闲) · c checkout · s 发送 · t 转向 · f 后续 · r 刷新</Text>
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

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function safeError(value: unknown): string {
  return sanitizeTerminalText(value instanceof Error ? value.message : "TUI 发生未预期错误。");
}

function chatMessagesFromView(view: Awaited<ReturnType<AgentSessionContract["view"]>>): readonly ChatMessage[] { return view.entries.flatMap((item) => (item.message.kind === "user" || item.message.kind === "assistant") ? [{ id: item.id, role: item.message.kind, content: item.message.content, ...(item.message.kind === "user" && item.message.schemaVersion === 3 ? { attachments: item.message.attachments } : {}) }] : []); }
function tuiDraftKey(projectId?: string, sessionId?: string): string { return `${projectId ?? "unowned"}:${sessionId ?? "new"}`; }
function droppedImagePath(value: string): string | undefined { const path = value.trim().replace(/^("|')|("|')$/gu, ""); return /\.(png|jpe?g|webp|gif)$/iu.test(path) ? path : undefined; }
