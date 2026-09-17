import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, loadEnvFile, generateEphemeralSecret, ConfigError } from "./config/env.js";
import { createLogger } from "./shared/logger.js";
import { createApp } from "./http/app.js";
import { openAndMigrate, type Database } from "./infra/db/index.js";
import { UsersRepo } from "./modules/users/repo.js";
import { AuthService } from "./modules/auth/service.js";
import { AuditService } from "./modules/audit/service.js";
import { authRouter } from "./http/routes/auth.js";
import { setupRouter } from "./http/routes/setup.js";
import { usersRouter } from "./http/routes/users.js";
import { filesRouter } from "./http/routes/files.js";
import { blueprintsRouter } from "./http/routes/blueprints.js";
import { serversRouter } from "./http/routes/servers.js";
import { powerRouter } from "./http/routes/power.js";
import { apiKeysRouter } from "./http/routes/api-keys.js";
import { subusersRouter } from "./http/routes/subusers.js";
import { allocationsRouter } from "./http/routes/allocations.js";
import { backupsRouter } from "./http/routes/backups.js";
import { schedulesRouter } from "./http/routes/schedules.js";
import { tunnelRouter } from "./http/routes/tunnel.js";
import { addonsRouter } from "./http/routes/addons.js";
import { attachConsoleGateway } from "./http/console-gateway.js";
import { FilesService } from "./modules/files/service.js";
import { BlueprintRegistry } from "./modules/blueprints/registry.js";
import { ServersRepo } from "./modules/servers/repo.js";
import { LocalProcessEngine } from "./modules/runtime/engine.js";
import { BackupsService } from "./modules/backups/service.js";
import { Scheduler } from "./modules/schedules/runner.js";
import { ApiKeysRepo } from "./modules/auth/api-keys.js";

export interface PanelContext {
  env: ReturnType<typeof loadEnv>;
  db: Database;
  users: UsersRepo;
  servers: ServersRepo;
  engine: LocalProcessEngine;
  backups: BackupsService;
  scheduler: Scheduler;
  apiKeys: ApiKeysRepo;
  auth: AuthService;
  audit: AuditService;
}

/**
 * Composition root: env -> logger -> db/migrations -> services -> http app -> listen.
 * Socket.IO and background jobs attach here in later slices.
 */
