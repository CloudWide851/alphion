# Changelog

## [0.10.2] - 2026-08-28

- Bounded Project Code Recall with a 3-second CodeGraph ceiling and a deterministic lexical fallback capped at 1 second, 256 files, 8 MiB and 20 results. Cancelled and time-dependent partial results are not cached.
- Added a five-second Session Recall ceiling so unavailable or slow optional recall degrades to empty context and ordinary chat continues to the selected Provider; non-degradable Shape, capability and SQLite failures still release the Run lease and fail closed.
- Added a real SQLite Session → first Shape → bounded Recall → local protocol Provider regression proving that exact Provider test success and ordinary chat can both complete and the current prompt is sent once.
- Fixed TUI user history geometry so a content-sized block reaches the right edge at wide and compact terminal widths while CJK, Markdown, code and image placeholders remain naturally left-aligned inside it.
- Removed duplicate preparation/status text from active TUI Runs while preserving fixed composer, scroll, drafts, attachments, usage/context and Provider-test success feedback.

This patch does not change public TypeScript APIs, Provider Profile schema v3, UI transport schemas or SQLite user_version 9. Stop Alphion processes to roll back directly to v0.10.1; no database restoration is required.

## [0.10.1] - 2026-08-28

- Fixed TUI Provider connectivity feedback so a resolved successful real request renders `✓ 实测成功` through the notice channel instead of a red application error. Mixed test-all results are warnings; all-failed results remain errors.
- Refreshed mainland and international normal model pickers from official Provider documentation verified on 2026-08-28: DeepSeek V4, Kimi K3/K2.7/K2.6/K2.5, Qwen 3.8/3.7 and GLM 5.3/5.2 families.
- Added exact context-window and vision defaults for the refreshed catalog while keeping official endpoints private to adapters.
- Kept v0.10.0 model IDs in an adapter-private stored-profile compatibility allowlist. They remain runnable when already stored but are not published in normal pickers or accepted as new ordinary profiles.

This patch does not change Provider Profile schema v3, UI transport schemas or SQLite user_version 9. It does not rewrite stored profiles and can be rolled back to v0.10.0 without restoring a database backup.

## [0.10.0] - 2026-08-28

- Restored `/settings` across the shared TUI, WebUI and Desktop slash registry while keeping commands and transient management views outside Session history.
- Simplified chat surfaces to borderless user-right/Alphion-left messages, a fixed final-row composer, independently scrollable content, a single bounded `| / - \\` active-answer indicator and accessible static motion fallbacks.
- Upgraded Provider Profile to schema v3 with catalog vision/context metadata, validated 4K–4M context overrides, a 32K unknown-model fallback and latest-call context occupancy distinct from aggregate Run usage.
- Added versioned text/image Session inputs and ordered Provider content parts. PNG, JPEG, WebP and GIF attachments are validated, bounded, SHA-256 addressed and represented by metadata-only references in SQLite, events, cache and surface protocols.
- Added attachment-aware send, steer, follow-up, Fork, replay, cache and compaction behavior. Non-vision Providers reject image drafts before creating a message or Run lease, while recent compaction cycles retain original image references.
- Added TUI clipboard/path image import, protected Web upload/read endpoints and narrow Electron attachment IPC with bounded transfer, authorized thumbnails, draft preservation and no generic filesystem or Node access.
- Migrated SQLite from user_version 8 to 9 after a verified adjacent `.v8-backup`; existing text messages and Provider profiles remain readable and future schemas continue to fail closed.

This pre-1.0 milestone changes Provider Profile, Session message, Provider message and SQLite contracts. To roll back, stop every Alphion process, preserve the current v9 database and `.alphion/attachments/` directory for diagnosis, restore the verified adjacent `.v8-backup`, then run v0.9.0. v0.9.0 rejects schema v9 and cannot retain post-migration Profile v3 or attachment relations; referenced attachment files should be preserved until the rollback decision is final.

## [0.9.0] - 2026-08-27

