# SynapseHub Release Process

This document captures the canonical process for publishing a SynapseHub release. It is the single source of truth for "how do we ship a new version" and exists so future maintainers (and our future selves) don't have to rediscover the workflow from scratch.

It also keeps a log of historical anomalies — every release that didn't go cleanly contributes back here.

## Pre-requisites

### Repository protections

- `main` branch protection enabled (no direct push, PR + 1 review required, status checks must pass).
- `cargo audit` step must be green (advisories listed in `src-tauri/audit.toml` are explicitly ignored — see `SECURITY.md` for rationale).

### GitHub Actions secrets

Two secrets are required for the signed updater bundle:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key (base64-encoded, including the `untrusted comment:` header) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting the private key. **Set explicitly to the empty string if the key has no password** — the variable must be defined, not absent. |

Verify via `Settings → Secrets and variables → Actions`. The values are masked but their presence is shown.

### Minisign keypair generation

The private key was generated with the Tauri CLI:

```bash
npm run tauri signer generate -- -w ~/.tauri/synapsehub.key
# or
cargo tauri signer generate -w ~/.tauri/synapsehub.key
```

This produces:
- `~/.tauri/synapsehub.key` — private key (keep secret, **never commit**)
- `~/.tauri/synapsehub.key.pub` — public key (paste content into `tauri.conf.json` `plugins.updater.pubkey`)

The current public key fingerprint in `tauri.conf.json` is `BD5AA9E173A8A318` (visible in the base64 header). Cross-check with the private key in the secret store.

To regenerate the keypair, follow the same procedure, **bump the SynapseHub minor version**, and ship a hard cutover release — installs running the previous public key cannot validate updates signed by the new private key.

### Local development environment variables

Copy `.env.example` (committed at the repo root) to `.env.local` (git-ignored) and fill in only the values you actually need.

