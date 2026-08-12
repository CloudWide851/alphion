# Alphion v0.5.0 Release Evidence

Status: release gate passed
Date: 2026-08-12

## Scope

- Project-scoped shared Agent and same-domain bounded Session collaboration.
- SQLite v5 / `better-sqlite3`, durable collaboration and non-blocking UI fan-out.
- Provider catalog presets, chat-first TUI, shared safe Markdown, loopback WebUI and sandboxed Electron Desktop.
- Breaking removal of the v0.4.x Desktop JSONL Host.

## Compatibility and rollback

Opening a v4 database creates a validated adjacent `.v4-backup` before the v5 transaction. Rollback requires stopping all Alphion processes, preserving the v5 database for diagnosis, restoring `.v4-backup`, and running v0.4.0. v0.4.0 cannot open schema v5. JSONL consumers must remain on v0.4.x or migrate to Web command/SSE or Electron IPC.

Windows Electron artifacts are unsigned and may trigger SmartScreen. `better-sqlite3` must be rebuilt for the packaged Electron ABI. Uninstall does not delete Project/Vault/session data from the platform application directory.

## Final gate record

- `npm run verify:static`: passed; 43 Markdown files and 29 core files checked.
- `npm ci` + Node `better-sqlite3` ABI smoke: passed; 454 packages installed.
- `npm audit --json`: 0 known vulnerabilities. Electron was raised to the
  locked `43.4.0` line after the earlier version produced current advisories.
- `npm run typecheck`: passed for core, Desktop and WebUI while preserving root
  `skipLibCheck: false`; only the Desktop project isolates Electron/Node ambient declarations.
- `npm run build`: one clean formal build passed. `scripts/clean-dist.mjs`
  prevents removed JSONL files from surviving an incremental build.
- `npm run test:built`: 84/84 passed. The focused security, migration,
  collaboration, backpressure, Markdown, Web and Desktop set also passed.
- `npm run benchmark:built`: memory cache 20,000 operations / 34.35 ms;
  ContextPack 1,000 assemblies / 21.01 ms; SQLite 1,002 events / 399.68 ms
  with a valid hash chain.
- `npm run smoke:built`: core, WebUI and Desktop IPC subpath imports passed and
  no removed Desktop JSONL output remained.
- WebUI browser E2E: loopback bootstrap, restrained chat shell, settings,
  circular disclosure, Session creation/input and console checks passed. A
  send without a configured Provider failed closed and retained the editable draft.
- `npm run desktop:deps` and `npm run desktop:abi-smoke`: passed;
  `electron-sqlite-abi-ok`. Node gates ran before this Electron rebuild because
  one native `better-sqlite3` binary cannot serve both ABIs simultaneously.
- Electron packaging: passed using the locked local Electron distribution.
  `Alphion-0.5.0-x64-setup.exe` (114,347,317 bytes) and
  `Alphion-0.5.0-x64-portable.exe` (114,117,391 bytes) were both produced,
  remained unsigned as planned, included `app.asar` plus the native module,
  and the unpacked Desktop process stayed responsive during an 8-second smoke.
  Distinct target-specific artifact names prevent one target overwriting the other.
- `npm pack --dry-run --json`: version 0.5.0, 346 entries, 1,184,472 packed
  bytes and 2,772,676 unpacked bytes; no removed JSONL artifact was present.
- CodeGraph: core dependency direction remained clean; Project/Session public
  blast radius was reviewed and JSONL terms were confined to history/removal tests.
- Trellis: current PRD/design/implement and all applicable backend/frontend
  specs were reloaded; spec, cross-layer, diff and staging checks passed.

The release commit and annotated tag are recorded by Git after this document is
staged. No push, npm publish or GitHub Release was performed.
