# Changelog

All notable changes to Renom are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: SemVer.

## [Unreleased]

### Changed

- The panel is now full-screen with a persistent left navigation rail. Global destinations (Servers,
  Account, API keys, Admin) sit at the top; when a server is open, its own menus — Console, Files,
  Backups, Schedule, Startup, Network, Users, Plugins, Settings — appear beneath and stay put while
  the middle column swaps between them. The centred "white box" layout is gone.
- Console: power buttons and live resource graphs moved to a right rail that is shown only on the
  Console tab, so the console owns the full width of the middle column. Start, Restart, Stop, and Kill
  keep their state rules (Start is offered only when the server is offline).
- Live resource graphs: CPU and memory are sampled per process from the host OS every two seconds and
  pushed over the existing console socket, and inbound/outbound network rates come from the host's
  non-loopback interface counters. **The network figures are host-wide, not per-server** — a process
  outside a container has no per-process byte counters, so the UI labels them as host traffic rather
  than attributing them to one server. Sampling only runs while a client is watching.
- Console no longer stacks runs: starting, restarting, stopping, or killing a server clears the
  console buffer, so each run reads from zero instead of appending every run the server has had.
- Admin: clicking a server in the admin list opens a dedicated, admin-only management view (name,
  description, CPU, memory, disk) instead of jumping into that server's console. A separate "Console"
  control opens the server. The user-management pattern is unchanged.
- Server creation now offers a CPU allocation field alongside memory and disk.

- Restored the approved warm-paper Renom design system across authenticated navigation, server cards,
  and server tabs: paper surfaces, terracotta actions, and teal health states rather than a separate
  dark theme.
- Panel updates now provision required Java runtimes before rebuilding. Provisioning skips runtimes that
  are already installed, and best-effort runtimes (Java 25 and 17) are skipped when the package manager
  cannot supply or install them, so a single failure never aborts an update. Required Java 21 must be
  present for the panel to build.
- Dashboard status now reports the real server-list state (loading, empty, failed, or server count),
  and navigation no longer overwrites a newer route.
- Server console: live-connection state is now reported (connected, closed, unreachable, suspended),
  recent history is replayed when the stream joins, and power buttons reflect the real server state
  (Start only when offline, Stop and Kill only when running) with a confirmation before a forced kill.
- File manager: the inline editor and its duplicate Save button are gone. Editing happens only in the
  dialog, and every row gained Rename, Move, and Delete backed by the existing confined file routes.
- Addons: search Modrinth from the panel. Results are filtered by the server's loader and exact
  Minecraft version, so a Fabric server never sees Paper plugins. The tab is hidden for software with
  no mod platform (Vanilla, Bedrock, and the generic runtimes) rather than offering something unusable.
- Minekube Connect is installed by default when a Java server or proxy is created, with a reserved
  random endpoint name. The manual route mints one too when the name is left blank, and a supplied
  name that another server already advertises is refused.
- Addresses: servers now show the host's real outbound IP instead of the `0.0.0.0` bind wildcard.
- Resource limits: administrators can set CPU, memory, and disk on a server, and only an
  administrator may change any of the three. CPU is **unlimited** by default (`0`, the same
  convention Pterodactyl uses) so a new server is never silently pinned to a single core. A positive
  value is a percentage of one core that rounds up to whole JVM-visible processors (100 = 1 core,
  300 = 3) and is applied to Java servers as `-XX:ActiveProcessorCount`. **This sizes JVM thread
  pools; it is not a kernel CPU quota** and does not cap time spent by native or plugin threads. A
  hard quota needs cgroups or a container, which this engine does not have.

### Fixed

- Endstone reported `install_failed` on every current Debian and Ubuntu: the installer ran a bare
  `pip install` into the system interpreter, which PEP 668 refuses. Endstone now installs into a
  per-server virtualenv under `.renom/venv`, and the engine launches that interpreter, so the server
  boots with the package it needs. Verified: Endstone installs, boots, downloads and verifies the
  Bedrock server, and stops cleanly.
- PocketMine's bundled PHP interpreter is made executable after extraction, so a zip-sourced
  archive no longer leaves it non-executable and failing to start with EACCES.
- Server addresses no longer show the `0.0.0.0` bind wildcard. The host address is resolved per
  request from the node's configured `public_ip` (or the host's own outbound address), so a change
  to `nodes.public_ip` applies without restarting the panel.
- Plugins and mods on a brand new Paper or Purpur server now work. The installer resolved the
  blueprint's `"latest"` Minecraft version to a concrete build but never recorded it, so every new
  server stored no version at all and both Modrinth search and install refused. The resolved version
  is now persisted after install and after reinstall.
- Modrinth project ids are case-sensitive base62 (`Vebnzrzj` is LuckPerms, `vebnzrzj` is nobody).
  The panel lowercased every submitted id, so installing any project whose id contains an uppercase
  letter failed with a 404. Ids are now used exactly as given or as returned by search.
- The dashboard carried a second sign-out button below the server list, next to the one in the header.
  Only the header button remains.

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
- Dedicated account self-service, admin user detail pages, an admin user-creation page, and an admin
  server-creation page; the main server list no longer contains server creation, admin server rows
  show their owner, and server owners/admins retain full server controls.
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
