# Alphion v0.10.1 Release Evidence

## Scope

- Release: `0.10.1`
- Date: 2026-08-28
- SQLite: user_version 9; no migration from v0.10.0
- Public changes: none; Provider Profile remains schema v3 and `ProviderTestResult` remains schema v1
- Compatibility: stored v0.10 Provider model IDs remain runnable through adapter-private compatibility metadata, but are absent from normal model pickers

## Functional evidence

- Provider connectivity feedback is derived only from `ProviderTestResult.status`: a successful single test and all-success batch use the success notice, mixed batches use warning, and failed/all-failed results use the error channel.
- Successful Provider tests no longer enter the TUI application-error state or render a red `✗` beside `实测成功`.
- Mainland and international normal pickers expose the same ordered current chat catalogs: DeepSeek V4 Flash/Pro/Vision Exp, Kimi K3/K2.7/K2.6/K2.5, Qwen 3.8/3.7 and GLM 5.3/5.2.
- Catalog context-window and vision defaults are explicit and tested. Official endpoints and adapter-private `legacyModels` are stripped from public preset metadata.
- New ordinary built-in profiles reject legacy or unknown IDs unless the existing explicit advanced unlisted-model flow is used. Stored legacy profiles remain constructible without rewriting SQLite.
- Official source URLs and the 2026-08-28 verification record are retained in the local Trellis research artifact.

## Verification record

The complete release gate ran after source, tests, docs and version files were complete. It restarted from static verification after every code or test correction.

- Static/32 KiB: passed; 61 maintained Markdown files and 41 core files passed size, link, dependency and version checks.
- Root install/audit: 455 packages audited with 0 vulnerabilities. The isolated Desktop runtime audited 40 packages with 0 vulnerabilities.
- Native ABI: Node reported ABI 127; the isolated Electron ABI smoke passed without replacing the root `better-sqlite3` addon.
- Typecheck/build: strict Core, Desktop and WebUI typechecks passed. The clean formal build passed; Vite emitted only its existing non-blocking 511.62 kB chunk advisory.
- Compiled tests: all 148 tests passed, including exact catalog ordering/context/vision/legacy compatibility and Provider success/warning/error rendering regressions.
- Benchmark: memory cache 20,000 operations in 33.34 ms; Project Profile cold/warm 128.63/66.37 ms; ContextPack 1,000 assemblies in 19.43 ms; SQLite wrote 1,002 events in 372.33 ms with a valid hash chain.
- Built smoke: Core, WebUI and Desktop IPC subpath imports passed.
- Windows x64 artifacts: `Alphion-0.10.1-x64-setup.exe` (105,179,654 bytes), `Alphion-0.10.1-x64-portable.exe` (104,817,036 bytes), and setup blockmap (109,967 bytes). Artifact names are distinct.
- Package: `npm pack --dry-run` produced 552 files, a 1,496,060-byte package and 3,716,284 unpacked bytes; shasum `42f1e3584a9602e6071d77c8790ba475c789b195`.
- CodeGraph dependency/API review: passed; `src/` has no reverse import of TUI, WebUI, Desktop, CLI, Electron, UI frameworks or concrete Provider adapters. Catalog changes remain adapter metadata and TUI presentation behavior; no public type/schema changed.
- Trellis full check: passed against the Provider conversation, Project Provider-test/workspace, TUI and chat-surface contracts; ignored local docs/spec remain outside the staged release set.
- Live paid Provider smoke: not repeated by the release gate because the reported real request already returned success and no credential was supplied for a new paid call. Deterministic local protocol tests cover request mapping and status projection.

## Rollback

Stop Alphion processes, install `v0.10.0`, and keep the existing v9 Project database and credential files unchanged. This patch has no SQLite or public schema migration, so database restoration is unnecessary. If diagnosis requires state rollback, preserve the current database first and follow the v0.10.0 `.v8-backup` recovery procedure; never delete the database or Project key to address a Provider catalog or UI-status issue.
