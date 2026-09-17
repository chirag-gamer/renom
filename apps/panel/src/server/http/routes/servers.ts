import { Router, type Request, type Response, type NextFunction } from "express";
import type { UsersRepo } from "../../modules/users/repo.js";
import type { ServersRepo } from "../../modules/servers/repo.js";
import { toPublicServer } from "../../modules/servers/repo.js";
import type { BlueprintRegistry } from "../../modules/blueprints/registry.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import type { Database } from "../../infra/db/database.js";
import { requireAuth, requireAdmin } from "../middleware/authn.js";
import { requireServerPermission } from "../middleware/authz.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createServerSchema, patchServerSchema, pageQuerySchema } from "@renom/contracts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ServersDeps {
  db: Database;
  users: UsersRepo;
  servers: ServersRepo;
  blueprints: BlueprintRegistry;
  audit: AuditService;
  auth: AuthService;
  /** Resolved DATA_DIR; server directories live at <dataDir>/servers/<id>. */
  dataDir: string;
}

export function serversRouter(deps: ServersDeps): Router {
  const { users, servers, blueprints, audit, auth, dataDir } = deps;
  const router = Router();
  router.use(requireAuth(auth));

  router.get("/servers", (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = parseQuery(pageQuerySchema, req);
      const p = req.principal!;
      const rows = servers.list({
        userId: p.userId,
        role: p.role,
        limit: q.limit,
        cursor: q.cursor,
      });
      res.json({
        items: rows.map((s) => toPublicServer(s, servers.primaryAllocation(s.id))),
        nextCursor: rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post("/servers", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody(createServerSchema, req);
      const p = req.principal!;
      const privileged = p.role === "owner" || p.role === "admin";

      // Owner assignment is a privilege; regular users create for themselves.
      let ownerId = p.userId;
      if (body.ownerUsername) {
        if (!privileged) throw new ForbiddenError("Only admins can assign servers to others");
        const target = users.byUsername(body.ownerUsername);
        if (!target) throw new NotFoundError("Owner account not found");
        ownerId = target.id;
      }
      const ownerRow = users.byId(ownerId)!;

      // Quota: admins/owner are unbound; users stop at their plan.
      if (!privileged && servers.countOwned(ownerId) >= ownerRow.quota_max_servers) {
        throw new ConflictError("Server quota reached for this account");
      }

      const bp = blueprints.lookup(body.blueprintSlug);
      const doc = blueprints.getDoc(body.blueprintSlug);

      const created = servers.create({
        name: body.name,
        description: body.description,
        ownerId,
        blueprintId: bp.id,
        versionTag: doc.tag,
        imageRef: doc.image,
        memoryMb: body.memoryMb,
        diskQuotaMb: body.diskQuotaMb,
      });
      mkdirSync(join(dataDir, "servers", created.id), { recursive: true });
      servers.setStatus(created.id, "ready");
      audit.record({
        event: "server.create",
        actorUserId: p.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: created.id,
        target: { blueprint: body.blueprintSlug },
      });
      const fresh = servers.byId(created.id)!;
      res.status(201).json({ server: toPublicServer(fresh, servers.primaryAllocation(fresh.id)) });
    } catch (e) {
      next(e);
    }
  });

  const guard = (perm: string | string[]) => requireServerPermission(perm, deps.db);

  router.get(
    "/servers/:id",
    guard("startup.read"),
    (req: Request, res: Response, next: NextFunction) => {
      const s = servers.byId(req.params.id ?? "");
      if (!s) {
        next(new NotFoundError("Not found"));
        return;
      }
      res.json({ server: toPublicServer(s, servers.primaryAllocation(s.id)) });
    },
  );

  router.patch("/servers/:id", guard("settings.rename"), (req, res, next) => {
    try {
      const body = parseBody(patchServerSchema, req);
      const updated = servers.update(req.params.id ?? "", body);
      if (!updated) throw new NotFoundError("Not found");
      audit.record({
        event: "server.update",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: updated.id,
      });
      res.json({ server: toPublicServer(updated, servers.primaryAllocation(updated.id)) });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/servers/:id", guard("settings.reinstall"), (req, res, next) => {
    try {
      const id = req.params.id ?? "";
      servers.remove(id);
      audit.record({
        event: "server.delete",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  // Suspension is an admin-only state flip (FR-023); the engine refuses power on suspended.
  router.post(
    "/servers/:id/suspend",
    requireAdmin,
    guard("settings.reinstall"),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        servers.setStatus(req.params.id ?? "", "suspended");
        audit.record({
          event: "server.suspend",
          actorUserId: req.principal!.userId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId: req.params.id,
        });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/servers/:id/unsuspend",
    requireAdmin,
    guard("settings.reinstall"),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        servers.setStatus(req.params.id ?? "", "ready");
        audit.record({
          event: "server.unsuspend",
          actorUserId: req.principal!.userId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId: req.params.id,
        });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
