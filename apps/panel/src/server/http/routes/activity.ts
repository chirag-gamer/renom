import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission, assertSuspendedReadable } from "../middleware/authz.js";
import { parseQuery } from "../../shared/validate.js";

const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Id of the last event already shown; omit for the newest page. */
  before: z.string().max(64).optional(),
});

/**
 * Per-server audit feed (FR-060). Reads the append-only `audit_log` that every
 * mutating route already writes, newest first, resolving actor display names at
 * read time so renames show correctly instead of freezing old usernames.
 *
 * Gated on `activity.read`, which existed in the permission vocabulary but had
 * no route enforcing it. Suspended servers stay readable for the same callers
 * allowed to see them at all (assertSuspendedReadable).
 */
export function activityRouter(deps: {
  db: Database;
  audit: AuditService;
  auth: AuthService;
}): Router {
  const { db, audit, auth } = deps;
  const router = Router();
  router.use(requireAuth(auth));

  router.get(
    "/servers/:id/activity",
    requireServerPermission("activity.read", db),
    (req, res, next) => {
      try {
        assertSuspendedReadable(req, res);
        const q = parseQuery(activityQuery, req);
        const serverId = req.params.id ?? "";
        // One extra row tells the client whether a further page exists without
        // a second COUNT over an unbounded table.
        const rows = audit.activityForServer({
          serverId,
          limit: q.limit + 1,
          before: q.before,
        });
        const page = rows.slice(0, q.limit);
        res.json({
          // actorIp is deliberately not public: it is a real peer address for
          // user actions, so activity.read alone must not hand a collaborator
          // the addresses other users connect from.
          items: page.map(({ id, ts, event, actorUserId, actorUsername, target }) => ({
            id,
            ts,
            event,
            actorUserId,
            actorUsername,
            target,
          })),
          nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
