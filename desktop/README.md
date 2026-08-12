# Desktop IPC migration

Alphion v0.5.0 removes the v0.4.x stdin/stdout JSONL Host. The public
`alphion/desktop` subpath now exports the versioned `DesktopRendererBridge`,
IPC channel constants and exact payload decoders used by the sandboxed
Electron preload.

Electron Main owns the active Project application, SQLite writer, approvals
and external-link opening. Renderer reuses the WebUI bundle and has
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; arbitrary
navigation, new windows, WebView attachment and non-allowlisted IPC are denied.

Integrations that require the old line protocol must remain on v0.4.x or move
to the loopback Web command/SSE boundary. There is no compatibility façade.
Vault master passwords are never exposed through IPC. Provider credentials use
the dedicated one-use bridge method and are cleared by the form after every
outcome.
