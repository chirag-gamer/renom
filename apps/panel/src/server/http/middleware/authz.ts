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

export function requireServerAccess(db: Database) {
  return (req: Request, res: Response, next: NextFunction): void => {
    authorizeServerRequest(req, res, next, db, null);
  };
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
    authorizeServerRequest(req, res, next, db, requiredList);
  };
}

function authorizeServerRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  db: Database,
  requiredList: string[] | null,
): void {
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
  const scoped = intersectScopes(effective, principal.scopes);

  if (scoped.length === 0) {
    if (req.method === "GET" || req.method === "HEAD") {
      next(new NotFoundError("Not found"));
    } else {
      next(new ForbiddenError());
    }
    return;
  }

  if (requiredList && !scoped.includes("*") && !requiredList.every((r) => scoped.includes(r))) {
    next(new ForbiddenError());
    return;
  }

  res.locals.server = server;
  res.locals.effectivePermissions = scoped;
  next();
}

/**
 * Narrow `effective` by API-key `scopes` (undefined = session JWT, no narrowing).
 * '*' on either side behaves as expected: a wildcard key keeps wildcard access,
 * a wildcard grant is reduced to exactly the key's listed scopes.
 */
export function intersectScopes(
  effective: string[],
  scopes: readonly string[] | undefined,
): string[] {
  if (scopes === undefined) return effective;
  if (scopes.includes("*")) return effective;
  if (effective.includes("*")) return [...scopes];
  return effective.filter((p) => scopes.includes(p));
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

/**
 * FR-023 reads on suspended servers: the panel owner, admins, and the
 * server's own owner may look; collaborators see a plain 404 (they are
 * effectively detached until unsuspension).
 */
export function assertSuspendedReadable(req: Request, res: Response): void {
  const server = res.locals.server as LoadedServer | undefined;
  const p = req.principal;
  if (!server || !p) throw new ForbiddenError();
  if (server.status !== "suspended") return;
  const privileged = p.role === "owner" || p.role === "admin";
  if (!privileged && server.owner_id !== p.userId) {
    throw new NotFoundError("Not found");
  }
}
