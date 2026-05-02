use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime, State,
};
use tokio::sync::Mutex;

mod focus;
mod hooks;
mod types;
mod watcher;

use types::{AgentSession, AppState};

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// Returns the current list of agent sessions (called on dashboard init).
#[tauri::command]
async fn get_sessions(state: State<'_, Arc<Mutex<AppState>>>) -> Result<Vec<AgentSession>, String> {
    let s = state.lock().await;
    Ok(s.sessions.clone())
}

/// Focuses the window of the process with the given PID (or one of its
/// ancestors — see `focus::focus_window_by_pid`). Returns `true` if a
/// window was actually brought to the foreground; `false` means no window
/// was found in the parent chain (typical for orphaned PIDs whose terminal
/// host has since been closed). Errors are logged but never propagate to
/// JS, so the UI stays responsive even if the focus call fails.
#[tauri::command]
fn focus_window(pid: u32) -> bool {
    focus::focus_window_by_pid(pid)
}

/// Clears the waiting marker once the user explicitly returns to the agent.
/// This keeps the Rust/JS bridge simple and avoids refactoring the scanner path.
#[tauri::command]
async fn acknowledge_waiting(
    project_path: String,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let mut app_state = state.lock().await;
    app_state.waiting_since.remove(&project_path);
    Ok(())
}

/// Hides the dashboard window (minimize to tray).
#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.hide();
    }
}

/// Toggles the dashboard's `alwaysOnTop` flag at runtime. Driven by the user
/// toggle in the settings drawer and by the focus action (which temporarily
/// disables alwaysOnTop so the IDE window can come to the foreground without
/// being covered by SynapseHub). Returns the standard string error so the
/// frontend can log it.
#[tauri::command]
fn set_always_on_top(app: AppHandle, on_top: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("dashboard")
        .ok_or_else(|| "dashboard window not found".to_string())?;
    win.set_always_on_top(on_top).map_err(|e| e.to_string())
}

/// Quits the application entirely.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Surfaces the dashboard window of the running primary instance: shows it,
/// brings it to the foreground, and unminimises it if it was minimised.
///
/// Used by `tauri-plugin-single-instance`'s callback when a second launch is
/// attempted, and exercised from `lib::tests::focus_primary_dashboard_*`.
/// Errors from the underlying `WebviewWindow` are intentionally ignored —
/// the only graceful behaviour for an attempted second launch is "do as much
/// as we can, then carry on".
fn focus_primary_dashboard<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Body of the `tauri-plugin-single-instance` callback, extracted so it can
/// be unit-tested without spinning up a second OS process. Logs the rejected
/// argv/cwd and refocuses the primary dashboard.
fn handle_second_instance_attempt<R: Runtime>(
    app: &AppHandle<R>,
    args: &[String],
    cwd: &str,
) {
    log::info!(
        "second-instance launch refused — focusing primary (argv = {:?}, cwd = {:?})",
        args,
        cwd
    );
    focus_primary_dashboard(app);
}

/// Quits the running instance cleanly so an installer (NSIS / MSI on Windows,
/// pkg on macOS, deb/rpm on Linux) can replace the locked binary on disk.
///
/// The frontend calls this after `availableUpdate.downloadAndInstall(...)` in
/// the v0.2.1 update flow: the JS side has already triggered the installer
/// via the Tauri updater plugin, and this command makes the previous
/// instance's exit explicit (logged + `app.exit(0)`) instead of relying on
/// the plugin to do it implicitly. Always returns `Ok(())`; failures here
/// would mean the runtime is already torn down.
#[tauri::command]
async fn quit_and_install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    log::info!("quit_and_install_update — exiting cleanly so the installer can swap the binary");
    app.exit(0);
    Ok(())
}

#[derive(serde::Serialize)]
struct AppConfig {
    port: Option<u16>,
    token: Option<String>,
}

