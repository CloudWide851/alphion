# Alphion v0.8.0 Release Evidence

## Scope

- Release: `0.8.0`
- Date: 2026-08-14
- SQLite: user_version 7, migrated from v6 through a verified adjacent `.v6-backup`
- Public additions: device vault, durable Compaction, Goal, Schedule and shared surface automation contracts
- Compatibility: pre-1.0 minor milestone; old password Vault APIs are removed, UI envelope/frame schema remains v1

## Functional evidence

- Normal startup enters editable chat without password initialization/unlock; first credential import provisions a per-user device key.
- Provider credentials use an authenticated wrapped data key and per-call short-lived plaintext; legacy password ciphertext remains disabled until explicit reset.
- Context budget uses the model catalog window, 85% threshold and output/Tool/safety reserves; records are append-only and never become Session messages.
- Goals own dedicated visible Sessions and append-only revisions; Agent progress requires Evidence, while root changes and completion remain user-authoritative.
- Schedules accept only Goal review or fixed Session prompt payloads and use bounded process-local scans, leases, overlap handling and latest-missed catch-up.
- TUI/Web/Desktop share Context/Goal/Schedule commands and projections, preserve drafts across refresh/resync and keep compaction bodies hidden by default.
- Web favicon/header and Electron window/package/shortcut icons derive from the canonical `alphion-icon.svg`.

## Verification record

The release gate is intentionally executed only after source, tests, migrations, docs and version files are complete. Final command results, test counts, package sizes, benchmark measurements and artifact identities are recorded here before the release commit and tag.

- Static/32 KiB: passed; 52 Markdown files and 36 core files checked, including secrets, brand assets and dependency direction.
- Root install/audit and isolated Desktop ABI: 454 root packages and 40 Desktop staging packages installed; both audits reported 0 vulnerabilities; Node ABI 127 and Electron SQLite smoke passed.
- Typecheck and formal build: Core, Desktop and WebUI typecheck passed; clean Core/Desktop/Vite production build passed.
- Built, security, migration, Compaction, Goal and Scheduler tests: 123/123 full built tests and 16/16 focused v0.8 safety tests passed.
- Benchmark: 20,000 memory-cache operations in 48.72 ms; 1,000 ContextPack assemblies in 27.71 ms; 1,002 SQLite events in 391.55 ms with a valid hash chain; profiler cold/warm 205.60/80.59 ms.
- WebUI/Electron: WebUI HTTP/CSRF/credential tests and Desktop IPC hardening tests passed; packaged unpacked executable remained responsive in a controlled headless startup smoke.
- Windows packages: NSIS `Alphion-0.8.0-x64-setup.exe` 105,128,502 bytes; portable `Alphion-0.8.0-x64-portable.exe` 104,765,922 bytes; blockmap 110,018 bytes.
- Subpath imports and `npm pack --dry-run`: built Core/WebUI/Desktop IPC subpath smoke passed; 500-file tarball is 1.4 MB packed / 3.4 MB unpacked, shasum `a54d244d6289b17536ae3cbb02e063ad1ad4ebf2`.
- CodeGraph dependency/API review and Trellis full check: passed; Core retains its port/domain dependency direction, concrete Providers remain composition-root adapters, and v0.8 Store → application → command/snapshot → TUI/Web/Desktop flows satisfy the applicable backend/frontend specifications.

## Rollback

Stop every Alphion CLI/TUI/WebUI/Desktop process. Preserve the current v7 database for diagnosis, verify the adjacent `.v6-backup`, restore that file to the configured state path, then install and run `v0.7.0` with matching Node/Electron native dependency trees. v0.7.0 rejects schema v7 and post-migration Goal, Schedule, Compaction and device-credential writes are not retained. A missing device key is `device-key-unavailable`, not database corruption; never delete SQLite as an attempted credential recovery.
