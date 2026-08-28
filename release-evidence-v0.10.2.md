# Alphion v0.10.2 Release Evidence

## Scope

- Release: `0.10.2`
- Date: 2026-08-28
- SQLite: user_version 9; no migration from v0.10.1
- Public changes: none; Provider Profile remains schema v3 and UI Snapshot/Frame remains schema v2
- Compatibility: ordinary chat keeps the active Profile frozen in the Session shape; Provider exact-test and chat share factory/credential resolution but intentionally have different preparation paths

## Functional evidence

- Project Code Recall owns a 3-second CodeGraph ceiling and a lexical fallback capped at 1 second, 256 files, 8 MiB and 20 results with stable traversal exclusions.
- `AgentSession` owns a five-second total Recall ceiling. Optional timeout/unavailability degrades to empty context and continues Provider execution; caller cancellation propagates and is not cached.
- A real SQLite Session + first Shape + bounded Recall + local OpenAI-compatible protocol regression covers the production path and asserts the current prompt appears once.
- TUI user history uses full-width rows with content-sized right-justified blocks (78% normal, 94% compact), while Agent history remains left aligned.
- `RunView` shows one preparation phase before output and no duplicated status in the usage row. Existing `✓ 实测成功` semantic feedback remains covered.

## Verification record

The complete release gate ran only after source, tests, local docs/spec and version files were complete.

- Static/32 KiB: passed for 64 Markdown files and 41 Core files.
- Root/Desktop install and audit: passed; root installed 455 packages and Desktop runtime installed 40 packages, both with 0 vulnerabilities.
- Node/Electron native ABI: passed; Node reported ABI 127 and the isolated Electron runtime smoke loaded its native dependency successfully.
- Typecheck/formal build: strict Core, Desktop and WebUI typechecks passed; the single formal clean build passed. Vite emitted only its existing 511.62 kB chunk-size advisory.
- Compiled and focused Recall/Session/TUI tests: 156/156 full built tests and 39/39 focused tests passed. The real SQLite Session -> first Shape -> bounded Recall -> local Provider regression completed in about 5.13 seconds.
- Security/migration: 20/20 tests passed; SQLite remains at user_version 9.
- Benchmark: memory cache 20,000 operations in 35.87 ms; Project Profile cold 18.2 ms and warm 3.39 ms; ContextPack 1,000 operations in 23.19 ms; SQLite persisted 1,002 events in 409.6 ms with a valid hash chain.
- WebUI E2E and Electron IPC/startup/package: 5/5 WebUI E2E and 3/3 Desktop IPC/Main/preload tests passed. Desktop startup remained healthy for the five-second isolated smoke window.
- Windows packaging: unsigned x64 NSIS and portable builds passed. `Alphion-0.10.2-x64-setup.exe` is 105,268,196 bytes, `Alphion-0.10.2-x64-portable.exe` is 104,905,576 bytes, and the blockmap is 109,513 bytes. Two direct GitHub Electron ZIP downloads timed out, so the successful build used the locally installed Electron 43.4.0 distribution that had already passed ABI smoke; no product source or packaging configuration was changed for this fallback.
- Subpath/import smoke: passed against built output.
- Package dry run: passed with 552 files, package size 1,499,456 bytes, unpacked size 3,730,795 bytes and shasum `c02812120aafc7720efbf9a7e4a82717b5a86acf`.
- CodeGraph dependency/API review: passed; Recall changes remain behind existing internal contracts, and Core has no reverse dependency on TUI, WebUI, Desktop, Electron or a concrete Provider adapter.
- Trellis full check: passed against the task PRD/design/implementation plan and affected backend, frontend and cross-layer specifications.
- Live paid Provider smoke: not repeated unless a credential is explicitly supplied; deterministic local protocol integration covers the exact request path without external cost.

## Rollback

Stop Alphion processes, install `v0.10.1`, and keep the existing v9 Project database, Project key and attachment files unchanged. This patch has no SQLite or public schema migration, so database restoration is unnecessary. Never delete the database or credentials to address Recall degradation or TUI layout.
