# Changelog

All notable changes to SynapseHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-04-29

### Security
- **S1** Timing-safe token comparison via `subtle::ConstantTimeEq` ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- **S2** Token entropy fixed: `OsRng` 32 bytes → 64 hex consistent ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- **S3** `0600` perms on Unix for `hook_token` file ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- **S4** Rate limit `POST /hook` to 10 req/s via `tower_governor` ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- **S12** `cargo audit` step added in CI as hard gate ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- **S13** Frontend deps audit fix: vite 6.4.2, postcss 8.5.12 ([#12](https://github.com/thierryvm/SynapseHub/pull/12))
- Bumped `rustls-webpki` 0.103.10 → 0.103.13 (fixes RUSTSEC-2026-0098 / 0099 / 0104)
- Bumped `git2` 0.19 → 0.20.4 (fixes RUSTSEC-2026-0008)
- 19 transitive advisories documented in `audit.toml` with rationale + GitHub trackers ([#13](https://github.com/thierryvm/SynapseHub/issues/13), [#14](https://github.com/thierryvm/SynapseHub/issues/14), [#15](https://github.com/thierryvm/SynapseHub/issues/15))

### Tests
- 13 new router-level tests via `EventEmitter` trait (10 → 23 on Windows / 24 on Unix)
- Vitest now runs in CI

### UX
- Settings modal: Claude Code Terminal added to the detected agents wording
- Settings modal: code block uses `white-space: pre-wrap` for full token visibility
- Settings modal: explicit user-level vs project-level paths documented
- Empty state: removed redundant `hero-orbit`, single visual focus
- Header `agent-badge`: `-webkit-app-region: no-drag` so clicks don't trigger a window drag

## [0.1.0] - 2026-03-27

### Added
- MVP: tray icon + dashboard + Claude Code Stop hook + multi-IDE detection
- Auto-updater (tauri-plugin-updater + GitHub Releases, signed)
- Cross-platform window focus by PID (Windows / macOS / Linux)
- CI workflow: Rust fmt / clippy / test on every push and PR
