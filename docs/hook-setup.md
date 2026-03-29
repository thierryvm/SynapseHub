# Hook Setup Guide

## 1. Start SynapseHub once

Launch SynapseHub so it can generate:

- a local hook token
- a local hook port

Locations:

- Windows: `%APPDATA%\synapsehub\hook_token` and `%APPDATA%\synapsehub\hook_port`
- macOS/Linux: `~/.config/synapsehub/hook_token` and `~/.config/synapsehub/hook_port`

## 2. Update Claude Code

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

Replace `PORT` and `TOKEN` with the locally generated values.

## 3. Security notes

- The hook server only listens on `127.0.0.1`.
- Never share or commit the token value.
- If the token leaks, remove the local `hook_token` file and restart SynapseHub to rotate it.
