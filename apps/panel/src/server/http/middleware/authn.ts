import type { NextFunction, Request, Response } from "express";
import type { AuthService, Principal } from "../../modules/auth/service.js";
import { ForbiddenError, UnauthorizedError } from "../../shared/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      requestId: string;
    }
  }
}

export function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1]! : null;
}

/** Requires a valid JWT; attaches principal or rejects with 401 (SEC-004 foundation). */
export function requireAuth(auth: AuthService) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req.header("authorization"));
    const principal = token ? auth.authenticateToken(token) : null;
    if (!principal) {
      next(new UnauthorizedError());
      return;
    }
    req.principal = principal;
    next();
  };
}

/** Requires an authenticated principal with an admin-capable role. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const p = req.principal;
  if (!p) {
    next(new UnauthorizedError("Authentication required"));
    return;
  }
  if (p.role !== "admin" && p.role !== "owner") {
    next(new ForbiddenError("Admin role required"));
    return;
  }
  // A scoped API key never inherits the owner's adminhood: global admin
  // routes (users, key minting, blueprint import) need a full key or session.
  if (p.scopes !== undefined && !p.scopes.includes("*")) {
    next(new ForbiddenError("Admin role required"));
    return;
  }
  next();
}

/** Requires the single owner account (managing admins is owner-only). */
export function requireOwner(req: Request, _res: Response, next: NextFunction): void {
  const p = req.principal;
  if (!p) {
    next(new UnauthorizedError("Authentication required"));
    return;
  }
  if (p.role !== "owner" || (p.scopes !== undefined && !p.scopes.includes("*"))) {
    next(new ForbiddenError("Owner role required"));
    return;
  }
  next();
}
