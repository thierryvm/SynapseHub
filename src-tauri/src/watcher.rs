use std::{
    collections::HashMap,
    ffi::OsStr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, System};
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::types::{AgentSession, AgentStatus, AppState, LockFile, WaitingState};

const RESUME_CPU_THRESHOLD: f32 = 2.0;
const RESUME_POLLS_REQUIRED: u8 = 2;

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

/// Returns true when a waiting session shows sustained enough local activity
/// to consider it resumed.
fn should_resume(waiting: &WaitingState, pid: u32, cpu_usage: f32, active_polls: u8) -> bool {
    match waiting.pid {
        Some(waiting_pid) if waiting_pid == pid => {
            cpu_usage >= RESUME_CPU_THRESHOLD && active_polls >= RESUME_POLLS_REQUIRED
        }
        _ => false,
    }
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
    waiting_since: &HashMap<String, WaitingState>,
    start_times: &mut HashMap<String, u64>,
    resume_votes: &mut HashMap<String, u8>,
) -> (Vec<AgentSession>, Vec<String>) {
    let lock_dir = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("ide"),
        None => return (vec![], vec![]),
    };

    let entries = match std::fs::read_dir(&lock_dir) {
        Ok(e) => e,
        Err(_) => return (vec![], vec![]),
    };

    let mut sessions = vec![];
    let mut resumed_projects = vec![];

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

        let project_path = lock.workspace_folders.first().cloned().unwrap_or_default();

        let lock_file = path.to_string_lossy().into_owned();

        // Track when we first saw this session
        let seen_since = *start_times
            .entry(lock_file.clone())
            .or_insert_with(now_secs);

        let status = if let Some(waiting) = waiting_since.get(&project_path) {
            let cpu_usage = sys
                .process(Pid::from_u32(lock.pid))
                .map(|p| p.cpu_usage())
                .unwrap_or(0.0);
            let active_polls = if waiting.pid == Some(lock.pid) && cpu_usage >= RESUME_CPU_THRESHOLD
            {
                let votes = resume_votes.entry(project_path.clone()).or_insert(0);
                *votes = votes.saturating_add(1);
                *votes
            } else {
                resume_votes.remove(&project_path);
                0
            };

            if should_resume(waiting, lock.pid, cpu_usage, active_polls) {
                resumed_projects.push(project_path.clone());
                resume_votes.remove(&project_path);
                AgentStatus::Running {
                    since_secs: now_secs().saturating_sub(seen_since),
                }
            } else {
                AgentStatus::Waiting {
                    since_secs: now_secs().saturating_sub(waiting.since_secs),
                }
            }
        } else {
            resume_votes.remove(&project_path);
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

    (sessions, resumed_projects)
}

