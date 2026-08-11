# Changelog

All notable changes to Alphion are documented here. The project follows Semantic Versioning; detailed architecture research remains in the local, Git-ignored design workspace.

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
