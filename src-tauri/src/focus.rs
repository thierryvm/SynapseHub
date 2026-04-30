//! Cross-platform window focus by PID.
//!
//! Modern terminals (Windows Terminal, Alacritty, iTerm2, GNOME Terminal,
//! Konsole, …) host CLI children inside a multiplexed window owned by the
//! terminal process itself. The `claude.exe` / `claude` CLI session we track
//! in the watcher therefore has no HWND of its own — its window lives one or
//! more `parent_pid` hops above. To still bring the right window to the
//! foreground, we walk the parent chain (bounded depth) and try focus on
//! each ancestor until one succeeds.

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

/// Maximum depth we walk up the parent chain before giving up. CLI ↔ shell ↔
/// terminal host is typically 2 hops; 5 keeps us safe against unusual nestings
/// (tmux, wsl wrapper, pwsh-in-cmd, etc.) without iterating forever.
const MAX_PARENT_HOPS: u8 = 5;

/// Brings the main window of the process `pid` (or one of its ancestors) to
/// the foreground. Returns `true` if a window was actually focused.
pub fn focus_window_by_pid(pid: u32) -> bool {
    let parents = collect_parent_chain(pid);
    log::info!(
        "focus_window_by_pid({pid}) — trying chain {:?}",
        parents
    );

    for candidate in &parents {
        if focus_one(*candidate) {
            log::info!("focus_window_by_pid({pid}) → succeeded on pid {candidate}");
            return true;
        }
    }

    log::warn!(
        "focus_window_by_pid({pid}) — no focusable window found across {} ancestors",
        parents.len()
    );
    false
}

/// Returns `[pid, parent_pid, grandparent_pid, …]` up to `MAX_PARENT_HOPS`
/// hops, excluding any PID we have already seen (cycle guard) and stopping
/// at PID 0 / unknown processes.
fn collect_parent_chain(pid: u32) -> Vec<u32> {
    let refresh_kind =
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing());
    let mut sys = System::new_with_specifics(refresh_kind);
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );

    let mut chain = Vec::with_capacity(MAX_PARENT_HOPS as usize + 1);
    chain.push(pid);

    let mut current = pid;
    for _ in 0..MAX_PARENT_HOPS {
        let parent = sys
            .process(Pid::from_u32(current))
            .and_then(|p| p.parent())
            .map(|p| p.as_u32());
        match parent {
            Some(p) if p != 0 && !chain.contains(&p) => {
                chain.push(p);
                current = p;
            }
            _ => break,
        }
    }

    chain
}

/// Platform dispatch for a single PID.
fn focus_one(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    return focus_windows(pid);

    #[cfg(target_os = "macos")]
    return focus_macos(pid);

    #[cfg(target_os = "linux")]
    return focus_linux(pid);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        log::warn!("focus_one: unsupported platform");
        false
    }
}

// ─── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn focus_windows(pid: u32) -> bool {
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
    use windows_sys::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
            ShowWindow, SW_RESTORE,
        },
    };

    // HWND is *mut c_void — store as usize for atomic access across threads.
    static FOUND_HWND: AtomicUsize = AtomicUsize::new(0);
    static TARGET_PID: AtomicU32 = AtomicU32::new(0);

    TARGET_PID.store(pid, Ordering::SeqCst);
    FOUND_HWND.store(0, Ordering::SeqCst);

    unsafe extern "system" fn enum_callback(hwnd: HWND, _: isize) -> i32 {
        let target = TARGET_PID.load(Ordering::SeqCst);
        let mut window_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut window_pid as *mut u32);
        if window_pid == target && IsWindowVisible(hwnd) != 0 {
            FOUND_HWND.store(hwnd as usize, Ordering::SeqCst);
            return 0; // stop enumeration
        }
        1 // continue
    }

    unsafe {
        EnumWindows(Some(enum_callback), 0);
        let hwnd = FOUND_HWND.load(Ordering::SeqCst) as HWND;
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd) != 0
        } else {
            false
        }
    }
}

// ─── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn focus_macos(pid: u32) -> bool {
    // Use AppleScript via osascript — no extra dependency needed.
    let script = format!(
        r#"tell application "System Events"
             set p to first process whose unix id is {pid}
             set frontmost of p to true
           end tell"#
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ─── Linux ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn focus_linux(pid: u32) -> bool {
    // Requires wmctrl to be installed: `apt install wmctrl`
    std::process::Command::new("wmctrl")
        .args(["-ip", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::collect_parent_chain;

    #[test]
    fn chain_starts_with_self() {
        let chain = collect_parent_chain(std::process::id());
        assert_eq!(chain.first().copied(), Some(std::process::id()));
    }

    #[test]
    fn chain_is_bounded() {
        let chain = collect_parent_chain(std::process::id());
        assert!(chain.len() <= super::MAX_PARENT_HOPS as usize + 1);
    }

    #[test]
    fn chain_has_no_duplicates() {
        let chain = collect_parent_chain(std::process::id());
        let mut sorted = chain.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), chain.len());
    }
}