/// Scans active processes for known AI agents to provide universal tracking.
fn scan_processes(
    sys: &System,
    waiting_since: &HashMap<String, WaitingState>,
    start_times: &mut HashMap<String, u64>,
    existing_sessions: &[AgentSession],
    resume_votes: &mut HashMap<String, u8>,
) -> (Vec<AgentSession>, Vec<String>) {
    let mut sessions = vec![];
    let mut resumed_projects = vec![];
    let mut seen_projects = std::collections::HashSet::new();

    // Preremplir avec les projets déjà trouvés par scan_lock_files
    for s in existing_sessions {
        seen_projects.insert(s.project_path.clone());
    }

    for (pid, process) in sys.processes() {
        let name_lower = process.name().to_string_lossy().to_lowercase();

        let mut ide_name = None;

        // Identification de l'agent
        if name_lower.contains("antigravity") {
            ide_name = Some("Antigravity");
        } else if name_lower.contains("cursor") {
            ide_name = Some("Cursor");
        } else if name_lower.contains("windsurf") {
            ide_name = Some("Windsurf");
        } else if name_lower.contains("claude.exe") || name_lower.contains("claude desktop") {
            ide_name = Some("Claude Desktop");
        } else if name_lower.contains("code") && name_lower != "node.exe" {
            ide_name = Some("VSCode");
        } else if name_lower.contains("aider") {
            ide_name = Some("Aider");
        } else if name_lower.contains("cline") {
            ide_name = Some("Cline");
        } else if name_lower.contains("openhands") {
            ide_name = Some("OpenHands");
        }

        // Si le nom du processus est un host commun (Node, JS, bash, pwsh), on vérifie les arguments
        let cmd_joined = process
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().to_lowercase())
            .collect::<Vec<String>>()
            .join(" ");

        if cmd_joined.contains("claude-code")
            || cmd_joined.contains("@anthropic-ai")
            || cmd_joined.contains("claude.cmd")
        {
            ide_name = Some("Claude Code Terminal");
        }

        let ide_name = match ide_name {
            Some(n) => n,
            None => continue,
        };

        // Determine project path from cwd or command line arguments
        let mut cwd = process
            .cwd()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut cwd_lower = cwd.to_lowercase();
        if cwd.is_empty()
            || cwd_lower.contains("program files")
            || cwd_lower.contains("appdata")
            || cwd_lower.contains("/usr/bin")
            || cwd_lower.contains("/usr/lib")
            || cwd == "/"
        {
            // Cherche dans les arguments command-line une éventuelle arborescence de projet existante
            for arg_os in process.cmd() {
                let arg_str = arg_os.to_string_lossy().into_owned();
                let path = std::path::Path::new(&arg_str);
                if path.is_dir() {
                    let arg_lower = arg_str.to_lowercase();
                    if !arg_lower.contains("program files")
                        && !arg_lower.contains("appdata")
                        && arg_str != "/"
                    {
                        cwd = arg_str;
                        break;
                    }
                }
            }
            cwd_lower = cwd.to_lowercase();
        }

        // Ignore system paths or typical non-project folders
        if cwd_lower.contains("program files")
            || cwd_lower.contains("appdata")
            || cwd_lower.contains("/usr/bin")
            || cwd_lower.contains("/usr/lib")
            || cwd == "/"
            || cwd.is_empty()
        {
            continue;
        }

        // Avoid duplicating sessions for the same project
        if seen_projects.contains(&cwd) {
            continue;
        }
        seen_projects.insert(cwd.clone());

        // Use a stable identifier to track uptime
        let lock_file = format!("process_{}", cwd);

        let seen_since = *start_times
            .entry(lock_file.clone())
            .or_insert_with(now_secs);

        let status = if let Some(waiting) = waiting_since.get(&cwd) {
            let active_polls = if waiting.pid == Some(pid.as_u32())
                && process.cpu_usage() >= RESUME_CPU_THRESHOLD
            {
                let votes = resume_votes.entry(cwd.clone()).or_insert(0);
                *votes = votes.saturating_add(1);
                *votes
            } else {
                resume_votes.remove(&cwd);
                0
            };

            if should_resume(waiting, pid.as_u32(), process.cpu_usage(), active_polls) {
                resumed_projects.push(cwd.clone());
                resume_votes.remove(&cwd);
                AgentStatus::Running {
                    since_secs: now_secs().saturating_sub(seen_since),
                }
            } else {
                AgentStatus::Waiting {
                    since_secs: now_secs().saturating_sub(waiting.since_secs),
                }
            }
        } else {
            resume_votes.remove(&cwd);
            AgentStatus::Running {
                since_secs: now_secs().saturating_sub(seen_since),
            }
        };

        sessions.push(AgentSession {
            pid: pid.as_u32(),
            project_name: project_name(&cwd),
            project_path: cwd.clone(),
            ide_name: ide_name.to_owned(),
            git_branch: git_branch(&cwd),
            status,
            lock_file,
        });
    }

    (sessions, resumed_projects)
}

