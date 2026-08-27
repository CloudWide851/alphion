import type { DesktopApprovalDecision, DesktopRendererBridge } from "../../../desktop/contracts.js";
import type { ImageAttachmentRef } from "../../../src/index.js";
import { decodeUiEventFrame, type UiCommand, type UiCommandEnvelope, type UiCommandResult, type UiEventFrame } from "../../../ui/contracts.js";

export interface SurfaceClient {
  readonly ready: boolean;
  execute(command: UiCommand): Promise<UiCommandResult>;
  subscribe(listener: (frame: UiEventFrame) => void): () => void;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(decision: DesktopApprovalDecision): Promise<void>;
  importAttachment(file: File): Promise<ImageAttachmentRef>;
  readAttachment(ref: ImageAttachmentRef): Promise<Uint8Array>;
}

export function createSurfaceClient(desktop: DesktopRendererBridge | undefined, csrf: string, cursor: Readonly<{ current: number }>): SurfaceClient {
  return Object.freeze({
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
    importAttachment: async (file) => {
      if (desktop) return desktop.importAttachment(file.name, new Uint8Array(await file.arrayBuffer()));
      const response = await fetch("/api/attachment", { method: "POST", credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream", "x-alphion-csrf": csrf, "x-alphion-file-name": encodeURIComponent(file.name) }, body: file });
      if (!response.ok) throw new Error("图片导入失败"); return response.json() as Promise<ImageAttachmentRef>;
    },
    readAttachment: async (ref) => {
      if (desktop) return (await desktop.readAttachment(ref.id)).bytes;
      const response = await fetch(`/api/attachment/${encodeURIComponent(ref.id)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("图片读取失败"); return new Uint8Array(await response.arrayBuffer());
    },
  });
}

export class UiApiError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = "UiApiError"; } }
function requestId(): string { return `web_${crypto.randomUUID().replaceAll("-", "")}`; }
