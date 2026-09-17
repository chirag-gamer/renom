import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import type { Env } from "../config/env.js";
import type { Logger } from "../shared/logger.js";
import { requestId } from "./middleware/request-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { AppError } from "../shared/errors.js";

export interface ReadinessComponent {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AppDeps {
  env: Env;
  logger: Logger;
  /** Registered by infrastructure (db, engine) — evaluated per /readyz call. */
  readiness?: () => Promise<ReadinessComponent[]>;
  /** Domain routers mount here; always ahead of the 404/error terminators. */
  registerRoutes?: (app: Express) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // Proxy trust is explicit, never guessed: behind a TLS terminator the
  // panel must see real client IPs (rate limits, audit) — set TRUST_PROXY=1.
  // Direct exposure keeps the default off so `req.ip` is the socket peer.
  app.set("trust proxy", deps.env.TRUST_PROXY === "1");

  // Baseline hardening headers (no dependency): no MIME sniffing, no
  // framing, no referrer leakage, conservative script/style sourcing for the
  // same-origin client. Tighten `connect-src` if the API ever leaves origin.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'self'",
    );
    next();
  });

  app.use(requestId);

  // CORS locked to configured origins (SEC hardening). Empty list => no cross-origin access.
  if (deps.env.CORS_ORIGINS.length > 0) {
    const allowed = new Set(deps.env.CORS_ORIGINS);
    app.use(
      cors({
        origin(origin, cb) {
          if (!origin || allowed.has(origin)) {
            cb(null, true);
          } else {
            cb(null, false);
          }
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        maxAge: 600,
      }),
    );
  }

  // SEC-010: bounded JSON ingress (1 MB default per SPEC §7).
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/readyz", async (_req: Request, res: Response) => {
    const components = deps.readiness ? await deps.readiness() : [{ name: "app", ok: true }];
    const ok = components.every((c) => c.ok);
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "degraded", components });
  });

  if (deps.registerRoutes) {
    deps.registerRoutes(app);
  }

  // Unknown API route => structured 404 (existence-hiding happens at the service layer).
  app.use((_req, _res, next) => {
    next(new AppError("not_found", 404, "Not found"));
  });

  app.use(errorHandler(deps.logger));
  return app;
}
