import React, { useEffect, useRef, useState } from "react";
import type { ImageAttachmentRef } from "../../../src/index.js";
import type { SurfaceClient } from "./surface-client.js";

export function AttachmentStrip(props: Readonly<{ attachments: readonly ImageAttachmentRef[]; client: SurfaceClient; removable?: boolean; onRemove?: (id: string) => void }>): React.JSX.Element | null {
  if (!props.attachments.length) return null;
  return <div className="attachment-strip" aria-label="图片附件">{props.attachments.map((ref, index) => <AttachmentThumb key={ref.id} refValue={ref} client={props.client} label={`图片 ${index + 1}`} removable={props.removable} onRemove={props.onRemove} />)}</div>;
}
function AttachmentThumb(props: Readonly<{ refValue: ImageAttachmentRef; client: SurfaceClient; label: string; removable?: boolean; onRemove?: (id: string) => void }>): React.JSX.Element {
  const [url, setUrl] = useState<string>(); const current = useRef<string>();
  useEffect(() => { let active = true; void props.client.readAttachment(props.refValue).then((bytes) => { if (!active) return; const buffer = new ArrayBuffer(bytes.byteLength); new Uint8Array(buffer).set(bytes); const next = URL.createObjectURL(new Blob([buffer], { type: props.refValue.mediaType })); current.current = next; setUrl(next); }).catch(() => undefined); return () => { active = false; if (current.current) URL.revokeObjectURL(current.current); }; }, [props.client, props.refValue]);
  return <figure className="attachment-thumb">{url ? <img src={url} alt={`${props.label}：${props.refValue.fileName}`} /> : <span aria-label={`${props.label} 正在加载`}>▧</span>}<figcaption>{props.refValue.fileName}</figcaption>{props.removable ? <button type="button" aria-label={`移除 ${props.refValue.fileName}`} onClick={() => props.onRemove?.(props.refValue.id)}>×</button> : null}</figure>;
}
