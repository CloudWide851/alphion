import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import katex from "katex";
import "katex/dist/katex.min.css";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../../../ui/markdown.js";
import type { CodeProjection } from "../../../ui/code-projection.js";
import { decodeUiEventFrame, decodeUiSurfaceSnapshot, type UiCommand, type UiCommandEnvelope, type UiCommandResult, type UiEventEnvelope, type UiSurfaceSnapshot } from "../../../ui/contracts.js";
import type { DesktopRendererBridge } from "../../../desktop/contracts.js";
import { forkAndSelectSession } from "../../../ui/session-actions.js";
import { parseNewProjectArguments, parseSlashCommand } from "../../../ui/slash-commands.js";
import { SlashComposer } from "./slash-palette.js";
import { createConversationRunState, createSubmittedConversationRunState, reduceConversationRun, type ConversationRunState } from "../../../ui/conversation-run.js";
import { AutomationPanel } from "./automation-panel.js";
import type { SurfaceClient } from "./surface-client.js";
import { useChatScroll } from "./chat-scroll.js";
import "./style.css";
import "./enhancements.css";

interface SessionItem { readonly id: string; readonly title: string; readonly revision: number; readonly status: string; readonly activeRunId?: string; }
interface ChatItem { readonly id: string; readonly role: "user" | "assistant"; readonly content: string; readonly run?: ConversationRunState; }
interface ApprovalChallenge { readonly requestId: string; readonly runId: string; readonly toolName: string; readonly actionDigest: string; readonly shapeDigest?: string; readonly summary: string; }
function App(): React.JSX.Element {
  const [csrf, setCsrf] = useState("");
  const [sessions, setSessions] = useState<readonly SessionItem[]>([]);
  const [active, setActive] = useState<SessionItem | undefined>();
  const [messages, setMessages] = useState<readonly ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("正在连接");
  const [settings, setSettings] = useState(false);
  const [projectPickerRequest, setProjectPickerRequest] = useState(0);
  const [approval, setApproval] = useState<ApprovalChallenge>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [surface, setSurface] = useState<Pick<UiSurfaceSnapshot, "project" | "compaction" | "goals" | "schedules" | "backgroundRuns">>({ goals: [], schedules: [], backgroundRuns: [] });
  const cursor = useRef(0);
  const selectedProjectId = useRef<string>();
  const activeRef = useRef<SessionItem>();
  const draftRef = useRef("");
  const drafts = useRef(new Map<string, string>());
  const scroll = useChatScroll(messages.length, messages.at(-1)?.content.length ?? 0, active?.id ?? "new");

  const desktop = window.alphionDesktop;
  const api = useMemo<SurfaceClient>(() => ({
    ready: desktop !== undefined || csrf !== "",
    execute: async (command: UiCommand): Promise<UiCommandResult> => {
      const envelope: UiCommandEnvelope = { schemaVersion: 1, requestId: requestId(), command };
      if (desktop) return desktop.invoke(envelope);
      const response = await fetch("/api/command", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-alphion-csrf": csrf }, body: JSON.stringify(envelope) });
      const value = await response.json() as UiCommandResult & { error?: { message?: string } };
      if (!response.ok) throw new UiApiError(response.status, value.error?.message ?? "命令失败");
      return value;
    },
    subscribe: (listener) => {
      if (desktop) return desktop.subscribe((frame) => listener(decodeUiEventFrame(frame)));
      const source = new EventSource(`/api/events?cursor=${cursor.current}`, { withCredentials: true });
      source.addEventListener("surface.frame", (event) => listener(decodeUiEventFrame(JSON.parse((event as MessageEvent<string>).data))));
      return () => source.close();
    },
    importProviderCredential: async (profileId, secret) => {
      if (desktop) return desktop.importProviderCredential(profileId, secret);
      const response = await fetch(`/api/secret/provider/${encodeURIComponent(profileId)}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-alphion-csrf": csrf }, body: JSON.stringify({ secret }) });
      if (!response.ok) throw new Error("凭据导入失败");
    },
    decideApproval: async (decision) => {
      if (desktop) return desktop.decideApproval(decision);
      const response = await fetch("/api/approval", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-alphion-csrf": csrf }, body: JSON.stringify(decision) });
      if (!response.ok) throw new Error("审批决定未被接受");
    },
  }), [csrf, desktop]);

  const showSession = useCallback(async (session: SessionItem): Promise<void> => {
    drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), draftRef.current);
    const result = await api.execute({ kind: "session.show", sessionId: session.id });
    const view = result.result as { session?: SessionItem };
    const current = view.session ?? session;
    setActive(current);
    activeRef.current = current;
    setActiveRunId(current.status === "running" ? current.activeRunId : undefined);
    const restored = drafts.current.get(draftKey(selectedProjectId.current, current.id)) ?? "";
    draftRef.current = restored; setDraft(restored);
    setSessions((items) => items.map((item) => item.id === current.id ? current : item));
    setMessages(sessionMessages(result.result));
  }, [api]);

  const reloadSessions = useCallback(async (preferredId?: string): Promise<void> => {
    const result = await api.execute({ kind: "surface.snapshot", ...(preferredId ? { selectedSessionId: preferredId } : {}) });
    const snapshot = decodeUiSurfaceSnapshot(result.result);
    cursor.current = Math.max(cursor.current, snapshot.cursor);
    const values: readonly SessionItem[] = snapshot.sessions;
    const previousProjectId = selectedProjectId.current; const previousSessionId = activeRef.current?.id;
    drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), draftRef.current);
    selectedProjectId.current = snapshot.selectedProjectId;
    setSurface({ ...(snapshot.project ? { project: snapshot.project } : {}), ...(snapshot.compaction ? { compaction: snapshot.compaction } : {}), goals: snapshot.goals, schedules: snapshot.schedules, backgroundRuns: snapshot.backgroundRuns });
    setSessions(values);
    const selected = values.find((item) => item.id === snapshot.selectedSessionId) ?? values[0];
    if (selected && snapshot.selectedView) { const next = snapshot.selectedView.session as SessionItem; setActive(next); activeRef.current = next; setActiveRunId(next.status === "running" ? next.activeRunId : undefined); const restored = drafts.current.get(draftKey(selectedProjectId.current, next.id)) ?? ""; draftRef.current = restored; setDraft(restored); const history = sessionMessages(snapshot.selectedView); setMessages((items) => previousProjectId === snapshot.selectedProjectId && previousSessionId === next.id ? preserveLiveAssistant(history, items) : history); }
    else if (selected) await showSession(selected); else { setActive(undefined); activeRef.current = undefined; setActiveRunId(undefined); const restored = drafts.current.get(draftKey(selectedProjectId.current)) ?? ""; draftRef.current = restored; setDraft(restored); setMessages([]); }
  }, [api, showSession]);

  useEffect(() => { if (desktop) { setStatus("已连接"); return; } void fetch("/api/bootstrap", { method: "POST" }).then((response) => response.json()).then((value: { csrf: string }) => { setCsrf(value.csrf); setStatus("已连接"); }); }, [desktop]);
  useEffect(() => {
    if (!api.ready) return;
    let watermark = cursor.current;
    let synchronized = false;
    const pending: UiEventEnvelope[] = [];
    const consumeEvent = (event: UiEventEnvelope) => {
      if (event.cursor <= watermark) return;
      cursor.current = globalThis.Math.max(cursor.current, event.cursor);
      const payload = event.payload;
      if (event.projectId && event.projectId !== selectedProjectId.current) {
        if (payload.kind === "run.finished" || payload.kind === "surface.invalidate") void reloadSessions(activeRef.current?.id);
        return;
      }
      if (payload.kind === "run.delta") setMessages((items) => appendAssistantDelta(items, payload.runId, payload.delta));
      else if (payload.kind === "run.finished") { setStatus(payload.status); setActiveRunId((value) => value === payload.runId ? undefined : value); setMessages((items) => finalizeAssistant(items, payload.runId, payload.status, payload.finalText)); void reloadSessions(payload.sessionId); }
      else if (payload.kind === "agent.event") setMessages((items) => applyAssistantEvent(items, payload.event));
      else if (payload.kind === "stream.resync-required") { setStatus("正在重新同步"); void reloadSessions().then(() => setStatus("已同步")); }
      else if (payload.kind === "surface.invalidate") { const preferred = payload.sessionIds.includes(active?.id ?? "") ? active?.id : undefined; void reloadSessions(preferred); }
      else if (payload.kind === "approval.challenge") setApproval(payload);
    };
    const unsubscribe = api.subscribe((frame) => { for (const event of frame.events) { if (synchronized) consumeEvent(event); else pending.push(event); } });
    void reloadSessions(active?.id).then(() => { watermark = cursor.current; synchronized = true; for (const event of pending.splice(0)) consumeEvent(event); });
    return unsubscribe;
  }, [active?.id, api, reloadSessions]);

  const send = async () => {
    const content = draft.trim(); if (!content || !api.ready) return;
    const submissionId = requestId(); const userId = requestId();
    draftRef.current = ""; drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), ""); setDraft(""); setStatus("准备上下文"); setMessages((items) => beginSubmittedMessages(items, userId, content, submissionId, active?.id));
    let session = active;
    try {
      if (!session) { const created = await api.execute({ kind: "session.create", title: content.slice(0, 80), idempotencyKey: requestId() }); session = created.result as SessionItem; setActive(session); activeRef.current = session; setSessions((items) => [session!, ...items]); }
      const result = await api.execute({ kind: "session.send", sessionId: session.id, message: content, expectedRevision: session.revision, idempotencyKey: requestId() });
      const runId = (result.result as { runId: string }).runId;
      setStatus("等待模型"); setActiveRunId(runId);
      setMessages((items) => startSubmittedRun(items, submissionId, runId, session!.id));
    } catch (error) {
      setStatus(error instanceof UiApiError && error.status === 409 ? "修订冲突，已刷新" : "发送失败");
      setMessages((items) => failSubmittedRun(items, submissionId, error instanceof Error ? error.message : "发送失败"));
      if (error instanceof UiApiError && error.status === 409 && session) await reloadSessions(session.id);
    }
  };

  const decideApproval = async (approved: boolean): Promise<void> => {
    if (!approval) return;
    try {
      await api.decideApproval({ requestId: approval.requestId, actionDigest: approval.actionDigest, ...(approval.shapeDigest ? { shapeDigest: approval.shapeDigest } : {}), approved });
    } finally { setApproval(undefined); }
  };
  const forkActive = async (): Promise<void> => {
    if (!active || active.status !== "idle") { setStatus("仅空闲 Session 可 fork"); return; }
    try {
      await forkAndSelectSession((command) => api.execute(command), active, requestId(), reloadSessions);
      setStatus("已切换到 Fork");
    } catch (error) { setStatus(error instanceof UiApiError && error.status === 409 ? "Session 已变化，请重试" : "Fork 失败"); }
  };
  const clearDraft = () => { draftRef.current = ""; drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), ""); setDraft(""); };
  const executeSlash = async (input: string): Promise<void> => {
    const parsed = parseSlashCommand(input, { hasSession: active !== undefined, sessionIdle: !activeRunId && active?.status === "idle", ...(activeRunId ? { activeRunId } : {}) });
    if (parsed.kind !== "command") { setStatus("未知快捷命令"); return; }
    if (!parsed.availability.available) { setStatus(parsed.availability.reason ?? "命令当前不可用"); return; }
    const id = parsed.descriptor.id;
    if (id === "new") { clearDraft(); drafts.current.set(draftKey(selectedProjectId.current), ""); setActive(undefined); activeRef.current = undefined; setMessages([]); setStatus("新对话"); return; }
    if (id === "new-project") { const project = parseNewProjectArguments(parsed.argumentTokens); clearDraft(); setStatus("正在创建 Project"); const result = await api.execute({ kind: "project.create", root: project.root, ...(project.name ? { name: project.name } : {}) }); setSettings(false); await reloadSessions(); setStatus(`已打开 ${(result.result as { name?: string }).name ?? "Project"} · 请选择 Session`); return; }
    if (id === "open-projects") { setSettings(true); setProjectPickerRequest((value) => value + 1); clearDraft(); setStatus("Project 选择器"); return; }
    if (id === "open-sessions") { setSettings(false); clearDraft(); setStatus("Session 选择器"); return; }
    if (["context", "goals", "goal", "schedules"].includes(id)) { setSettings(true); setStatus(`/${id}`); clearDraft(); return; }
    if (id === "fork") { clearDraft(); await forkActive(); return; }
    if (id === "cancel" && activeRunId) { await api.execute({ kind: "run.cancel", runId: activeRunId, reason: "Cancelled from slash command." }); clearDraft(); return; }
    if ((id === "steer" || id === "follow-up") && active) {
      if (!parsed.argument) { setStatus(`/${id} 需要消息参数`); return; }
      const shown = await api.execute({ kind: "session.show", sessionId: active.id }); const current = (shown.result as { session: SessionItem }).session;
      await api.execute({ kind: id === "steer" ? "session.steer" : "session.follow-up", sessionId: active.id, message: parsed.argument, expectedRevision: current.revision, idempotencyKey: requestId() });
      clearDraft(); setStatus(id === "steer" ? "已注入下一模型边界" : "后续消息已排队"); return;
    }
    const command: UiCommand | undefined = id === "profile" ? { kind: "project.inspect" }
      : id === "doctor" ? { kind: "doctor" }
      : id === "resources" ? { kind: "resource.list" }
      : id === "providers" ? { kind: "provider.list" }
      : id === "harness" ? { kind: "harness.plan", prompt: parsed.argument || "检查当前任务" }
      : undefined;
    if (id === "help") { setSettings(true); setStatus("命令面板可直接通过 / 打开"); clearDraft(); return; }
    if (!command) { setStatus(`/${id} 暂无可执行动作`); return; }
    setSettings(true); setStatus("正在执行命令"); await api.execute(command); clearDraft(); setStatus(`/${id} 已完成`);
  };

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img className="brand-mark" src="./alphion-icon.svg" alt="" /><span>Alphion</span></div><nav><button className="quiet" onClick={() => setSettings((value) => !value)}>管理</button><Info text="Alphion 只在本机 127.0.0.1 提供服务；修改依赖 revision 与幂等键。" /></nav></header>
    <aside className="rail"><span className="rail-label">Sessions</span>{sessions.map((session) => <button className={session.id === active?.id ? "session active" : "session"} key={session.id} onClick={() => void showSession(session)}>{session.title}<small>{session.status}</small></button>)}<button className="new-session" onClick={() => { drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), draftRef.current); setActive(undefined); activeRef.current = undefined; setMessages([]); const restored = drafts.current.get(draftKey(selectedProjectId.current)) ?? ""; draftRef.current = restored; setDraft(restored); }}>＋ 新对话</button>{surface.backgroundRuns.length ? <><span className="rail-label">后台运行</span>{surface.backgroundRuns.map((run) => <span className="background-run" key={`${run.projectId}:${run.runId}`}>{run.projectName}<small>{run.title}</small></span>)}</> : null}</aside>
    <main className="conversation">
      <div className="conversation-head"><h1>{active?.title ?? "新对话"}</h1><div><button className="quiet" disabled={!active || active.status !== "idle"} onClick={() => void forkActive()}>Fork</button><span className="connection"><i />{status}</span></div></div>
      {settings ? <SettingsPanel client={api} {...(active ? { sessionId: active.id } : {})} surface={surface} sessions={sessions} projectPickerRequest={projectPickerRequest} onProjectActivated={() => { setSettings(false); void reloadSessions(); }} /> : null}
      {approval ? <ApprovalCard challenge={approval} onDecide={(approved) => void decideApproval(approved)} /> : null}
      <section className="messages" ref={scroll.viewportRef} onScroll={scroll.onScroll} aria-live="polite">{messages.length === 0 ? <EmptyState /> : messages.map((message) => <article className={`message ${message.role} ${message.run?.status ?? ""}`} key={message.id}><span className="speaker">{message.role === "assistant" ? "Alphion" : "你"}</span>{message.run?.status === "waiting" && !message.content ? <WaitingDots /> : <div className={message.run?.status === "streaming" ? "stream-content" : undefined}><Markdown content={message.content || message.run?.statusText || "…"} /></div>}{message.run ? <RunMeta run={message.run} /> : null}</article>)}{scroll.unseenCount ? <button className="new-message" onClick={scroll.returnToLatest}>{scroll.unseenCount} 条新消息 · 返回最新</button> : null}</section>
      <SlashComposer value={draft} context={{ hasSession: active !== undefined, sessionIdle: !activeRunId && active?.status === "idle", ...(activeRunId ? { activeRunId } : {}) }} disabled={!api.ready} onChange={(value) => { draftRef.current = value; drafts.current.set(draftKey(selectedProjectId.current, activeRef.current?.id), value); setDraft(value); }} onSubmitMessage={() => void send()} onCommand={(command) => void executeSlash(command).catch(() => setStatus("命令执行失败"))} />
    </main>
  </div>;
}

function EmptyState(): React.JSX.Element { return <div className="empty"><img className="glyph" src="./alphion-icon.svg" alt="Alphion" /><h1>Alphion</h1><Info text="直接描述任务。项目、Session、Provider 与资源可在设置中管理。" /></div>; }
function WaitingDots(): React.JSX.Element { return <span className="waiting-dots" role="status" aria-label="等待模型输出"><i /><i /><i /></span>; }
function RunMeta({ run }: Readonly<{ run: ConversationRunState }>): React.JSX.Element { return <small className="run-meta">{run.statusText}{run.usage.inputTokens || run.usage.outputTokens ? ` · tokens ${run.usage.inputTokens}/${run.usage.outputTokens}` : ""}</small>; }
function Info({ text }: Readonly<{ text: string }>): React.JSX.Element { return <details className="info"><summary aria-label="说明">!</summary><div>{text}</div></details>; }
function SettingsPanel({ client, sessionId, surface, sessions, projectPickerRequest, onProjectActivated }: Readonly<{ client: SurfaceClient; sessionId?: string; surface: Pick<UiSurfaceSnapshot, "compaction" | "goals" | "schedules">; sessions: readonly SessionItem[]; projectPickerRequest: number; onProjectActivated: () => void }>): React.JSX.Element {
  const [diagnostic, setDiagnostic] = useState("选择一项查看");
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const [providers, setProviders] = useState<readonly { id: string; name: string; model: string }[]>([]);
  const loadProjects = () => void client.execute({ kind: "project.list" }).then((result) => { const items = result.result as readonly { id: string; name: string }[]; setProjects(items); setDiagnostic(items.length ? "选择 Project 进行切换" : "尚未注册 Project"); });
  const loadProviders = () => void client.execute({ kind: "provider.list" }).then((result) => { const items = result.result as readonly { id: string; name: string; model: string }[]; setProviders(items); setDiagnostic(items.length ? "Provider 实测会发送真实请求并可能产生费用" : "尚未配置 Provider"); });
  const testProvider = (profileId: string) => void client.execute({ kind: "provider.test", profileId }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)));
  useEffect(() => { if (projectPickerRequest > 0) loadProjects(); }, [projectPickerRequest]);
  return <section className="settings-panel">
    <div className="settings-actions"><button onClick={loadProjects}>Projects</button><button onClick={loadProviders}>Provider</button><button onClick={() => void client.execute({ kind: "resource.list" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>资源</button><button onClick={() => void client.execute({ kind: "doctor" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>doctor</button></div>
    {projects.length ? <div className="project-list">{projects.map((project) => <button key={project.id} onClick={() => void client.execute({ kind: "project.activate", projectId: project.id }).then(() => { setProjects([]); setDiagnostic(`已切换至 ${project.name}`); onProjectActivated(); })}>{project.name}</button>)}</div> : null}
    {providers.length ? <div className="project-list">{providers.map((profile) => <button key={profile.id} onClick={() => testProvider(profile.id)}>测试 {profile.name}</button>)}<button onClick={() => void client.execute({ kind: "provider.test-all" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>一键测试全部</button></div> : null}
    <pre>{diagnostic}</pre><AutomationPanel client={client} {...(sessionId ? { sessionId } : {})} {...(surface.compaction ? { compaction: surface.compaction } : {})} goals={surface.goals} schedules={surface.schedules} sessions={sessions} reload={onProjectActivated} /><CredentialForm client={client} /><Info text="API Key 通过 Project 独立密钥保护并经一次性表单提交；Provider 实测会发送真实请求并可能产生费用。输入不会写入浏览器存储。" />
  </section>;
}

function CredentialForm({ client }: Readonly<{ client: SurfaceClient }>): React.JSX.Element {
  const profile = useRef<HTMLInputElement>(null); const secret = useRef<HTMLInputElement>(null); const [status, setStatus] = useState("");
  useEffect(() => () => { if (profile.current) profile.current.value = ""; if (secret.current) secret.current.value = ""; }, []);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const profileId = profile.current?.value.trim() ?? ""; const value = secret.current?.value ?? ""; try { await client.importProviderCredential(profileId, value); setStatus("凭据已导入"); } catch { setStatus("凭据导入失败"); } finally { if (profile.current) profile.current.value = ""; if (secret.current) secret.current.value = ""; } };
  return <form className="credential" onSubmit={(event) => void submit(event)}><input ref={profile} aria-label="Provider Profile ID" placeholder="Profile ID" autoComplete="off" required /><input ref={secret} aria-label="Provider API Key" placeholder="API Key" type="password" autoComplete="off" required /><button type="submit">导入凭据</button><span role="status">{status}</span></form>;
}

function ApprovalCard({ challenge, onDecide }: Readonly<{ challenge: ApprovalChallenge; onDecide: (approved: boolean) => void }>): React.JSX.Element { return <section className="approval" role="alertdialog" aria-label="工具审批"><strong>{challenge.toolName}</strong><p>{challenge.summary}</p><code>{challenge.actionDigest}</code><div><button onClick={() => onDecide(false)}>拒绝</button><button className="approve" onClick={() => onDecide(true)}>允许一次</button></div></section>; }

function Markdown({ content }: Readonly<{ content: string }>): React.JSX.Element { return <div className="markdown">{parseMarkdown(content).blocks.map((block, index) => <Block key={index} block={block} />)}</div>; }
function Block({ block }: Readonly<{ block: MarkdownBlock }>): React.JSX.Element { switch (block.kind) { case "paragraph": return <p>{inline(block.children)}</p>; case "heading": return React.createElement(`h${block.level}`, {}, inline(block.children)); case "code": return <CodeBlock projection={block.projection} />; case "math": return <MathFragment value={block.value} display />; case "quote": return <blockquote>{block.children.map((child, index) => <Block key={index} block={child} />)}</blockquote>; case "list": return block.ordered ? <ol>{block.items.map((item, index) => <li key={index}>{item.checked === undefined ? null : <input type="checkbox" checked={item.checked} readOnly />}{inline(item.children)}</li>)}</ol> : <ul>{block.items.map((item, index) => <li key={index}>{item.checked === undefined ? null : <input type="checkbox" checked={item.checked} readOnly />}{inline(item.children)}</li>)}</ul>; case "table": return <div className="table-scroll"><table><thead><tr>{block.header.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>; case "rule": return <hr />; } }
function CodeBlock({ projection }: Readonly<{ projection: CodeProjection }>): React.JSX.Element { const [expanded, setExpanded] = useState(false); const tokens = projection.closed && (expanded || !projection.truncated) ? projection.tokens : [{ kind: "plain", value: projection.preview }]; return <section className="code-block"><header><span>{projection.language ?? "text"} · {projection.originalLines} lines{projection.closed ? "" : " · streaming"}</span><button onClick={() => void navigator.clipboard.writeText(projection.code)} aria-label="复制代码">复制</button></header><pre><code>{tokens.map((token, index) => <span className={`tok-${token.kind}`} key={index}>{token.value}</span>)}</code></pre>{projection.truncated ? <button className="code-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : `已截断 · ${projection.originalCharacters} chars`}</button> : null}<small>{projection.digest.slice(0, 12)}</small></section>; }
function inline(items: readonly MarkdownInline[]): React.ReactNode { return items.map((item, index) => { switch (item.kind) { case "text": return item.value; case "break": return <br key={index} />; case "code": return <code key={index}>{item.value}</code>; case "math": return <MathFragment key={index} value={item.value} />; case "link": return <a key={index} href={item.href} onClick={(event) => openExternal(event, item.href, item.domain)} rel="noreferrer">{inline(item.children)} <span aria-label={`域名 ${item.domain}`}>↗</span></a>; case "strong": return <strong key={index}>{inline(item.children)}</strong>; case "emphasis": return <em key={index}>{inline(item.children)}</em>; } }); }
function MathFragment({ value, display = false }: Readonly<{ value: string; display?: boolean }>): React.JSX.Element { const ref = useRef<HTMLSpanElement>(null); useEffect(() => { if (ref.current) katex.render(value, ref.current, { displayMode: display, throwOnError: false, strict: "error", trust: false }); }, [display, value]); return <span className={display ? "math-block" : "math-inline"} ref={ref} />; }

function beginSubmittedMessages(items: readonly ChatItem[], userId: string, content: string, submissionId: string, sessionId?: string): readonly ChatItem[] { return [...items, { id: userId, role: "user", content }, { id: `pending:${submissionId}`, role: "assistant", content: "", run: createSubmittedConversationRunState(submissionId, sessionId) }]; }
function startSubmittedRun(items: readonly ChatItem[], submissionId: string, runId: string, sessionId: string): readonly ChatItem[] { return items.map((item) => item.id === `pending:${submissionId}` ? { ...item, id: runId, run: createConversationRunState(runId, sessionId) } : item); }
function failSubmittedRun(items: readonly ChatItem[], submissionId: string, message: string): readonly ChatItem[] { return items.map((item) => item.id === `pending:${submissionId}` ? updateRunItem(item, { kind: "error", message }) : item); }
function appendAssistantDelta(items: readonly ChatItem[], runId: string, delta: string): readonly ChatItem[] { const index = items.findIndex((item) => item.id === runId); if (index < 0) { const run = reduceConversationRun(createConversationRunState(runId, "unknown"), { kind: "delta", delta }); return [...items, { id: runId, role: "assistant", content: run.text, run }]; } return items.map((item) => item.id === runId ? updateRunItem(item, { kind: "delta", delta }) : item); }
function applyAssistantEvent(items: readonly ChatItem[], event: Extract<UiEventEnvelope["payload"], { kind: "agent.event" }>["event"]): readonly ChatItem[] { if ("delivery" in event) return items; const index = items.findIndex((item) => item.id === event.runId); if (index < 0) { const run = reduceConversationRun(createConversationRunState(event.runId, event.sessionId), { kind: "agent-event", event }); return [...items, { id: event.runId, role: "assistant", content: run.text, run }]; } return items.map((item) => item.id === event.runId ? updateRunItem(item, { kind: "agent-event", event }) : item); }
function finalizeAssistant(items: readonly ChatItem[], runId: string, status: string, finalText: string): readonly ChatItem[] { return items.map((item) => item.id === runId ? updateRunItem(item, { kind: "finish", status, finalText }) : item); }
function updateRunItem(item: ChatItem, action: Parameters<typeof reduceConversationRun>[1]): ChatItem { const run = reduceConversationRun(item.run ?? createConversationRunState(item.id, "unknown"), action); return { ...item, content: run.text, run }; }
function sessionMessages(value: unknown): readonly ChatItem[] { const entries = (value as { entries?: Array<{ id: string; message: { kind: string; content?: string } }> }).entries ?? []; return entries.filter((entry) => (entry.message.kind === "user" || entry.message.kind === "assistant") && typeof entry.message.content === "string").map((entry) => ({ id: entry.id, role: entry.message.kind as "user" | "assistant", content: entry.message.content ?? "" })); }
function preserveLiveAssistant(history: readonly ChatItem[], current: readonly ChatItem[]): readonly ChatItem[] { const live = current.filter((item) => item.role === "assistant" && item.run && ["waiting", "streaming", "tool"].includes(item.run.status)); return [...history, ...live.filter((item) => !history.some((entry) => entry.id === item.id))]; }
function requestId(): string { return `web_${crypto.randomUUID().replaceAll("-", "")}`; }
function draftKey(projectId?: string, sessionId?: string): string { return `${projectId ?? "unowned"}:${sessionId ?? "new"}`; }
function openExternal(event: React.MouseEvent<HTMLAnchorElement>, href: string, domain: string): void { event.preventDefault(); if (!confirm(`打开外部链接 ${domain}？`)) return; const desktop = (window as Window & { alphionDesktop?: { openExternal(href: string): Promise<boolean> } }).alphionDesktop; if (desktop) void desktop.openExternal(href); else window.open(href, "_blank", "noopener,noreferrer"); }
class UiApiError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = "UiApiError"; } }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

declare global { interface Window { readonly alphionDesktop?: DesktopRendererBridge } }
