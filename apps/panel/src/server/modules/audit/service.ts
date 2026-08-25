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
}
