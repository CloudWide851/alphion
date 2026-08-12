import { resolve } from "node:path";
import { openLocalAlphionApplication } from "../adapters/local/local-application.js";
import { createDesktopHost } from "./host.js";
import { StdioJsonlTransport } from "./stdio.js";

export async function runDesktopHost(options: Readonly<{ projectRoot: string; statePath?: string }>): Promise<void> {
  const application = await openLocalAlphionApplication({ projectRoot: resolve(options.projectRoot), ...(options.statePath ? { statePath: resolve(options.statePath) } : {}) });
  await createDesktopHost({ application, transport: new StdioJsonlTransport() }).run();
}
