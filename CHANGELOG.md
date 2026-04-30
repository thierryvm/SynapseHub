# Changelog

All notable changes to SynapseHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-30

### Changed
- **UX/UI rework global** ([#30](https://github.com/thierryvm/SynapseHub/issues/30)) — refonte visuelle complète intégrée depuis le livrable Claude Design (claude.ai/design). Direction validée @thierry : Dark-first / hybride moderne / **cyan néon HUD subtil** (cohérent icône systray) / **Inter Display + JetBrains Mono Variable** / 4 piliers UX (adaptive density, responsive, settings drawer JSON, onboarding guide).
- **Design tokens centralisés** dans `src/styles/tokens.css` (palette OKLCH dark + variant `[data-theme="light"]`, typographie, spacing 4px-base, radius, shadows, focus ring HUD, motion durations, layout, density modes). 9 fichiers de composants modulaires sous `src/styles/components/` (header, stats, toolbar, session-card, drawer, empty, onboarding, toast, footer).
- **Session card status-led** — border-left coloré + dot animé selon `data-status` (running mint / waiting amber / stopped neutre / error rouge). Glyphe IDE monochrome 2-lettres (CC, CD, CR, CX, AG, WS, VS, AI, CL, OH) avec teinte par IDE, runtime pill mono-format. Hover révèle les actions, click reste cliquable partout sur la carte.
- **Settings drawer** (remplace l'ancienne modal v0.1.x) — slide-in droit, JSON config syntax-highlighted (token classes `.tk-key`, `.tk-str`, `.tk-num`, `.tk-bool`, `.tk-null`, `.tk-punct`), bouton **Copier** avec feedback visuel ✓ + état `data-state="copied"` 1.8s. Section update intégrée (check + install). Fermeture par clic backdrop, croix, ou `Escape`.
- **Adaptive density** — `data-density="confortable"` (défaut) ↔ `data-density="compact"` (auto > 10 sessions actives). Tokens density-aware (`--row-h`, `--row-pad-y`, `--row-pad-x`, `--row-gap`, `--card-pad`, `--stack-gap`).
- **Responsive** via CSS Container Queries — breakpoints 320 / 380 / 480 / 800 / 1200px+ sur header, stats, session-list, drawer, footer, onboarding. Adaptation graceful (tagline cachée < 480px, status label caché < 480px, drawer pleine largeur < 480px).
- **Empty state guidant** — illustration animée + 1-2-3 steps (ouvrir un terminal IA / configurer le hook / cliquer une carte pour focus). Remplace l'ancien empty state minimal.
- **Footer status bar** — daemon dot, session count avec icône CPU, footer detail dynamique, lien guide (`btn-show-onboarding`), version.
- **Header** — brand mark + tagline "Multi-agent orchestration desk" + privacy chip "100% local · zéro télémétrie" + active badge HUD avec dot pulsant + window controls (settings / minimize / close).
- **`focus_window` Tauri command** — la commande retourne `bool` depuis v0.1.4 ; le frontend log explicitement en console quand `focus_window` retourne `false` (terminal fermé).

### Added
- **Onboarding modal 3 slides** au premier lancement (Détection / Hook / Focus). Persistance via `localStorage.synapsehub_onboarding_completed_v0.2.0`. Re-accessible via le bouton "Guide" dans le footer. Bouton `Skip` pour fermer immédiatement, `Précédent` / `Suivant → Terminer` pour naviguer, dots indicateurs.
- **CSP corrigé** dans `index.html` : `connect-src 'self' ipc: http://ipc.localhost https://fonts.googleapis.com https://fonts.gstatic.com` + `font-src 'self' https://fonts.gstatic.com`. Fixe le bug v0.1.x où l'IPC Tauri faisait un fallback `postMessage` (lossy) faute de `connect-src` explicite.

### Fixed
- **Auto-hide après focus IDE** ([#28](https://github.com/thierryvm/SynapseHub/issues/28)) — porte le fix v0.1.5 dans la nouvelle architecture. Quand l'utilisateur clique une session card et que `focus_window` retourne `true`, SynapseHub se masque automatiquement (`hide_window`) pour laisser place à la fenêtre IDE. La dashboard `alwaysOnTop: true` masquait sinon visuellement le terminal qui avait pourtant le focus clavier.

### Removed
- **DevTools en build release** — désactivés par défaut. Précédemment activés temporairement en v0.1.4 pour le diagnostic du bug focus, ils sont maintenant gated derrière la feature Cargo `debug-devtools` (`cargo tauri build --features debug-devtools`). En prod, la WebView inspector n'est plus compilée dans le binaire.
- **Ancien hero panel + orbites animées** — remplacés par le nouveau header + stats grid plus dense.
- **Ancien settings modal** — remplacé par le drawer slide-in.

### Tests
- Tests Rust : 43/43 inchangés (régression-zéro sur watcher, focus, hooks).
- Tests Vitest : 7/7 inchangés (`session-view.ts` augmenté avec `getStatusDataAttr`, `getStatusLabelShort`, `ideKey`, `ideGlyph` — les utilitaires legacy `summarizeSessions`, `getStatusKey`, etc. restent exportés pour la compat tests).
- Build vite : 14 KB HTML, 35 KB CSS (7 KB gzip), 20 KB JS (7.2 KB gzip).
- `cargo build --features debug-devtools` valide la feature flag opt-in.

## [0.1.4] - 2026-04-30

### Fixed
- **Watcher — faux positifs path résolution** ([#26](https://github.com/thierryvm/SynapseHub/issues/26)). `is_system_path` étendu pour rejeter `\system32`, `\syswow64`, `:\windows\…`, `/system/`, `/usr/sbin`. Le pattern Windows est anchored sur `:\windows\` (drive-letter prefix) pour ne pas flagger des projets utilisateurs comme `F:\PROJECTS\windows-toolbox`. Sans ce fix, un PowerShell admin lancé depuis `C:\WINDOWS\system32` faisait apparaître une session fantôme dans le dashboard.
- **Watcher — exiger un marqueur de projet** ([#26](https://github.com/thierryvm/SynapseHub/issues/26)). `normalize_project_path` n'accepte plus tout dossier existant en fallback de `git2::Repository::discover` : nouvelle fonction `has_project_indicator` qui exige `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle[.kts]`, `Gemfile`, `composer.json`, `.project`, `.vscode`, ou `.idea`. Sans ce fix, une session CC Terminal lancée depuis un dossier container (ex : `F:\PROJECTS\Apps\` sans `.git` propre) pollait le dashboard avec une fausse entrée "Apps".
- **One-click focus — terminaux modernes** ([#26](https://github.com/thierryvm/SynapseHub/issues/26)). `focus_window_by_pid` remonte désormais la chaîne `parent_pid` (jusqu'à 5 hops, avec cycle guard) avant de tester chaque PID via `EnumWindows`. Cause primaire : un process `claude.exe` (CLI) hébergé dans `pwsh.exe` → `WindowsTerminal.exe` n'a pas de HWND propre — la fenêtre visible appartient au terminal host plusieurs hops au-dessus. Pattern identique sur macOS (`iTerm2`, `Terminal.app`) et Linux (`gnome-terminal`, `konsole`, `alacritty`).

### Changed
- **`focus_window` Tauri command** retourne désormais `bool` (au lieu de `()`) pour que le frontend logge en console DevTools si le focus a échoué (ex : terminal fermé entre la détection et le clic). Le frontend log un `console.warn` explicite dans ce cas.
- **DevTools activés en build release** (Cargo feature `tauri/devtools` + `app.windows[].devtools: true` dans `tauri.conf.json`). Permet le diagnostic terrain via `Ctrl+Shift+I`. Sera reverté en v0.2.0 derrière un Cargo feature flag conditionnel (sprint UX/UI rework).

### Tests
- 13 nouveaux tests unitaires dans `watcher::tests` :
  - `is_system_path` étendus : `flags_windows_system32_as_non_project`, `flags_windows_syswow64_as_non_project`, `flags_generic_windows_dir_as_non_project`, `does_not_flag_user_projects_with_windows_in_name`, `flags_unix_system_locations_as_non_project`.
  - `has_project_indicator` : `accepts_git_repo`, `accepts_node_project`, `accepts_rust_project`, `rejects_empty_container`.
  - `normalize_project_path` end-to-end : `rejects_container_dir_without_project_marker`, `accepts_dir_with_project_marker`, `rejects_nonexistent_path`, `rejects_system_path_even_with_marker`.
- 3 nouveaux tests unitaires dans `focus::tests` : `chain_starts_with_self`, `chain_is_bounded`, `chain_has_no_duplicates`.
- Tests Rust : 27 → 43. Tests vitest : 7/7 inchangés.

## [0.1.3] - 2026-04-29

### Fixed
- **Watcher Windows — détection Claude Code Terminal CLI v2026** ([#24](https://github.com/thierryvm/SynapseHub/issues/24)). Le pattern matching dans `detect_ide_name` était trop restrictif (`claude-code`, `@anthropic-ai`, `claude.cmd` uniquement) et misclassifiait les sessions CC Terminal CLI v2026 sur Windows comme `Claude Desktop`. La cmd line v2026 est ultra-minimaliste (`claude  --dangerously-skip-permissions -c`), sans path préfixe. Patterns élargis : `claude` / `claude.exe` / `"claude" ` (bare-name invocations), avec garde anti-faux-positif sur `\windowsapps\claude_` qui distingue l'Electron desktop.
- **Distinction Claude Desktop vs CC Terminal** — la branche Claude Desktop est désormais positivement gatée sur le path complet WindowsApps (Windows) ou `/applications/claude.app/` (macOS). Un `claude.exe` orphelin sans préfixe de path est traité comme CC Terminal et non plus comme Desktop.
- **Résolution `cwd` sur Windows** — le `RefreshKind` du watcher n'appelait jamais `.with_cwd(...)`, ce qui faisait que sysinfo Windows ne populait jamais le field `cwd` (cf. `sysinfo-0.33.1/src/windows/process.rs:816`). Conséquence : `process.cwd()` retournait `None` pour tous les processes, et la résolution du project path retombait silencieusement sur l'args fallback qui échoue pour CC Terminal CLI v2026 (cmd line sans path). Ajout de `.with_cwd(UpdateKind::OnlyIfNotSet)` aux deux `ProcessRefreshKind` (init + refresh loop).

### Tests
- 4 nouveaux tests unitaires dans `watcher::tests` :
  - `detects_claude_code_terminal_cli_v2026_windows` — reproduce @thierry smoke-test
  - `detects_claude_code_terminal_cli_minimal` — invocation `claude` seule
  - `does_not_misclassify_claude_desktop_as_terminal` — primary process WindowsApps
  - `does_not_misclassify_claude_desktop_subprocess_as_terminal` — Electron renderer/utility
- Tests Rust : 23 → 27 (Windows local). Régression-safe : les 9 tests `watcher::tests` existants restent verts.

### Documentation
- Note d'investigation `analysis/2026-04-29-watcher-windows-cwd-investigation.md` (cause primaire, cause secondaire, sources sysinfo cross-checkées) pour traçabilité du diagnostic.

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
