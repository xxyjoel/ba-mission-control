# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — Unreleased

First public open-source release.

### Added
- **Matrix** green-phosphor theme, selectable in Settings → Colors or via
  `:theme matrix`. BlueArch remains the default palette.
- `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and a PR
  template for open-source contribution.
- npm packaging as the scoped public package `@bluearch/mission-control`
  (`npx @bluearch/mission-control`), with a `files` allowlist so only runtime
  code ships.
- CI dependency-audit job (`npm audit`).

### Changed
- Hardened hook-settings command construction to quote executable/emitter paths
  (safe under install directories containing spaces).

### Notes
- Everything runs locally: no telemetry, no network service, no account beyond
  your own Claude authentication.
