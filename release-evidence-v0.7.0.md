# Alphion v0.7.0 Release Evidence

## Scope

- Release: `0.7.0`
- Date: 2026-08-13
- SQLite: user_version 6 (no migration)
- Public additions: `ProviderConversationPlan`, slash descriptors/parser, `ConversationRunState`, `project.inspect`
- Compatibility: pre-1.0 minor milestone; UI envelope/frame schema remains v1

## Functional evidence

- Terminal lifecycle enters/restores alternate screen and launcher clears stale menu output.
- Current Run user entry is excluded before compaction and prompt is appended once.
- Audit system events, approvals and `tool.updated` stay out of Provider messages.
- Tool batches/results are ordered and malformed sequences fail closed.
- Vault credential is resolved per call; stable safe errors distinguish local credential state, credential rejection and request/model rejection.
- Built-in Provider ordinary configuration is catalog-only; DeepSeek lists `deepseek-chat` and `deepseek-reasoner`.
- TUI/Web/Desktop share slash matching, disabled reasons and typed dispatch without Session-history writes.
- TUI remains chat-first during a Run; React surfaces share assistant bubbles, waiting/stream projection and reduced-motion handling.

## Verification record

- Static/32 KiB: `npm run verify:static` passed for 49 Markdown and 30 Core files; maintained-file size, secret scan, dependency direction and documentation-link checks passed.
- Root clean install/audit: `npm ci` installed 454 packages and audited 455; `npm audit --audit-level=high` reported 0 vulnerabilities.
- Desktop isolated install and ABI: `npm run desktop:deps` installed 39 packages in the ignored staging tree and audited 40 with 0 vulnerabilities. Node SQLite ABI 127 and Electron SQLite ABI smoke both passed without replacing one another.
- Typecheck and formal build: Core, Electron and WebUI TypeScript checks passed. The single formal `npm run build` completed Core, Desktop and Vite production output.
- Built and focused tests: `npm run test:built` passed 109/109 with 0 failures, cancellations or skips. This includes encrypted Vault multi-turn requests, legal Provider message order, error classification, catalog gating, slash/TUI behavior, WebUI loopback E2E, Electron IPC, migration/security and slow-subscriber coverage.
- Benchmark: 20,000 memory-cache operations in 39.99 ms; 1,000 ContextPack assemblies in 22.95 ms; 1,002 SQLite events in 445.88 ms with a valid hash chain.
- WebUI E2E: Origin, HttpOnly session, CSRF, malformed/oversized request isolation and dedicated credential import passed in the compiled suite.
- Electron IPC/start/package smoke: strict IPC tests and ABI smoke passed. Packaged renderer loaded `app.asar` in isolated temporary user data. Windows x64 artifacts are `Alphion-0.7.0-x64-setup.exe` (104,697,346 bytes) and `Alphion-0.7.0-x64-portable.exe` (104,467,588 bytes).
- Subpath/import smoke: built Core, runtime/providers/resources, WebUI and Desktop IPC subpaths passed; removed JSONL Desktop outputs remain absent.
- `npm pack --dry-run`: `alphion-0.7.0.tgz`, 1,230,110 bytes packed, 2,971,440 bytes unpacked, 438 entries.
- CodeGraph boundary review: confirmed the execution spine and public blast radius for `ProviderConversationPlan`, slash commands, `ConversationRunState`, `project.inspect` and Vault/Provider changes. Static import checks confirm `src/` does not reverse-depend on TUI, shared UI surfaces, WebUI, Desktop, Electron or concrete Provider adapters.
- Trellis full check: PRD/design/implementation, Backend/Frontend v0.7 specs, cross-layer data flow, error propagation, direct regression coverage, ignored local state and final release gates were reviewed with no unresolved violations.

## Rollback

Stop CLI/TUI/WebUI/Desktop processes and install `v0.6.0` with its matching root Node ABI and isolated Electron ABI dependencies. No SQLite restore is required because user_version remains 6. Preserve the database and Vault. If native preflight reports an ABI mismatch, repair only the relevant dependency tree; never delete SQLite.
