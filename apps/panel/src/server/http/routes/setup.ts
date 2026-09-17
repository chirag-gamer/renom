import { Router } from "express";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { UsersRepo } from "../../modules/users/repo.js";
import type { AuditService } from "../../modules/audit/service.js";
import { ConflictError, ForbiddenError } from "../../shared/errors.js";
import { parseBody } from "../../shared/validate.js";
import { toPublicUser } from "../../modules/auth/service.js";

const setupAdminSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/, "3-32 chars: letters, digits, _ or -"),
  // First account guards everything: demand a real password, not a placeholder.
  password: z.string().min(12).max(128),
  email: z.string().email().optional(),
  /** One-time bootstrap token (required when the installer configured one). */
  setupToken: z.string().max(256).optional(),
});

export interface SetupOptions {
  /** When set, owner creation requires this token — no open claiming. */
  setupToken?: string;
}

/**
 * First-run setup. These endpoints exist so a fresh install can create its
 * owner account through the same validation every later account goes through.
 *
 * The moment one user exists, POST /setup/admin stops working (409) — there
 * is no second owner bootstrap, only admin-created accounts from then on.
 *
 * Open-claiming hardening: the installer writes a one-time SETUP_TOKEN into
 * `.env` and prints it for fallback use. When configured, the token must be
 * supplied (header `x-setup-token` or body `setupToken`); without it the
 * endpoint refuses even on an empty database. The CLI path needs no token —
 * it already proves local machine access.
 */
export function setupRouter(
  users: UsersRepo,
  audit: AuditService,
  opts: SetupOptions = {},
): Router {
  const router = Router();

  router.get("/setup/status", (_req, res) => {
    res.json({
      needsSetup: users.list({ limit: 1 }).length === 0,
      tokenRequired: (opts.setupToken ?? "").length > 0,
    });
  });

  router.post("/setup/admin", (req, res, next) => {
    try {
      if (users.list({ limit: 1 }).length > 0) {
        throw new ConflictError("Setup is already complete");
      }
      const body = parseBody(setupAdminSchema, req);
      const required = opts.setupToken ?? "";
      if (required.length > 0) {
        const header = req.header("x-setup-token") ?? "";
        const supplied = header.length > 0 ? header : (body.setupToken ?? "");
        if (!tokenEqual(supplied, required)) {
          audit.record({
            event: "setup.admin.denied",
            actorIp: req.ip,
            requestId: req.requestId,
            target: { username: body.username },
          });
          throw new ForbiddenError("A setup token is required to claim this panel");
        }
      }
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

function tokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