/// Background task: polls lock files every 2 s and emits `agents-updated`.
pub async fn start_watcher(state: Arc<Mutex<AppState>>, app: AppHandle) {
    use sysinfo::{ProcessRefreshKind, RefreshKind, UpdateKind};

    // Optimisation majeure du CPU : on informe sysinfo de ne scanner que le strict nécessaire
    let refresh_kind = RefreshKind::nothing().with_processes(
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet), // On ne demande ni la RAM ni le CPU de chaque process, ce qui est très lourd
    );
    let mut sys = System::new_with_specifics(refresh_kind);
    let mut start_times: HashMap<String, u64> = HashMap::new();
    let mut resume_votes: HashMap<String, u8> = HashMap::new();

    loop {
        // Refresh uniquement ce qui est nécessaire très rapidement
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet),
        );

        let waiting_since = {
            let s = state.lock().await;
            s.waiting_since.clone()
        };

        let (mut sessions, mut resumed_projects) =
            scan_lock_files(&sys, &waiting_since, &mut start_times, &mut resume_votes);
        let (process_sessions, process_resumed_projects) = scan_processes(
            &sys,
            &waiting_since,
            &mut start_times,
            &sessions,
            &mut resume_votes,
        );
        sessions.extend(process_sessions);
        resumed_projects.extend(process_resumed_projects);

        if !resumed_projects.is_empty() {
            let mut state = state.lock().await;
            for project_path in resumed_projects {
                state.waiting_since.remove(&project_path);
            }
        }

        // Webhook fallback : Support universel pour les agents inconnus qui pingent le webhook
        let seen_projects: std::collections::HashSet<_> =
            sessions.iter().map(|s| s.project_path.clone()).collect();

        for (cwd, waiting) in waiting_since.iter() {
            if !seen_projects.contains(cwd) {
                let lock_file = format!("webhook_{}", cwd);
                let _seen_since = *start_times
                    .entry(lock_file.clone())
                    .or_insert_with(now_secs);
                sessions.push(AgentSession {
                    pid: 0,
                    project_name: project_name(cwd),
                    project_path: cwd.clone(),
                    ide_name: "Agent IA Ext.".to_string(),
                    git_branch: git_branch(cwd),
                    status: AgentStatus::Waiting {
                        since_secs: now_secs().saturating_sub(waiting.since_secs),
                    },
                    lock_file,
                });
            }
        }

        // Nettoyage global des start_times morts
        let active_locks: std::collections::HashSet<_> =
            sessions.iter().map(|s| s.lock_file.clone()).collect();
        start_times.retain(|k, _| active_locks.contains(k));
        resume_votes.retain(|project_path, _| waiting_since.contains_key(project_path));

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

#[cfg(test)]
mod tests {
    use super::{should_resume, RESUME_CPU_THRESHOLD, RESUME_POLLS_REQUIRED};
    use crate::types::WaitingState;

    fn waiting_state(pid: Option<u32>) -> WaitingState {
        WaitingState {
            since_secs: 1_700_000_000,
            pid,
        }
    }

    #[test]
    fn should_not_resume_without_hook_pid() {
        let waiting = waiting_state(None);

        assert!(!should_resume(
            &waiting,
            4242,
            RESUME_CPU_THRESHOLD + 1.0,
            RESUME_POLLS_REQUIRED
        ));
    }

    #[test]
    fn should_not_resume_with_wrong_pid() {
        let waiting = waiting_state(Some(1111));

        assert!(!should_resume(
            &waiting,
            2222,
            RESUME_CPU_THRESHOLD + 1.0,
            RESUME_POLLS_REQUIRED
        ));
    }

    #[test]
    fn should_not_resume_with_low_cpu() {
        let waiting = waiting_state(Some(4242));

        assert!(!should_resume(
            &waiting,
            4242,
            RESUME_CPU_THRESHOLD - 0.1,
            RESUME_POLLS_REQUIRED
        ));
    }

    #[test]
    fn should_not_resume_after_single_active_poll() {
        let waiting = waiting_state(Some(4242));

        assert!(!should_resume(
            &waiting,
            4242,
            RESUME_CPU_THRESHOLD + 1.0,
            RESUME_POLLS_REQUIRED - 1
        ));
    }

    #[test]
    fn should_resume_after_two_active_polls() {
        let waiting = waiting_state(Some(4242));

        assert!(should_resume(
            &waiting,
            4242,
            RESUME_CPU_THRESHOLD + 1.0,
            RESUME_POLLS_REQUIRED
        ));
    }

    #[test]
    fn should_resume_after_hook_stop_when_same_pid_becomes_active_again() {
        let waiting = waiting_state(Some(9001));

        assert!(should_resume(
            &waiting,
            9001,
            RESUME_CPU_THRESHOLD + 2.5,
            RESUME_POLLS_REQUIRED
        ));
    }
}
