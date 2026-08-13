# Alphion v0.6.0 Release Evidence

Status: release gate passed
Date: 2026-08-13

## Scope

- Transactional same-domain Session Fork with independent remapped history, preserved Evidence, digest-reidentified Shape/provider configuration and immutable provenance.
- SQLite v6 after a verified `.v5-backup`, same-Session parent/current-leaf integrity and AgentSessionRecord schema v3.
- Subscribe-first Snapshot/Frame refresh, bounded 30/60 FPS fan-out and deterministic resync across TUI, WebUI and Electron.
- Shared bounded safe code projection/rendering and TUI `/fork` argv-only terminal launch with durable failure recovery.
- Isolated Node/Electron `better-sqlite3` install trees, native ABI preflight/doctor classification and a 32768-byte maintained-file gate.

## Compatibility and rollback

This 0.x milestone adds public Session Fork, Snapshot/Frame and Session record contracts. Opening v5 creates and verifies an adjacent `.v5-backup` before the v6 transaction. Rollback requires stopping every Alphion process, retaining the v6 database/WAL/SHM for diagnosis, restoring `.v5-backup`, and running v0.5.0. v0.5.0 rejects schema v6 and post-migration Fork data is not retained.

Native ABI mismatch is a dependency failure before SQLite opens. Repair root `node_modules` for Node, or ignored `.desktop-runtime/` for Electron; never delete the database. Windows Electron artifacts remain unsigned and may trigger SmartScreen.

## Final gate record

The complete final gate ran in the prescribed order after commit `2c798ba`:

- `npm run verify:static`: passed; checked 46 Markdown files and 30 Core files, including the 32768-byte gate.
- clean root `npm ci --prefer-offline`: 454 packages installed, 455 audited, 0 vulnerabilities. A separate `npm audit --json` also reported 0 vulnerabilities across 504 dependency records.
- isolated `npm run desktop:deps`: 39 packages installed, 40 audited, 0 vulnerabilities; the resulting `.desktop-runtime` contained 3,578 files / 27.62 MiB.
- native preflight: Node loaded `better-sqlite3` with ABI 127; Electron loaded the staging binding successfully (`electron-sqlite-abi-ok`).
- `npm run typecheck`: root, Desktop and WebUI TypeScript projects passed.
- `npm run build`: the single formal clean Core/Desktop/WebUI build passed; Vite produced a 475.90 kB JavaScript bundle (147.04 kB gzip) and 35.94 kB CSS bundle (10.21 kB gzip).
- `npm run test:built`: 97/97 tests passed. The focused security, Vault, migration, Fork, refresh, Markdown, WebUI and Desktop suite passed 64/64.
- Web/Desktop acceptance: loopback Origin/CSRF/E2E tests, strict Electron IPC/navigation tests, frame/resync tests and the packaged `Alphion.exe` temporary-userData startup smoke passed.
- `npm run benchmark:built`: 20,000 memory-cache operations in 52.55 ms; project profile cold/warm 26.06/3.75 ms; 1,000 ContextPack assemblies in 32.45 ms; 1,002 SQLite events in 567.01 ms with a valid hash chain.
- `npm run smoke:built`: Core, WebUI and Desktop IPC public subpath imports passed.
- `npm run desktop:pack`: completed in 119.5 seconds and produced both unsigned Windows x64 formats. NSIS is 104,679,814 bytes with SHA-256 `0533CA0FD6FB689E6F84665EB37A70942D05601ED2F8283C8EA4F7BEB8DED417`; portable is 104,450,054 bytes with SHA-256 `E3F81EED84430C5E131DFD096D769F4B025E762124F45A13EE704C5C004104F0`.
- `npm pack --dry-run --json`: `alphion-0.6.0.tgz`, 1,214,095 bytes packed, 2,899,226 bytes unpacked, 414 files.
- final CodeGraph review found no Core reverse dependency on TUI, WebUI, Desktop, Electron or concrete Provider adapters; the Fork/Snapshot/Frame public blast radius reaches the intended Store, CLI, UI and test consumers. Trellis full-scope PRD/design/spec review found no remaining deviation.

The release commit and annotated tag are recorded by Git only after every item passes and this section is updated. No push, npm publish or GitHub Release is authorized.
