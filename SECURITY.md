# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

### Responsible disclosure process

1. **Email** `thierryvm@gmail.com` with subject `[SECURITY] SynapseHub — <brief title>`.
2. Include:
   - A clear description of the vulnerability and its potential impact.
   - Steps to reproduce (proof-of-concept if available).
   - Affected version(s) and platform(s).
   - Your contact information for follow-up.
3. You will receive an acknowledgement within **72 hours** and a status update within **7 days**.
4. We aim to release a patch within **30 days** for critical issues.
5. We will credit you in the release notes (unless you prefer to remain anonymous).

### Scope

In scope:
- Remote code execution via the Tauri IPC layer or HTTP hook server.
- Authentication bypass or privilege escalation.
- Sensitive data leakage (tokens, PII, filesystem paths).
- Dependency vulnerabilities with a direct exploitation path.

Out of scope:
- Theoretical vulnerabilities without a practical attack vector.
- Vulnerabilities in third-party software not directly bundled by SynapseHub.
- Social engineering or phishing.

## Security design notes

- The local HTTP hook server binds to `127.0.0.1` only and uses a randomly generated 256-bit (64 hex chars) token stored locally.
- The token comparison uses `subtle::ConstantTimeEq` to prevent timing-based recovery.
- The hook server is rate-limited to 10 req/s (burst of 10) via `tower_governor` to bound a flooding attacker.
- On Unix, the `hook_token` file is created with `0600` permissions; on Windows we rely on the per-user ACL of the config directory.
- No credentials or secrets are ever transmitted to remote servers.
- Hook secrets are stored in the operating system config directory (`%APPDATA%\synapsehub\` on Windows, `~/.config/synapsehub/` on macOS/Linux), not inside the repository.
- Hook secrets must never be logged, copied into issue reports, or committed to version control.

## Automated security checks

Every push and pull request to `main` runs:

- `cargo audit` (binary installed via `taiki-e/install-action`) for known Rust dependency advisories.
- `cargo clippy -D warnings` and `cargo test` to keep the static analysis floor.

`npm audit` is run manually by maintainers before each release. JavaScript dependency vulnerabilities only affect the development server, not the bundled production WebView.

## Known advisories ignored in audit

`src-tauri/audit.toml` contains an explicit ignore list. Each entry is documented inline with a rationale and a tracking issue. Current entries:

| Advisory | Crate | Path | Rationale | Tracker |
|---|---|---|---|---|
| [RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097) | `rand 0.9.2` | transitive via `tauri-plugin-notification 2.3.3` | (1) SynapseHub code uses `OsRng + RngCore::fill_bytes` on `rand 0.8.5`, not `rand::rng()`; (2) `tauri-plugin-notification` uses `rand` only for notification IDs, not the vulnerable pattern (`rand::rng()` + custom logger that calls back into `rand`); (3) `tauri-plugin-notification 2.3.3` is the latest published version — no upstream patch available yet | [#13](https://github.com/thierryvm/SynapseHub/issues/13) |

Each ignored advisory is re-verified on every SynapseHub release. Entries are removed as soon as the upstream chain ships a patched version.

Thank you for helping keep SynapseHub secure.
