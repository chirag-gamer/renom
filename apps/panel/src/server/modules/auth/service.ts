import { signAccessToken, verifyAccessToken, type JwtConfig } from "./jwt.js";
import { RateLimiter } from "./ratelimit.js";
import type { UsersRepo, UserRow } from "../users/repo.js";
import type { AuditService } from "../audit/service.js";
import { UnauthorizedError, RateLimitError } from "../../shared/errors.js";
import type { Role } from "@renom/contracts";

export interface Principal {
  userId: string;
  role: Role;
  /** Set when authenticated via API key. */
  apiKeyId?: string;
  scopes?: readonly string[];
}

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  username: string;
  role: string;
  displayName: string;
  email: string | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    displayName: u.display_name,
    email: u.email,
  };
}

/**
 * Authentication service.
 * FR-004 invariant: NO code path here creates users. Unknown user => uniform failure.
 */
export class AuthService {
  private readonly loginLimiter = new RateLimiter(5, 60_000); // 5/min per ip+username (FR-010)

  constructor(
    private readonly jwtCfg: JwtConfig,
    private readonly users: UsersRepo,
    private readonly audit: AuditService,
  ) {}

  async login(
    username: string,
    password: string,
    ctx: { ip: string; requestId?: string },
  ): Promise<AuthResult> {
    const limit = this.loginLimiter.take(`login:${ctx.ip}:${username.toLowerCase()}`);
    if (limit.limited) {
      throw new RateLimitError(limit.retryAfterSec, "Too many login attempts");
    }

    const user = this.users.byUsername(username);
    const ok =
      user && !user.suspended
        ? this.users.verifyPassword(user, password)
        : this.users.verifyDummy(password);

    // Uniform latency floor (>=200ms jittered) to blunt timing/enumeration (FR-001).
    await sleep(200 + Math.floor(Math.random() * 80));

    if (!user || !ok || user.suspended === 1) {
      this.audit.record({
        event: "auth.login.fail",
        actorUserId: user?.id ?? null,
        actorIp: ctx.ip,
        requestId: ctx.requestId,
        target: { username },
      });
      throw new UnauthorizedError("Invalid credentials");
    }

    const token = signAccessToken(this.jwtCfg, {
      sub: user.id,
      role: user.role as Role,
      pwdv: user.password_version,
    });
    this.users.touchLastLogin(user.id);
    this.audit.record({
      event: "auth.login.success",
      actorUserId: user.id,
      actorIp: ctx.ip,
      requestId: ctx.requestId,
    });
    return { token, user: toPublicUser(user) };
  }

  /**
   * Verify a bearer token against the CURRENT user record; enforces passwordVersion
   * invalidation (SEC-014). Returns principal or null.
   */
  authenticateToken(token: string): Principal | null {
    try {
      const payload = verifyAccessToken(this.jwtCfg, token);
      if (!payload) return null;
      const user = this.users.byId(payload.sub);
      if (!user || user.suspended === 1) return null;
      // re-verify with current password version (session invalidation)
      return verifyAccessToken(this.jwtCfg, token, user.password_version)
        ? { userId: user.id, role: user.role as Role }
        : null;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
