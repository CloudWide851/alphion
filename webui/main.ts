import { WorkspaceController } from "../adapters/project/active-project-controller.js";
import { LocalUiCommandClient } from "../ui/local-command-client.js";
import { createWebUiServer } from "./server.js";

/** Runs the single-user loopback WebUI until the process receives a stop signal. */
export async function runWebUi(options: Readonly<{ port?: number }> = {}): Promise<void> {
  const projects = new WorkspaceController();
  await projects.openCurrentOrDefault();
  const client = new LocalUiCommandClient({ application: () => { const current = projects.current(); if (!current) throw new Error("WebUI Project is not open."); return current.application; }, projects: projects.projects, activateProject: async (projectId) => { await projects.activate(projectId); }, currentProjectId: () => projects.current()?.project?.id, backgroundRuns: () => projects.backgroundRuns() });
  const server = await createWebUiServer({ client, ...(options.port === undefined ? {} : { port: options.port }) });
  process.stdout.write(`Alphion WebUI: ${server.origin}\n`);
  try { await stopSignal(); }
  finally { await server.close(); await projects.close(); }
}

function stopSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
