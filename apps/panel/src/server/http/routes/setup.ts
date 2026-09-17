import { Router } from "express";
import { z } from "zod";
import type { UsersRepo } from "../../modules/users/repo.js";
import type { AuditService } from "../../modules/audit/service.js";
import { ConflictError } from "../../shared/errors.js";
import { parseBody } from "../../shared/validate.js";
import { toPublicUser } from "../../modules/auth/service.js";

const setupAdminSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/, "3-32 chars: letters, digits, _ or -"),
  // First account guards everything: demand a real password, not a placeholder.
  password: z.string().min(12).max(128),
  email: z.string().email().optional(),
});

/**
 * First-run setup. These endpoints exist so a fresh install can create its
 * owner account through the same validation every later account goes through.
 *
 * The moment one user exists, POST /setup/admin stops working (403) — there
 * is no second owner bootstrap, only admin-created accounts from then on.
 */
export function setupRouter(users: UsersRepo, audit: AuditService): Router {
  const router = Router();

  router.get("/setup/status", (_req, res) => {
    res.json({ needsSetup: users.list({ limit: 1 }).length === 0 });
  });

  router.post("/setup/admin", (req, res, next) => {
    try {
      if (users.list({ limit: 1 }).length > 0) {
        throw new ConflictError("Setup is already complete");
      }
      const body = parseBody(setupAdminSchema, req);
      if (users.byUsername(body.username)) {
        throw new ConflictError("Username already taken");
      }
      const owner = users.create({
        username: body.username,
        password: body.password,
        email: body.email,
        role: "owner",
      });
      audit.record({
        event: "setup.admin.created",
        actorUserId: owner.id,
        actorIp: req.ip,
        requestId: req.requestId,
      });
      res.status(201).json({ user: toPublicUser(owner) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
