# Alphion v0.9.0 Release Evidence

## Scope

- Release: `0.9.0`
- Date: 2026-08-27
- SQLite: user_version 8, migrated from v7 through a verified adjacent `.v7-backup`
- Public changes: Project encrypted credentials, exact Provider tests, stable Run lifecycle, fixed chat, multi-token commands, Workspace navigation and Surface Snapshot/Frame v2
- Compatibility: pre-1.0 minor milestone; password/Device Vault APIs and Surface v1 are removed

## Functional evidence

- Accepted sends create an assistant waiting projection before asynchronous orchestration; parent Session/Snapshot refresh does not cancel the Run and all paths reach a terminal state.
- TUI/Web/Desktop use fixed composers, independently scrollable history, user-right/Agent-left bubbles, bottom-aware auto-follow and Project/Session-keyed ordinary drafts.
- Shared quote-aware commands remove `/settings`, support direct Project/Session navigation and create or reuse directories without shell-string execution.
- Project credentials use an external per-Project key and authenticated AES-256-GCM SQLite envelope; plaintext remains short-lived and absent from events, messages, cache, logs and surface transports.
- Provider current/all tests use the exact Profile, no fallback/history/tools/cache, bounded timeout/concurrency and safe transient results.
- Workspace switching keeps only already-busy background applications, pauses their Schedulers, reports bounded background activity and closes idle writers.
- SQLite v8 preserves Session/Event truth and migrates v7 credentials through verified backup, re-encryption where possible or explicit Profile re-entry where not.

## Verification record

The release gate ran after source, tests, migration, docs and version files were complete.

- Static/32 KiB: passed; 55 maintained Markdown files and 38 core source files were checked with no undeclared exception.
- Root install/audit: 454 packages installed, 455 audited, 0 vulnerabilities. The isolated Desktop runtime installed 39 packages, audited 40, with 0 vulnerabilities.
- Native ABI: Node reported ABI 127; the independent Electron `better-sqlite3` process smoke passed without modifying the root addon.
- Typecheck/build: strict Core, Desktop and WebUI typechecks passed. The clean formal build completed; Vite emitted only its non-blocking 504.22 kB chunk-size advisory.
- Compiled tests: all 137 tests passed. The focused security, migration, Provider, Workspace, WebUI and Desktop suites passed all 50 tests.
- Benchmark: memory cache 20,000 operations in 30.77 ms; Project Profile cold/warm 129.74/59.54 ms; ContextPack 1,000 operations in 17.75 ms; SQLite wrote 1,002 events in 330.1 ms with a valid hash chain.
- Surface/package smoke: Core, WebUI and Desktop IPC subpath imports passed. The packaged Electron executable remained healthy for an isolated 8-second startup smoke.
- Windows x64 artifacts: `Alphion-0.9.0-x64-setup.exe` (105,153,191 bytes) and `Alphion-0.9.0-x64-portable.exe` (104,790,598 bytes); the setup blockmap is 109,896 bytes.
- `npm pack --dry-run`: 520 files; 1,465,293-byte package, 3,562,419 bytes unpacked; shasum `dd717c1a0f5a45dcb0bfc3d723387fc21d3841b4`.
- CodeGraph dependency/API review: passed; `src/` has no reverse dependency on TUI, WebUI, Desktop, Electron or concrete Provider adapters, and the v0.9 Workspace/credential/Provider-test/Surface-v2 blast radius is contained to the intended ports, application and surface consumers.
- Trellis full check: passed across Backend, Frontend and shared cross-layer/reuse guides; Git whitespace and ignored-output checks also passed.
- Live paid Provider smoke: intentionally not run; it requires an explicitly supplied credential and authorization for a real billable request. Deterministic local protocol tests cover the exact request path.

## Rollback

Stop every Alphion CLI/TUI/WebUI/Desktop process. Preserve the current v8 database and Project key directory for diagnosis, verify the adjacent `.v7-backup`, restore that file to the configured state path, then install and run `v0.8.0` with matching Node/Electron native dependency trees. v0.8.0 rejects schema v8 and post-migration Project credential/Workspace writes are not retained. A missing Project key is a credential re-entry condition, not database corruption; never delete SQLite as attempted credential recovery.