- Stabilized continuous conversations: accepted sends create waiting assistant projections immediately, parent Snapshot/Session refreshes no longer cancel stable Run controllers, and every preparation/model/stream/Tool path reaches a terminal state.
- Rebuilt TUI, WebUI and Desktop chat around an independently scrollable message viewport, fixed bottom composer, right-aligned user and left-aligned Agent bubbles, bottom-aware auto-follow, unseen counts and Project/Session-scoped drafts.
- Added quote-aware, longest-prefix multi-token slash completion; removed `/settings`, added direct Project/Session selectors and `/new project <path> [--name <name>]`, and kept every command out of Session history.
- Replaced Device Vault and password/device-credential public contracts with per-Project AES-256-GCM credential envelopes whose random 32-byte keys live outside SQLite in the platform configuration directory.
- Added exact-Profile Provider connectivity tests: current/all actions issue real bounded no-history/no-Tool requests, never route fallback, cap all-tests concurrency at two and return only sanitized transient diagnostics.
- Added create-or-open Project navigation and a bounded Workspace controller that retains only busy background applications, pauses their Schedulers, restores active Session projections and closes writers after activity becomes idle.
- Upgraded Surface Snapshot/Frame to schema v2 with Project identity, selected Session and bounded background Run summaries; upgraded SQLite from user_version 7 to 8 after a verified adjacent `.v7-backup`.

This pre-1.0 milestone changes Provider authentication, surface and SQLite contracts. Password, Device Vault and device-credential APIs are removed; v1 Snapshot/Frame clients must upgrade. To roll back, stop every Alphion process, preserve the current v8 database and Project key directory for diagnosis, restore the verified adjacent `.v7-backup`, then run v0.8.0. v0.8.0 rejects schema v8 and cannot retain post-migration credential or Workspace writes. A missing Project key requires credential re-entry and is not database corruption.

## [0.8.0] - 2026-08-14

- Replaced password-gated startup credentials with a device-bound vault: first credential import provisions a 32-byte per-user device key, Project SQLite stores authenticated envelopes, Provider calls receive short-lived plaintext, and legacy password ciphertext remains `legacy-disabled` until explicit reset.
- Added model-aware, append-only context compaction records. Effective input budgets derive from catalog context windows at an 85% threshold after output, Tool-schema and safety reserves; unknown models use 32K and deterministic fallback always rebuilds from the raw branch.
- Added Project-scoped Goals with dedicated visible Sessions, append-only revisions, Evidence-backed Agent progress, user-only root/acceptance authority, advisory completion and explicit user confirmation.
- Added durable once/interval/five-field-Cron schedules with IANA timezone handling, bounded claims and leases, busy-Session follow-up, overlap audit, most-recent missed-run catch-up and process-local lifecycle.
- Extended shared commands, snapshots and TUI/Web/Desktop surfaces with `/context`, `/goals`, `/goal` and `/schedules`, draft-safe automatic refresh, hidden compaction bodies by default and bounded non-blocking activity fan-out.
- Made `alphion-icon.svg` the canonical brand source and deterministically generated Web favicon/PNG plus Windows multi-size ICO assets used by Web, Electron, installers, Start Menu entries and shortcuts.
- Migrated SQLite from user_version 6 to 7 after a verified adjacent `.v6-backup`; added Goal, Schedule, Compaction and device-credential tables without rewriting Session/Event history.

This pre-1.0 milestone adds public Goal, Schedule, Compaction and device-vault contracts and removes the old password Vault public API. To roll back, stop every Alphion process, preserve the failed/current v7 database for diagnosis, restore the verified adjacent `.v6-backup`, then run v0.7.0. v0.7.0 rejects schema v7 and cannot retain post-migration Goal, Schedule, Compaction or device-credential writes. Losing the device key is reported as `device-key-unavailable`; it is not database corruption and must never trigger database deletion.

## [0.7.0] - 2026-08-13

- Added deterministic `ProviderConversationPlan` projection so the current Run prompt appears exactly once, audit events remain outside Provider history, and assistant Tool batches pair with ordered observations.
- Hardened credential handling with one Vault decrypt lease per Provider call, best-effort temporary Buffer zeroing, sanitized HTTP/Vault error reasons, and catalog-only built-in model selection unless explicitly advanced.
- Added one shared slash command registry and palette across TUI, WebUI and Electron, including typed `project.inspect`, availability reasons and draft-preserving keyboard/mouse interaction.
- Kept TUI on the chat home during Runs and added shared waiting/streaming/tool/terminal conversation projection, in-place assistant bubbles, follow-up/steer/cancel input, and bounded 30 FPS rendering.
- Added full glass assistant bubbles, purposeful waiting/stream animations and reduced-motion/transparency fallbacks to the shared WebUI/Desktop Renderer without expanding IPC privileges.
- Restored TUI terminal lifecycle through alternate-screen cleanup and launcher clearing, eliminating stale startup menu output.

