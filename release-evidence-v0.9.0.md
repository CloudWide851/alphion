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

The release gate runs only after source, tests, migration, docs and version files are complete. Final command results, test counts, benchmark measurements, package sizes and artifact identities are recorded here after the gate.

- Static/32 KiB: pending.
- Root install/audit and isolated Node/Electron ABI: pending.
- Typecheck and formal build: pending.
- Built and focused security/migration/Provider/Workspace/performance tests: pending.
- WebUI E2E and Electron IPC/start/package smoke: pending.
- Benchmark, subpath import and `npm pack --dry-run`: pending.
- CodeGraph dependency/API review and Trellis full check: pending.

## Rollback

Stop every Alphion CLI/TUI/WebUI/Desktop process. Preserve the current v8 database and Project key directory for diagnosis, verify the adjacent `.v7-backup`, restore that file to the configured state path, then install and run `v0.8.0` with matching Node/Electron native dependency trees. v0.8.0 rejects schema v8 and post-migration Project credential/Workspace writes are not retained. A missing Project key is a credential re-entry condition, not database corruption; never delete SQLite as attempted credential recovery.
