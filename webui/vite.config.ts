import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({ root: "webui/client", plugins: [react()], build: { outDir: "../../dist/webui/client", emptyOutDir: true }, server: { host: "127.0.0.1" } });
