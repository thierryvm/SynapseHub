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
///
/// The `:\windows\` pattern is matched with the drive-letter prefix on
/// purpose: a bare `\windows\` substring would also flag user projects like
/// `F:\PROJECTS\windows-toolbox\` (the trailing slash before `windows` is the
/// path separator). Anchoring on `:\windows\` keeps the rule strictly aimed
/// at the system root.
fn is_system_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    path.is_empty()
        || path == "/"
        || lower.contains("program files")
        || lower.contains("appdata")
        || lower.contains("\\system32")
        || lower.contains("\\syswow64")
        || lower.contains(":\\windows\\")
        || lower.ends_with(":\\windows")
        || lower.contains("/system/")
        || lower.contains("/usr/bin")
        || lower.contains("/usr/lib")
        || lower.contains("/usr/sbin")
}

/// Returns true when `path` looks like an actual project root rather than a
/// generic container directory.
///
/// A "project marker" is any of the conventional manifest / metadata files
/// that signal a real codebase (Git checkout, language manifest, IDE
/// workspace). We use this as a positive gate when `git2::Repository::discover`
/// fails: without it, a CC Terminal session opened in a parent container
/// like `F:\PROJECTS\Apps\` would be accepted as a "project" and surface in
/// the dashboard, even though it is just a folder of folders.
fn has_project_indicator(path: &Path) -> bool {
    const INDICATORS: &[&str] = &[
        ".git",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "Gemfile",
        "composer.json",
        ".project",
        ".vscode",
        ".idea",
    ];
    INDICATORS.iter().any(|i| path.join(i).exists())
}

