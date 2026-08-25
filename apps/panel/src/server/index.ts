import { createServer, type Server } from "node:http";
import { loadEnv, generateEphemeralSecret, ConfigError } from "./config/env.js";
import { createLogger } from "./shared/logger.js";
import { createApp } from "./http/app.js";

/**
 * Composition root: parse env -> logger -> http app -> listen -> graceful shutdown.
 * Socket.IO, database and jobs attach here in later phases.
 */
function main(): void {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Fail closed, visibly, without secrets in output.
    const message = err instanceof ConfigError ? err.message : "Invalid configuration";
    process.stderr.write(`startup_refused: ${message}\n`);
    process.exit(78); // EX_CONFIG
  }

  // SEC-001 companion: dev/test convenience secret is ephemeral and loudly warned.
  const jwtSecret = env.JWT_SECRET ?? generateEphemeralSecret();
  if (!env.isProduction) {
    process.stdout.write(
      "warn: JWT_SECRET not set - using an ephemeral development secret (sessions reset on restart)\n",
    );
  }

  const logger = createLogger(env.LOG_LEVEL, env.isProduction);
  const app = createApp({ env, logger });
  const server: Server = createServer(app);

  server.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, "panel_listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting_down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // NFR-005: crash loudly; supervisor restarts. No half-states are hidden.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled_rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught_exception");
    process.exit(1);
  });

  // jwtSecret intentionally not exported further yet; auth module consumes it in the next slice.
  void jwtSecret;
}

main();
