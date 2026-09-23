import type { Database } from "../../infra/db/database.js";
import { ulid } from "../../shared/ulid.js";
import type { PublicServer } from "@renom/contracts";

export interface ServerRow {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  blueprint_id: string;
  blueprint_slug: string;
  blueprint_version_tag: string;
  image_ref: string;
  node_id: string;
  status: string;
  runtime_state: string | null;
  memory_mb: number;
  disk_quota_mb: number;
  eula_accepted_at: number | null;
  created_at: number;
  updated_at: number;
}

const PUBLIC_COLUMNS = `s.id, s.name, s.description, s.owner_id, s.blueprint_id, b.slug AS blueprint_slug,
  s.blueprint_version_tag, s.image_ref, s.node_id, s.status, s.runtime_state,
  s.memory_mb, s.disk_quota_mb, s.eula_accepted_at, s.created_at, s.updated_at`;

export class ServersRepo {
  constructor(private readonly db: Database) {}

  byId(id: string): ServerRow | null {
    const row = this.db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM servers s JOIN blueprints b ON b.id = s.blueprint_id
         WHERE s.id = ? AND s.deleted_at IS NULL`,
      )
      .get(id) as ServerRow | undefined;
    return row ?? null;
  }

  /** Servers visible to a user: owned ones, or everything for owner/admin callers. */
  list(args: { userId: string; role: string; limit: number; cursor?: string }): ServerRow[] {
    const admin = args.role === "owner" || args.role === "admin";
    const where = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (!admin) {
      where.push(
        "(s.owner_id = ? OR EXISTS (SELECT 1 FROM subusers su WHERE su.server_id = s.id AND su.user_id = ?))",
      );
      params.push(args.userId, args.userId);
    }
    if (args.cursor) {
      where.push("s.id > ?");
      params.push(args.cursor);
    }
    params.push(args.limit);
    return this.db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM servers s JOIN blueprints b ON b.id = s.blueprint_id
         WHERE ${where.join(" AND ")} ORDER BY s.id LIMIT ?`,
      )
      .all(...params) as unknown as ServerRow[];
  }

  countOwned(userId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM servers WHERE owner_id = ? AND deleted_at IS NULL")
      .get(userId) as { n: number };
    return Number(row.n);
  }

  /** Live quota usage for an owner (excludes deleted servers). */
  resourceUsage(userId: string): { servers: number; memoryMb: number; diskMb: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(memory_mb), 0) AS ram, COALESCE(SUM(disk_quota_mb), 0) AS disk
         FROM servers WHERE owner_id = ? AND deleted_at IS NULL`,
      )
      .get(userId) as { n: number; ram: number; disk: number };
    return { servers: Number(row.n), memoryMb: Number(row.ram), diskMb: Number(row.disk) };
  }

  create(input: {
    name: string;
    description: string;
    ownerId: string;
    blueprintId: string;
    versionTag: string;
    imageRef: string;
    memoryMb: number;
    diskQuotaMb: number;
    now?: number;
  }): ServerRow {
    const now = input.now ?? Date.now();
    const id = ulid(now);
    // Port-claim races abort the transaction via the UNIQUE index; retry a
    // few times with a fresh scan instead of surfacing a 500.
    let lastError: unknown = new Error("no free ports in allocation range");
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return this.db.transaction(() => this.createOnce(id, input, now));
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private createOnce(
    id: string,
    input: {
      name: string;
      description: string;
      ownerId: string;
      blueprintId: string;
      versionTag: string;
      imageRef: string;
      memoryMb: number;
      diskQuotaMb: number;
    },
    now: number,
  ): ServerRow {
    this.db
      .prepare(
        `INSERT INTO servers (id, name, description, owner_id, blueprint_id, blueprint_version_tag,
           image_ref, status, runtime_state, memory_mb, disk_quota_mb, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', 'offline', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description,
        input.ownerId,
        input.blueprintId,
        input.versionTag,
        input.imageRef,
        input.memoryMb,
        input.diskQuotaMb,
        now,
        now,
      );
    // Seed the JVM-facing variables from the chosen plan: without this the
    // engine falls back to blueprint defaults and the quota is a fiction.
    this.db
      .prepare(
        `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
         ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(id, "maxMemory", String(input.memoryMb));
    // Primary allocation: first free game port on all interfaces, claimed atomically.
    const port = this.claimFreePort("0.0.0.0", 25565, 26565);
    this.db
      .prepare(
        `INSERT INTO allocations (id, server_id, ip, port, notes, created_at, updated_at)
         VALUES (?, ?, '0.0.0.0', ?, 'primary', ?, ?)`,
      )
      .run(ulid(now), id, port, now, now);
    const created = this.byId(id);
    if (!created) throw new Error("server creation failed");
    return created;
  }

  /**
   * First unallocated port in range. The UNIQUE(ip,port) partial index is the
   * race backstop: a concurrent claim aborts our transaction and the caller retries.
   */
  private claimFreePort(ip: string, from: number, to: number): number {
    const taken = new Set(
      (
        this.db
          .prepare("SELECT port FROM allocations WHERE ip = ? AND released = 0")
          .all(ip) as Array<{ port: number }>
      ).map((r) => r.port),
    );
    for (let port = from; port <= to; port++) {
      if (!taken.has(port)) return port;
    }
    throw new Error("no free ports in allocation range");
  }

  update(
    id: string,
    patch: { name?: string; description?: string; memoryMb?: number; diskQuotaMb?: number },
  ): ServerRow | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      params.push(patch.description);
    }
    if (patch.memoryMb !== undefined) {
      sets.push("memory_mb = ?");
      params.push(patch.memoryMb);
    }
    if (patch.diskQuotaMb !== undefined) {
      sets.push("disk_quota_mb = ?");
      params.push(patch.diskQuotaMb);
    }
    if (sets.length === 0) return this.byId(id);
    sets.push("updated_at = ?");
    params.push(Date.now(), id);
    this.db.prepare(`UPDATE servers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    if (patch.memoryMb !== undefined) {
      // Keep the JVM flag in lockstep with the plan, like creation does.
      this.db
        .prepare(
          `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
           ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
        )
        .run(id, "maxMemory", String(patch.memoryMb));
    }
    return this.byId(id);
  }

  setStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE servers SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }

  /** Record an explicit human EULA acceptance (never implied, always audited at the route). */
  recordEula(id: string, ip: string | null): void {
    this.db
      .prepare("UPDATE servers SET eula_accepted_at = ?, eula_ip = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), ip, Date.now(), id);
  }

  setRuntimeState(id: string, state: string | null): void {
    this.db
      .prepare("UPDATE servers SET runtime_state = ?, updated_at = ? WHERE id = ?")
      .run(state, Date.now(), id);
  }

  /** Soft delete: row stays for audit/migration; allocations are released. */
  remove(id: string): void {
    this.db.transaction(() => {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE servers SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
      this.db
        .prepare(
          "UPDATE allocations SET server_id = NULL, released = 1, updated_at = ? WHERE server_id = ?",
        )
        .run(now, id);
    });
  }

  primaryAllocation(serverId: string): { ip: string; port: number } | null {
    const row = this.db
      .prepare(
        "SELECT ip, port FROM allocations WHERE server_id = ? AND released = 0 ORDER BY created_at LIMIT 1",
      )
      .get(serverId) as { ip: string; port: number } | undefined;
    return row ?? null;
  }
}

export function toPublicServer(
  s: ServerRow,
  alloc: { ip: string; port: number } | null,
): PublicServer {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    ownerId: s.owner_id,
    blueprintSlug: s.blueprint_slug,
    status: s.status as PublicServer["status"],
    runtimeState: s.runtime_state as PublicServer["runtimeState"],
    memoryMb: s.memory_mb,
    diskQuotaMb: s.disk_quota_mb,
    primaryAllocation: alloc,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}
