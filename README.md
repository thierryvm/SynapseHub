# SynapseHub

> Cross-platform agent activity dashboard for Claude Code — Windows, macOS, Linux.

SynapseHub lives in your system tray and tells you which Claude Code agents are active, on which project, and — critically — **which ones are waiting for your input**, even when their IDE is in the background.

Built with Tauri 2 + Rust + TypeScript. MIT licensed.

---

## Why

When working with multiple Claude Code sessions across Antigravity, Cursor, or a plain terminal, you lose track of which agent needs attention. Standard OS notifications only fire when the IDE is in the foreground. SynapseHub fixes this.

---

## Features (v0.1)

- **Agent dashboard** — see all active Claude Code sessions at a glance: project name, git branch, IDE, running time
- **Waiting detection** — highlights agents waiting for input via Claude Code's `Stop` hook
- **Native notifications** — OS-level alert when any agent needs you, regardless of which window is focused
- **One-click focus** — click an agent card to bring its IDE window to the front
- **Zero terminal required** — system tray app, starts with OS

---

## Stack

| Layer | Technology |
|---|---|
| App shell | Tauri 2 |
| Backend | Rust (axum, sysinfo, git2) |
| UI | TypeScript + CSS (no framework) |
| Notifications | tauri-plugin-notification |
| CI/CD | GitHub Actions |

---

## Quick start

See [SETUP.md](SETUP.md) for prerequisites and build instructions.

```bash
npm install
npm run tauri dev   # development
npm run tauri build # production
```

---

## Architecture

```
~/.claude/ide/*.lock   →  Rust watcher (polls every 2s)
                               ↓
                         AppState (Arc<Mutex>)
                               ↓
Claude Code Stop hook  →  axum HTTP server (127.0.0.1:PORT)
                               ↓
                         Tauri events → WebView dashboard
```

---

## Roadmap

- **v0.1** — Agent list + waiting detection + notifications + focus *(current)*
- **v0.2** — Setup wizard (auto-configure Claude Code hooks), settings UI
- **v0.3** — Multi-monitor support, custom notification sounds
- **v1.0** — Stable API for plugins / community extensions

---

## Contributing

PRs welcome. Please read [SETUP.md](SETUP.md) to get a dev environment running.
File issues for bugs or feature requests.

## License

MIT — see [LICENSE](LICENSE).
