use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{
    AppHandle, Manager, State,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

mod focus;
mod hooks;
mod types;
mod watcher;

use types::{AgentSession, AppState};

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// Returns the current list of agent sessions (called on dashboard init).
#[tauri::command]
async fn get_sessions(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<AgentSession>, String> {
    let s = state.lock().await;
    Ok(s.sessions.clone())
}

/// Focuses the window of the process with the given PID.
#[tauri::command]
fn focus_window(pid: u32) {
    focus::focus_window_by_pid(pid);
}

/// Hides the dashboard window (minimize to tray).
#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.hide();
    }
}

/// Quits the application entirely.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
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
    let show   = MenuItem::with_id(app, "show",   "Ouvrir SynapseHub", true, None::<&str>)?;
    let quit   = MenuItem::with_id(app, "quit",   "Quitter",           true, None::<&str>)?;
    let menu   = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            Image::from_bytes(include_bytes!("../icons/tray.png"))
                .expect("Missing tray icon")
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
            _      => {}
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

    if let Ok(token) = std::fs::read_to_string(&token_file) {
        let token = token.trim().to_owned();
        if !token.is_empty() {
            return token;
        }
    }

    // Generate a new 32-char hex token
    let token: String = (0..32)
        .map(|_| format!("{:x}", rand::random::<u8>()))
        .collect();

    let _ = std::fs::write(&token_file, &token);
    token
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            focus_window,
            hide_window,
            quit_app,
            get_config,
        ])
        .run(tauri::generate_context!())
        .expect("Error running SynapseHub");
}
