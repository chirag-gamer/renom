import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../../infra/db/database.js";
import { ulid } from "../../shared/ulid.js";
import { safeEqual } from "../users/repo.js";

export interface ApiKeyRow {
  id: string;
  identifier: string;
  scopes: string[];
  memo: string;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  user_id: string;
  created_at: number;
}

export interface ApiKeyPrincipal {
  userId: string;
  keyId: string;
  scopes: string[];
}

/**
 * Scoped API keys (FR-0xx). Token format: `jtgsk.<identifier>.<secret>`.
 * Only sha256(secret) is stored; the secret itself is shown once at creation.
 * Verification is constant-time; use updates last_used_at.
 */
export class ApiKeysRepo {
  constructor(private readonly db: Database) {}

  create(
    userId: string,
    input: { memo?: string; scopes: string[]; expiresAt?: number | null; now?: number },
  ): { row: ApiKeyRow; token: string } {
    const now = input.now ?? Date.now();
    const identifier = randomBytes(9).toString("base64url");
    const secret = randomBytes(32).toString("hex");
    const row: ApiKeyRow = {
      id: ulid(now),
      identifier,
      scopes: [...input.scopes],
      memo: input.memo ?? "",
      expires_at: input.expiresAt ?? null,
      revoked_at: null,
      last_used_at: null,
      user_id: userId,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, prefix, identifier, token_hash, scopes_json, memo,
           expires_at, user_id, created_at)
         VALUES (?, 'jtgsk', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.identifier,
        sha256Hex(secret),
        JSON.stringify(row.scopes),
        row.memo,
        row.expires_at,
        row.user_id,
        row.created_at,
      );
    return { row, token: `jtgsk.${identifier}.${secret}` };
  }

  verify(token: string): ApiKeyPrincipal | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "jtgsk") return null;
    const [, identifier, secret] = parts as [string, string, string];
    if (!identifier || !secret || secret.length > 256) return null;
    const row = this.db
      .prepare(
        `SELECT id, user_id, token_hash, scopes_json, expires_at, revoked_at
         FROM api_keys WHERE identifier = ?`,
      )
      .get(identifier) as
      | {
          id: string;
          user_id: string;
          token_hash: string;
          scopes_json: string;
          expires_at: number | null;
          revoked_at: number | null;
        }
      | undefined;
    if (!row || row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
    if (!safeEqual(sha256Hex(secret), row.token_hash)) return null;
    let scopes: string[];
    try {
      const parsed: unknown = JSON.parse(row.scopes_json);
      if (!Array.isArray(parsed)) return null;
      scopes = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      return null;
    }
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
    return { userId: row.user_id, keyId: row.id, scopes };
  }

  listForUser(userId: string): ApiKeyRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, identifier, scopes_json, memo, expires_at, revoked_at, last_used_at,
                user_id, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at`,
      )
      .all(userId) as Array<{
      id: string;
      identifier: string;
      scopes_json: string;
      memo: string;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
      user_id: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      scopes: parseScopes(r.scopes_json),
      memo: r.memo,
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      last_used_at: r.last_used_at,
      user_id: r.user_id,
      created_at: r.created_at,
    }));
  }

  revoke(id: string, userId: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, userId);
    return Number(res.changes) === 1;
  }
}

function parseScopes(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