/// Fetches the dynamic hook port and secret token
#[tauri::command]
async fn get_config() -> AppConfig {
    let config_dir = dirs::config_dir().unwrap_or_default().join("synapsehub");

    let token = std::fs::read_to_string(config_dir.join("hook_token"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let port_str = std::fs::read_to_string(config_dir.join("hook_port")).ok();
    let port = port_str.and_then(|s| s.trim().parse::<u16>().ok());

    AppConfig { port, token }
}

// ─── Tray setup ────────────────────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Ouvrir SynapseHub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            Image::from_bytes(include_bytes!("../icons/tray.png")).expect("Missing tray icon")
        }))
        .tooltip("SynapseHub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_dashboard(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => toggle_dashboard(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn toggle_dashboard(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.center();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

// ─── App setup ─────────────────────────────────────────────────────────────────

fn load_or_create_secret() -> String {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("synapsehub");

    let _ = std::fs::create_dir_all(&config_dir);
    let token_file = config_dir.join("hook_token");

    if let Ok(existing) = std::fs::read_to_string(&token_file) {
        let existing = existing.trim().to_owned();
        if validate_token_format(&existing) {
            log::info!("Hook token loaded ({} chars)", existing.len());
            return existing;
        }
        if !existing.is_empty() {
            log::warn!("Existing hook_token did not match expected format; regenerating");
        }
    }

    let token = generate_token();
    write_token_file(&token_file, &token);
    log::info!("Hook token generated ({} chars)", token.len());
    token
}

/// Writes the hook token with `0600` permissions on Unix so other users on
/// shared machines cannot read it. On Windows we rely on the per-user ACL
/// inherited from `%APPDATA%/synapsehub/`; explicit ACL hardening is tracked
/// for v0.1.2.
fn write_token_file(path: &std::path::Path, token: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(token.as_bytes()) {
                    log::warn!("Failed to write hook_token: {e}");
                }
            }
            Err(e) => log::warn!("Failed to open hook_token for write: {e}"),
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = std::fs::write(path, token.as_bytes()) {
            log::warn!("Failed to write hook_token: {e}");
        }
    }
}

