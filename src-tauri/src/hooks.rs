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
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::GlobalKeyExtractor, GovernorLayer,
};

use crate::types::{AppState, HookPayload, WaitingState};

/// Abstraction over the dashboard event sink. In production this is the
/// Tauri `AppHandle`; tests substitute a recording mock so they don't need
/// to spin up a Tauri runtime (which requires Wry/WebView2 even in
/// `mock_app` mode on Windows, breaking the test harness link step).
pub(crate) trait EventEmitter: Clone + Send + Sync + 'static {
    fn emit_event(&self, event: &str, payload: &str);
}

impl<R: Runtime> EventEmitter for AppHandle<R> {
    fn emit_event(&self, event: &str, payload: &str) {
        if let Err(e) = Emitter::emit(self, event, payload) {
            log::warn!("Failed to emit {event}: {e}");
        }
    }
}

struct HookState<E: EventEmitter> {
    app_state: Arc<Mutex<AppState>>,
    emitter: E,
    secret: String,
}

// `#[derive(Clone)]` would impose `E: Clone` syntactically; the trait already
// requires it, so a hand-rolled impl avoids the redundant bound.
impl<E: EventEmitter> Clone for HookState<E> {
    fn clone(&self) -> Self {
        Self {
            app_state: self.app_state.clone(),
            emitter: self.emitter.clone(),
            secret: self.secret.clone(),
        }
    }
}

async fn handle_hook<E: EventEmitter>(
    State(hs): State<HookState<E>>,
    Json(payload): Json<HookPayload>,
) -> StatusCode {
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

    hs.emitter.emit_event("agent-waiting", &payload.project_dir);

    StatusCode::OK
}

