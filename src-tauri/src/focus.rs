//! Cross-platform window focus by PID.

/// Brings the main window of the process `pid` to the foreground.
/// Returns true if the operation was attempted successfully.
pub fn focus_window_by_pid(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    return focus_windows(pid);

    #[cfg(target_os = "macos")]
    return focus_macos(pid);

    #[cfg(target_os = "linux")]
    return focus_linux(pid);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        log::warn!("focus_window_by_pid: unsupported platform");
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
