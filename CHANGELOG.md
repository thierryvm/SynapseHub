# Changelog

All notable changes to SynapseHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-04-29

### Fixed
- **Updater pipeline** — `createUpdaterArtifacts: true` ajouté dans `tauri.conf.json` `bundle` (validé sur 3/4 OS via la rc.1 : Linux + macOS Intel + macOS Apple Silicon ont tous publié `latest.json` + `.sig`). Sans cette ligne, Tauri 2 stable ne génère pas les artefacts updater. Référence : [#17](https://github.com/thierryvm/SynapseHub/issues/17).
- **Windows MSI version format** — pre-release suffix retiré pour respecter la contrainte `MAJOR.MINOR.PATCH.BUILD` numeric-only de WiX/MSI. La rc.1 avait fail sur ce point spécifique (`0.1.2-rc.1` rejeté par le bundler MSI), résolu par construction en taguant directement `0.1.2`.

### Changed
- Nouvelle paire de clés minisign générée. Pubkey rotée dans `tauri.conf.json` (fingerprint `3877AE0A82FBBFE`, vs précédent `BD5AA9E173A8A318`). Les anciens binaires v0.1.1 ne pourront pas valider les updates v0.1.2 — réinstall manuelle requise pour les early adopters de v0.1.1.

## [0.1.2-rc.1] - 2026-04-29

### Fixed
- **release pipeline** — `createUpdaterArtifacts: true` ajouté dans `tauri.conf.json` `bundle`. Sans cette option, Tauri 2 stable n'émet ni `latest.json` ni les `.sig` updater (régression silencieuse côté framework, opt-in explicite obligatoire). C'est ce qui a empêché l'auto-update à v0.1.1. Référence : [#17](https://github.com/thierryvm/SynapseHub/issues/17).

### Changed
- Nouvelle paire de clés minisign générée pour repartir sur une chaîne de signing dont le password (vide) est documenté. Pubkey rotée dans `tauri.conf.json` (fingerprint `3877AE0A82FBBFE`, vs précédent `BD5AA9E173A8A318`).

### Validation
- `v0.1.2-rc.1` est tagged d'abord pour valider le pipeline (présence de `latest.json` + `.sig` dans les assets de la release). `v0.1.2` stable suit uniquement si la rc passe le gate post-build.

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
