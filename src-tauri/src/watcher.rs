use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Path, PathBuf},
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

/// Stable deduplication key per visible agent on a project.
fn session_identity(project_path: &str, ide_name: &str) -> String {
    format!("{project_path}::{ide_name}")
}

/// Returns true when a path points to system-owned locations that do not
/// represent a user project we should surface in the dashboard.
fn is_system_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    path.is_empty()
        || path == "/"
        || lower.contains("program files")
        || lower.contains("appdata")
        || lower.contains("/usr/bin")
        || lower.contains("/usr/lib")
}

/// Best-effort normalization that collapses files to their parent directory and
/// upgrades nested paths to the repository root when a Git checkout is found.
fn normalize_project_path(path: &Path) -> Option<String> {
    let candidate = if path.is_file() { path.parent()? } else { path };

    if !candidate.exists() {
        return None;
    }

    let resolved = git2::Repository::discover(candidate)
        .ok()
        .and_then(|repo| repo.workdir().map(PathBuf::from))
        .unwrap_or_else(|| candidate.to_path_buf());

    let normalized = resolved.to_string_lossy().into_owned();
    if is_system_path(&normalized) {
        None
    } else {
        Some(normalized)
    }
}

/// Fast filter to avoid probing arbitrary command line flags as filesystem paths.
fn looks_like_project_path_arg(arg: &str) -> bool {
    arg.contains(":\\") || arg.contains('\\') || arg.contains('/') || Path::new(arg).exists()
}

/// Extracts a plausible project directory from the process cwd and arguments.
fn resolve_project_path(process: &sysinfo::Process) -> Option<String> {
    if let Some(cwd) = process.cwd() {
        if let Some(path) = normalize_project_path(cwd) {
            return Some(path);
        }
    }

    for arg_os in process.cmd() {
        let arg = arg_os.to_string_lossy().trim_matches('"').to_owned();
        if arg.is_empty() || !looks_like_project_path_arg(&arg) {
            continue;
        }

        let candidate = Path::new(&arg);
        if let Some(path) = normalize_project_path(candidate) {
            return Some(path);
        }
    }

    None
}

/// Maps known process names or command-line signatures to a UI-facing agent name.
fn detect_ide_name(name_lower: &str, cmd_joined: &str) -> Option<&'static str> {
    if cmd_joined.contains("claude-code")
        || cmd_joined.contains("@anthropic-ai")
        || cmd_joined.contains("claude.cmd")
    {
        return Some("Claude Code Terminal");
    }

    if name_lower.contains("codex")
        || cmd_joined.contains("\\codex.exe")
        || cmd_joined.contains("/codex")
        || cmd_joined.contains(" openai.codex")
    {
        return Some("OpenAI Codex");
    }

    if name_lower.contains("antigravity") {
        Some("Antigravity")
    } else if name_lower.contains("cursor") {
        Some("Cursor")
    } else if name_lower.contains("windsurf") {
        Some("Windsurf")
    } else if name_lower.contains("claude.exe") || name_lower.contains("claude desktop") {
        Some("Claude Desktop")
    } else if name_lower.contains("code") && name_lower != "node.exe" {
        Some("VSCode")
    } else if name_lower.contains("aider") {
        Some("Aider")
    } else if name_lower.contains("cline") {
        Some("Cline")
    } else if name_lower.contains("openhands") {
        Some("OpenHands")
    } else {
        None
    }
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
    let mut seen_sessions = std::collections::HashSet::new();

    // Pre-fill with sessions already found via lock files so we keep one visible
    // entry per project + agent kind, while still allowing Codex and Claude to
    // coexist on the same repository.
    for s in existing_sessions {
        seen_sessions.insert(session_identity(&s.project_path, &s.ide_name));
    }

    for (pid, process) in sys.processes() {
        let name_lower = process.name().to_string_lossy().to_lowercase();

        let cmd_joined = process
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().to_lowercase())
            .collect::<Vec<String>>()
            .join(" ");

        let ide_name = match detect_ide_name(&name_lower, &cmd_joined) {
            Some(n) => n,
            None => continue,
        };

        let cwd = match resolve_project_path(process) {
            Some(path) => path,
            None => continue,
        };

        let identity = session_identity(&cwd, ide_name);

        // Avoid duplicating the exact same visible agent on the same project.
        if seen_sessions.contains(&identity) {
            continue;
        }
        seen_sessions.insert(identity);

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
    use super::{
        detect_ide_name, is_system_path, looks_like_project_path_arg, should_resume,
        RESUME_CPU_THRESHOLD, RESUME_POLLS_REQUIRED,
    };
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

    #[test]
    fn detects_codex_processes_before_generic_vscode_matching() {
        assert_eq!(
            detect_ide_name("codex.exe", "\"C:\\\\Tools\\\\codex.exe\" app-server"),
            Some("OpenAI Codex")
        );
    }

    #[test]
    fn detects_claude_code_from_command_line_signature() {
        assert_eq!(
            detect_ide_name(
                "node.exe",
                "node claude-code --project F:\\\\PROJECTS\\\\Apps\\\\SynapseHub"
            ),
            Some("Claude Code Terminal")
        );
    }

    #[test]
    fn flags_system_locations_as_non_project_paths() {
        assert!(is_system_path("C:\\Program Files\\Codex"));
        assert!(is_system_path("C:\\Users\\thier\\AppData\\Local\\Programs"));
        assert!(!is_system_path("F:\\PROJECTS\\Apps\\SynapseHub"));
    }

    #[test]
    fn path_arg_filter_ignores_plain_flags_and_accepts_real_paths() {
        assert!(!looks_like_project_path_arg("--port"));
        assert!(!looks_like_project_path_arg("serve"));
        assert!(looks_like_project_path_arg(
            "F:\\PROJECTS\\Apps\\SynapseHub"
        ));
        assert!(looks_like_project_path_arg("./src"));
    }
}
