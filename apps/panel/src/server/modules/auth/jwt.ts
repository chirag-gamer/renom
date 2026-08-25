import jwt from "jsonwebtoken";
import type { Role } from "@renom/contracts";

export interface AccessTokenClaims {
  sub: string;
  role: Role;
  /** Bumped on password change; older tokens fail verification against current version. */
  pwdv: number;
}

export interface JwtConfig {
  secret: string;
  ttlSeconds: number;
}

export function signAccessToken(cfg: JwtConfig, claims: AccessTokenClaims): string {
  return jwt.sign(claims, cfg.secret, {
    algorithm: "HS256",
    expiresIn: cfg.ttlSeconds,
    issuer: "renom-panel",
  });
}

/**
 * Verify signature/expiry AND that the token's password-version matches the user's
 * current version (FR-009 / SEC-014 session invalidation).
 * Returns claims or null for ANY failure (never throws to callers).
 */
export function verifyAccessToken(
  cfg: JwtConfig,
  token: string,
  currentUserPasswordVersion?: number,
): AccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, cfg.secret, {
      algorithms: ["HS256"],
      issuer: "renom-panel",
    });
    if (typeof decoded === "string") return null;
    const claims = decoded as AccessTokenClaims & { exp?: number };
    if (!claims.sub || typeof claims.pwdv !== "number") return null;
    if (currentUserPasswordVersion !== undefined && claims.pwdv !== currentUserPasswordVersion) {
      return null;
    }
    return { sub: claims.sub, role: claims.role, pwdv: claims.pwdv };
  } catch {
    return null;
  }
}
