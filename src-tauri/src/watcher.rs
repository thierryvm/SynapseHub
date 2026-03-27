use std::{
    collections::HashMap,
    ffi::OsStr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use sysinfo::{Pid, System};

use crate::types::{AgentSession, AgentStatus, AppState, LockFile};

/// Returns the current time as seconds since Unix epoch.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Checks whether a process with the given PID is still alive.
fn is_pid_alive(sys: &System, pid: u32) -> bool {
    sys.process(Pid::from_u32(pid)).is_some()
}

/// Reads the current git branch for a directory (best-effort).
fn git_branch(path: &str) -> Option<String> {
    let repo = git2::Repository::discover(path).ok()?;
    let head = repo.head().ok()?;
    head.shorthand().map(str::to_owned)
}

/// Derives a human-readable project name from a path.
fn project_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_owned()
}

/// Parses all lock files in `~/.claude/ide/` and returns active sessions.
fn scan_lock_files(
    sys: &System,
    waiting_since: &HashMap<String, u64>,
    start_times: &mut HashMap<String, u64>,
) -> Vec<AgentSession> {
    let lock_dir = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("ide"),
        None => return vec![],
    };

    let entries = match std::fs::read_dir(&lock_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut sessions = vec![];

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("lock")) {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let lock: LockFile = match serde_json::from_str(&content) {
            Ok(l) => l,
            Err(_) => continue,
        };

        if !is_pid_alive(sys, lock.pid) {
            continue;
        }

        let project_path = lock
            .workspace_folders
            .first()
            .cloned()
            .unwrap_or_default();

        let lock_file = path.to_string_lossy().into_owned();

        // Track when we first saw this session
        let seen_since = *start_times
            .entry(lock_file.clone())
            .or_insert_with(now_secs);

        let status = if let Some(&ws) = waiting_since.get(&project_path) {
            AgentStatus::Waiting {
                since_secs: now_secs().saturating_sub(ws),
            }
        } else {
            AgentStatus::Running {
                since_secs: now_secs().saturating_sub(seen_since),
            }
        };

        sessions.push(AgentSession {
            pid: lock.pid,
            project_name: project_name(&project_path),
            project_path: project_path.clone(),
            ide_name: lock.ide_name,
            git_branch: git_branch(&project_path),
            status,
            lock_file,
        });
    }

    // Clean up start_times entries for gone sessions
    let active_locks: std::collections::HashSet<_> =
        sessions.iter().map(|s| s.lock_file.clone()).collect();
    start_times.retain(|k, _| active_locks.contains(k));

    sessions
}

/// Background task: polls lock files every 2 s and emits `agents-updated`.
pub async fn start_watcher(state: Arc<Mutex<AppState>>, app: AppHandle) {
    let mut sys = System::new_all();
    let mut start_times: HashMap<String, u64> = HashMap::new();

    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let waiting_since = {
            let s = state.lock().await;
            s.waiting_since.clone()
        };

        let sessions = scan_lock_files(&sys, &waiting_since, &mut start_times);

        {
            let mut s = state.lock().await;
            if s.sessions != sessions {
                s.sessions = sessions.clone();
                // Emit to the dashboard WebView
                if let Err(e) = app.emit("agents-updated", &sessions) {
                    log::warn!("Failed to emit agents-updated: {e}");
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
