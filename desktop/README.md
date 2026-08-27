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
Project keys, credential ciphertext and legacy migration material are never
exposed through IPC. Provider credentials use the dedicated one-use bridge
method, are encrypted by Main for the active Project, and are cleared by the
form after every outcome.

In v0.8.0 the Renderer inherits the WebUI slash palette, conversation Run,
Compaction, Goal and Schedule projections. No generic Node capability or IPC
channel is added: all v0.8 commands travel through the existing exact command
bridge. The Electron window, top-left header, executable, installer, Start Menu
entry and shortcuts use the ICO/PNG assets deterministically generated from
the canonical `alphion-icon.svg`.
