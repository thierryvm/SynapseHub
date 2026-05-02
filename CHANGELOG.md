# Changelog

All notable changes to SynapseHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (v0.3.0 Vague 1 — #33 + #34)
- **Frame: maximize/restore button** ([#33](https://github.com/thierryvm/SynapseHub/issues/33)) — bouton SVG inséré entre minimize et close. Icône swap automatique entre carré simple (état normal → "Agrandir") et double-carré chevauché (état maximisé → "Restaurer"). Sync via `WebviewWindow.onResized` listener pour rester aligné avec l'état réel même si l'utilisateur maximise via raccourci OS (Win+Up, drag-to-edge, double-click titlebar). Nouveaux helpers `buildMaximizeIcon` / `buildRestoreIcon` dans `src/icons.ts`, helper DI `setMaximizeButtonState(button, maximized)` dans `src/session-view.ts` (zero `innerHTML`).
- **Settings: "Garder dans la barre des tâches" toggle (Option A)** ([#34](https://github.com/thierryvm/SynapseHub/issues/34)) — ajouté sous "Toujours au premier plan" dans le drawer settings. **OFF par défaut** : SynapseHub reste un compagnon tray invisible (comportement actuel préservé). **ON** : la fenêtre apparaît dans la barre des tâches Windows / Dock macOS, et le bouton réduire effectue un minimize OS classique au lieu d'envoyer dans le tray. Persistance `localStorage.synapsehub_keep_taskbar`. Helpers DI `setKeepTaskbarToggle`, `restoreKeepTaskbarFromStorage`, `getKeepTaskbarPreference`, constante `KEEP_TASKBAR_KEY` exportés depuis `src/session-view.ts` (pattern aligné sur `setAlwaysOnTopToggle`).
- **Commande Tauri `toggle_maximize`** (`src-tauri/src/lib.rs`) — flippe entre maximisé et normal, retourne le nouvel état (`Result<bool, String>`) pour que le frontend swap l'icône sans poll séparé. Générique sur `R: Runtime` pour testabilité via `MockRuntime`.
- **Commande Tauri `set_keep_taskbar(keep: bool)`** (`src-tauri/src/lib.rs`) — appelle `WebviewWindow::set_skip_taskbar(!keep)` ; sur macOS flippe aussi `app.set_activation_policy(Regular ↔ Accessory)` pour que le toggle soit visible (sans le 2ème op, `set_skip_taskbar(false)` seul est un no-op sur macOS car l'activation policy fixée en `setup` neutralise la visibilité). Générique sur `R: Runtime`.
- **Commande Tauri `minimize_window`** (`src-tauri/src/lib.rs`) — minimize OS-natif, distinct de `hide_window` (qui envoie au tray). Utilisée quand l'utilisateur a activé "Garder dans la barre des tâches". Générique sur `R: Runtime`.

### Changed
- **Bouton minimize (`-`) respecte la nouvelle préférence "Garder dans la barre des tâches"** — preference OFF (défaut) : `hide_window` (tray, comportement v0.2.x préservé). Preference ON : `minimize_window` (minimize OS natif). La préférence est lue à chaque clic, donc le toggle prend effet immédiatement sans redémarrage. Logique dans `src/main.ts` ; choix arbitré Option β par @cowork (cohérence UX : si l'utilisateur a demandé la taskbar, il s'attend à un vrai minimize).

### Tests (Vague 1)
- **3 tests Rust err-only** dans `src-tauri/src/lib.rs` (module `vague_1_window_controls_mock_app`, gated `#[cfg(not(target_os = "windows"))]` — même contrainte que les helpers single-instance v0.2.1) : `minimize_window_errors_when_dashboard_window_absent`, `toggle_maximize_errors_when_dashboard_window_absent`, `set_keep_taskbar_errors_when_dashboard_window_absent`. Couvrent la branche `dashboard window not found` ; le happy path dépend de `WebviewWindow::{minimize, is_maximized, set_skip_taskbar}` que `MockRuntime` n'implémente pas, validé via Vitest (helpers DI) + smoke test @thierry.
- **8 tests Vitest** dans `src/session-view.dom.test.ts` (env jsdom) : 5 sur `setKeepTaskbarToggle` / `restoreKeepTaskbarFromStorage` / `getKeepTaskbarPreference` (lifecycle ON/OFF + restore + default + preference probe), 3 sur `setMaximizeButtonState` (swap icône + aria-label + cleanup children). Pattern aligné sur les tests `AlwaysOnTop` v0.2.0.

### Added (v0.3.0 Vague 2b — closes [#35](https://github.com/thierryvm/SynapseHub/issues/35))

- **Stats cards interactives en filter shortcuts** ([#35](https://github.com/thierryvm/SynapseHub/issues/35)) — les cartes "EN COURS" et "EN ATTENTE" sont désormais cliquables (transformées en `<button>` accessibles, `aria-pressed` dynamique, focus ring HUD) et appliquent un filter sur la session-list. Click sur card active = clear filter (option θ toggle behavior arbitrée @cowork). Visual highlight via tokens design system v0.2.0 (border `currentColor` + glow cyan/mint/amber selon `data-tone` + bg-tint, zero nouveau token). État persisté en `sessionStorage.synapsehub_active_filter` (PAS `localStorage` — reset au redémarrage app par design pour éviter UX collante après tray close + reopen).
- **Empty state filter contextuel** — quand un filter actif matche zéro session (ex: "EN COURS" filter avec 0 session Running mais d'autres sessions Waiting visibles), affiche un message "Aucune session en cours actuellement" + bouton "Effacer le filtre" qui clear le filter et restaure la vue complète. Distinct du global empty-state ("Lancez Claude Code…") qui n'apparaît que quand le watcher voit zéro session totale.
- **Carte "PROJETS SUIVIS" reste informative-only** — option δ arbitrée @cowork (le compteur de groupes de projets est sémantiquement différent d'un statut de session, transformer en filter serait conceptuellement étrange). La carte reste un `<article>` non-interactif. Un futur group-by-project ergonomique (expand/collapse) sera traité comme feature dédiée v0.4.0+ si besoin réel observé.
- **Helpers DI dans `src/session-view.ts`** : type `ActiveFilter = "running" | "waiting" | null`, constante `ACTIVE_FILTER_KEY`, fonctions `getActiveFilter` / `setActiveFilter` / `clearActiveFilter` (avec injection `StorageLike` pour testabilité), `filterSessions(sessions, filter)`, `setStatsCardActiveStates(cards, filter)`, `nextFilterAfterClick(current, clicked)` (pure function pour la logique toggle θ).
- **Élargissement type `StorageLike`** : ajout `removeItem` à `Pick<Storage, …>` pour supporter `setActiveFilter(null)` qui supprime l'entrée sessionStorage (au lieu d'écrire une string vide).

### Tests (Vague 2b)

- **17 nouveaux tests Vitest** dans `src/session-view.dom.test.ts` (env jsdom) — total 30 → 47 :
  - 6 sur la persistance filter (sessionStorage round-trip ON/OFF, clear, default null, validation valeur invalide, anti-cross-contamination avec localStorage)
  - 4 sur `filterSessions` (passthrough null, "running" / "waiting" filtering, empty array)
  - 3 sur `nextFilterAfterClick` (toggle clear sur card active, swap sans null intermédiaire, activation depuis null)
  - 4 sur `setStatsCardActiveStates` (running aria-pressed, waiting aria-pressed, null clear both, round-trip sequence)

### Tests (Vague 2a — refs [#43](https://github.com/thierryvm/SynapseHub/issues/43), opens [#45](https://github.com/thierryvm/SynapseHub/issues/45))

Baseline test coverage pour `detect_ide_name` (`src-tauri/src/watcher.rs`). Les patterns `name_lower.contains(...)` pour Codex / Cursor / Windsurf / Aider / Cline / OpenHands existaient déjà mais sans tests dédiés ; ce bloc pin le comportement actuel comme baseline avant tout futur affinement (qui n'arrivera qu'avec data empirique sur les invocations CLI bundled dans Node ou Python).

- **11 nouveaux tests Rust** dans `watcher::tests` :
  - `detects_openai_codex_desktop_via_windowsapps_path` — Codex desktop OpenAI via Microsoft Store. Pattern OK ; le filtrage `resolve_project_path` (cwd dans WindowsApps = `system_path` rejeté) est tracké séparément en [#45](https://github.com/thierryvm/SynapseHub/issues/45) (v0.4.0 candidate)
  - `detects_cursor_from_process_name` + `detects_cursor_subprocess` — Cursor.exe + sub-processes Electron `--type=renderer`
  - `detects_windsurf_from_process_name` — Windsurf.exe (Codeium fork)
  - `detects_aider_from_process_name_when_packaged` — pour les builds PyInstaller / pip-shim qui produisent un `aider.exe`
  - `aider_python_module_invocation_currently_unmatched_regression_check` — bookmark régression : `python -m aider` sous `python.exe` n'est PAS matché par le pattern actuel ; le test pin ce comportement pour qu'un futur affinement (post-empirical-diagnostic) soit une flip intentionnelle de None → Some("Aider")
  - `detects_cline_from_process_name` — pour le cas standalone hypothétique
  - `cline_vscode_extension_currently_unmatched_regression_check` — bookmark régression : Cline en extension VSCode (host = `code.exe`) tombe sur le fallback "VSCode" actuel ; tracké pour refinement futur
  - `detects_openhands_from_process_name` — pour les builds standalone PyInstaller
  - `openhands_docker_host_currently_unmatched_regression_check` — bookmark régression : OpenHands Docker (host = `docker.exe`) hors scope du watcher (introspection `docker ps` requise)
  - `does_not_misclassify_unrelated_node_processes` — sanity check : npm/Vite/MCP servers Node ne sont pas faux-positifs

Les tests `*_currently_unmatched_regression_check` documentent intentionnellement les limites du pattern matching actuel comme bookmarks pour refinement futur — ils seront flippés positifs dès qu'on aura des cmd lines empiriques d'invocations Aider Python / Cline VSCode-extension / OpenHands non-Docker (cf. [#43](https://github.com/thierryvm/SynapseHub/issues/43) reste ouvert pour ce scope).

## [0.2.1] - 2026-05-01

Hotfix sprint pour [#39](https://github.com/thierryvm/SynapseHub/issues/39) — single-instance lock + clean update flow. Adresse les deux régressions de cycle de vie observées sur v0.2.0 :
- Lancer SynapseHub deux fois (raccourci, double-clic, démarrage Windows) ouvrait deux instances qui se battaient sur le même port hook + tray icon.
- Cliquer "Installer la mise à jour" tuait l'app en cours sans confirmation et sans signaler à l'utilisateur que le redémarrage était volontaire.

### Added
- **`tauri-plugin-single-instance` v2** — de première classe dans la chaîne de plugins (`src-tauri/src/lib.rs`). Verrou OS (mutex Windows, socket UNIX macOS/Linux) posé avant tout autre init Tauri. Une 2ème tentative de lancement reçoit un refus immédiat ; le callback dans le processus principal journalise les `argv` + `cwd` rejetés et refocus le dashboard via `focus_primary_dashboard` (unminimize + show + set_focus). Évite la duplication watcher / hook server / tray icon. Helper `handle_second_instance_attempt(&AppHandle, &[String], &str)` extrait pour testabilité.
- **Commande Tauri `quit_and_install_update`** (`src-tauri/src/lib.rs`) — appelée par le frontend après que le plugin updater a téléchargé + spawné l'installeur. Log explicite ("exiting cleanly so the installer can swap the binary") puis `app.exit(0)` — l'exit du process primary devient intentionnel et tracé, plutôt que de dépendre du comportement implicite du plugin updater. Générique sur `Runtime` pour tests sur `MockRuntime`.
- **Modal de confirmation update** (`index.html` + `src/main.ts`) — clic sur "Installer la mise à jour" n'installe plus directement ; ouvre une modal qui explique que SynapseHub doit redémarrer pour que l'installeur remplace le binaire ("Tes sessions Claude détectées seront re-scannées au redémarrage."). Boutons **Annuler** (ferme la modal, garde l'état actuel) + **Quitter et installer** (download → `quit_and_install_update`). Dismissal Esc + clic backdrop, cohérent avec le drawer settings et l'onboarding modal.
- **Toast post-update** (`src/main.ts`, `src/session-view.ts`) — au redémarrage après une mise à jour, comparaison `localStorage.synapsehub_last_version` vs version courante. Si la version a changé, surface un toast success "Mise à jour réussie · SynapseHub v{version} est maintenant actif." (3s auto-dismiss). Premier lancement silencieux mais stamp la version pour que le prochain upgrade soit détecté.
- **Toasts** (`src/session-view.ts`) — système de toasts générique (`showToast(region, opts)`) avec tones `success | error`, icônes alert + close, lien optionnel, auto-dismiss configurable. Construit 100% via `document.createElement` (security hook compliant, zero `innerHTML`). Fallback erreur update : toast avec lien direct vers `github.com/thierryvm/SynapseHub/releases`.

### Tests
- **3 tests Rust** dans `src-tauri/src/lib.rs` : `focus_primary_dashboard_no_panic_when_window_absent`, `handle_second_instance_attempt_invokes_focus_without_panic`, `quit_and_install_update_returns_ok` (async, sur `MockRuntime`). Gated `#[cfg(not(target_os = "windows"))]` pour contourner un STATUS_ENTRYPOINT_NOT_FOUND déclenché par `tauri::test::mock_app()` + feature `tray-icon` sur les binaires de test Windows ; couverts par la matrice CI macOS + Linux x64 + Linux ARM64.
- **6 tests Vitest** dans `src/session-view.dom.test.ts` : `attachUpdateConfirmHandlers wires both buttons`, `handleQuitAndInstall invokes the command`, `handleQuitAndInstall surfaces an error toast on reject` (avec lien fallback releases), `notifyUpdateSuccessIfNeeded shows toast on version change` (stamp persisté), `first launch silent but stamps`, `showToast renders icon + body + close`. 22 tests Vitest verts au total.

## [0.2.0] - 2026-04-30

### Fixed (pre-tag focus UX hardening)
- **Click handler restreint au bouton focus** — la zone neutre des session cards (project name, path, IDE glyph, status pill) n'invoque plus rien au click. Avant le pre-tag fix, le listener était attaché à la fois à toute la `.session-card` ET au bouton focus, ce qui créait deux pièges UX révélés au smoke test v0.1.5 : (a) un click n'importe où sur la card déclenchait le flow focus + auto-hide, (b) le double listener pouvait fire en parallèle (bubble vs capture) et causait le bug intermittent "il faut le faire plusieurs fois". Le handler est maintenant uniquement sur `BUTTON[data-action="focus"]`. Le `keydown` Enter/Space reste sur la card pour préserver l'accessibilité clavier.
- **alwaysOnTop dynamique au lieu de statique** — le flag dans `tauri.conf.json` est `false` par défaut. SynapseHub démarre comme une fenêtre normale qui peut passer en arrière-plan. Un toggle "Toujours au premier plan" dans le settings drawer permet d'activer le comportement HUD-overlay si l'utilisateur le souhaite. Préférence persistée dans `localStorage.synapsehub_always_on_top`. Avant, `alwaysOnTop: true` statique bloquait toutes les fenêtres tierces (y compris celles ramenées en Alt+Tab) — comportement invasif pour un companion tray tool.
- **Action post-focus non destructive** — après un `focus_window === true`, on appelle désormais `set_always_on_top(false)` au lieu de `hide_window`. SynapseHub reste **visible** mais peut être recouverte par l'IDE, au lieu de disparaître complètement dans le tray. Récupération via Alt+Tab (workflow Windows natif) ou via le tray icon. Si le toggle utilisateur "Toujours au premier plan" est ON, la préférence est restaurée automatiquement quand SynapseHub regagne le focus (listener Tauri 2 `WebviewWindow::onFocusChanged`).
- **Nouvelle commande Tauri `set_always_on_top(on_top: bool)`** dans `src-tauri/src/lib.rs`. Wrapper sur `WebviewWindow::set_always_on_top` avec `Result<(), String>` pour propagation propre des erreurs côté JS. Enregistrée dans `invoke_handler!`.

### Refactor (pre-tag testability)
- **`src/icons.ts` (nouveau)** — extraction des SVG builders (`svg`, `svgPath`, `svgCircle`, `svgLine`, `svgRect`, `buildBranchIcon`, `buildFocusIcon`, `buildCheckIcon`, `buildCopyIcon`, `buildBrandGlyph`) hors de `main.ts` pour réutilisation par `session-view.ts`. Zero `innerHTML`, security hook compliance préservée.
- **`src/session-view.ts` augmenté** — nouveaux exports `renderSessionCard`, `attachFocusHandler`, `setAlwaysOnTopToggle`, `restoreAlwaysOnTopFromStorage`, `getAlwaysOnTopPreference`, `ALWAYS_ON_TOP_KEY`, type `InvokeFn`. Pattern dependency-injection sur la fonction `invoke` pour testabilité unitaire sans pull Tauri dans le test env.

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
- Tests Rust : 43/43 inchangés (régression-zéro sur watcher, focus, hooks). `cargo clippy --all-features --all-targets -- -D warnings` clean. `cargo check --features debug-devtools` clean.
- **Tests Vitest : 7/7 → 16/16**. 9 nouveaux tests DOM dans `src/session-view.dom.test.ts` (env jsdom) — couverture du gap d'interaction surfacé après le smoke v0.1.5 :
  - `click on .card-focus button triggers focus_window invoke`
  - `click on neutral card area does NOT trigger focus_window`
  - `focus_window true triggers set_always_on_top(false)` (vérifie aussi qu'`hide_window` n'est PLUS appelé — régression-check vs v0.1.5)
  - `focus_window false does NOT trigger set_always_on_top` + `console.warn` émis
  - `Waiting status triggers acknowledge_waiting before focus`
  - `toggle ON saves to localStorage and invokes set_always_on_top(true)`
  - `toggle OFF saves to localStorage and invokes set_always_on_top(false)`
  - `on app load, restores localStorage 'true' preference`
  - `default is alwaysOnTop OFF when no localStorage value (no Rust call)`
- Anciens tests `session-view.test.ts` (formatDuration, projectNameFromPath, sortSessions, summarizeSessions) restent en env node natif, untouched.
- `jsdom` ajouté en `devDependencies` (devOnly, free, standard, supports `addEventListener` + `dispatchEvent` + `querySelector`).
- Build vite : 15.7 KB HTML / 35 KB CSS (7 KB gzip) / 34.4 KB JS (10.4 KB gzip — augmente vs v0.2.0 PR #31 dû à l'import `@tauri-apps/api/window` pour le listener `onFocusChanged`).

### Documentation
- Note d'investigation `analysis/2026-04-30-focus-ux-investigation.md` documente la confirmation des 4 hypothèses de bugs UX dans le code post-PR #31, le plan de fix retenu (Option A complète du handoff §5), et les risques identifiés (loop focus-changed, localStorage indispo, refactor renderSessionCard, jsdom CSS limitations).

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
