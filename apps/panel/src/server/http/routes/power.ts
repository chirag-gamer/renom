import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../../modules/servers/repo.js";
import type { LocalProcessEngine, PowerAction } from "../../modules/runtime/engine.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission } from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import { ForbiddenError } from "../../shared/errors.js";

const powerSchema = z.object({
  action: z.enum(["start", "stop", "restart", "kill"]),
});

const PERM_FOR_ACTION: Record<PowerAction, string> = {
  start: "control.start",
  stop: "control.stop",
  restart: "control.restart",
  kill: "control.kill",
};

export interface PowerDeps {
  db: Database;
  servers: ServersRepo;
  engine: LocalProcessEngine;
  audit: AuditService;
  auth: AuthService;
}

/**
 * Power actions (FR-02x lifecycle). Each action carries its own permission so a
 * collaborator can be allowed to start a server without being able to kill it.
 * All transitions are idempotent at the engine layer (stop on offline = no-op).
 */
export function powerRouter(deps: PowerDeps): Router {
  const { db, servers, engine, audit, auth } = deps;
  const router = Router();
  router.use(requireAuth(auth));

  router.post("/servers/:id/power", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const body = parseBody(powerSchema, req);
      const guard = requireServerPermission(PERM_FOR_ACTION[body.action], db);
      await new Promise<void>((resolve, reject) => {
        guard(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });

      const id = req.params.id ?? "";
      const row = servers.byId(id);
      if (row?.status === "suspended") throw new ForbiddenError("Server is suspended");

      if (body.action === "start") await engine.start(id);
      else if (body.action === "stop") await engine.stop(id);
      else if (body.action === "restart") await engine.restart(id);
      else await engine.kill(id);

      audit.record({
        event: `server.power.${body.action}`,
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
      });
      res.json({ state: engine.stateOf(id) });
    })().catch(next);
  });

  router.post("/servers/:id/console/send", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const schema = z.object({ command: z.string().min(1).max(4096) });
      const body = parseBody(schema, req);
      const guard = requireServerPermission("control.console", db);
      await new Promise<void>((resolve, reject) => {
        guard(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });
      const accepted = engine.sendInput(req.params.id ?? "", body.command);
      res.json({ accepted });
    })().catch(next);
  });

  router.get("/servers/:id/console/history", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const guard = requireServerPermission("control.console", db);
      await new Promise<void>((resolve, reject) => {
        guard(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
      });
      const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
      res.json({ lines: engine.history(req.params.id ?? "", limit) });
    })().catch(next);
  });

  return router;
}
