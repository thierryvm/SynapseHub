# Focus UX investigation — pre-tag v0.2.0

> **Date** : 2026-04-30
> **Sprint** : v0.2.0 fix focus UX before tag (handoff `2026-04-30-1530-v0-2-0-fix-focus-ux-before-tag.md`)
> **Trigger** : @thierry smoke test of v0.1.5 surfaced 4 UX bugs that propagate into the merged v0.2.0 (PR #31)
> **Decision** : Voie 1 — fix on `main` before tagging v0.2.0, ship clean

## Confirmation des 4 hypothèses

| # | Bug observé | Cause primaire | Localisation exacte |
|---|-------------|----------------|---------------------|
| 1 | Click flèche intermittent | Double-fire `card` + `focusBtn` (event bubble + dual listener) | `src/main.ts:282-283` |
| 2 | Click zone neutre = même action | Listener attaché à TOUTE la `.session-card`, pas seulement au bouton | `src/main.ts:282-289` |
| 3 | App entièrement réduite dans le tray | `hide_window` Rust appelle `win.hide()` qui cache complètement | `src-tauri/src/lib.rs:51-55` |
| 4 | alwaysOnTop invasif | Valeur statique `true` dans la conf, pas de toggle runtime | `src-tauri/tauri.conf.json:24` |

### Détail Bug 1 — intermittence

Pattern observé : "il faut le faire plusieurs fois". Cause hautement probable :
- Le user click sur le bouton `BUTTON.card-focus` (icône SVG flèche).
- L'event listener du bouton fire → `handleAction(event)` → `event.stopPropagation()`.
- MAIS le listener est aussi attaché à `.session-card` (le parent ARTICLE) qui reçoit l'event en phase de capture (avant le bouton). Selon l'ordre exact d'évaluation, le card listener peut fire AVANT que stopPropagation soit déclenché par le bouton.
- Conséquence : double-invoke. La 2ème invoke `focus_window` peut arriver après que le 1er focus ait déjà déclenché `hide_window` et que le PID Windows Terminal soit changé/re-parenté. → focus_window retourne false, hide_window n'est pas appelé, mais hide_window initial l'a déjà été. → state bizarre.

Le fix structurel (un seul listener sur le bouton) supprime mécaniquement le double-fire et donc le bug 1 par la même occasion.

### Détail Bug 3 — `hide_window`

```rust
// lib.rs:50-55
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.hide();
    }
}
```

`win.hide()` en Tauri 2 = WebviewWindow::hide() = `ShowWindow(SW_HIDE)` sur Windows = la fenêtre disparaît complètement de l'écran ET de la barre des tâches (déjà cachée via `skipTaskbar: true`). Pour la rouvrir, il faut passer par le tray icon.

Le user attend "laisser passer le terminal devant", pas "minimiser SynapseHub". On veut SynapseHub rester visible mais en arrière-plan z-order.

### Détail Bug 4 — alwaysOnTop invasif

```json
// tauri.conf.json:24
"alwaysOnTop": true
```

Avec `alwaysOnTop: true`, Windows place la fenêtre dans le `HWND_TOPMOST` group → bloque TOUTES les fenêtres tierces non-TOPMOST. Pour un companion tool, c'est trop agressif. Devrait être désactivable (toggle settings) et désactivé par défaut.

### Pas de commande Rust `set_always_on_top`

Audit du `invoke_handler!` macro (`lib.rs:256-263`) :
```rust
.invoke_handler(tauri::generate_handler![
    get_sessions,
    focus_window,
    acknowledge_waiting,
    hide_window,
    quit_app,
    get_config,
])
```

Aucune commande pour piloter dynamiquement `alwaysOnTop`. À ajouter :
```rust
#[tauri::command]
fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("dashboard") {
        win.set_always_on_top(on_top).map_err(|e| e.to_string())
    } else {
        Err("dashboard window not found".to_string())
    }
}
```

Tauri 2 expose `WebviewWindow::set_always_on_top(bool)` natif (cf. `tauri::WebviewWindow`).

## Plan de fix retenu (Option A — handoff §5)

1. **Rust** (`lib.rs`) : ajouter `set_always_on_top` + register dans `invoke_handler!`. Garder `hide_window` (utilisé pour le bouton minimize header). Pas de suppression.
2. **Config** (`tauri.conf.json`) : `alwaysOnTop: true` → `false`. La fenêtre démarre normale.
3. **Frontend session-view.ts** : refactor pour exposer `renderSessionCard(session)`, `attachFocusHandler(card, session, invokeFn)`, `setAlwaysOnTopToggle(on, invokeFn)`, `restoreAlwaysOnTopFromStorage(invokeFn)` — DI sur `invoke` pour testabilité.
4. **Frontend main.ts** : utilise les nouveaux exports. Restaure la préférence localStorage au boot. Listener `onFocusChanged` qui re-applique alwaysOnTop=true uniquement si toggle utilisateur ON.
5. **HTML drawer** : ajouter une `setting-row` avec toggle "Toujours au premier plan", default OFF.
6. **Click handler** : restreint au bouton `BUTTON[data-action="focus"]`. Plus de listener sur la card entière. Le keydown reste sur card pour accessibilité (Enter/Space).
7. **Action post-focus** : `invoke("hide_window")` → `invoke("set_always_on_top", { onTop: false })`. SynapseHub reste visible mais peut être recouverte.
8. **Diagnostic** : `console.warn` si `focus_window` retourne false (déjà présent en v0.2.0 ; on garde).

## Tests Vitest (handoff §6.bis)

Ajout d'un nouveau fichier `src/session-view.dom.test.ts` (env jsdom) avec 9 tests :
- 5 focus interaction (button click vs neutral zone, focus true/false branches, Waiting acknowledgement)
- 4 alwaysOnTop toggle (set ON, set OFF, restore from localStorage, default OFF)

Cible : vitest 7/7 → 16/16.

L'ancien `session-view.test.ts` (7 tests, pure utility) garde son env node natif.

Une `devDependency` `jsdom` sera ajoutée pour le nouveau fichier — devOnly, free, standard.

## Fichiers impactés

| Fichier | Type | Diff estimé |
|--------|------|-------------|
| `src-tauri/src/lib.rs` | modif | +12 lignes (commande + register) |
| `src-tauri/tauri.conf.json` | modif | -1 / +1 |
| `src/session-view.ts` | refactor | +180 lignes (move renderSessionCard + helpers + new exports) |
| `src/main.ts` | refactor | -150 / +30 (delegate to session-view, add focus-changed listener + toggle handler) |
| `index.html` | modif | +12 lignes (setting-row toggle dans drawer) |
| `src/session-view.dom.test.ts` | nouveau | +180 lignes (9 tests) |
| `package.json` | modif | +1 devDep `jsdom` |
| `analysis/2026-04-30-focus-ux-investigation.md` | nouveau | ce fichier |

## Risques / pièges identifiés

1. **focus-changed listener loop** : si on re-active alwaysOnTop sur focus-gained, et que ça relance un événement focus, attention au loop. → Tester avec un guard explicit (set_always_on_top n'émet pas un focus-gained).
2. **localStorage indispo** (sandbox tests) : wrapper try/catch autour de chaque accès, comme on a déjà fait pour le flag onboarding.
3. **Refactor renderSessionCard** : doit garder le même DOM output pour ne pas casser la régression visuelle v0.2.0.
4. **jsdom CSS limitations** : pas de layout calculé, pas de animations. Les tests d'interaction restent OK (pas de visual regression dans cette suite).

## Validation

- ✅ Ces 4 hypothèses confirmées dans le code actuel sur main (post-PR #31).
- ✅ Plan de fix cohérent avec la stratégie handoff §5 (Option A complète).
- ✅ Pas de scope creep (trio integration / folder watcher / webhook generic = v0.3.0+).

Ready to attack Phase 3.