This pre-1.0 milestone adds public shared slash descriptors, `ConversationRunState`, `project.inspect` UI command and Provider conversation diagnostics while preserving SQLite user_version 6 and UI envelope/frame schema v1. Rollback to v0.6.0 needs no database migration; stop all processes and reinstall the matching Node/Electron dependency trees. Provider profiles saved with explicit unlisted-model opt-in remain data-compatible but v0.6.0 does not enforce the v0.7 catalog workflow.

## [0.6.0] - 2026-08-13

- Added revision-checked, idempotent transactional Session Fork across Core, SQLite, CLI, TUI, WebUI and Electron, with remapped independent history, preserved Evidence and immutable provenance.
- Migrated SQLite to schema v6 after a verified `.v5-backup`, enforcing same-Session parents/current leaves and retaining non-fork v5 Sessions without invented history.
- Added subscribe-first `surface.snapshot`, cursor-watermarked resync and bounded 30/60 FPS event frames so slow surfaces never block Agent execution.
- Added shared safe code projections with deterministic highlighting, streaming previews, bounded truncation, TUI `NO_COLOR`, and Web/Desktop copy/scroll rendering.
- Isolated Node and Electron `better-sqlite3` ABI install trees, added native preflight/doctor diagnostics, and stopped misclassifying `NODE_MODULE_VERSION` failures as database corruption.
- Added TUI `/fork` with argv-only new-terminal launch and failure recovery; Web/Desktop select a new Fork in the current surface.
- Enforced a 32768-byte limit for maintained source, tests, configuration, Trellis specs and docs, with explicit generated/binary/lockfile exceptions.

This pre-1.0 milestone adds public Session Fork, Session record schema v3, SQLite v6 and shared Snapshot/Frame contracts. To roll back, stop all Alphion processes, preserve the v6 files for diagnosis, restore the verified adjacent `.v5-backup`, then run v0.5.0; v0.5.0 rejects schema v6 and post-migration Fork data is not retained. Native ABI mismatch recovery repairs the corresponding install tree and never deletes the database.

## [0.5.0] - 2026-08-12

- Added case-insensitive/realpath-unique Project registration, one active Project writer, isolated per-Project SQLite state and a least-privilege unowned domain.
- Added bounded same-domain `session.send` collaboration with durable receipts, idle target Run leases, busy target agent steering, idempotency and hop/send limits.
- Replaced experimental `node:sqlite` with `better-sqlite3`, migrated to schema v5 with `.v4-backup`, and decoupled durable event writes from per-subscriber bounded UI queues/resync.
- Added mainland/international DeepSeek, Kimi, Qwen and GLM catalog presets whose official Base URLs stay hidden; custom compatible Providers remain URL-validated.
- Rebuilt the Simplified Chinese TUI around chat and reusable inputs; added shared safe GFM/TeX Markdown rendering with no reasoning projection.
- Added a loopback-only React/Vite WebUI with strict commands, HttpOnly/Origin/CSRF security, cursor SSE, revision recovery, dedicated credential and digest-bound approval flows.
- Replaced the v0.4.x Desktop JSONL Host with a sandboxed Electron workbench, narrow allowlisted preload IPC and unsigned Windows x64 NSIS/portable packaging.

This pre-1.0 milestone intentionally changes the Desktop public contract and Session/Project schema. JSONL clients must stay on v0.4.x or migrate to Web command/SSE or Electron IPC. To roll back state, stop all Alphion processes, restore the adjacent `.v4-backup`, then run v0.4.0; v0.4.0 rejects schema v5 and post-migration data is not retained.

## [0.4.0] - 2026-08-12

