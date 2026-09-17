import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { UsersRepo } from "../../modules/users/repo.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import type { ConsoleGateway } from "../console-gateway.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission, assertNotSuspendedForMutation } from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/errors.js";
import { permissions } from "@renom/contracts";

const grantSchema = z.object({
  username: z.string().min(1).max(32),
  permissions: z.array(z.string().min(1).max(64)).min(1).max(64),
});

const SCOPE_VOCABULARY = new Set<string>([...permissions, "*"]);

export interface SubusersDeps {
  db: Database;
  users: UsersRepo;
  audit: AuditService;
  auth: AuthService;
  gateway?: ConsoleGateway;
}

/**
 * Collaborators (FR-0xx subusers): the server owner (or an admin) grants a
 * named set of permission strings to another account. Deny-by-default —
 * anything not listed is refused by requireServerPermission.
 */
export function subusersRouter(deps: SubusersDeps): Router {
  const { db, users, audit, auth, gateway } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  router.get("/servers/:id/users", guard("user.read"), (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT s.user_id, u.username, s.permissions_json, s.granted_by, s.created_at
         FROM subusers s JOIN users u ON u.id = s.user_id WHERE s.server_id = ? ORDER BY u.username`,
      )
      .all(req.params.id ?? "") as Array<{
      user_id: string;
      username: string;
      permissions_json: string;
      granted_by: string;
      created_at: number;
    }>;
    res.json({
      users: rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        permissions: safeParseList(r.permissions_json),
        grantedBy: r.granted_by,
        createdAt: r.created_at,
      })),
    });
  });

  router.post("/servers/:id/users", guard("user.create"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(grantSchema, req);
      const unknown = body.permissions.filter((p) => !SCOPE_VOCABULARY.has(p));
      if (unknown.length > 0) throw new BadRequestError(`Unknown permission: ${unknown[0]}`);
      // No escalation: every granted permission must sit inside the grantor's
      // own effective set ('*' only from someone who already has it).
      const ceiling = res.locals.effectivePermissions as string[];
      const granted = [...new Set(body.permissions)];
      const excess = ceiling.includes("*")
        ? []
        : granted.filter((p) => p === "*" || !ceiling.includes(p));
      if (excess.length > 0) {
        throw new ForbiddenError("Cannot grant permissions you do not have");
      }
      const target = users.byUsername(body.username);
      // Uniform 404 whether the account is missing or ungrantable: the
      // grantor learns nothing about which usernames exist.
      if (!target) throw new NotFoundError("User not found");
      const serverId = req.params.id ?? "";
      const server = res.locals.server as { owner_id: string };
      if (target.id === server.owner_id) {
        throw new NotFoundError("User not found");
      }
      const exists = db
        .prepare("SELECT user_id FROM subusers WHERE user_id = ? AND server_id = ?")
        .get(target.id, serverId);
      if (exists) throw new ConflictError("That account already has access");
      db.prepare(
        "INSERT INTO subusers (user_id, server_id, permissions_json, granted_by, created_at) VALUES (?,?,?,?,?)",
      ).run(target.id, serverId, JSON.stringify(granted), req.principal!.userId, Date.now());
      audit.record({
        event: "server.subuser.add",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId,
        target: { userId: target.id },
      });
      res.status(201).json({ userId: target.id, permissions: granted });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/servers/:id/users/:userId", guard("user.delete"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const serverId = req.params.id ?? "";
      const userId = req.params.userId ?? "";
      const result = db
        .prepare("DELETE FROM subusers WHERE user_id = ? AND server_id = ?")
        .run(userId, serverId);
      if (Number(result.changes) === 0) throw new NotFoundError("Collaborator not found");
      // Cut their live console stream now, not when they choose to leave.
      gateway?.dropGrants(serverId, userId);
      audit.record({
        event: "server.subuser.remove",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId,
        target: { userId },
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function safeParseList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}
