import { join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { WorkspaceController } from "../adapters/project/active-project-controller.js";
import { LocalProjectManager } from "../adapters/project/project-manager.js";
import { AlphionError } from "../src/application/errors.js";
import type { AgentApplication } from "../src/ports/index.js";
import { decodeUiCommandEnvelope } from "../ui/contracts.js";
import { LocalUiCommandClient } from "../ui/local-command-client.js";
import { parseExternalHttpUrl } from "../ui/markdown.js";
import { decodeDesktopApprovalDecision, decodeDesktopCredential, DESKTOP_IPC_CHANNELS } from "./contracts.js";

const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererFile = normalize(join(moduleDirectory, "..", "webui", "client", "index.html"));
const rendererUrl = pathToFileURL(rendererFile).href;
const desktopIcon = normalize(join(moduleDirectory, "..", "..", "assets", "alphion.png"));
let shuttingDown = false;

export async function runElectronDesktop(): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const dataRoot = app.getPath("userData");
  const projects = new WorkspaceController(new LocalProjectManager(join(dataRoot, "projects.json")), dataRoot);
  await projects.openCurrentOrDefault();
  const application = (): AgentApplication => {
    const current = projects.current();
    if (!current) throw new AlphionError("conflict", "Desktop Project is not open.", { stage: "desktop" });
    return current.application;
  };
  const client = new LocalUiCommandClient({ application, projects: projects.projects, activateProject: async (projectId) => { await projects.activate(projectId); }, currentProjectId: () => projects.current()?.project?.id, backgroundRuns: () => projects.backgroundRuns() });
  registerDesktopIpc(client, rendererUrl);
  const window = createWindow();
  const eventAbort = new AbortController();
  const events = pumpEvents(client, window, eventAbort.signal);
  await window.loadFile(rendererFile);
  app.on("second-instance", () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true;
    void (async () => { ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.command); ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.credential); ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.approval); ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.external); eventAbort.abort(); await client.close(); await events; await projects.close(); app.quit(); })();
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520, backgroundColor: "#f7f6fa", show: false, icon: desktopIcon,
    titleBarStyle: "hiddenInset",
    webPreferences: { preload: join(moduleDirectory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (target !== rendererUrl) event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  return window;
}

function registerDesktopIpc(client: LocalUiCommandClient, allowedRendererUrl: string): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.command, (event, value: unknown) => { assertTrustedSender(event, allowedRendererUrl); return client.execute(decodeUiCommandEnvelope(value)); });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.credential, async (event, value: unknown) => { assertTrustedSender(event, allowedRendererUrl); const input = decodeDesktopCredential(value); try { await client.importProviderCredential(input.profileId, input.secret); } finally { value = undefined; } });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.approval, (event, value: unknown) => { assertTrustedSender(event, allowedRendererUrl); client.decideApproval(decodeDesktopApprovalDecision(value)); });
  ipcMain.handle(DESKTOP_IPC_CHANNELS.external, async (event, value: unknown) => { assertTrustedSender(event, allowedRendererUrl); const safe = typeof value === "string" ? parseExternalHttpUrl(value) : undefined; if (!safe) throw new AlphionError("forbidden", "Desktop external URL is not allowed.", { stage: "desktop" }); await shell.openExternal(safe.href, { activate: true }); return true; });
}

async function pumpEvents(client: LocalUiCommandClient, window: BrowserWindow, signal: AbortSignal): Promise<void> {
  for await (const frame of client.subscribe()) { if (signal.aborted) break; if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC_CHANNELS.event, frame); }
}

function assertTrustedSender(event: IpcMainInvokeEvent, expected: string): void {
  if (event.senderFrame?.url !== expected) throw new AlphionError("forbidden", "Desktop IPC sender is not allowed.", { stage: "desktop" });
}

if (process.versions.electron) void runElectronDesktop();
