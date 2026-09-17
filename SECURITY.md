# Security Policy

## Supported versions

| Version/channel                 | Status                                   |
| ------------------------------- | ---------------------------------------- |
| latest tagged release (`x.y.z`) | supported - security fixes               |
| `dev` branch head               | development only - no support guarantees |
| anything older                  | unsupported - upgrade                    |

## Reporting a vulnerability

Do NOT open a public issue for security problems.

Use GitHub **Security Advisories** (Repository -> Security -> Report a vulnerability) or contact the
maintainer privately. Include: affected version/commit, reproduction steps, impact assessment.

You will receive an acknowledgment within 7 days and a fix timeline within 30 days for confirmed
issues. Credit is given in the advisory and changelog unless you prefer otherwise.

## Security posture (normative excerpts)

These are enforced product invariants (SPEC SEC-001..017 of the planning workspace):

- No hardcoded/default production secrets. Startup fails closed if `JWT_SECRET` is missing or
  shorter than 32 characters when `NODE_ENV=production`.
- Deny-by-default authorization on every server-scoped endpoint and WebSocket room.
- All filesystem operations pass through one confinement utility (realpath + prefix + symlink
  policy). Traversal, archive-slip and symlink escapes are treated as critical vulnerabilities.
- Bounded ingress: JSON body 1 MB default, per-file upload limit, decompression-ratio guard on
  archives.
- The Docker socket is never proxied over the network by panel components.
- Append-only audit log for power actions, console commands, file mutations, backup actions.
- Scoped API keys (`jtgsk_` user / `jtga_` admin), hashed at rest, enforced server-side.

## Hardening guidance for operators

- Run behind a reverse proxy with TLS, or bind panel port to localhost.
- Keep `.env` permissions at 0600; never commit `.env`.
- Enable automatic security updates for the host OS; keep Docker updated.
