import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission, assertNotSuspendedForMutation } from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { ulid } from "../../shared/ulid.js";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const assignSchema = z.object({
  ip: z.string().regex(IPV4, "must be an IPv4 address"),
  port: z.number().int().min(1024).max(65535),
});

export interface AllocationsDeps {
  db: Database;
  audit: AuditService;
  auth: AuthService;
}

/**
 * Network allocations (FR-0xx). The UNIQUE(ip,port) partial index is the
 * conflict backstop; violations surface as 409, never 500.
 */
export function allocationsRouter(deps: AllocationsDeps): Router {
  const { db, audit, auth } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  router.get("/servers/:id/allocations", guard("allocation.read"), (req, res) => {
    const rows = db
      .prepare(
        "SELECT id, ip, port, notes FROM allocations WHERE server_id = ? AND released = 0 ORDER BY port",
      )
      .all(req.params.id ?? "") as Array<{ id: string; ip: string; port: number; notes: string }>;
    res.json({ allocations: rows });
  });

  router.post("/servers/:id/allocations", guard("allocation.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(assignSchema, req);
      const serverId = req.params.id ?? "";
      const now = Date.now();
      const id = ulid(now);
      try {
        db.prepare(
          `INSERT INTO allocations (id, server_id, ip, port, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
        ).run(id, serverId, body.ip, body.port, now, now);
      } catch (err) {
        // Only the address-in-use conflict maps to 409; anything else is a
        // real database problem and must surface as a 500, not a lie.
        if (!(err instanceof Error) || !err.message.includes("UNIQUE constraint failed")) {
          throw err;
        }
        throw new ConflictError(`Allocation ${body.ip}:${body.port} is already in use`);
      }
      audit.record({
        event: "server.allocation.add",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId,
        target: { ip: body.ip, port: body.port },
      });
      res.status(201).json({ allocation: { id, ip: body.ip, port: body.port } });
    } catch (e) {
      next(e);
    }
  });

  router.delete(
    "/servers/:id/allocations/:allocationId",
    guard("allocation.update"),
    (req, res, next) => {
      try {
        assertNotSuspendedForMutation(req, res);
        const serverId = req.params.id ?? "";
        const allocationId = req.params.allocationId ?? "";
        const remaining = db
          .prepare("SELECT COUNT(*) AS n FROM allocations WHERE server_id = ? AND released = 0")
          .get(serverId) as { n: number };
        const target = db
          .prepare("SELECT id FROM allocations WHERE id = ? AND server_id = ? AND released = 0")
          .get(allocationId, serverId);
        if (!target) throw new NotFoundError("Allocation not found");
        if (Number(remaining.n) <= 1) {
          throw new BadRequestError("Cannot release the server's last allocation");
        }
        db.prepare(
          "UPDATE allocations SET server_id = NULL, released = 1, updated_at = ? WHERE id = ?",
        ).run(Date.now(), allocationId);
        audit.record({
          event: "server.allocation.release",
          actorUserId: req.principal!.userId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId,
          target: { allocationId },
        });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
