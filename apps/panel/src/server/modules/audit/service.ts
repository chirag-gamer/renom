import { ulid } from "../../shared/ulid.js";
import type { Database } from "../../infra/db/database.js";

export interface AuditEvent {
  event: string;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  actorIp?: string | null;
  serverId?: string | null;
  target?: Record<string, unknown>;
  batchUuid?: string | null;
  requestId?: string | null;
}

/**
 * Append-only audit writer (SEC-012). The application layer never updates or deletes
 * rows here; retention pruning happens by age only, via the janitor job.
 */
export class AuditService {
  constructor(private readonly db: Database) {}

  record(ev: AuditEvent): string {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO audit_log
           (id, ts, actor_user_id, actor_api_key_id, actor_ip, event, server_id,
            target_json, batch_uuid, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        Date.now(),
        ev.actorUserId ?? null,
        ev.actorApiKeyId ?? null,
        ev.actorIp ?? null,
        ev.event,
        ev.serverId ?? null,
        JSON.stringify(ev.target ?? {}),
        ev.batchUuid ?? null,
        ev.requestId ?? null,
      );
    return id;
  }

  query(filter: {
    actorUserId?: string;
    serverId?: string;
    eventPrefix?: string;
    sinceTs?: number;
    untilTs?: number;
    limit: number;
    cursor?: string;
  }): Array<{
    id: string;
    ts: number;
    event: string;
    actor_user_id: string | null;
    server_id: string | null;
    target_json: string;
  }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.actorUserId !== undefined) {
      where.push("actor_user_id = ?");
      params.push(filter.actorUserId);
    }
    if (filter.serverId !== undefined) {
      where.push("server_id = ?");
      params.push(filter.serverId);
    }
    if (filter.eventPrefix) {
      where.push("event LIKE ?");
      params.push(`${filter.eventPrefix}%`);
    }
    if (filter.sinceTs !== undefined) {
      where.push("ts >= ?");
      params.push(filter.sinceTs);
    }
    if (filter.untilTs !== undefined) {
      where.push("ts <= ?");
      params.push(filter.untilTs);
    }
    if (filter.cursor) {
      where.push("id > ?");
      params.push(filter.cursor);
    }
    const sql = `SELECT id, ts, event, actor_user_id, server_id, target_json FROM audit_log
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY id LIMIT ?`;
    params.push(Math.min(filter.limit, 100));
    return this.db.prepare(sql).all(...params) as Array<{
      id: string;
      ts: number;
      event: string;
      actor_user_id: string | null;
      server_id: string | null;
      target_json: string;
    }>;
  }

  /**
   * Newest-first page of one server's events, with the actor resolved.
   *
   * `query()` walks forward from a cursor, which suits tests and exports but
   * not a feed: the Activity tab shows the latest actions first and pages
   * backwards, so the cursor here is exclusive-descending (`id < ?`).
   * ULIDs are monotonic per writer, so id order tracks ts order.
   */
  activityForServer(args: {
    serverId: string;
    limit: number;
    /** Id of the last row already shown; the next page starts below it. */
    before?: string;
  }): Array<{
    id: string;
    ts: number;
    event: string;
    actorUserId: string | null;
    actorUsername: string | null;
    actorIp: string | null;
    target: Record<string, unknown>;
  }> {
    const where = ["a.server_id = ?"];
    const params: unknown[] = [args.serverId];
    if (args.before) {
      where.push("a.id < ?");
      params.push(args.before);
    }
    // Clamped at 101, not 100: the route asks for one row beyond the page as a
    // "more pages exist" sentinel, and clamping to 100 silently swallowed it
    // whenever the caller wanted a full 100-row page.
    params.push(Math.min(Math.max(args.limit, 1), 101));
    const rows = this.db
      .prepare(
        `SELECT a.id, a.ts, a.event, a.actor_user_id, a.actor_ip, a.target_json,
                COALESCE(NULLIF(u.display_name, ''), u.username) AS actor_username
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...params) as Array<{
      id: string;
      ts: number;
      event: string;
      actor_user_id: string | null;
      actor_ip: string | null;
      target_json: string;
      actor_username: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      event: row.event,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username,
      actorIp: row.actor_ip,
      target: parseTarget(row.target_json),
    }));
  }
}

/** Stored targets are JSON; a corrupted row must not break the whole feed. */
function parseTarget(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
