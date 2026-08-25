import type { NextFunction, Request, Response } from "express";
import type { AuthService, Principal } from "../../modules/auth/service.js";
import { UnauthorizedError } from "../../shared/errors.js";

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
  if (!p || (p.role !== "admin" && p.role !== "owner")) {
    next(new UnauthorizedError("Authentication required"));
    return;
  }
  next();
}