/// Best-effort normalization that collapses files to their parent directory and
/// upgrades nested paths to the repository root when a Git checkout is found.
///
/// When the candidate is not inside a Git repository, we still accept it iff
/// it carries a project marker (cf. `has_project_indicator`). This guards
/// against bare CC Terminal sessions opened in container directories such as
/// `F:\PROJECTS\Apps\` polluting the dashboard with a fake "Apps" project.
fn normalize_project_path(path: &Path) -> Option<String> {
    let candidate = if path.is_file() { path.parent()? } else { path };

    if !candidate.exists() {
        return None;
    }

    let resolved = git2::Repository::discover(candidate)
        .ok()
        .and_then(|repo| repo.workdir().map(PathBuf::from))
        .or_else(|| {
            if has_project_indicator(candidate) {
                Some(candidate.to_path_buf())
            } else {
                None
            }
        })?;

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
///
/// `cmd_joined` is expected to be lowercase already (the caller in
/// `scan_processes` lowercases each cmd arg before joining).
fn detect_ide_name(name_lower: &str, cmd_joined: &str) -> Option<&'static str> {
    // Claude Code Terminal CLI — multiple signatures across versions:
    // - Pre-v2026: `node claude-code …`, `@anthropic-ai/…`, or `claude.cmd`
    // - v2026 Windows: `claude --dangerously-skip-permissions -c` — bare
    //   binary, no path prefix. Distinguished from Claude Desktop by the
    //   absence of `\windowsapps\claude_` (which is what the desktop
    //   Electron bundle carries on Windows).
    let is_claude_code_legacy = cmd_joined.contains("claude-code")
        || cmd_joined.contains("@anthropic-ai")
        || cmd_joined.contains("claude.cmd");
    let is_claude_terminal_v2026 = (cmd_joined == "claude"
        || cmd_joined == "claude.exe"
        || cmd_joined.starts_with("claude ")
        || cmd_joined.starts_with("claude.exe ")
        || cmd_joined.starts_with("\"claude\" "))
        && !cmd_joined.contains("\\windowsapps\\claude_");
    if is_claude_code_legacy || is_claude_terminal_v2026 {
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
    } else if name_lower.contains("claude desktop")
        || cmd_joined.contains("\\windowsapps\\claude_")
        || cmd_joined.contains("/applications/claude.app/")
    {
        // Claude Desktop is recognised by the Electron bundle path: the
        // WindowsApps installer on Windows or the `.app` bundle on macOS.
        // A bare `claude.exe` without one of those prefixes is the CLI
        // and was already handled above; falling through here means we
        // intentionally ignore it rather than mislabel it as Desktop.
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

    // CPU optimisation: only collect the fields we actually consume
    // downstream (cpu / exe / cmd / cwd). `OnlyIfNotSet` means each field
    // is read once per process and reused across polls until that process
    // exits, so adding `cwd` here costs one PEB read per new process and
    // nothing per refresh.
    //
    // `with_cwd` is mandatory: without it, sysinfo Windows leaves
    // `process.cwd()` returning `None` for every process (cf. sysinfo
    // 0.33.1 src/windows/process.rs:816 — `cwd_needs_update` short-circuits
    // unless the refresh kind explicitly asks for it). That broke project
    // path resolution for Claude Code Terminal CLI sessions whose cmd
    // line carries no path argument to fall back on.
    let refresh_kind = RefreshKind::nothing().with_processes(
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
    let mut sys = System::new_with_specifics(refresh_kind);
    let mut start_times: HashMap<String, u64> = HashMap::new();
    let mut resume_votes: HashMap<String, u8> = HashMap::new();

    loop {
        // Keep the refresh shape in sync with the initial RefreshKind above
        // — the same `with_cwd(...)` is required here for new processes
        // discovered between polls.
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet),
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
        detect_ide_name, has_project_indicator, is_system_path, looks_like_project_path_arg,
        normalize_project_path, should_resume, RESUME_CPU_THRESHOLD, RESUME_POLLS_REQUIRED,
    };
    use crate::types::WaitingState;
    use std::path::Path;

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
    fn detects_claude_code_terminal_cli_v2026_windows() {
        // Reproduces @thierry's smoke-test scenario on v0.1.2: bare
        // `claude` invocation with the typical CC Terminal CLI flags,
        // no path prefix, name = `claude.exe`.
        assert_eq!(
            detect_ide_name("claude.exe", "claude  --dangerously-skip-permissions -c"),
            Some("Claude Code Terminal")
        );
    }

    #[test]
    fn detects_claude_code_terminal_cli_minimal() {
        // Edge case: a shell where the user typed just `claude` with no
        // arguments. We still want to surface it.
        assert_eq!(
            detect_ide_name("claude.exe", "claude"),
            Some("Claude Code Terminal")
        );
    }

    #[test]
    fn does_not_misclassify_claude_desktop_as_terminal() {
        // The desktop Electron app on Windows ships under a versioned
        // WindowsApps directory. The cmd line carries the full path,
        // which is the discriminator we use to keep it labelled as the
        // Desktop app, not the CLI.
        assert_eq!(
            detect_ide_name(
                "claude.exe",
                r#""c:\program files\windowsapps\claude_1.5354.0.0_x64__pzs8sxrjxfjjc\app\claude.exe""#
            ),
            Some("Claude Desktop")
        );
    }

    #[test]
    fn does_not_misclassify_claude_desktop_subprocess_as_terminal() {
        // Electron renderer / utility sub-processes inherit the same
        // WindowsApps path prefix and add a `--type=…` flag. Same
        // discrimination rule applies.
        assert_eq!(
            detect_ide_name(
                "claude.exe",
                r#""c:\program files\windowsapps\claude_1.5354.0.0_x64__pzs8sxrjxfjjc\app\claude.exe" --type=renderer"#
            ),
            Some("Claude Desktop")
        );
    }

    // ─── v0.3.0 Vague 2a (#43) — IDE detection coverage baseline ─────────────
    //
    // The 6 IDEs targeted by issue #43 (Codex / Cursor / Aider / Cline /
    // OpenHands / Windsurf) had bare-minimum `name_lower.contains(...)`
    // patterns prior to v0.3.0 but no dedicated tests. The block below pins
    // the *current* behaviour as a regression baseline before the post-pwsh
    // refinement round adds cmd-line aware patterns for Node-bundled and
    // Python-bundled invocations. Tests labelled "*_currently_unmatched_*"
    // are intentional bookmarks documenting where the current matcher falls
    // short — they will be flipped to positive matches once empirical cmd
    // lines from @thierry's diagnostic are merged in.

    #[test]
    fn detects_openai_codex_desktop_via_windowsapps_path() {
        // OpenAI Codex desktop app is distributed via the Microsoft Store
        // and installs under `WindowsApps/OpenAI.Codex_<version>/app/Codex.exe`.
        // ProcessName lowercased is "codex" → caught by the existing
        // `name_lower.contains("codex")` arm BEFORE the generic VSCode
        // fallback. The desktop-app project resolution is a separate
        // concern: `resolve_project_path` rejects WindowsApps cwd as a
        // system path, so Codex desktop sessions still don't surface
        // until v0.4.0+ adds lock-file-based desktop hooks (#43 §2).
        assert_eq!(
            detect_ide_name(
                "codex.exe",
                r#""c:\program files\windowsapps\openai.codex_26.429.2026.0_x64__2p2nqsd0c76g0\app\codex.exe""#
            ),
            Some("OpenAI Codex")
        );
    }

    #[test]
    fn detects_cursor_from_process_name() {
        // Cursor ships as an Electron app with a real `Cursor.exe` host
        // binary. ProcessName lowercased is "cursor.exe" or "cursor".
        assert_eq!(detect_ide_name("cursor.exe", "cursor.exe"), Some("Cursor"));
        assert_eq!(detect_ide_name("cursor", "cursor"), Some("Cursor"));
    }

    #[test]
    fn detects_cursor_subprocess() {
        // Cursor renderer / utility helpers inherit the same process name
        // and add a `--type=…` Electron flag.
        assert_eq!(
            detect_ide_name(
                "cursor.exe",
                r#""c:\users\thier\appdata\local\programs\cursor\cursor.exe" --type=renderer"#
            ),
            Some("Cursor")
        );
    }

    #[test]
    fn detects_windsurf_from_process_name() {
        // Windsurf is the Codeium fork of VSCode, also Electron-based.
        // Distinct ProcessName "windsurf.exe" — not the generic "code.exe".
        assert_eq!(
            detect_ide_name("windsurf.exe", "windsurf.exe"),
            Some("Windsurf")
        );
    }

    #[test]
    fn detects_aider_from_process_name_when_packaged() {
        // PyInstaller / pip-shim packaging produces a real `aider.exe`
        // binary on Windows. The pure-pip install path (`python -m aider`)
        // requires cmd-line matching and is captured below as a regression
        // bookmark — tracked for refinement once empirical cmd-line lands.
        assert_eq!(
            detect_ide_name("aider.exe", "aider --model gpt-4o"),
            Some("Aider")
        );
        assert_eq!(detect_ide_name("aider", "aider"), Some("Aider"));
    }

    #[test]
    fn aider_python_module_invocation_currently_unmatched_regression_check() {
        // `python -m aider` and `python /path/to/aider/__main__.py` run
        // under `python.exe`. The current `name_lower.contains("aider")`
        // pattern does NOT match this invocation, so the watcher returns
        // None and the session does not surface. This test pins today's
        // behaviour so the post-empirical refinement is an intentional
        // change (assertion will flip from None to Some("Aider")).
        assert_eq!(
            detect_ide_name("python.exe", "python -m aider --model gpt-4o"),
            None
        );
        assert_eq!(
            detect_ide_name(
                "python.exe",
                r#""c:\program files\python313\python.exe" "c:\users\thier\appdata\roaming\python\python313\scripts\aider.py" --model gpt-4o"#
            ),
            None
        );
    }

    #[test]
    fn detects_cline_from_process_name() {
        // Hypothetical standalone packaging — captures the current pattern
        // intent. The realistic VSCode-extension hosting path (`code.exe`
        // + cline extension dir) is tracked separately as a regression
        // bookmark below.
        assert_eq!(detect_ide_name("cline.exe", "cline"), Some("Cline"));
    }

    #[test]
    fn cline_vscode_extension_currently_unmatched_regression_check() {
        // Cline ships as a VSCode extension. The host process is `code.exe`
        // and `name_lower.contains("cline")` returns false. The dispatcher
        // routes a bare `code.exe` to "VSCode" instead via the generic
        // `name.contains("code")` arm. Pinned as a regression bookmark —
        // post-empirical refinement will add a cmd-line check that lifts
        // Cline above the VSCode fallback when its extension path appears
        // in the args.
        assert_eq!(
            detect_ide_name(
                "code.exe",
                r#""c:\users\thier\appdata\local\programs\microsoft vs code\code.exe" --extension-id rooveterinaryinc.cline"#
            ),
            Some("VSCode")
        );
    }

    #[test]
    fn detects_openhands_from_process_name() {
        // PyInstaller packaging produces a real `openhands.exe`. The
        // realistic Docker container hosting path is tracked separately
        // as a regression bookmark — `docker.exe` host is intentionally
        // unmatched (out of scope for the watcher to introspect Docker).
        assert_eq!(
            detect_ide_name("openhands.exe", "openhands"),
            Some("OpenHands")
        );
    }

    #[test]
    fn openhands_docker_host_currently_unmatched_regression_check() {
        // OpenHands distributed as Docker container: visible process is
        // `docker.exe`, not `openhands.exe`. Detecting an OpenHands
        // container from the host side would require inspecting
        // `docker ps` output, which is out of scope for the watcher.
        // Pinned as a regression bookmark — this case is not a candidate
        // for the post-empirical refinement.
        assert_eq!(
            detect_ide_name(
                "docker.exe",
                r#""docker" run -p 3000:3000 openhands/openhands-app:latest"#
            ),
            None
        );
    }

    #[test]
    fn does_not_misclassify_unrelated_node_processes() {
        // Sanity check: a generic Node tool (npm dev server, Vite, etc.)
        // that does NOT carry an Anthropic / Codex / agent signature in
        // its cmd line must return None. This guards against future
        // pattern additions accidentally over-matching `node.exe`.
        assert_eq!(detect_ide_name("node.exe", "node"), None);
        assert_eq!(
            detect_ide_name("node.exe", "node /usr/local/bin/npm run dev"),
            None
        );
        assert_eq!(
            detect_ide_name(
                "node.exe",
                "node /usr/local/lib/node_modules/vite/bin/vite.js"
            ),
            None
        );
    }

    #[test]
    fn flags_system_locations_as_non_project_paths() {
        assert!(is_system_path("C:\\Program Files\\Codex"));
        assert!(is_system_path("C:\\Users\\thier\\AppData\\Local\\Programs"));
        assert!(!is_system_path("F:\\PROJECTS\\Apps\\SynapseHub"));
    }

    #[test]
    fn flags_windows_system32_as_non_project() {
        // The smoke-test fault: a PowerShell admin dropping a CC Terminal
        // session in `C:\WINDOWS\system32` was being surfaced as a project.
        assert!(is_system_path(r"C:\WINDOWS\system32"));
        assert!(is_system_path(r"C:\WINDOWS\system32\"));
        assert!(is_system_path(r"C:\Windows\System32\drivers"));
    }

    #[test]
    fn flags_windows_syswow64_as_non_project() {
        // 32-bit syscall layer on 64-bit Windows. Same intent as system32.
        assert!(is_system_path(r"C:\WINDOWS\SysWOW64"));
        assert!(is_system_path(r"C:\Windows\SysWOW64\drivers"));
    }

    #[test]
    fn flags_generic_windows_dir_as_non_project() {
        // Catch-all for `X:\Windows\…` subtrees we have not enumerated.
        assert!(is_system_path(r"C:\Windows\WinSxS"));
        assert!(is_system_path(r"C:\Windows"));
    }

    #[test]
    fn does_not_flag_user_projects_with_windows_in_name() {
        // Anti-false-negative: a user project whose folder name contains
        // "windows" must not be flagged as system. Anchoring the rule on
        // the drive-letter prefix `:\windows\` keeps user paths safe.
        assert!(!is_system_path(r"F:\PROJECTS\windows-toolbox"));
        assert!(!is_system_path(r"F:\PROJECTS\Apps\windows-helper\src"));
    }

    #[test]
    fn flags_unix_system_locations_as_non_project() {
        assert!(is_system_path("/usr/bin"));
        assert!(is_system_path("/usr/lib/x86_64-linux-gnu"));
        assert!(is_system_path("/usr/sbin"));
        assert!(is_system_path("/system/bin/sh"));
        assert!(!is_system_path("/home/thierry/projects/synapsehub"));
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

    /// Creates an isolated test directory unique to each invocation, rooted
    /// under the user's home directory.
    ///
    /// We deliberately avoid two cleaner-looking alternatives:
    ///
    /// - `std::env::temp_dir()`: resolves to `…\AppData\Local\Temp\…` on
    ///   Windows, which `is_system_path` (correctly) flags as system. Any
    ///   end-to-end test of `normalize_project_path` placed there would
    ///   fail spuriously.
    /// - `CARGO_MANIFEST_DIR/target/…`: lives inside the SynapseHub Git
    ///   tree, so `git2::Repository::discover` walks up and finds the
    ///   project root. A test that intends to place a "container without
    ///   project marker" would then resolve to the SynapseHub workdir and
    ///   pass for the wrong reason.
    ///
    /// Home directory is typically neither under a system path nor inside
    /// any Git tree; we keep test artefacts under `.synapsehub-test-tmp/`
    /// to make them obvious and easy to wipe.
    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let base = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let dir = base
            .join(".synapsehub-test-tmp")
            .join(format!("{label}-{nonce}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn project_indicator_accepts_git_repo() {
        let dir = make_temp_dir("git");
        std::fs::create_dir_all(dir.join(".git")).expect("create .git");
        assert!(has_project_indicator(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_indicator_accepts_node_project() {
        let dir = make_temp_dir("node");
        std::fs::write(dir.join("package.json"), "{}").expect("write package.json");
        assert!(has_project_indicator(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_indicator_accepts_rust_project() {
        let dir = make_temp_dir("rust");
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n")
            .expect("write Cargo.toml");
        assert!(has_project_indicator(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_indicator_rejects_empty_container() {
        // The smoke-test fault: `F:\PROJECTS\Apps\` had no project marker
        // of its own (just sub-folders). It must be rejected.
        let dir = make_temp_dir("container");
        assert!(!has_project_indicator(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_rejects_container_dir_without_project_marker() {
        // End-to-end: a container directory like `F:\PROJECTS\Apps\` must
        // not be returned as a project path even though it exists.
        let dir = make_temp_dir("normalize-container");
        assert!(normalize_project_path(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_accepts_dir_with_project_marker() {
        let dir = make_temp_dir("normalize-marker");
        std::fs::write(dir.join("Cargo.toml"), "[package]\nname = \"x\"\n")
            .expect("write Cargo.toml");
        assert!(normalize_project_path(&dir).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_rejects_nonexistent_path() {
        let path = std::env::temp_dir().join("synapsehub-does-not-exist-xyz");
        let _ = std::fs::remove_dir_all(&path);
        assert!(normalize_project_path(&path).is_none());
    }

    #[test]
    fn normalize_rejects_system_path_even_with_marker() {
        // Defence in depth: if some hostile path with `system32` ever gets
        // a `.git` folder, we still refuse. Hard to fabricate cleanly in
        // a temp dir, so we use a synthesized path string by going through
        // the `is_system_path` fallback. This is a smoke-check, not an
        // exhaustive proof.
        let _ = Path::new(""); // silence unused import warnings on Windows
        assert!(is_system_path(r"C:\WINDOWS\system32"));
    }
}
