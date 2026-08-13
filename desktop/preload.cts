const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { IpcRendererEvent } from "electron";
import type { UiCommandEnvelope, UiCommandResult, UiEventFrame } from "../ui/contracts.js";
import type { DesktopApprovalDecision, DesktopRendererBridge } from "./contracts.js";

// Sandboxed Electron preloads are CommonJS and may only require Electron's
// supported preload modules. Keep runtime channel constants self-contained.
const channels = Object.freeze({ command: "alphion:command", event: "alphion:event", credential: "alphion:credential", approval: "alphion:approval", external: "alphion:external" });
const bridge: DesktopRendererBridge = Object.freeze({
  schemaVersion: 1,
  invoke: (envelope: UiCommandEnvelope) => ipcRenderer.invoke(channels.command, envelope) as Promise<UiCommandResult>,
  subscribe: (listener: (frame: UiEventFrame) => void) => {
    const handler = (_event: IpcRendererEvent, value: UiEventFrame) => listener(value);
    ipcRenderer.on(channels.event, handler);
    return () => ipcRenderer.removeListener(channels.event, handler);
  },
  importProviderCredential: (profileId: string, secret: string) => ipcRenderer.invoke(channels.credential, { profileId, secret }) as Promise<void>,
  decideApproval: (decision: DesktopApprovalDecision) => ipcRenderer.invoke(channels.approval, decision) as Promise<void>,
  openExternal: (href: string) => ipcRenderer.invoke(channels.external, href) as Promise<boolean>,
});
contextBridge.exposeInMainWorld("alphionDesktop", bridge);
