# Completion ledger

`Requirement → implementation → tests → verification → commit → docs`.
A requirement is complete only when all five exist. Suite: **107/107 green**
(`npm test`), `npm run build` + `npm run typecheck` clean, live smoke-tested
2026-09-17 (setup → owner → login → power → console over real HTTP + WebSocket).

## Auth, users, setup (Phases 0–1, 6)

| Requirement | Implementation | Tests | Verify | Commit | Docs |
|---|---|---|---|---|---|
| SEC-001 fail-closed secrets | `apps/panel/src/server/config/env.ts` | `test/unit/env.spec.ts` | suite | prior | `SECURITY.md` |
| FR-001 uniform login, no enumeration | `modules/auth/service.ts` | `auth.spec.ts` (unknown user, wrong password) | suite | prior | — |
| FR-006 owner bootstrap | `http/routes/setup.ts`, `server/cli/create-owner.ts` (+`--check`) | `setup.spec.ts` | suite + live | `81af366` / `0166af2` | `README.md` |
| FR-007/008 quotas + user CRUD | `http/routes/users.ts` | `auth.spec.ts` | suite | prior | — |
| FR-009 password version invalidation | `modules/users/repo.ts` | `auth.spec.ts` | suite | prior | — |
| FR-010 login rate limit | `modules/auth/ratelimit.ts` | `auth.spec.ts` (5/min) | suite | prior | — |
| FR-023 suspension blocks auth + mutations | `repo.ts`, `authz.ts` | `auth.spec.ts`, `files-authz.spec.ts` | suite | prior | — |
| SEC-002/004/012/013/014 | service, middleware, audit | `auth.spec.ts` | suite | prior | `SECURITY.md` |

## Servers, runtime, console (Phases 5–7)

| Requirement | Implementation | Tests | Verify | Commit | Docs |
|---|---|---|---|---|---|
| Servers CRUD + quotas + suspend | `modules/servers/repo.ts`, `http/routes/servers.ts`, `BlueprintRegistry.lookup` | `servers.spec.ts` (9 tests) | suite | `86440f0` | `CHANGELOG.md` |
| Allocations, conflict-safe | `ServersRepo.claimFreePort`, `http/routes/allocations.ts` | `servers.spec.ts`, `access.spec.ts` | suite | `86440f0` / `33564d5` | — |
| Local process engine, lifecycle | `modules/runtime/engine.ts` (+`EngineError`) | `power.spec.ts` (5 tests) | suite + live | `2e70376` | `CHANGELOG.md` |
| Power API per-action perms | `http/routes/power.ts` | `power.spec.ts`, tenant isolation case | suite | `2e70376` | — |
| Socket console, auth + limits | `http/console-gateway.ts` | `gateway.spec.ts` (real transport), history cases | suite + live | `2e70376` | — |
| Boot reconciliation to offline | `server/index.ts` | implicit (every `buildPanel` in suite) | suite | `2e70376` | — |

## Access control (Phases 6–7)

| Requirement | Implementation | Tests | Verify | Commit | Docs |
|---|---|---|---|---|---|
| Scoped API keys (narrow-only) | `modules/auth/api-keys.ts`, `AuthService` fallback, `intersectScopes` | `access.spec.ts` (create/once/reject-scopes/narrow-owner/revoke) | suite | `33564d5` | `CHANGELOG.md` |
| Subusers deny-by-default | `http/routes/subusers.ts` | `access.spec.ts`, `power.spec.ts` isolation | suite | `33564d5` | — |
| Existence-hiding 404 / 403 split | `http/middleware/authz.ts` | `servers.spec.ts`, `files-authz.spec.ts` | suite | prior | `docs/` (planning) |

## Backups, schedules (Phase 7)

| Requirement | Implementation | Tests | Verify | Commit | Docs |
|---|---|---|---|---|---|
| tar.gz backups, checksums, locks, restore | `modules/backups/service.ts`, `http/routes/backups.ts` | `jobs.spec.ts` (create→delete-file→restore→read back) | suite | `bcd165c` | `CHANGELOG.md` |
| Cron schedules, atomic claim, tasks | `modules/schedules/cron.ts`, `runner.ts`, `http/routes/schedules.ts` | `jobs.spec.ts` (parse/next, CRUD, manual command run, cross-server 404) | suite | `bcd165c` | — |
| Scheduler tick in serving process only | `server/index.ts` `main()` | by construction (tests import `buildPanel`) | review | `bcd165c` | — |

## Web client, installer (Phases 4, 9)

| Requirement | Implementation | Tests | Verify | Commit | Docs |
|---|---|---|---|---|---|
| Setup/login/servers/console/files/backups/schedules/admin UI, plain language | `apps/panel/public/*` | `setup.spec.ts` (shell + socket.io client served) | suite + live fetch | `f2dfcc2` / `81af366` | `README.md` |
| Idempotent installer, admin prompt | `install.sh`, CLI `--check` | manual review + `bash` unavailable on host; CLI paths executed | partial⚠️ | `24f05ba` / `0166af2` | `README.md` |
| Provenance / license gate | `docs/PROVENANCE.md` (consent re-affirmed 2026-09-17, f8900ee) | n/a (record) | owner statement | `24f05ba` | `NOTICE`, `LICENSE` |

## Honestly deferred (waivers, not silent gaps)

| Item | Status | Reason |
|---|---|---|
| Docker engine | Refused loudly (409) for docker blueprints | No Docker on build host; interface boundary (`LocalProcessEngine`) ready for a `DockerEngine` |
| SFTP daemon | Credential table exists; no daemon | Needs `ssh2` + security review; files API covers management over HTTPS |
| Remote nodes | `nodes` table + `local` seed only | Single-machine scope per plan; no mutual-auth design accepted yet |
| `install.sh` end-to-end on Linux | Syntax reviewed, not executed | No Linux host in this environment; marked ⚠️ — run once on target before release |
| Non-UTC schedule timezones | Rejected at validation (UTC-only storage) | TZ database handling deferred; column exists for later |

## Verification log (2026-09-17)

| Check | Result |
|---|---|
| `npm run build` (contracts + panel `tsc`) | clean |
| `npm run typecheck` | clean |
| `npm test` (vitest) | 14 files, 107 tests, all pass |
| eslint on all touched files | clean (`--fix` applied, then verified) |
| Live: setup/status → owner → 2nd setup 409 → login → power → console line over socket | pass |
| CLI `--check` on empty/populated DB | `no` / `yes` |
| `git status` | clean except intentionally untracked `package-lock.json` |
