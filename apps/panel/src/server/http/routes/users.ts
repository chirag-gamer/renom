import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { ServersRepo } from "../../modules/servers/repo.js";
import { toPublicServer } from "../../modules/servers/repo.js";
import type { UsersRepo, UserRow } from "../../modules/users/repo.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import type { ConsoleGateway } from "../console-gateway.js";
import { requireAuth, requireAdmin } from "../middleware/authn.js";
import { parseBody, parseQuery, passwordSchema } from "../../shared/validate.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../shared/errors.js";
import { pageQuerySchema } from "@renom/contracts";
import { toPublicUser } from "../../modules/auth/service.js";

const createUserSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/, "3-32 chars: letters, digits, _ or -"),
  password: passwordSchema,
  email: z.string().email().optional(),
  role: z.enum(["admin", "user"]).default("user"),
  displayName: z.string().max(64).optional(),
});

const patchUserSchema = z.object({
  suspended: z.boolean().optional(),
  password: passwordSchema.optional(),
  role: z.enum(["admin", "user"]).optional(),
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{3,32}$/, "3-32 chars: letters, digits, _ or -")
    .optional(),
  displayName: z.string().max(64).optional(),
  email: z.string().email().optional(),
  quotaMaxServers: z.number().int().min(0).max(1000).optional(),
  quotaRamMb: z.number().int().min(0).max(1_048_576).optional(),
  quotaDiskMb: z.number().int().min(0).max(10_485_760).optional(),
});

const accountPatchSchema = z.object({
  displayName: z.string().max(64).optional(),
  email: z.string().email().optional(),
  password: passwordSchema.optional(),
});

