import type { NextFunction, Request, Response } from "express";
import type { Database } from "../../infra/db/database.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { resolveEffectivePermissions } from "../../modules/servers/permissions.js";

export interface LoadedServer {
  id: string;
  name: string;
  owner_id: string;
  status: string;
  runtime_state: string | null;
}

/**
 * Server-scoped authorization (SEC-004): deny-by-default.
 * - Unknown server -> 404 for everyone (existence hiding).
 * - No relationship to the server:
 *     safe methods (GET) -> 404; mutating methods -> 403 (documented rule).
 * - Relationship but missing required permission -> 403.
 * Attaches res.locals.server and res.locals.effectivePermissions for handlers.
 */
export function requireServerPermission(required: string | string[], db: Database) {
  const requiredList = Array.isArray(required) ? required : [required];
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = req.principal;
    if (!principal) {
      next(new ForbiddenError());
      return;
    }
    const serverId = req.params.id ?? "";
    const server = db
      .prepare(
        "SELECT id, name, owner_id, status, runtime_state FROM servers WHERE id = ? AND deleted_at IS NULL",
      )
      .get(serverId) as LoadedServer | undefined;

    if (!server) {
      next(new NotFoundError("Not found"));
      return;
    }

    const effective = resolveEffectivePermissions(db, {
      userId: principal.userId,
      role: principal.role,
      serverId: server.id,
    });

    const hasAnyAccess = effective.length > 0 || server.owner_id === principal.userId;
    if (!hasAnyAccess) {
      // no relationship at all: hide existence on reads, refuse writes
      if (req.method === "GET" || req.method === "HEAD") {
        next(new NotFoundError("Not found"));
      } else {
        next(new ForbiddenError());
      }
      return;
    }

    const grantedAll = effective.includes("*");
    if (!grantedAll && !requiredList.every((r) => effective.includes(r))) {
      next(new ForbiddenError());
      return;
    }

    res.locals.server = server;
    res.locals.effectivePermissions = effective;
    next();
  };
}

/** FR-023: suspension blocks ALL mutations; reads allowed for owner/admin only. */
export function assertNotSuspendedForMutation(req: Request, res: Response): void {
  const server = res.locals.server as LoadedServer | undefined;
  if (!server) throw new ForbiddenError();
  if (server.status !== "suspended") return;
  const isRead = req.method === "GET" || req.method === "HEAD";
  if (!isRead) {
    throw new ForbiddenError("Server is suspended");
  }
}
