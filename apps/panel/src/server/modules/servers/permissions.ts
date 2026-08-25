import { hasPermission } from "@renom/contracts";
import type { Database } from "../../infra/db/database.js";

export interface ServerRow {
  id: string;
  name: string;
  owner_id: string;
  status: string;
  runtime_state: string | null;
  suspended_reason: string | null;
  memory_mb: number;
  cpu_weight: number;
  disk_quota_mb: number;
  blueprint_id: string;
}

export interface SubuserRow {
  user_id: string;
  server_id: string;
  permissions_json: string;
}

/**
 * Effective-permission resolution (PERMISSIONS-MATRIX.md):
 *   owner role | admin role | server owner  -> ['*'] (all)
 *   subuser                                    -> granted strings
 *   everyone else                              -> []    (deny-by-default, SEC-004)
 */
export function resolveEffectivePermissions(
  db: Database,
  args: { userId: string; role: string; serverId: string },
): string[] {
  if (args.role === "owner" || args.role === "admin") return ["*"];
  const server = db.prepare("SELECT owner_id FROM servers WHERE id = ?").get(args.serverId) as
    | { owner_id: string }
    | undefined;
  if (!server) return [];
  if (server.owner_id === args.userId) return ["*"];
  const sub = db
    .prepare("SELECT permissions_json FROM subusers WHERE user_id = ? AND server_id = ?")
    .get(args.userId, args.serverId) as SubuserRow | undefined;
  if (!sub) return [];
  try {
    const parsed: unknown = JSON.parse(sub.permissions_json);
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // corrupted grant -> fail closed
  }
  return [];
}

export function isPermitted(
  db: Database,
  args: { userId: string; role: string; serverId: string },
  required: string,
): boolean {
  return hasPermission(resolveEffectivePermissions(db, args), required);
}
