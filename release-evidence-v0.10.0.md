# Alphion v0.10.0 Release Evidence

## Scope

- Release: `0.10.0`
- Date: 2026-08-28
- SQLite: user_version 9, migrated from v8 through a verified adjacent `.v8-backup`
- Public changes: Provider Profile v3, vision/context capability metadata, latest-call context occupancy, attachment-aware Session/Provider messages and dedicated surface attachment transports
- Compatibility: pre-1.0 minor milestone; v0.9 consumers must adopt Profile v3 and ref-only multimodal contracts

## Functional evidence

- `/settings` is again a shared slash command and opens transient management without writing Session history.
- TUI, WebUI and Desktop use borderless user-right/Alphion-left messages, an independently scrollable viewport, a final-row composer and one bounded answer indicator with accessible static fallback.
- Provider context overrides are validated from 4096 through 4194304 tokens; catalog defaults and the 32768-token unknown-model fallback drive compaction and context occupancy.
- Run totals remain cumulative while the usage bar reports only the latest Provider input plus output, marks pre-usage estimates with `≈` and does not double-count cached input.
- PNG, JPEG, WebP and GIF imports validate signature, dimensions, regular-file identity, per-image/message limits and Project/domain ownership before persistence.
- SQLite, Agent events, Snapshot/Frame, generic commands, cache and diagnostics retain only immutable `ImageAttachmentRef` metadata; binary reads happen at dedicated surface or concrete Provider boundaries.
- Text-only, image-only and mixed send/steer/follow-up requests preserve content-part order. Non-vision rejection precedes message/lease persistence and leaves surface drafts intact.
- Fork, replay and compaction preserve attachment identity without copying binaries; the two latest complete cycles keep original refs and older unsupported image detail becomes an explicit omission.

## Verification record

The complete release gate ran after source, tests, migration, docs and version files were complete. The gate was restarted from static verification after each code or test correction.

- Static/32 KiB: passed; 58 maintained Markdown files and 41 core files were checked, with the historical v2 migration fixture split into its own bounded test module.
- Root install/audit: 454 packages installed, 455 audited, 0 vulnerabilities. The isolated Desktop runtime installed 39 packages, audited 40, with 0 vulnerabilities.
- Native ABI: Node reported ABI 127; the independent Electron `better-sqlite3` process smoke passed without modifying the root addon.
- Typecheck/build: strict Core, Desktop and WebUI typechecks passed. The clean formal build completed; Vite emitted only its non-blocking 511.62 kB chunk-size advisory.
- Compiled tests: all 146 tests passed. The focused security, migration, multimodal, context and provider suites passed all 81 tests.
- Benchmark: memory cache 20,000 operations in 33.34 ms; Project Profile cold/warm 134.34/62.23 ms; ContextPack 1,000 operations in 19.68 ms; SQLite wrote 1,002 events in 398.48 ms with a valid hash chain.
- Surface smoke: WebUI loopback/Origin/CSRF/attachment E2E passed all 5 tests; Desktop IPC/sandbox passed all 3 tests; the packaged Electron executable remained healthy for an isolated 8-second startup smoke.
- Windows x64 artifacts: `Alphion-0.10.0-x64-setup.exe` (105,177,283 bytes), `Alphion-0.10.0-x64-portable.exe` (104,814,664 bytes), and setup blockmap (109,941 bytes). Artifact names are distinct.
- Core/runtime/providers/resources/WebUI/Desktop subpath imports passed. `npm pack --dry-run` produced 552 files, a 1,494,258-byte package and 3,709,104 unpacked bytes; shasum `73e4fad70be1cf37e5ff9f4503cbe2e34895a4f2`.
- CodeGraph dependency/API review: passed; `src/` has no reverse import of TUI, WebUI, Desktop, Electron, UI renderers or concrete adapters, and the v0.10 Provider Profile v3, usage and attachment blast radius is contained to intended ports, application, store and surface consumers.
- Trellis full check: passed across backend, frontend, SQLite v9, multimodal, surface and shared cross-layer/reuse contracts; whitespace, ignored-output and exact-scope checks passed.
- Live paid Provider smoke: intentionally not run unless a credential and explicit authorization are supplied; deterministic local protocol tests cover Provider request mapping.

## Rollback

Stop every Alphion CLI, TUI, WebUI and Desktop process. Preserve the current v9 database and attachment directory for diagnosis, verify the adjacent `.v8-backup`, restore that file to the configured state path, then install and run `v0.9.0` with matching Node/Electron native dependency trees. v0.9.0 rejects schema v9 and post-migration Provider Profile v3 or attachment-relation writes are not retained. Do not delete content-addressed attachment files until the rollback decision is final; database deletion is never an attachment or credential recovery step.