As of v0.1.1, SynapseHub itself does **not** consume any custom environment variables — the hook server picks a random loopback port at startup, the polling cadence is hard-coded in `watcher.rs`, and runtime configuration lives under the OS config directory (`%APPDATA%\synapsehub\` on Windows, `~/Library/Application Support/synapsehub/` on macOS, `~/.config/synapsehub/` on Linux).

The two variables that *do* influence local builds today are:

| Variable | Consumer | Notes |
|---|---|---|
| `RUST_LOG` | `env_logger::init()` in `src-tauri/src/lib.rs::run` | Levels: `error` / `warn` / `info` / `debug` / `trace`. Default `warn`. |
| `TAURI_ENV_DEBUG` | `vite.config.ts` (lines 15-16) | Set automatically by `npm run tauri dev`; you normally do not touch it. |

Any future configuration that *should* be env-driven (e.g. `SYNAPSEHUB_HOOK_PORT`) gets added simultaneously to:
- `.env.example`
- This document
- `CONTRIBUTING.md` if it affects new contributors

## Step 1 — Prepare the version

1. Open a `feat/vX.Y.Z-ergonomics` (or similar) branch for the version bump and any UX/CI cleanup.
2. Bump version in **three places** (kept manually in sync — there is no shared source-of-truth file yet):
   - `package.json` (`"version"`)
   - `src-tauri/Cargo.toml` (`[package] version`)
   - `src-tauri/tauri.conf.json` (`"version"`)
3. Run `cargo check --all-features` from `src-tauri/` to regenerate `Cargo.lock`.
4. Update `CHANGELOG.md` with a `## [X.Y.Z] - YYYY-MM-DD` entry following [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Sections used so far: `Security`, `Tests`, `UX`, `Added`.
5. Open a PR, merge after CI green + Sourcery clean. The merged commit is what the tag will point at.

## Step 2 — Sanity checks pre-tag (mandatory)

Run from a clean checkout of `main`:

```bash
git checkout main
git pull origin main
git status                                # working tree must be clean
git log --oneline -3                      # the bump version commit must be at HEAD or HEAD-1

grep -A3 '"updater"' src-tauri/tauri.conf.json
#   must show pubkey present (format: starts with 'dW50cnVzdGVkIGNv...')
#   must show endpoints pointing to https://github.com/.../releases/latest/download/latest.json

head -20 CHANGELOG.md
#   must have the new version entry with at least one bullet
```

If any of these fail, fix before tagging. The tag is immutable once pushed.

## Step 3 — Annotated tag + push

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z — <one-line summary>

<paragraph summary, optionally bulleted by domain>

See CHANGELOG.md for full details."

git push origin vX.Y.Z
```

The push triggers `.github/workflows/release.yml` automatically (`on: push: tags: ['v*']`).

**Annotated tags only** (`-a`). Lightweight tags do not carry a message and break the release feed for some users.

## Step 4 — Monitor the matrix build

```bash
gh run list --repo thierryvm/SynapseHub --workflow=release.yml --limit 1
gh run watch <RUN_ID> --repo thierryvm/SynapseHub --exit-status
```

The matrix builds 4 OS targets in parallel:

| OS runner | Target | Typical duration |
|---|---|---|
| `windows-latest` | `x86_64-pc-windows-msvc` | 9 min |
| `macos-latest` | `x86_64-apple-darwin` | 5 min |
| `macos-latest` | `aarch64-apple-darwin` | 6 min |
| `ubuntu-latest` | `x86_64-unknown-linux-gnu` | 7 min |

Wall-clock total ~9 min (limited by the slowest job).

If any job fails, **stop**: do not retry blindly. Inspect with `gh run view <RUN_ID> --log-failed`, diagnose, document, and follow the rollback procedure below.

## Step 5 — Verify post-build (CRITICAL — added after v0.1.1)

The release publication itself does not guarantee the updater pipeline worked. **Always verify the asset list manually**:

```bash
gh release view vX.Y.Z --repo thierryvm/SynapseHub --json assets \
  --jq '.assets[] | .name' | sort
```

Required assets for a complete release:

| Asset class | Pattern | Why |
|---|---|---|
| Windows installer | `*_x64_en-US.msi`, `*_x64-setup.exe` | End-user install |
| macOS Intel | `*_x64.dmg` | End-user install |
| macOS Apple Silicon | `*_aarch64.dmg` | End-user install |
| macOS updater bundles | `*_x64.app.tar.gz`, `*_aarch64.app.tar.gz` | Auto-update payload |
| Linux | `*_amd64.deb`, `*_amd64.AppImage`, `*-1.x86_64.rpm` | End-user install |
| **Updater manifest** | `latest.json` | Consumed by `tauri-plugin-updater::check()` — without it, no auto-update |
| **Signatures** | `*.sig` next to each Windows / macOS / Linux primary binary | Validated client-side via the embedded minisign public key |

If `latest.json` or any `.sig` is missing → **stop**. Do not announce the release. Trace via the historical anomalies section below.

## Step 6 — Smoke test install (recommended)

On a separate machine (or VM), download the installer for that OS and:

1. Install (no security warning beyond what the OS expects for an unsigned-by-OS app — Tauri minisign signing is for *updates*, not for OS-level code signing).
2. Launch the app once. The first run generates `hook_token` under the OS config dir.
3. Quick smoke: open Settings, verify the token + port are present in the snippet, copy it.
4. Connect to a Claude Code session and trigger a Stop hook. The dashboard should update.

## Step 7 — Test auto-update (cross-version)

Once **vX.Y.Z+1** has shipped (or a release candidate is published):

1. On a machine that already has vX.Y.Z installed, open Settings → Rechercher.
2. The updater should detect the newer version, display the changelog, and offer Install.
3. Click Install, watch the progress bar, restart the app.
4. Confirm the version label now shows the new version.

If `check()` returns "Vérification indisponible" or 404 errors are visible in the WebView devtools, the `latest.json` was not published correctly for the new version — see anomaly v0.1.1 below.

## Historical anomalies

Each anomaly here is a real release where something went wrong. Future maintainers should consult this list before assuming a problem is unique.

### v0.1.1 (2026-04-29) — bundle updater not uploaded

**Symptom**

`gh release view v0.1.1` lists 9 binaries but no `latest.json` and no `.sig` files. Logs of the Build step show on all 4 OS runners:

```
Signature not found for the updater JSON. Skipping upload...
```

**Diagnostic (post-v0.1.1 investigation)**

Two hypotheses were considered:

1. *(Initial guess, partially wrong)* `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret missing or empty.
   - Refuted: @thierry confirmed both secrets are configured. The empty display in CI logs is GitHub Actions masking, not absence.
2. *(Confirmed root cause)* Tauri 2 does not generate updater artifacts by default. Either `bundle.createUpdaterArtifacts: true` or `bundle.targets` containing `"updater"` is required in `tauri.conf.json`. The v0.1.1 config had `bundle.targets: "all"` (which does **not** imply `updater`) and no `createUpdaterArtifacts`, so the bundler produced installers but skipped the `.sig` generation step. `tauri-action` then correctly looked for the signatures and, finding none, skipped the `latest.json` upload.

**Resolution (planned for v0.1.2)**

Tracked in [#17](https://github.com/thierryvm/SynapseHub/issues/17). The fix is a one-line addition to `tauri.conf.json`:

```json
"bundle": {
  "active": true,
  "targets": "all",
  "createUpdaterArtifacts": true,
  ...
}
```

A pre-merge validation step is to run a release-candidate tag (`vX.Y.Z-rc.1`) and check the asset list before promoting to a real release tag.

**Decision archived (Option γ)**

Re-tagging v0.1.1 was rejected (force-push to a published tag breaks downstream consumers). Re-running the workflow on the same tag was rejected (would publish without diagnosis). Instead, v0.1.1 stays public and installable; the fix lands in v0.1.2 and that becomes the first auto-updatable release. Existing v0.1.1 users (currently zero) will need a manual reinstall.

References: `cc-handoffs/2026-04-29-1730-release-v0-1-1-published.md` §6.1 + §7, issue #17.

## Rollback procedure

A pushed tag is immutable. The released GitHub Release page is also immutable. Do not attempt to overwrite either.

### Case A — small fix, fast turnaround

1. Open a hotfix branch from `main`.
2. Fix, bump version (e.g. `0.1.1` → `0.1.2`), update `CHANGELOG.md`.
3. Tag `vX.Y.Z+1` and push — the new release supersedes the broken one (the auto-updater always fetches `releases/latest/download/latest.json`).

### Case B — broken release that's actively hurting users

1. Open the affected GitHub Release in the UI.
2. Mark it as a **pre-release** (this hides it from `releases/latest` API).
3. Drop a comment in the release body pointing to the fixed version.
4. Follow Case A for the actual fix.

### Case C — leaked private key

1. Generate a new minisign keypair.
2. Update `tauri.conf.json` `plugins.updater.pubkey`.
3. Update both GitHub secrets.
4. Bump version, ship a hard-cutover release.
5. Existing installs cannot auto-update past this point — communicate via every channel available.

This is the worst case and is why the private key must never leave a secret store.

## Process improvements queued

- Single-source-of-truth version file (script that bumps `package.json`, `Cargo.toml`, `tauri.conf.json` from one input).
- Pre-tag CI-only smoke job that runs `tauri-action` against a `-rc` tag in dry-run mode and validates the asset list before the real tag is pushed.
- Auto-publish a discussion thread on the GitHub Releases page for each version, linking to the CHANGELOG section.