/// Builds the axum Router with rate-limiting wired in. Extracted so unit
/// tests can drive it via `tower::ServiceExt::oneshot` without binding a
/// real TCP listener.
pub(crate) fn build_router<E: EventEmitter>(
    state: Arc<Mutex<AppState>>,
    emitter: E,
    secret: String,
) -> Router {
    let hook_state = HookState {
        app_state: state,
        emitter,
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

    Router::new()
        .route("/hook", post(handle_hook))
        .layer(GovernorLayer {
            config: governor_conf,
        })
        .with_state(hook_state)
}

/// Starts the HTTP hook receiver on a random available port.
/// Returns the port so callers can display it in the UI / setup wizard.
pub async fn start_hook_server<E: EventEmitter>(
    state: Arc<Mutex<AppState>>,
    emitter: E,
    secret: String,
) -> u16 {
    let router = build_router(state, emitter, secret);

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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::sync::Mutex as StdMutex;
    use tower::util::ServiceExt;

    const VALID_SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[derive(Clone, Default)]
    struct RecordingEmitter {
        events: Arc<StdMutex<Vec<(String, String)>>>,
    }

    impl EventEmitter for RecordingEmitter {
        fn emit_event(&self, event: &str, payload: &str) {
            self.events
                .lock()
                .expect("emitter mutex")
                .push((event.to_string(), payload.to_string()));
        }
    }

    fn make_router(secret: &str) -> (Router, Arc<Mutex<AppState>>, RecordingEmitter) {
        let state = Arc::new(Mutex::new(AppState::default()));
        let emitter = RecordingEmitter::default();
        let router = build_router(state.clone(), emitter.clone(), secret.to_string());
        (router, state, emitter)
    }

    fn post_json(path: &str, body: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }

    fn post_raw(path: &str, body: &'static str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn valid_token_returns_200_and_persists_waiting() {
        let (router, state, emitter) = make_router(VALID_SECRET);

        let req = post_json(
            "/hook",
            serde_json::json!({
                "token": VALID_SECRET,
                "project_dir": "/tmp/synapsehub-test/valid",
                "pid": 4242u32,
            }),
        );

        let resp = router.oneshot(req).await.expect("oneshot");
        assert_eq!(resp.status(), StatusCode::OK);

        let s = state.lock().await;
        let entry = s
            .waiting_since
            .get("/tmp/synapsehub-test/valid")
            .expect("waiting_since populated for valid token");
        assert_eq!(entry.pid, Some(4242));

        let events = emitter.events.lock().expect("emitter mutex");
        assert_eq!(events.len(), 1, "exactly one event should be emitted");
        assert_eq!(events[0].0, "agent-waiting");
        assert_eq!(events[0].1, "/tmp/synapsehub-test/valid");
    }

    #[tokio::test]
    async fn invalid_token_returns_401() {
        let (router, state, emitter) = make_router(VALID_SECRET);

        let req = post_json(
            "/hook",
            serde_json::json!({
                "token": "f".repeat(64),
                "project_dir": "/tmp/synapsehub-test/wrong",
                "pid": 1u32,
            }),
        );

        let resp = router.oneshot(req).await.expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let s = state.lock().await;
        assert!(
            !s.waiting_since.contains_key("/tmp/synapsehub-test/wrong"),
            "rejected hook must not mutate state"
        );
        assert!(
            emitter.events.lock().expect("emitter mutex").is_empty(),
            "rejected hook must not emit any event"
        );
    }

    #[tokio::test]
    async fn wrong_length_token_returns_401() {
        let (router, _state, _emitter) = make_router(VALID_SECRET);

        // 32-char token vs the 64-char secret — ct_eq must reject without
        // panicking on length mismatch.
        let req = post_json(
            "/hook",
            serde_json::json!({
                "token": "0123456789abcdef0123456789abcdef",
                "project_dir": "/tmp/synapsehub-test/short",
                "pid": 1u32,
            }),
        );

        let resp = router.oneshot(req).await.expect("oneshot");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn malformed_payload_returns_4xx() {
        let (router, _state, _emitter) = make_router(VALID_SECRET);

        // Not even valid JSON
        let req = post_raw("/hook", "{not_json");

        let resp = router.oneshot(req).await.expect("oneshot");
        assert!(
            resp.status().is_client_error(),
            "malformed body should yield a 4xx, got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn missing_token_field_returns_4xx() {
        let (router, _state, _emitter) = make_router(VALID_SECRET);

        let req = post_json(
            "/hook",
            serde_json::json!({
                "project_dir": "/tmp/synapsehub-test/no-token",
                "pid": 1u32,
            }),
        );

        let resp = router.oneshot(req).await.expect("oneshot");
        assert!(
            resp.status().is_client_error(),
            "missing token must not return 200, got {}",
            resp.status()
        );
    }

    #[tokio::test]
    async fn legacy_32_char_token_accepted() {
        // Backward-compat per Q2 arbitrage @cowork: a 32-char hex secret
        // installed by an earlier SynapseHub build must still validate.
        let legacy_secret = "deadbeefcafebabedeadbeefcafebabe";
        assert_eq!(legacy_secret.len(), 32);
        let (router, state, _emitter) = make_router(legacy_secret);

        let req = post_json(
            "/hook",
            serde_json::json!({
                "token": legacy_secret,
                "project_dir": "/tmp/synapsehub-test/legacy",
                "pid": 7u32,
            }),
        );

        let resp = router.oneshot(req).await.expect("oneshot");
        assert_eq!(resp.status(), StatusCode::OK);

        let s = state.lock().await;
        assert!(s.waiting_since.contains_key("/tmp/synapsehub-test/legacy"));
    }

    #[tokio::test]
    async fn rate_limit_returns_429_when_flooded() {
        // 15 back-to-back requests; with burst=10 and 10 req/s replenish,
        // at least one of the last few must come back 429.
        let (router, _state, _emitter) = make_router(VALID_SECRET);

        let mut statuses = Vec::with_capacity(15);
        for _ in 0..15 {
            let req = post_json(
                "/hook",
                serde_json::json!({
                    "token": VALID_SECRET,
                    "project_dir": "/tmp/synapsehub-test/flood",
                    "pid": 1u32,
                }),
            );
            let resp = router.clone().oneshot(req).await.expect("oneshot");
            statuses.push(resp.status());
        }

        let too_many = statuses.iter().filter(|s| s.as_u16() == 429).count();
        assert!(
            too_many > 0,
            "expected ≥1 HTTP 429 in 15 fast requests; got statuses {statuses:?}",
        );
    }
}
