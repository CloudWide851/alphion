import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import katex from "katex";
import "katex/dist/katex.min.css";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "../../../ui/markdown.js";
import type { UiCommand, UiCommandEnvelope, UiCommandResult, UiEventEnvelope } from "../../../ui/contracts.js";
import type { DesktopApprovalDecision, DesktopRendererBridge } from "../../../desktop/contracts.js";
import "./style.css";
import "./enhancements.css";

interface SessionItem { readonly id: string; readonly title: string; readonly revision: number; readonly status: string; }
interface ChatItem { readonly id: string; readonly role: "user" | "assistant"; readonly content: string; }
interface ApprovalChallenge { readonly requestId: string; readonly runId: string; readonly toolName: string; readonly actionDigest: string; readonly shapeDigest?: string; readonly summary: string; }
interface SurfaceClient {
  readonly ready: boolean;
  execute(command: UiCommand): Promise<UiCommandResult>;
  subscribe(listener: (event: UiEventEnvelope) => void): () => void;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(decision: DesktopApprovalDecision): Promise<void>;
}

function App(): React.JSX.Element {
  const [csrf, setCsrf] = useState("");
  const [sessions, setSessions] = useState<readonly SessionItem[]>([]);
  const [active, setActive] = useState<SessionItem | undefined>();
  const [messages, setMessages] = useState<readonly ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("正在连接");
  const [settings, setSettings] = useState(false);
  const [approval, setApproval] = useState<ApprovalChallenge>();
  const cursor = useRef(0);

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
      if (desktop) return desktop.subscribe(listener);
      const source = new EventSource(`/api/events?cursor=${cursor.current}`, { withCredentials: true });
      for (const kind of ["run.delta", "run.finished", "agent.event", "stream.resync-required", "approval.challenge"]) source.addEventListener(kind, (event) => listener(JSON.parse((event as MessageEvent<string>).data) as UiEventEnvelope));
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
    const result = await api.execute({ kind: "session.show", sessionId: session.id });
    const view = result.result as { session?: SessionItem };
    const current = view.session ?? session;
    setActive(current);
    setSessions((items) => items.map((item) => item.id === current.id ? current : item));
    setMessages(sessionMessages(result.result));
  }, [api]);

  const reloadSessions = useCallback(async (preferredId?: string): Promise<void> => {
    const result = await api.execute({ kind: "session.list" });
    const values = result.result as SessionItem[];
    setSessions(values);
    const selected = values.find((item) => item.id === preferredId) ?? values[0];
    if (selected) await showSession(selected); else { setActive(undefined); setMessages([]); }
  }, [api, showSession]);

  useEffect(() => { if (desktop) { setStatus("已连接"); return; } void fetch("/api/bootstrap", { method: "POST" }).then((response) => response.json()).then((value: { csrf: string }) => { setCsrf(value.csrf); setStatus("已连接"); }); }, [desktop]);
  useEffect(() => { if (!api.ready) return; void reloadSessions(); }, [api.ready, reloadSessions]);
  useEffect(() => {
    if (!api.ready) return;
    const consumeEvent = (event: UiEventEnvelope) => {
      cursor.current = Math.max(cursor.current, event.cursor);
      if (event.payload.kind === "run.delta") setMessages((items) => appendAssistantDelta(items, event.payload.runId, event.payload.delta));
      else if (event.payload.kind === "run.finished") { setStatus(event.payload.status); setMessages((items) => finalizeAssistant(items, event.payload.runId, event.payload.finalText)); void reloadSessions(event.payload.sessionId); }
      else if (event.payload.kind === "stream.resync-required") { setStatus("正在重新同步"); void reloadSessions().then(() => setStatus("已同步")); }
      else if (event.payload.kind === "approval.challenge") setApproval(event.payload);
    };
    return api.subscribe(consumeEvent);
  }, [api, reloadSessions]);

  const send = async () => {
    const content = draft.trim(); if (!content || !api.ready) return;
    let session = active;
    if (!session) { const created = await api.execute({ kind: "session.create", title: content.slice(0, 80), idempotencyKey: requestId() }); session = created.result as SessionItem; setActive(session); setSessions((items) => [session!, ...items]); }
    try {
      const result = await api.execute({ kind: "session.send", sessionId: session.id, message: content, expectedRevision: session.revision, idempotencyKey: requestId() });
      const runId = (result.result as { runId: string }).runId;
      setDraft(""); setStatus("运行中");
      setMessages((items) => [...items, { id: requestId(), role: "user", content }, { id: runId, role: "assistant", content: "" }]);
    } catch (error) {
      setStatus(error instanceof UiApiError && error.status === 409 ? "修订冲突，已刷新" : "发送失败");
      if (error instanceof UiApiError && error.status === 409) await reloadSessions(session.id);
    }
  };

  const decideApproval = async (approved: boolean): Promise<void> => {
    if (!approval) return;
    try {
      await api.decideApproval({ requestId: approval.requestId, actionDigest: approval.actionDigest, ...(approval.shapeDigest ? { shapeDigest: approval.shapeDigest } : {}), approved });
    } finally { setApproval(undefined); }
  };

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">A</span><span>Alphion</span></div><nav><button className="quiet" onClick={() => setSettings((value) => !value)}>设置</button><Info text="Alphion 只在本机 127.0.0.1 提供服务；修改依赖 revision 与幂等键。" /></nav></header>
    <aside className="rail"><span className="rail-label">Sessions</span>{sessions.map((session) => <button className={session.id === active?.id ? "session active" : "session"} key={session.id} onClick={() => void showSession(session)}>{session.title}<small>{session.status}</small></button>)}<button className="new-session" onClick={() => { setActive(undefined); setMessages([]); }}>＋ 新对话</button></aside>
    <main className="conversation">
      <div className="conversation-head"><h1>{active?.title ?? "新对话"}</h1><span className="connection"><i />{status}</span></div>
      {settings ? <SettingsPanel client={api} onProjectActivated={() => void reloadSessions()} /> : null}
      {approval ? <ApprovalCard challenge={approval} onDecide={(approved) => void decideApproval(approved)} /> : null}
      <section className="messages" aria-live="polite">{messages.length === 0 ? <EmptyState /> : messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="speaker">{message.role === "assistant" ? "Alphion" : "你"}</span><Markdown content={message.content || "…"} /></article>)}</section>
      <div className="composer"><textarea aria-label="消息" placeholder="输入消息…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.altKey && !event.shiftKey) { event.preventDefault(); void send(); } }} /><button onClick={() => void send()} aria-label="发送">↑</button><span>Enter 发送 · Alt+Enter 换行</span></div>
    </main>
  </div>;
}