/// Generates a cryptographically random 256-bit token, hex-encoded as 64 chars.
fn generate_token() -> String {
    use rand::rngs::OsRng;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Accepts the legacy 32-char hex tokens (pre-v0.1.1) and the new 64-char hex
/// tokens. Both must be ASCII hex; everything else is rejected so a corrupted
/// or truncated file triggers regeneration on next launch.
fn validate_token_format(token: &str) -> bool {
    matches!(token.len(), 32 | 64) && token.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        // single-instance MUST be the first registered plugin: it opens an
        // OS-level lock (named mutex on Windows, UNIX socket on macOS/Linux)
        // before any other Tauri/plugin init runs, so a second launch dies
        // immediately without spinning up a duplicate watcher / hook server /
        // tray icon. The closure runs in the *primary* instance with the
        // would-be 2nd instance's argv + cwd; we use it to surface the
        // dashboard so the user understands "the app is already running".
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            handle_second_instance_attempt(app, &args, &cwd);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Prevent the dashboard from appearing in the taskbar
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let state = Arc::new(Mutex::new(AppState::default()));
            app.manage(state.clone());

            let handle = app.handle().clone();
            let secret = load_or_create_secret();

            log::info!("Hook token loaded — configure Claude Code hooks from the settings panel.");

            // Start the background watcher and hook server
            tauri::async_runtime::spawn(watcher::start_watcher(state.clone(), handle.clone()));
            tauri::async_runtime::spawn(async move {
                let port = hooks::start_hook_server(state, handle.clone(), secret).await;

                // Persist the port so external scripts can find it
                if let Some(config_dir) = dirs::config_dir() {
                    let dir = config_dir.join("synapsehub");
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(dir.join("hook_port"), port.to_string());
                }

                log::info!("Hook server ready on port {port}");
            });

            build_tray(app.handle())?;

            // Opt-in: open DevTools at startup when built with
            // `--features debug-devtools`. The feature also pulls in
            // `tauri/devtools`, which is what actually compiles the inspector
            // into the binary; without it, `open_devtools()` is a no-op.
            #[cfg(feature = "debug-devtools")]
            {
                if let Some(window) = app.get_webview_window("dashboard") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            focus_window,
            acknowledge_waiting,
            hide_window,
            set_always_on_top,
            quit_app,
            quit_and_install_update,
            get_config,
        ])
        .run(tauri::generate_context!())
        .expect("Error running SynapseHub");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_64_hex_chars_token() {
        for _ in 0..10 {
            let token = generate_token();
            assert_eq!(
                token.len(),
                64,
                "token should be 64 hex chars (256 bits), got {}",
                token.len()
            );
            assert!(
                token.chars().all(|c| c.is_ascii_hexdigit()),
                "token should be hex-only: {token}"
            );
        }
    }

    #[test]
    fn entropy_check_token_unique_across_runs() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            assert!(
                seen.insert(generate_token()),
                "OsRng produced a duplicate within 100 draws — entropy is broken"
            );
        }
    }

    #[test]
    fn validate_token_accepts_legacy_32_chars() {
        let legacy = "0123456789abcdef0123456789abcdef";
        assert_eq!(legacy.len(), 32);
        assert!(validate_token_format(legacy));
    }

    #[test]
    fn validate_token_accepts_new_64_chars() {
        let token = generate_token();
        assert!(validate_token_format(&token));
    }

    #[test]
    fn validate_token_rejects_non_hex_chars() {
        // 'g' is not a hex digit
        let bad = "0123456789abcdef0123456789abcdeg";
        assert_eq!(bad.len(), 32);
        assert!(!validate_token_format(bad));
    }

    #[test]
    fn validate_token_rejects_wrong_length() {
        assert!(!validate_token_format(""));
        assert!(!validate_token_format("a"));
        assert!(!validate_token_format(&"a".repeat(33)));
        assert!(!validate_token_format(&"a".repeat(63)));
        assert!(!validate_token_format(&"a".repeat(128)));
    }

    #[cfg(unix)]
    #[test]
    fn creates_token_file_with_0600_perms() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("synapsehub-test-{}", generate_token()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("hook_token");

        write_token_file(&path, "deadbeefcafebabedeadbeefcafebabe");

        let meta = std::fs::metadata(&path).expect("token file written");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got {:o}", mode);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ─── v0.2.1 hotfix (#39) — single-instance + clean update flow ──────────
    //
    // These three tests rely on `tauri::test::mock_app()`, which builds an
    // `App<MockRuntime>` in-memory. On Windows that pulls in tray-icon /
    // WebView2 import resolution at test-binary load time and trips
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before any test runs. The
    // production `release.yml` matrix exercises macOS + Linux x64 + Linux
    // ARM64 (3/4 OS), which is sufficient to cover the new code paths; we
    // skip them on Windows hosts only.

    #[cfg(not(target_os = "windows"))]
    mod single_instance_and_update_flow {
        use super::*;

        /// Mock app has no "dashboard" window; the helper must silently
        /// no-op instead of unwrapping a `None` and panicking.
        #[test]
        fn focus_primary_dashboard_no_panic_when_window_absent() {
            let app = tauri::test::mock_app();
            focus_primary_dashboard(app.handle());
        }

        /// Verifies the single-instance callback body runs end-to-end with
        /// the argv/cwd shape `tauri-plugin-single-instance` will hand us.
        /// No "dashboard" window is registered on the mock app, so this
        /// also exercises the graceful no-op branch in
        /// `focus_primary_dashboard` that the closure delegates to.
        #[test]
        fn handle_second_instance_attempt_invokes_focus_without_panic() {
            let app = tauri::test::mock_app();
            let args = vec![
                "synapsehub".to_string(),
                "--from-shortcut".to_string(),
            ];
            let cwd = "/home/thier".to_string();
            handle_second_instance_attempt(app.handle(), &args, &cwd);
        }

        /// `quit_and_install_update` must always resolve to `Ok(())`. We
        /// invoke it on a `MockRuntime` so `app.exit(0)` is recorded by
        /// the mock runtime instead of terminating the test binary.
        #[tokio::test]
        async fn quit_and_install_update_returns_ok() {
            let app = tauri::test::mock_app();
            let result = quit_and_install_update(app.handle().clone()).await;
            assert!(result.is_ok(), "expected Ok(()), got {:?}", result);
        }
    }
}