- Added deterministic four-scope resource manifests, provenance-aware resolution and versioned SystemPrompt plans.
- Added Session-bound lazy Agent shapes, explicit reshape, shape-aware approval/cache identity and SQLite schema v4 with recoverable v3 backups.
- Split model metadata/routing/provider resolution from concrete SDK construction and added stable runtime/providers/resources subpath exports.
- Added an injectable Desktop stdin/stdout JSONL RPC host with handshake, subscriptions, cancellation, fail-closed approvals and no credential commands.
- Added CLI and Simplified Chinese Ink TUI shape/resource workflows.

This pre-1.0 milestone changes public ResourceLoader, Session and application contracts. To roll back, stop Alphion, replace the v4 database with its adjacent `.v3-backup`, then run v0.3.2; v0.3.2 cannot open schema v4 and post-migration data will be lost.

## [0.3.2] - 2026-08-12

- Breaking: replace run-centric public entry points with a shared `Agent` and durable `AgentSession` façade.
- Add provider-independent `AgentMessage`, adapter-facing `ProviderMessage`, deterministic HarnessPlan, AgentEnvironment and bounded ResourceLoader contracts.
- Add branch-rebuilt context compaction with same-provider no-tool structured summaries, deterministic required-field fallback, and transient-only reasoning delivery that never enters SQLite or replay.
- Migrate SQLite v2 to v3 with adjacent `.v2-backup`, append-only session branches, revision/idempotency checks, durable queues and per-session run leases; v2 audit data remains read-only.
- Add CLI session create/list/show/checkout/send/steer/follow-up and harness plan workflows; TUI runs through the session boundary.
- Rollback: stop Alphion, restore the checkpointed and validated single-file v2 snapshot, then return to `v0.3.1`. Schema-v3 session data is not retained.

All notable changes to Alphion are documented here. Before 1.0, compatible increments advance the current `0.x.y` line and larger milestones advance to a new `0.x.0`; detailed architecture research remains in the local, Git-ignored design workspace.

## [0.3.1] - 2026-08-12

### Added

- Added the complete Phase 1 runtime baseline: deterministic read-only Node/TypeScript Project Profile, a bounded automatic ContextPack, and replayable run-scoped Working Memory.
- Added `project inspect [--refresh] [--json]` and offline, non-migrating `doctor [--json]` commands.
- Added `project.profiled` and `context.assembled` critical events with bounded summaries and explicit ContextPack omissions.
- Added a persistent Windows launcher menu for workbench, diagnostics, help, and exit.

### Changed

- Rebuilt the Ink TUI as a Simplified Chinese engineering workbench with responsive sidebar/top navigation, compact mode, consistent status/error/empty states, and `NO_COLOR` support.
- Moved DeepSeek/OpenAI-compatible presets behind the local application façade and reused one session-scoped L1 cache, tool registry, and profiler service.
- Replaced the timestamp-based filesystem revision overflow marker with a stable bounded identity and expanded the safe scan limit to 20,000 paths.

### Security and compatibility

- Project inspection skips symlinks, dependency/build/local-state directories, secret-like paths, oversized configuration content, and never asks a model to invent missing facts.
- Doctor performs no network calls, database migrations, credential resolution, or plaintext output; future/corrupt SQLite state fails visibly.
- `ALPHION_BRAND`, ProviderProfile schema v2, SQLite user_version 2, OpenAI-compatible and DeepSeek behavior, and the dependency set are unchanged.

### Rollback

- Return to tag `v0.3.0`. No persistent schema migration is required; cached Project Profiles are disposable.

## [0.3.0] - 2026-08-11

### Added

- Added an Ink/React TUI for provider configuration, masked API-key import, single-run streaming, exact tool approval, cancellation, and collapsed DeepSeek reasoning.
- Added a dedicated `DeepSeekProvider` for `deepseek-chat` and `deepseek-reasoner`, including reasoning continuation, function tools, cached-token usage, bounded retry, timeout, and cancellation.
- Added a versioned encrypted SQLite credential vault and core provider-configuration/local-application contracts.
- Completed the local Phase 1–6 Agent system design, implementation-status matrix, and DeepSeek/vault operational runbook.

### Security

