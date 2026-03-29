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

- The local HTTP hook server binds to `127.0.0.1` only and uses a randomly generated token stored locally.
- No credentials or secrets are ever transmitted to remote servers.
- Hook secrets are stored in the operating system config directory (`%APPDATA%\synapsehub\` on Windows, `~/.config/synapsehub/` on macOS/Linux), not inside the repository.
- Hook secrets must never be logged, copied into issue reports, or committed to version control.

Thank you for helping keep SynapseHub secure.
