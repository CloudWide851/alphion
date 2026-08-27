import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatSlashCommand, matchSlashCommands, parseSlashCommand, type SlashCommandContext } from "../../../ui/slash-commands.js";
import type { ImageAttachmentRef } from "../../../src/index.js";
import { AttachmentStrip } from "./attachment-strip.js";
import type { SurfaceClient } from "./surface-client.js";

export function SlashComposer(props: Readonly<{
  value: string;
  context: SlashCommandContext;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmitMessage: () => void;
  onCommand: (command: string) => void;
  client: SurfaceClient;
  attachments: readonly ImageAttachmentRef[];
  onFiles: (files: readonly File[]) => void;
  onRemoveAttachment: (id: string) => void;
}>): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const selectedRef = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const token = props.value.trimStart().split(/\s/u).slice(0, 2).join(" ");
  const matches = useMemo(() => props.value.startsWith("/") && !dismissed ? matchSlashCommands(props.value, props.context) : [], [dismissed, props.context, props.value]);
  useEffect(() => { selectedRef.current = 0; setSelected(0); setDismissed(false); }, [token]);
  const move = (offset: number) => { if (!matches.length) return; const next = (selectedRef.current + offset + matches.length) % matches.length; selectedRef.current = next; setSelected(next); };
  const run = (index = selectedRef.current) => {
    const match = matches[index];
    if (!match || !match.availability.available) return;
    const parsed = parseSlashCommand(props.value, props.context);
    const argument = parsed.kind === "command" && parsed.descriptor.id === match.descriptor.id ? parsed.argument : "";
    props.onCommand(formatSlashCommand(match.descriptor, argument));
  };
  const files = (value: FileList | null) => { if (value?.length) props.onFiles([...value].filter((file) => file.type.startsWith("image/"))); };
  return <div className="composer" onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); files(event.dataTransfer.files); }}>
    {matches.length ? <div className="slash-palette" role="listbox" aria-label="快捷命令">{matches.map((match, index) => <button type="button" role="option" aria-selected={index === selected} disabled={!match.availability.available} className={index === selected ? "slash-option selected" : "slash-option"} key={match.descriptor.id} onMouseDown={(event) => event.preventDefault()} onClick={() => run(index)}><strong>{formatSlashCommand(match.descriptor)}{match.descriptor.argumentHint ? ` ${match.descriptor.argumentHint}` : ""}</strong><span>{match.availability.reason ?? match.descriptor.description}</span></button>)}</div> : null}
    <AttachmentStrip attachments={props.attachments} client={props.client} removable onRemove={props.onRemoveAttachment} />
    <textarea aria-label="消息" placeholder="请输入内容…" value={props.value} onChange={(event) => props.onChange(event.target.value)} onPaste={(event) => files(event.clipboardData.files)} onKeyDown={(event) => {
      if (matches.length && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab")) { event.preventDefault(); move(event.key === "ArrowUp" ? -1 : 1); return; }
      if (matches.length && event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
      if (event.key === "Enter" && !event.altKey && !event.shiftKey) { event.preventDefault(); if (matches.length) run(); else if (props.value.trimStart().startsWith("/")) props.onCommand(props.value); else props.onSubmitMessage(); }
    }} />
    <input ref={picker} className="attachment-picker" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { files(event.target.files); event.target.value = ""; }} />
    <button type="button" className="attach-button" onClick={() => picker.current?.click()} aria-label="添加图片">＋图</button>
    <button disabled={props.disabled && !props.value.trimStart().startsWith("/")} onClick={() => props.value.trimStart().startsWith("/") ? props.onCommand(props.value) : props.onSubmitMessage()} aria-label="发送">↑</button>
    <span>{matches.length ? "↑/↓ 或 Tab 选择 · Enter 执行 · Esc 收起" : "Enter 发送 · Alt+Enter 换行"}</span>
  </div>;
}