- API keys stored locally use scrypt-derived AES-256-GCM encryption with random nonces and authenticated profile/revision binding; plaintext keys and master passwords never enter SQLite, events, cache, or logs.
- The vault locks explicitly or after 15 minutes of inactivity. Password rotation is transactional; destructive reset removes ciphertext credentials while preserving provider profiles.
- TUI output strips terminal control characters, masks credentials, and treats reasoning as untrusted non-evidence.

### Changed

- Advanced provider profiles and project-local SQLite state from schema v1 to v2. Existing environment-backed profiles migrate transactionally as `openai-compatible`.
- Extended core provider messages/events with separately typed reasoning content and included it in cache identity and output budgets.
- Added Ink and React only to the TUI adapter layer; `src/` remains independent of UI, SDK, and SQLite runtime implementations.

### Compatibility and rollback

- `ALPHION_BRAND` and the three SVG mappings are unchanged. Existing OpenAI-compatible environment profiles remain usable after migration.
- Schema-v2 state cannot be opened by v0.2.1. Back up `.alphion/alphion.sqlite3` before upgrading if binary rollback is required.

## [0.2.1] - 2026-08-11

### Added

- Added the first bounded `AgentRuntime` and public provider, run, event, tool, approval, cache, event-store, policy, and secret-reference contracts.
- Added an OpenAI-compatible adapter for both Chat Completions and Responses with streaming, tool calls, prompt-cache metrics, cancellation, bounded retry, and non-streaming fallback.
- Added project-local SQLite provider profiles, hash-chained audit events, cache entries, shell policies, schema migration, and integrity verification.
- Added L1/L2 caching with project/policy/permission/mutation invalidation, single-flight request sharing, evidence-aware project tools, a one-shot CLI, and `alphion.bat`.
- Added deterministic fake-provider, storage, cache, security, CLI, protocol, smoke, and benchmark coverage.

### Security

- API keys are resolved only from named environment variables and are never persisted in provider profiles, events, cache keys, or child-process environments.
- Secret-like model inputs/outputs skip local caches, and persisted event payloads redact recognized credential patterns.
- `edit`, `write`, and allowlisted `shell` require exact per-call approval; non-interactive runs deny them automatically.
- Project tools reject root escape, symlink escape, internal state, dependencies, generated output, oversized/binary data, common secret paths, stale writes, and changed executable digests.

### Changed

- Raised the Node.js engine floor to 22.13 for built-in SQLite and changed the compiled package layout to preserve the core/adapter boundary.
- Added the official `openai` JavaScript client as the only runtime dependency; provider and SDK types remain outside the core.
- Advanced the documented baseline from design-only v0.2.0 to the runnable OpenAI-compatible foundation in v0.2.1.

### Compatibility

- `ALPHION_BRAND`, `AlphionBrand`, and all three SVG mappings remain unchanged.
- New Agent interfaces are additive. Local `.alphion/` state starts at schema version 1 and readers fail closed on future schemas.

### Rollback

- Return to tag `v0.2.0`. The new `.alphion/` database is ignored local state and can be backed up or removed; no tracked project migration is required.

## [0.2.0] - 2026-08-11

### Added

- Established an executable Agent engineering system covering delivery lifecycle, repository and contract ownership, deterministic testing, probabilistic evaluation, observability, operations, release evidence, supply-chain controls, governance, and continuous improvement.
- Added reusable ADR, design proposal, evaluation plan, and runbook templates to the local engineering handbook.
- Defined prompts, model snapshots, tool schemas, policies, datasets, memory rules, and harness recipes as versioned and reversible engineering artifacts.

### Changed

- Promoted the project from an architecture-only baseline to an architecture and engineering-design baseline.
- Clarified that build execution follows all content and static validation gates.

### Compatibility

- No public TypeScript API or runtime dependency changes.
- `ALPHION_BRAND` and all three SVG asset mappings remain unchanged.

### Rollback

- Return to commit `e3feb3b` or the previous `0.1.0` package version; no state or schema migration is required.

## [0.1.0] - 2026-08-11

### Added

- Established the Node.js 22+, TypeScript, ESM, and zero-runtime-dependency baseline.
- Added the stable `ALPHION_BRAND` public interface and system SVG assets.
- Defined tracked TUI and WebUI adapter boundaries while keeping Agent implementation out of the baseline.
