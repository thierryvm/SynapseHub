# Watcher Windows — investigation cwd / detect_ide_name (29 avril 2026)

Pre-implementation investigation for the v0.1.3 hotfix sprint
([handoff](../cowork-handoffs/2026-04-29-2030-v0-1-3-hotfix-watcher.md), issue tracked on the parent PR).

## Symptom

SynapseHub v0.1.2 reports **0 active sessions** even though three Claude Code
Terminal CLI sessions are running on Windows. Process snapshot from
@thierry's machine:

```
ProcessId : 16344
Name      : claude.exe
CommandLine: claude  --dangerously-skip-permissions -c

ProcessId : 17352
Name      : claude.exe
CommandLine: claude  --dangerously-skip-permissions -c
```

Two layers of the watcher need attention.

## Layer 1 — `detect_ide_name` pattern matching

Current implementation (`src-tauri/src/watcher.rs`, lines 128-134):

```rust
if cmd_joined.contains("claude-code")
    || cmd_joined.contains("@anthropic-ai")
    || cmd_joined.contains("claude.cmd")
{
    return Some("Claude Code Terminal");
}
```

The CC Terminal CLI v2026 cmd line is `claude --dangerously-skip-permissions -c`
— it contains **none** of the three substrings. Detection falls through to
the generic branch at line 150:

```rust
} else if name_lower.contains("claude.exe") || name_lower.contains("claude desktop") {
    Some("Claude Desktop")
}
```

So every CC Terminal CLI session is silently misclassified as Claude
Desktop. From there, `resolve_project_path` either returns `None` (cf. Layer
2) or an irrelevant path, and the session is dropped or merged with a
phantom Desktop entry.

### Distinguishing the two

The CC Terminal CLI cmd line is a relative-name invocation
(`claude  --dangerously-skip-permissions -c`).

The desktop Electron app, when present on Windows, runs from
`C:\Program Files\WindowsApps\Claude_<version>_x64__<id>\app\claude.exe`
and its cmd line carries the full path. We can branch cleanly on the
presence of `\windowsapps\claude_` (case-insensitive, since `cmd_joined`
is already lowercased upstream).

Patterns to add for CC Terminal:
- `cmd_joined.starts_with("claude ")`
- `cmd_joined.starts_with("claude.exe ")` AND **not** containing `\windowsapps\`
- `cmd_joined.starts_with("\"claude\" ")` (quoted invocations seen in some shells)

Anti false-positive: keep the `\windowsapps\claude_` test as a guard
clause before returning `"Claude Code Terminal"`.

The existing branch for Claude Desktop becomes positively gated:
return `"Claude Desktop"` **only** when the cmd line carries
`\windowsapps\claude_` (Windows) or `/applications/claude.app/`
(macOS, harmless on Windows). A bare `claude.exe` with no path-prefix
has no business being labelled as Desktop and we return `None` so the
process is ignored cleanly.

## Layer 2 — `process.cwd()` is never populated

The watcher builds its `RefreshKind` like this (lines 364-369):

```rust
let refresh_kind = RefreshKind::nothing().with_processes(
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet),
);
```

And refreshes with the same shape (lines 379-383). Notice **`.with_cwd(...)`
is absent**.

Cross-checked against the sysinfo 0.33.1 source on Windows
(`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/sysinfo-0.33.1/src/windows/process.rs`):

```rust
// line 647 (Process::refresh path):
|| refresh_kind.cwd().needs_update(|| process.cwd.is_none())

// line 816 (initial process collection):
let cwd_needs_update = refresh_kind.cwd().needs_update(|| cwd.is_none());
// ...
// line 823: only when cwd_needs_update is true does it actually call
// QueryProcessImageName / read PEB to populate cwd. Otherwise the field
// stays None forever.
```

Conclusion: as long as we never call `.with_cwd(...)`, **`process.cwd()`
returns `None` for every process on every poll**, regardless of OS. The
fact that the dashboard occasionally surfaces sessions on macOS/Linux
today is incidental — the lock-file path (`scan_lock_files`) does not
need cwd, and the args fallback in `resolve_project_path` happens to
produce a result in some cases. CC Terminal CLI v2026 carries no path
in its argv, so the args fallback fails too, leaving us with nothing.

### Fix shape

Add `.with_cwd(UpdateKind::OnlyIfNotSet)` to both `ProcessRefreshKind`
builders. `OnlyIfNotSet` keeps the cost down: the cwd is read once per
process and reused across polls until that process exits.

We also keep the existing args fallback (`looks_like_project_path_arg`)
as a defense-in-depth for processes that genuinely have no readable cwd
(some sandboxed / restricted-token scenarios on Windows 11).

The handoff suggested two further fallbacks (parent process cwd, env
`PWD`). Neither is needed if `with_cwd` itself is the missing piece:
once it's set, the kernel-side `QueryProcessImageName` path runs and
returns the real working directory the process was spawned in. If real
production data later shows persistent gaps despite `with_cwd`, we can
add the parent-cwd fallback in a follow-up patch.

## Sanity check on existing tests

`watcher.rs` has 10 unit tests today. The relevant one for this fix:

- `detects_claude_code_from_command_line_signature` (line 549) — tests
  the `claude-code` substring path. **Stays green** because we keep
  that branch unchanged.

The cwd refresh fix is purely a runtime data-collection question; it
cannot be unit-tested without a real `sysinfo::Process` fixture.
Coverage there comes from the @thierry smoke test (Phase 11 of the
handoff).

## Plan

1. Update `detect_ide_name` to add the CC Terminal CLI v2026 patterns
   and gate the Claude Desktop return on the WindowsApps path.
2. Add `.with_cwd(UpdateKind::OnlyIfNotSet)` to both RefreshKind
   builders in `start_watcher`.
3. Four new unit tests in `watcher::tests`:
   - `detects_claude_code_terminal_cli_v2026_windows`
   - `detects_claude_code_terminal_cli_minimal`
   - `does_not_misclassify_claude_desktop_as_terminal`
   - `does_not_misclassify_claude_desktop_subprocess_as_terminal`
4. Bump 0.1.2 → 0.1.3 across the three sources of truth.
5. Update CHANGELOG.
6. Commit, push, PR with `Fixes #<issue>`.

Confidence: **high**. Both root causes are mechanically observable in
the source — no environmental guesswork.
