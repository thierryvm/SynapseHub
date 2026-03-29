# SynapseHub — Setup Guide

## 1. Install prerequisites

### Rust (required for Tauri)
```powershell
# Windows — run in PowerShell as administrator
winget install Rustlang.Rustup
# Then restart your terminal, and:
rustup default stable
```

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Node.js (v20+)
```powershell
winget install OpenJS.NodeJS.LTS  # Windows
```

### WebView2 (Windows only — usually already installed on Windows 11)
If missing: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### Linux extra dependencies
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf wmctrl pkg-config
```

---

## 2. Build SynapseHub

```bash
git clone https://github.com/YOUR_USERNAME/synapsehub.git
cd synapsehub
npm install
npm run tauri build
```

The built binary is in `src-tauri/target/release/`.

For development (hot reload):
```bash
npm run tauri dev
```

---

## 3. Connect Claude Code (Stop hook)

SynapseHub generates a unique token on first launch.
Find it at:
- **Windows:** `%APPDATA%\synapsehub\hook_token`
- **macOS/Linux:** `~/.config/synapsehub/hook_token`

Find the hook server port:
- **Windows:** `%APPDATA%\synapsehub\hook_port`
- **macOS/Linux:** `~/.config/synapsehub/hook_port`

Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://127.0.0.1:PORT/hook -H \"Content-Type: application/json\" -d \"{\\\"token\\\":\\\"TOKEN\\\",\\\"project_dir\\\":\\\"$CLAUDE_PROJECT_DIR\\\",\\\"pid\\\":$PPID}\""
          }
        ]
      }
    ]
  }
}
```

Replace `PORT` with the value from `hook_port` and `TOKEN` with the value from `hook_token`.

> **Windows note:** `curl` is available by default in Windows 11. If not, use `winget install curl.curl`.

---

## 4. Verify it works

1. Start SynapseHub — the tray icon appears
2. Open a project in Antigravity or Cursor with Claude Code active
3. The dashboard should show the project as "En cours"
4. When Claude Code finishes a turn, the card switches to "En attente" and a Windows notification fires

Click the tray icon to toggle the dashboard. Click any agent card to focus its window.

---

## Security notes

- The hook server binds to `127.0.0.1` only — unreachable from other machines
- The token is machine-generated and stored with user-only permissions
- Never commit `hook_token` or `hook_port` — they are in `.gitignore`
- SynapseHub reads lock files but never calls MCP tools with their auth tokens