export function usersRouter(
  users: UsersRepo,
  servers: ServersRepo,
  audit: AuditService,
  auth: AuthService,
  gateway?: ConsoleGateway,
): Router {
  const router = Router();
  // Per-route guards ONLY: a router-level .use() would intercept every later-mounted
  // /api/v3 path (Express routers fall through when no route matches, but a failed
  // guard short-circuits with its own error).
  const admin = [requireAuth(auth), requireAdmin] as const;

  router.patch("/account", requireAuth(auth), (req, res, next) => {
    try {
      if (req.principal!.scopes !== undefined) {
        throw new ForbiddenError("Account changes require a browser session");
      }
      const target = users.byId(req.principal!.userId);
      if (!target) throw new NotFoundError("User not found");
      const body = parseBody(accountPatchSchema, req);
      if (body.email !== undefined) {
        const existing = users.byEmail(body.email);
        if (existing && existing.id !== target.id) {
          throw new ConflictError("Email already taken");
        }
      }
      if (body.password !== undefined) {
        users.setPassword(target.id, body.password);
        users.bumpPasswordVersion(target.id);
        gateway?.disconnectUser(target.id);
        audit.record({
          event: "user.account.password.change",
          actorUserId: req.principal!.userId,
          actorApiKeyId: req.principal!.apiKeyId,
          actorIp: req.ip,
          requestId: req.requestId,
          target: { userId: target.id },
        });
      }
      users.update(target.id, body);
      audit.record({
        event: "user.account.update",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        target: { userId: target.id },
      });
      const updated = users.byId(target.id)!;
      res.json({ user: toPublicUser(updated), passwordChanged: body.password !== undefined });
    } catch (e) {
      next(e);
    }
  });

  router.get("/users/:id", ...admin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const target = users.byId(req.params.id ?? "");
      if (!target) throw new NotFoundError("User not found");
      const owned = servers
        .listOwned(target.id)
        .map((server) => toPublicServer(server, servers.primaryAllocation(server.id)));
      res.json({ user: toPublicUserWithQuotas(target), servers: owned });
    } catch (e) {
      next(e);
    }
  });

  router.get("/users", ...admin, (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = parseQuery(pageQuerySchema, req);
      const rows = users.list({ limit: q.limit, cursor: q.cursor });
      res.json({
        items: rows.map(toPublicUserWithQuotas),
        nextCursor: rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post("/users", ...admin, (req, res, next) => {
    try {
      const body = parseBody(createUserSchema, req);
      // Minting admins is owner-only: admins manage users, not each other.
      if (body.role === "admin" && req.principal!.role !== "owner") {
        throw new ForbiddenError("Only the owner can create admins");
      }
      if (users.byUsername(body.username)) {
        throw new ConflictError("Username already taken");
      }
      const user = users.create({
        username: body.username,
        password: body.password,
        email: body.email,
        role: body.role,
        displayName: body.displayName,
      });
      audit.record({
        event: "user.create",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        target: { userId: user.id },
      });
      res.status(201).json({ user: toPublicUserWithQuotas(user) });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/users/:id", ...admin, (req, res, next) => {
    try {
      const target = users.byId(req.params.id ?? "");
      if (!target) throw new NotFoundError("User not found");
      const body = parseBody(patchUserSchema, req);
      if (body.email !== undefined) {
        const existing = users.byEmail(body.email);
        if (existing && existing.id !== target.id) {
          throw new ConflictError("Email already taken");
        }
      }
      if (body.username !== undefined && body.username !== target.username) {
        const existing = users.byUsername(body.username);
        if (existing && existing.id !== target.id) {
          throw new ConflictError("Username already taken");
        }
      }
      // The owner account cannot be suspended: bricking the one account that
      // can always unsuspend would lock the panel with no recovery path.
      if (target.role === "owner" && body.suspended === true) {
        throw new ConflictError("The owner account cannot be suspended");
      }
      if (body.role !== undefined && target.role === "owner") {
        throw new ConflictError("The owner account cannot change roles");
      }
      if (body.role === "admin" && req.principal!.role !== "owner") {
        throw new ForbiddenError("Only the owner can make admins");
      }
      // Touching admins (suspend, quotas, profile) is owner-only: admins
      // manage users, not each other.
      if (target.role !== "user" && req.principal!.role !== "owner") {
        throw new ForbiddenError("Only the owner can change admins");
      }
      const roleChanged = body.role !== undefined && body.role !== target.role;
      // A password change is a credential rotation: it takes effect at once
      // (old sessions die with the version bump, live sockets are cut too)
      // and is always audited.
      if (body.password !== undefined) {
        users.setPassword(target.id, body.password);
        users.bumpPasswordVersion(target.id);
        gateway?.dropGrants(undefined, target.id);
        gateway?.disconnectUser(target.id);
        audit.record({
          event: "user.password.change",
          actorUserId: req.principal!.userId,
          actorApiKeyId: req.principal!.apiKeyId,
          actorIp: req.ip,
          requestId: req.requestId,
          target: { userId: target.id },
        });
      }
      users.update(target.id, body);
      if (roleChanged) {
        users.bumpPasswordVersion(target.id);
        gateway?.dropGrants(undefined, target.id);
        gateway?.disconnectUser(target.id);
        audit.record({
          event: "user.role.change",
          actorUserId: req.principal!.userId,
          actorApiKeyId: req.principal!.apiKeyId,
          actorIp: req.ip,
          requestId: req.requestId,
          target: { userId: target.id, role: body.role },
        });
      }
      if (body.suspended !== undefined) {
        // FR-007/009: suspension invalidates sessions via passwordVersion bump
        if (body.suspended) {
          users.bumpPasswordVersion(target.id);
          // Suspended users lose live console streams everywhere immediately.
          gateway?.dropGrants(undefined, target.id);
          gateway?.disconnectUser(target.id);
        }
        audit.record({
          event: body.suspended ? "user.suspend" : "user.resume",
          actorUserId: req.principal!.userId,
          actorApiKeyId: req.principal!.apiKeyId,
          actorIp: req.ip,
          requestId: req.requestId,
          target: { userId: target.id },
        });
      }
      const updated = users.byId(target.id)!;
      res.json({ user: toPublicUserWithQuotas(updated) });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/users/:id", ...admin, (req, res, next) => {
    try {
      const target = users.byId(req.params.id ?? "");
      if (!target) throw new NotFoundError("User not found");
      if (target.id === req.principal!.userId) {
        throw new ConflictError("You cannot delete the account you are using");
      }
      if (target.role === "owner") {
        throw new ConflictError("The owner account cannot be deleted");
      }
      if (target.role !== "user" && req.principal!.role !== "owner") {
        throw new ForbiddenError("Only the owner can delete admins");
      }
      const owned = users.countOwnedServers(target.id);
      const transferTo = typeof req.query.transferTo === "string" ? req.query.transferTo : null;
      if (owned > 0 && !transferTo) {
        throw new ConflictError("User owns servers; provide transferTo user id", {
          ownedServers: owned,
        });
      }
      if (transferTo === target.id) {
        throw new ConflictError("A user cannot transfer servers to themselves");
      }
      if (transferTo) {
        const recipient = users.byId(transferTo);
        if (!recipient || recipient.suspended === 1) {
          throw new ConflictError("Transfer target must be an active account");
        }
      }
      let transferredServers = 0;
      try {
        const r = users.deleteCascade(target.id, transferTo);
        transferredServers = r.transferredServers;
      } catch (err) {
        throw new ConflictError(err instanceof Error ? err.message : "Delete failed");
      }
      // Deleted users keep no live streams either.
      gateway?.dropGrants(undefined, target.id);
      gateway?.disconnectUser(target.id);
      audit.record({
        event: "user.delete",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        target: { userId: target.id, transferredServers },
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}

function toPublicUserWithQuotas(u: UserRow) {
  return {
    ...toPublicUser(u),
    quotas: {
      maxServers: u.quota_max_servers,
      ramMb: u.quota_ram_mb,
      diskMb: u.quota_disk_mb,
    },
    suspended: u.suspended === 1,
  };
}
