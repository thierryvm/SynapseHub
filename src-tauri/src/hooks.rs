//! Local HTTP server that receives Claude Code Stop hooks.
//!
//! Claude Code settings.json:
//! ```json
//! {
//!   "hooks": {
//!     "Stop": [{
//!       "matcher": "",
//!       "hooks": [{
//!         "type": "command",
//!         "command": "synapsehub-notify --token <TOKEN> --project \"$CLAUDE_PROJECT_DIR\""
//!       }]
//!     }]
//!   }
//! }
//! ```
//!
//! Or, using curl directly (no helper binary needed):
//! ```bash
//! curl -s -X POST http://127.0.0.1:PORT/hook \
//!   -H "Content-Type: application/json" \
//!   -d "{\"token\":\"TOKEN\",\"project_dir\":\"$CLAUDE_PROJECT_DIR\",\"pid\":$PPID}"
//! ```

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::types::{AppState, HookPayload, WaitingState};

#[derive(Clone)]
struct HookState {
    app_state: Arc<Mutex<AppState>>,
    app_handle: AppHandle,
    secret: String,
}

async fn handle_hook(State(hs): State<HookState>, Json(payload): Json<HookPayload>) -> StatusCode {
    // Validate shared secret (constant-time comparison via subtle would be
    // ideal; for a localhost-only server this is acceptable).
    if payload.token != hs.secret {
        log::warn!("Hook received with invalid token — ignoring");
        return StatusCode::UNAUTHORIZED;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    {
        let mut state = hs.app_state.lock().await;
        state.waiting_since.insert(
            payload.project_dir.clone(),
            WaitingState {
                since_secs: now,
                pid: payload.pid,
            },
        );
    }

    // Notify the tray icon and dashboard
    let project_name = payload
        .project_dir
        .replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("Projet")
        .to_owned();

    log::info!("Agent waiting: {project_name}");

    if let Err(e) = hs.app_handle.emit("agent-waiting", &payload.project_dir) {
        log::warn!("Failed to emit agent-waiting: {e}");
    }

    StatusCode::OK
}

/// Starts the HTTP hook receiver on a random available port.
/// Returns the port so callers can display it in the UI / setup wizard.
pub async fn start_hook_server(state: Arc<Mutex<AppState>>, app: AppHandle, secret: String) -> u16 {
    let hook_state = HookState {
        app_state: state,
        app_handle: app,
        secret,
    };

    let router = Router::new()
        .route("/hook", post(handle_hook))
        .with_state(hook_state);

    // Bind to a random available port on loopback only
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind hook server");

    let port = listener.local_addr().expect("No local addr").port();
    log::info!("Hook server listening on http://127.0.0.1:{port}/hook");

    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("Hook server crashed");
    });

    port
}
