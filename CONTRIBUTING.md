# Contributing to SynapseHub

## Dev environment setup (from scratch)

### 1. Rust

```powershell
# Windows
winget install Rustlang.Rustup --accept-package-agreements --accept-source-agreements
# Restart terminal, then:
rustup default stable
```

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 2. MSVC Build Tools (Windows only)

Required by the `windows-sys` crate and Tauri's Windows backend.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

> Takes ~5 min and ~2 GB. Skip on macOS/Linux.

### 3. Node.js (v20+)

```powershell
winget install OpenJS.NodeJS.LTS   # Windows
brew install node                  # macOS
```

### 4. Linux system dependencies

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf wmctrl
```

### 5. Security tooling (recommended)

```bash
cargo install cargo-audit
```

Run `cargo audit` (Rust) and `npm audit` (JS) before every commit that
touches `Cargo.toml`, `Cargo.lock`, `package.json`, or `package-lock.json`.
CI also runs `cargo audit` automatically on every push and pull request.

---

## Build

```bash
git clone https://github.com/YOUR_USERNAME/synapsehub.git
cd synapsehub

npm install          # JS deps + sharp for icon generation
npm run icons        # SVG → PNG (32x32, 128x128, etc.)
npm run tauri icon src-tauri/icons/icon.png  # .ico + .icns

npm run tauri dev    # hot-reload dev mode
npm run tauri build  # production build → src-tauri/target/release/bundle/
```

---

## Known issues encountered during initial setup

### `windows-sys` type mismatch (focus.rs)

`HWND` in `windows-sys` 0.59+ is `*mut c_void`, not `isize`.
Use `AtomicUsize` + cast to `HWND` when storing/loading across the enum callback.

```rust
// Wrong
static FOUND_HWND: AtomicIsize = AtomicIsize::new(0);
FOUND_HWND.store(hwnd, ...);           // hwnd is *mut c_void

// Correct
static FOUND_HWND: AtomicUsize = AtomicUsize::new(0);
FOUND_HWND.store(hwnd as usize, ...);
let hwnd = FOUND_HWND.load(...) as HWND;
```

`GetWindowThreadProcessId` takes `*mut u32`, not `Option<&mut u32>`:
```rust
// Wrong
GetWindowThreadProcessId(hwnd, Some(&mut pid));
// Correct
GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
```

### Deprecated `menu_on_left_click` (lib.rs)

```rust
// Tauri 2.x — deprecated
.menu_on_left_click(false)
// Use instead
.show_menu_on_left_click(false)
```

### SVG duplicate attribute (app-icon.svg)

`sharp` (libvips) rejects SVGs with duplicate attributes. The `<linearGradient>` element
had both `x1`/`y1` from the shorthand and from `gradientUnits="userSpaceOnUse"`.
Fix: keep only one set of coordinates per element.

---

## Project structure

```
synapsehub/
├── src/                     # TypeScript + CSS (WebView UI)
│   ├── main.ts              # Dashboard logic, Tauri event listeners
│   └── styles.css           # Design tokens, oklch colors, animations
├── src-tauri/
│   ├── icons/               # SVG sources + generated PNGs
│   │   ├── app-icon.svg     # Main icon source
│   │   ├── tray.svg         # Tray icon (color)
│   │   └── tray-monochrome.svg  # macOS template image
│   ├── src/
│   │   ├── main.rs          # Entry point
│   │   ├── lib.rs           # Tauri setup, tray, commands
│   │   ├── types.rs         # Shared types (AgentSession, AgentStatus…)
│   │   ├── watcher.rs       # Lock file scanner + PID liveness
│   │   ├── hooks.rs         # HTTP server for Claude Code Stop hooks
│   │   ├── focus.rs         # Cross-platform window focus by PID
│   │   └── notify.rs        # (placeholder) OS notification helpers
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/
│   └── generate-icons.mjs   # SVG → PNG via sharp
├── .github/workflows/
│   ├── ci.yml               # Frontend build + Rust fmt/clippy/test/audit on push/PR
│   └── release.yml          # Auto-release on tag push
├── SETUP.md                 # End-user installation + hook config
└── CONTRIBUTING.md          # This file
```

---

## Connecting Claude Code (for testing)

Find your hook token and port after first launch:
- **Windows:** `%APPDATA%\synapsehub\hook_token` and `hook_port`
- **macOS/Linux:** `~/.config/synapsehub/hook_token` and `hook_port`

Test the hook endpoint directly:
```bash
curl -X POST http://127.0.0.1:PORT/hook \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","project_dir":"C:\\your\\project"}'
```

Expected response: `200 OK`. The dashboard should update immediately.

---

## Release process

```bash
git tag v0.1.1
git push origin v0.1.1
# GitHub Actions builds all platforms and creates a draft release
```