function EmptyState(): React.JSX.Element { return <div className="empty"><div className="glyph">A</div><h1>Alphion</h1><Info text="直接描述任务。项目、Session、Provider 与资源可在设置中管理。" /></div>; }
function Info({ text }: Readonly<{ text: string }>): React.JSX.Element { return <details className="info"><summary aria-label="说明">!</summary><div>{text}</div></details>; }
function SettingsPanel({ client, onProjectActivated }: Readonly<{ client: SurfaceClient; onProjectActivated: () => void }>): React.JSX.Element {
  const [diagnostic, setDiagnostic] = useState("选择一项查看");
  const [projects, setProjects] = useState<readonly { id: string; name: string }[]>([]);
  const loadProjects = () => void client.execute({ kind: "project.list" }).then((result) => { const items = result.result as readonly { id: string; name: string }[]; setProjects(items); setDiagnostic(items.length ? "选择 Project 进行切换" : "尚未注册 Project"); });
  return <section className="settings-panel"><div className="settings-actions"><button onClick={loadProjects}>Projects</button><button onClick={() => void client.execute({ kind: "provider.list" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>Provider</button><button onClick={() => void client.execute({ kind: "resource.list" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>资源</button><button onClick={() => void client.execute({ kind: "doctor" }).then((result) => setDiagnostic(JSON.stringify(result.result, null, 2)))}>doctor</button></div>{projects.length ? <div className="project-list">{projects.map((project) => <button key={project.id} onClick={() => void client.execute({ kind: "project.activate", projectId: project.id }).then(() => { setProjects([]); setDiagnostic(`已切换至 ${project.name}`); onProjectActivated(); })}>{project.name}</button>)}</div> : null}<pre>{diagnostic}</pre><CredentialForm client={client} /><Info text="敏感凭据通过独立的一次性表单提交；无论成功或失败，输入都会立即清空，且不会写入浏览器存储。" /></section>;
}

function CredentialForm({ client }: Readonly<{ client: SurfaceClient }>): React.JSX.Element {
  const profile = useRef<HTMLInputElement>(null); const secret = useRef<HTMLInputElement>(null); const [status, setStatus] = useState("");
  useEffect(() => () => { if (profile.current) profile.current.value = ""; if (secret.current) secret.current.value = ""; }, []);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const profileId = profile.current?.value.trim() ?? ""; const value = secret.current?.value ?? ""; try { await client.importProviderCredential(profileId, value); setStatus("凭据已导入"); } catch { setStatus("凭据导入失败"); } finally { if (profile.current) profile.current.value = ""; if (secret.current) secret.current.value = ""; } };
  return <form className="credential" onSubmit={(event) => void submit(event)}><input ref={profile} aria-label="Provider Profile ID" placeholder="Profile ID" autoComplete="off" required /><input ref={secret} aria-label="Provider API Key" placeholder="API Key" type="password" autoComplete="off" required /><button type="submit">导入凭据</button><span role="status">{status}</span></form>;
}

function ApprovalCard({ challenge, onDecide }: Readonly<{ challenge: ApprovalChallenge; onDecide: (approved: boolean) => void }>): React.JSX.Element { return <section className="approval" role="alertdialog" aria-label="工具审批"><strong>{challenge.toolName}</strong><p>{challenge.summary}</p><code>{challenge.actionDigest}</code><div><button onClick={() => onDecide(false)}>拒绝</button><button className="approve" onClick={() => onDecide(true)}>允许一次</button></div></section>; }

function Markdown({ content }: Readonly<{ content: string }>): React.JSX.Element { return <div className="markdown">{parseMarkdown(content).blocks.map((block, index) => <Block key={index} block={block} />)}</div>; }
function Block({ block }: Readonly<{ block: MarkdownBlock }>): React.JSX.Element { switch (block.kind) { case "paragraph": return <p>{inline(block.children)}</p>; case "heading": return React.createElement(`h${block.level}`, {}, inline(block.children)); case "code": return <pre><code>{block.value}</code></pre>; case "math": return <Math value={block.value} display />; case "quote": return <blockquote>{block.children.map((child, index) => <Block key={index} block={child} />)}</blockquote>; case "list": return block.ordered ? <ol>{block.items.map((item, index) => <li key={index}>{item.checked === undefined ? null : <input type="checkbox" checked={item.checked} readOnly />}{inline(item.children)}</li>)}</ol> : <ul>{block.items.map((item, index) => <li key={index}>{item.checked === undefined ? null : <input type="checkbox" checked={item.checked} readOnly />}{inline(item.children)}</li>)}</ul>; case "table": return <div className="table-scroll"><table><thead><tr>{block.header.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>; case "rule": return <hr />; } }
function inline(items: readonly MarkdownInline[]): React.ReactNode { return items.map((item, index) => { if (item.kind === "text") return item.value; if (item.kind === "break") return <br key={index} />; if (item.kind === "code") return <code key={index}>{item.value}</code>; if (item.kind === "math") return <Math key={index} value={item.value} />; if (item.kind === "link") return <a key={index} href={item.href} onClick={(event) => openExternal(event, item.href, item.domain)} rel="noreferrer">{inline(item.children)} <span aria-label={`域名 ${item.domain}`}>↗</span></a>; if (item.kind === "strong") return <strong key={index}>{inline(item.children)}</strong>; return <em key={index}>{inline(item.children)}</em>; }); }
function Math({ value, display = false }: Readonly<{ value: string; display?: boolean }>): React.JSX.Element { const ref = useRef<HTMLSpanElement>(null); useEffect(() => { if (ref.current) katex.render(value, ref.current, { displayMode: display, throwOnError: false, strict: "error", trust: false }); }, [display, value]); return <span className={display ? "math-block" : "math-inline"} ref={ref} />; }

function appendAssistantDelta(items: readonly ChatItem[], runId: string, delta: string): readonly ChatItem[] { const index = items.findIndex((item) => item.id === runId); if (index < 0) return [...items, { id: runId, role: "assistant", content: delta }]; return items.map((item) => item.id === runId ? { ...item, content: item.content + delta } : item); }
function finalizeAssistant(items: readonly ChatItem[], runId: string, finalText: string): readonly ChatItem[] { return items.map((item) => item.id === runId && !item.content ? { ...item, content: finalText } : item); }
function sessionMessages(value: unknown): readonly ChatItem[] { const entries = (value as { entries?: Array<{ id: string; message: { kind: string; content?: string } }> }).entries ?? []; return entries.filter((entry) => (entry.message.kind === "user" || entry.message.kind === "assistant") && typeof entry.message.content === "string").map((entry) => ({ id: entry.id, role: entry.message.kind as "user" | "assistant", content: entry.message.content ?? "" })); }
function requestId(): string { return `web_${crypto.randomUUID().replaceAll("-", "")}`; }
function openExternal(event: React.MouseEvent<HTMLAnchorElement>, href: string, domain: string): void { event.preventDefault(); if (!confirm(`打开外部链接 ${domain}？`)) return; const desktop = (window as Window & { alphionDesktop?: { openExternal(href: string): Promise<boolean> } }).alphionDesktop; if (desktop) void desktop.openExternal(href); else window.open(href, "_blank", "noopener,noreferrer"); }
class UiApiError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = "UiApiError"; } }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

declare global { interface Window { readonly alphionDesktop?: DesktopRendererBridge } }
