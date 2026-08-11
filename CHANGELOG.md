# Changelog

All notable changes to Alphion are documented here. Before 1.0, compatible increments advance the current `0.x.y` line and larger milestones advance to a new `0.x.0`; detailed architecture research remains in the local, Git-ignored design workspace.

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
