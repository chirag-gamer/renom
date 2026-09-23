import bcrypt from "bcryptjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "../../infra/db/database.js";
import { ulid } from "../../shared/ulid.js";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string | null;
  email: string | null;
  role: string;
  totp_enabled: number;
  display_name: string;
  quota_max_servers: number;
  quota_ram_mb: number;
  quota_disk_mb: number;
  password_version: number;
  suspended: number;
}

export class UsersRepo {
  private readonly dummyHash: string;

  constructor(
    private readonly db: Database,
    private readonly bcryptCost = 12,
  ) {
    // Dummy work at the configured cost: a hardcoded $12$ hash would run
    // faster than real comparisons when BCRYPT_COST differs, leaking
    // existence through timing. One-time cost at construction.
    this.dummyHash = bcrypt.hashSync("renom-dummy-comparison-secret", bcryptCost);
  }

  byUsername(username: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as UserRow | undefined;
    return row ?? null;
  }

  byEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as
      UserRow | undefined;
    return row ?? null;
  }

  byId(id: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ?? null;
  }

  /**
   * First-owner bootstrap in ONE transaction: the emptiness check and the
   * insert run atomically, so two concurrent setups cannot mint two owners.
   * Returns null when the panel already has any user (caller maps to 409).
   */
  createFirstOwner(input: {
    username: string;
    password: string;
    email?: string;
    displayName?: string;
    now?: number;
  }): UserRow | null {
    // Bcrypt first (CPU only, outside the lock), then check-and-insert inside.
    const now = input.now ?? Date.now();
    const hash = bcrypt.hashSync(input.password, this.bcryptCost);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
      if (Number(row.c) > 0) return null;
      return this.create({ ...input, role: "owner", passwordHash: hash, now });
    });
  }

  create(input: {
    username: string;
    password?: string;
    email?: string;
    role: "owner" | "admin" | "user";
    displayName?: string;
    quotas?: Partial<Pick<UserRow, "quota_max_servers" | "quota_ram_mb" | "quota_disk_mb">>;
    passwordHash?: string; // used by JTG importer (hash preserved)
    now?: number;
  }): UserRow {
    const now = input.now ?? Date.now();
    const hash =
      input.passwordHash ??
      (input.password !== undefined ? bcrypt.hashSync(input.password, this.bcryptCost) : null);
    const user: UserRow = {
      id: ulid(now),
      username: input.username,
      password_hash: hash,
      email: input.email ?? null,
      role: input.role,
      totp_enabled: 0,
      display_name: input.displayName ?? input.username,
      quota_max_servers: input.quotas?.quota_max_servers ?? 5,
      quota_ram_mb: input.quotas?.quota_ram_mb ?? 8192,
      quota_disk_mb: input.quotas?.quota_disk_mb ?? 40_960,
      password_version: 0,
      suspended: 0,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, email, role, display_name,
           quota_max_servers, quota_ram_mb, quota_disk_mb, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.username,
        user.password_hash,
        user.email,
        user.role,
        user.display_name,
        user.quota_max_servers,
        user.quota_ram_mb,
        user.quota_disk_mb,
        now,
        now,
      );
    return user;
  }

  verifyPassword(user: UserRow, password: string): boolean {
    if (!user.password_hash) return false;
    try {
      return bcrypt.compareSync(password, user.password_hash);
    } catch {
      return false;
    }
  }

  /** Compare against a cost-matched dummy to equalize timing for missing users. */
  verifyDummy(password: string): boolean {
    try {
      void bcrypt.compareSync(password, this.dummyHash);
    } catch {
      // ignore
    }
    return false;
  }

  touchLastLogin(id: string, at = Date.now()): void {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, id);
  }

  bumpPasswordVersion(id: string): number {
    const row = this.db.prepare("SELECT password_version FROM users WHERE id = ?").get(id) as
      { password_version: number } | undefined;
    if (!row) throw new Error("user not found");
    const next = row.password_version + 1;
    this.db
      .prepare("UPDATE users SET password_version = ?, updated_at = ? WHERE id = ?")
      .run(next, Date.now(), id);
    return next;
  }

  setPassword(id: string, password: string): void {
    const hash = bcrypt.hashSync(password, this.bcryptCost);
    this.db
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hash, Date.now(), id);
  }

  setSuspended(id: string, suspended: boolean): void {
    this.db
      .prepare("UPDATE users SET suspended = ?, updated_at = ? WHERE id = ?")
      .run(suspended ? 1 : 0, Date.now(), id);
  }

  countByRole(role: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = ?").get(role) as {
      n: number;
    };
    return Number(row.n);
  }

  list(args: { limit: number; cursor?: string }): UserRow[] {
    if (args.cursor) {
      return this.db
        .prepare("SELECT * FROM users WHERE id > ? ORDER BY id LIMIT ?")
        .all(args.cursor, args.limit) as unknown as UserRow[];
    }
    return this.db
      .prepare("SELECT * FROM users ORDER BY id LIMIT ?")
      .all(args.limit) as unknown as UserRow[];
  }

  update(
    id: string,
    patch: {
      suspended?: boolean;
      role?: "admin" | "user";
      username?: string;
      displayName?: string;
      email?: string;
      quotaMaxServers?: number;
      quotaRamMb?: number;
      quotaDiskMb?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.suspended !== undefined) {
      sets.push("suspended = ?");
      params.push(patch.suspended ? 1 : 0);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      params.push(patch.role);
    }
    if (patch.username !== undefined) {
      sets.push("username = ?");
      params.push(patch.username);
    }
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(patch.displayName);
    }
    if (patch.email !== undefined) {
      sets.push("email = ?");
      params.push(patch.email);
    }
    if (patch.quotaMaxServers !== undefined) {
      sets.push("quota_max_servers = ?");
      params.push(patch.quotaMaxServers);
    }
    if (patch.quotaRamMb !== undefined) {
      sets.push("quota_ram_mb = ?");
      params.push(patch.quotaRamMb);
    }
    if (patch.quotaDiskMb !== undefined) {
      sets.push("quota_disk_mb = ?");
      params.push(patch.quotaDiskMb);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  countOwnedServers(userId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE owner_id = ? AND deleted_at IS NULL")
      .get(userId) as { n: number };
    return Number(row.n);
  }

  /**
   * FR-007: deleting a user requires ownership transfer of their servers in the SAME
   * transaction. Returns counts for the audit record.
   */
  deleteCascade(userId: string, transferTo: string | null): { transferredServers: number } {
    return this.db.transaction(() => {
      let transferred = 0;
      if (transferTo) {
        const target = this.byId(transferTo);
        if (!target) throw new Error("transferTo user not found");
        const res = this.db
          .prepare(
            "UPDATE servers SET owner_id = ?, updated_at = ? WHERE owner_id = ? AND deleted_at IS NULL",
          )
          .run(transferTo, Date.now(), userId);
        transferred = Number(res.changes);
      } else {
        const remaining = this.countOwnedServers(userId);
        if (remaining > 0) throw new Error("servers still owned; refusing delete");
      }
      this.db
        .prepare("DELETE FROM subusers WHERE user_id = ? OR granted_by = ?")
        .run(userId, userId);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
      return { transferredServers: transferred };
    });
  }
}

/** Cryptographically strong random token (setup tokens, API keys). */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison for token hashes. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
