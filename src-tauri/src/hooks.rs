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
use subtle::ConstantTimeEq;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::GlobalKeyExtractor, GovernorLayer,
};

use crate::types::{AppState, HookPayload, WaitingState};

#[derive(Clone)]
struct HookState {
    app_state: Arc<Mutex<AppState>>,
    app_handle: AppHandle,
    secret: String,
}

async fn handle_hook(State(hs): State<HookState>, Json(payload): Json<HookPayload>) -> StatusCode {
    // Constant-time comparison: ct_eq returns 0 if lengths differ or any byte
    // differs, with no early exit, so a local attacker cannot recover the
    // secret from response timing.
    if payload
        .token
        .as_bytes()
        .ct_eq(hs.secret.as_bytes())
        .unwrap_u8()
        != 1
    {
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

    // 10 requests/second, burst of 10. POST /hook is local-only and only used
    // by Claude Code Stop hooks, so this is far above legitimate traffic and
    // exists only to bound a flooding attacker who has the token.
    // GlobalKeyExtractor: per-IP keying makes no sense on a loopback-only
    // server (single 127.0.0.1 source); a global bucket is enough and avoids
    // the ConnectInfo wiring that PeerIpKeyExtractor would require.
    let governor_conf = Arc::new(
        GovernorConfigBuilder::default()
            .per_millisecond(100)
            .burst_size(10)
            .key_extractor(GlobalKeyExtractor)
            .finish()
            .expect("invalid governor configuration"),
    );

    // Periodically purge stale rate-limit state so a long-running session
    // doesn't hold dead entries in memory.
    let limiter = governor_conf.limiter().clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            limiter.retain_recent();
        }
    });

    let router = Router::new()
        .route("/hook", post(handle_hook))
        .layer(GovernorLayer {
            config: governor_conf,
        })
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