export function buildPanel(sourceEnv: NodeJS.ProcessEnv = process.env): {
  ctx: PanelContext;
  server: Server;
  app: Express;
} {
  // The installer's .env takes effect without wrappers: file fills gaps, real env wins.
  if (sourceEnv === process.env) loadEnvFile();
  let env;
  try {
    env = loadEnv(sourceEnv);
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : "Invalid configuration";
    process.stderr.write(`startup_refused: ${message}\n`);
    process.exit(78);
  }

  // SEC-001 companion: dev/test convenience secret is ephemeral and loudly warned.
  const jwtSecret = env.JWT_SECRET ?? generateEphemeralSecret();
  if (!env.isProduction) {
    process.stdout.write(
      "warn: JWT_SECRET not set - using an ephemeral development secret (sessions reset on restart)\n",
    );
  }

  const logger = createLogger(env.LOG_LEVEL, env.isProduction);

  const dataDir = resolve(env.DATA_DIR);
  mkdirSync(dataDir, { recursive: true });
  const db = openAndMigrate(join(dataDir, "panel.db"));

  // The single-machine install always has a 'local' node; servers FK to it.
  // INSERT OR IGNORE keeps this safe on every boot (idempotent seed).
  db.prepare(
    `INSERT OR IGNORE INTO nodes (id, name, is_local, engine, data_root, backup_root, created_at)
     VALUES ('local', 'local', 1, 'local', ?, ?, ?)`,
  ).run(join(dataDir, "servers"), join(dataDir, "backups"), Date.now());

  const audit = new AuditService(db);
  const users = new UsersRepo(db, env.BCRYPT_COST);
  const apiKeys = new ApiKeysRepo(db);
  const auth = new AuthService(
    { secret: jwtSecret, ttlSeconds: env.JWT_TTL_SECONDS },
    users,
    audit,
    apiKeys,
  );
  const files = new FilesService();
  const blueprints = new BlueprintRegistry(db);
  // Idempotent: only seeds slugs missing from the table (safe on every boot).
  blueprints.seedBuiltins();
  const servers = new ServersRepo(db);
  const engine = new LocalProcessEngine(db, servers, blueprints, dataDir);
  const backups = new BackupsService(db, servers, blueprints, engine, dataDir);
  const scheduler = new Scheduler(db, servers, engine, backups, audit);

  // Reconcile on boot: child processes do not survive a panel restart, so any
  // recorded non-offline state is stale. Reset loudly rather than lying.
  {
    const stale = db
      .prepare(
        "SELECT id FROM servers WHERE runtime_state IS NOT NULL AND runtime_state != 'offline'",
      )
      .all() as Array<{ id: string }>;
    for (const s of stale) {
      servers.setRuntimeState(s.id, "offline");
      audit.record({ event: "server.state.reconciled", actorIp: "system", serverId: s.id });
    }
  }

  const apiRouters = [
    setupRouter(users, audit, { setupToken: env.SETUP_TOKEN }),
    authRouter(auth, users),
    usersRouter(users, audit, auth),
    apiKeysRouter(apiKeys, audit, auth),
    serversRouter({ db, users, servers, engine, blueprints, audit, auth, dataDir }),
    powerRouter({ db, servers, engine, audit, auth }),
    subusersRouter({ db, users, audit, auth }),
    allocationsRouter({ db, audit, auth }),
    backupsRouter({ db, backups, audit, auth }),
    schedulesRouter({ db, scheduler, audit, auth }),
    tunnelRouter({ db, servers, engine, audit, auth, dataDir }),
    addonsRouter({ db, servers, audit, auth, dataDir }),
    filesRouter(db, env, files, audit, auth),
    blueprintsRouter(blueprints, auth),
  ];

  // Web client (apps/panel/public): src/server -> ../../public, same for dist/server.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "../../public");

  const app = createApp({
    env,
    logger,
    readiness: async () => {
      try {
        const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
        return [
          { name: "db", ok: row.integrity_check === "ok", detail: row.integrity_check },
          { name: "engine", ok: true, detail: "not configured yet" },
        ];
      } catch (err) {
        return [{ name: "db", ok: false, detail: String(err) }];
      }
    },
    registerRoutes: (expressApp) => {
      for (const r of apiRouters) {
        expressApp.use("/api/v3", r);
      }
      if (existsSync(publicDir)) {
        expressApp.use(express.static(publicDir, { index: false, maxAge: "1h" }));
        // Client-side view routing: anything that is not an API call gets the app shell.
        expressApp.get(/^\/(?!api\/).*/, (_req, res, next) => {
          res.sendFile(join(publicDir, "index.html"), (err) => {
            if (err) next(err);
          });
        });
      }
    },
  });

  const server: Server = createServer(app);
  attachConsoleGateway(server, { db, auth, engine });

  return {
    ctx: { env, db, users, servers, engine, backups, scheduler, apiKeys, auth, audit },
    server,
    app,
  };
}

/** CLI entrypoint. */
function main(): void {
  const { server, ctx } = buildPanel();
  // The scheduler tick runs only in the serving process — never in tests.
  ctx.scheduler.start();
  server.listen(ctx.env.PORT, ctx.env.HOST, () => {
    process.stdout.write(`panel_listening host=${ctx.env.HOST} port=${ctx.env.PORT}\n`);
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`shutting_down signal=${signal}\n`);
    // Stop game processes first so nothing is orphaned holding ports.
    void ctx.engine
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10_000).unref();
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // NFR-005: crash loudly; supervisor restarts. No half-states are hidden.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`unhandled_rejection ${String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaught_exception ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

// Only run the listener when executed directly (tests import buildPanel).
const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (invoked) {
  main();
}
