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
- Bootable Paper/Vanilla/Purpur blueprints on the local process engine; Fabric/Forge/
  Velocity declared for Docker (honest 409 locally). Catalog is Minecraft Java
  software only (Bedrock and generic runtimes removed for now).
- Modrinth addons: version-pinned, checksum-verified mod/plugin installs with an
  Addons tab (list/install/remove); Vanilla refuses (no mod platform).
- Version changer: edit the version on the Startup tab, press Reinstall — the panel
  re-downloads and swaps server files.
- Bedrock, Python, and Node return as Experimental blueprints: official BDS via the
  EndstoneMC registry, PocketMine-MP with its PHP binary, Endstone via pip, plain
  Python/Node runtimes. Minekube stays Java-only; other tunnels follow docs/tunnels.md.
- Docs for every feature and game server (`docs/features`, `docs/servers`, `docs/tunnels.md`).
- Security review pass (PR-11-REVIEW.md): checksums required on all downloads,
  confined + member-validated extraction, install-root `.env` loading, socket
  revocation on every grant change, central console sanitization, atomic owner
  bootstrap, hardened schemas, memory/claim/mkdir correctness, session-only key
  management, owner-only admin tier, runtime EULA + ready gates, honest kill,
  expiring schedule locks, async audited backups with unlock, per-user socket
  budgets, CSP headers, generated installer passwords with reset UI, and the
  full negative-test battery.
- Endpoint sweep: a manual CLI (`src/server/cli/sweep.ts`) boots a real panel
  and asserts every route (71 checks, all passing).
- Production self-review: suspended-read guards on allocations, audit key
  attribution everywhere, socket cuts on password change/user delete/server
  delete, confined install paths with root refusal, wrapped move errors,
  installer function self-tests (13/13), and a full DOM id cross-check.
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

- Permission-aware server detail: related collaborators can open server metadata with their
  effective grants returned by the API, and the client only loads and exposes tabs/actions
  allowed by those grants. Suspended servers remain existence-hidden from collaborators.
- Admin user editing now supports display name, email, role, and quotas; role changes rotate
  the target's sessions, disconnect live sockets, and server transfer rejects self-transfer and
  suspended recipients. Manual schedule runs use `schedule.update`, and file dialog saves respect
  `file.update`.
- Server-list load failures no longer reuse the successful-empty-state message; Java `auto` runtime
  selection follows Minecraft patch-level compatibility; suspended collaborators cannot read
  console history, and revoked keys or rotated user credentials disconnect live sockets.
- Unauthorized deep-link tabs normalize to the first permitted server tab, and successful server
  deletion returns to the home route before refreshing the server list.
- Added dedicated account self-service, admin user detail pages, and an admin server-creation page;
  the main server list no longer contains server creation, and admin server rows show their owner.

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
- Admin audit pass: owner accounts cannot be suspended, blueprint imports are
  audited, servers cannot be created for suspended accounts, resource bumps obey
  quotas, unsuspend requires suspended state, and `blueprint_id` is actually
  selected (the tunnel category check read it before it existed).
- Full test suite green (127 tests): upgraded vitest 2 → 3 for `node:sqlite` resolution,
  resolved `@renom/contracts` through the workspace build (contracts build before tests),
  deleted stray `registry.js` that shadowed the real blueprint registry module.
- `.gitignore` `backups/` rule no longer swallows the backups product module (scoped negation).
- Installer no longer probes the DB with `node -e require()` (breaks under `"type": "module"`);
  it uses the CLI `--check` path and the `setup:admin` workspace script instead of `npx tsx`.
