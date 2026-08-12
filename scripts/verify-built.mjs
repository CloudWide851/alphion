import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const modules = await Promise.all([
  import(pathToFileURL(resolve(root, "dist/src/index.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/runtime.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/providers.js")).href),
  import(pathToFileURL(resolve(root, "dist/src/resources.js")).href),
  import(pathToFileURL(resolve(root, "dist/desktop/index.js")).href),
  import(pathToFileURL(resolve(root, "dist/webui/index.js")).href),
]);
if (!modules[0].ALPHION_BRAND || !modules[1].Agent || !modules[2].DeterministicRoutingPolicy || !modules[3].SystemPromptComposer || modules[4].DESKTOP_IPC_SCHEMA_VERSION !== 1 || !modules[5].createWebUiServer) throw new Error("A public v0.5.0 subpath export is missing.");
process.stdout.write("built core, WebUI, and Desktop IPC subpath smoke passed\n");
