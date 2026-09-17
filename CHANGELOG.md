# Changelog

All notable changes to Renom are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: SemVer.

## [Unreleased]

### Added

- `renom.sh` console dashboard: install / update / delete from one script, including a
  `curl | bash` path that fetches the repo and re-runs locally.
- Minecraft lifecycle: declarative install-op executor (PaperMC Fill v3, Mojang piston-meta,
  Purpur v2 with checksum verification), explicit EULA acceptance gate, startup variables
  API, background installs with honest `installing → ready / install_failed` states.
  Paper boots for real (verified: `Done (40.4s)!` through the local engine).
- Bootable Paper/Vanilla/Purpur blueprints on the local process engine; Fabric/Forge
  declared for Docker (honest 409 locally).
- Optional Minekube Connect tunnel per Java server: plugin install, `CONNECT_ENDPOINT`
  wiring, public-address scraping from console history into the Network tab.
- Server detail tabs: Startup (variables), Network (allocations + tunnel), Users
  (collaborators), Settings (rename/reinstall/delete); `server.properties` shortcut.
- Warm-paper UI theme (terracotta accent, serif display + mono utility).
- Repository scaffold: Apache-2.0 license, NOTICE, provenance doc, security policy.
- CI pipeline: install, typecheck, lint, unit tests, production build, secret scan (gitleaks),
  dependency audit, SBOM artifact.
- Panel server skeleton: fail-closed environment configuration (SEC-001), structured pino logging
  with secret redaction, request-id middleware (NFR-008), RFC-7807-style error mapping,
  `/healthz` + `/readyz` endpoints (FR-154), 1 MB JSON body bound (SEC-010).
- Servers domain: CRUD with quotas, automatic primary allocations with conflict detection,
  suspend/unsuspend, soft delete with allocation release; `local` node seeded at boot.
- Local process runtime engine: argv-only launches (no shell), graceful console/signal stop,
  kill, restart, bounded console history, boot-time state reconciliation.
- Power API (`POST /servers/:id/power`) with per-action permissions; Socket.IO console
  gateway with token auth, existence-hiding joins, and per-socket send limits.
- Scoped API keys (`jtgsk.*`, shown once, hashed at rest, revocation + expiry) that can only
  narrow the owner's own permissions; subuser grants with permission vocabulary validation;
  allocation assign/release with last-allocation protection.
- Backups: tar.gz snapshots with checksums, locked retention, checksum-verified restore,
  download endpoint; schedules: 5-field UTC cron, atomic claiming, power/command/backup
  tasks, manual trigger.
- First-run setup: `GET /setup/status` + one-shot `POST /setup/admin` (owner, 12+ char
  password, closes permanently after first user; one-time `SETUP_TOKEN` required when the
  installer configured one), `npm run setup:admin` CLI (with `--check` for the installer),
  and a first-run screen in the web client. The installer asks for the admin account.
- `install.sh`: prompts for listen address/port/data dir, generates the session secret,
  installs, builds, creates the admin, and prints the address to open. Safe to re-run.
- Web client (`apps/panel/public`, no build step): setup, sign-in, servers list + creation,
  server detail with live console, file browser + editor, backups, schedules, and an admin
  home with user management — in plain language.
- Files API and blueprints catalog API are now served by the panel (routers existed but
  were never mounted); built-in blueprints seed idempotently at boot.

### Fixed

- Review batch (cubic PR #10/#11): setup-token gate against owner claiming; `.env`
  auto-loading so the installer-generated config takes effect; API-key scopes enforced on
  admin routes, key minting, subuser grants, and the socket console; suspended servers are
  inert (kill on suspend, console/files/backups/allocations/schedules guarded); schedule
  ownership checked before update; servers kill their process on delete; RAM/disk quotas
  enforced; backups run async with checksum-verified temp-dir restores and fail-closed
  policies; scheduler claims recheck state, manual runs take the lock, failures audited;
  cron strictness (wildcards, malformed tokens, 5-year leap window); allocation conflicts
  map only unique violations to 409; CLI creates missing data dirs and bootstraps
  atomically; installer uses existing `.env` as prompt defaults, passes secrets by
  environment, exits on EOF, and defaults to loopback.
- Full test suite green (127 tests): upgraded vitest 2 → 3 for `node:sqlite` resolution,
  resolved `@renom/contracts` through the workspace build (contracts build before tests),
  deleted stray `registry.js` that shadowed the real blueprint registry module.
- `.gitignore` `backups/` rule no longer swallows the backups product module (scoped negation).
- Installer no longer probes the DB with `node -e require()` (breaks under `"type": "module"`);
  it uses the CLI `--check` path and the `setup:admin` workspace script instead of `npx tsx`.
