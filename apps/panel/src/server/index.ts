import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, generateEphemeralSecret, ConfigError } from "./config/env.js";
import { createLogger } from "./shared/logger.js";
import { createApp, type ReadinessComponent } from "./http/app.js";
import { openAndMigrate, type Database } from "./infra/db/index.js";
import { UsersRepo } from "./modules/users/repo.js";
import { AuthService } from "./modules/auth/service.js";
import { AuditService } from "./modules/audit/service.js";
import { authRouter } from "./http/routes/auth.js";
import { setupRouter } from "./http/routes/setup.js";
import { usersRouter } from "./http/routes/users.js";
import { filesRouter } from "./http/routes/files.js";
import { blueprintsRouter } from "./http/routes/blueprints.js";
import { FilesService } from "./modules/files/service.js";
import { BlueprintRegistry } from "./modules/blueprints/registry.js";

export interface PanelContext {
  env: ReturnType<typeof loadEnv>;
  db: Database;
  users: UsersRepo;
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

  const audit = new AuditService(db);
  const users = new UsersRepo(db, env.BCRYPT_COST);
  const auth = new AuthService(
    { secret: jwtSecret, ttlSeconds: env.JWT_TTL_SECONDS },
    users,
    audit,
  );
  const files = new FilesService();
  const blueprints = new BlueprintRegistry(db);
  // Idempotent: only seeds slugs missing from the table (safe on every boot).
  blueprints.seedBuiltins();

  const apiRouters = [
    setupRouter(users, audit),
    authRouter(auth, users),
    usersRouter(users, audit, auth),
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

  return { ctx: { env, db, users, auth, audit }, server, app };
}

/** CLI entrypoint. */
function main(): void {
  const { server, ctx } = buildPanel();
  server.listen(ctx.env.PORT, ctx.env.HOST, () => {
    process.stdout.write(`panel_listening host=${ctx.env.HOST} port=${ctx.env.PORT}\n`);
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`shutting_down signal=${signal}\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
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
