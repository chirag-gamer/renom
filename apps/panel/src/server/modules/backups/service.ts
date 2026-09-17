import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../servers/repo.js";
import type { BlueprintRegistry } from "../blueprints/registry.js";
import type { LocalProcessEngine } from "../runtime/engine.js";
import { ulid } from "../../shared/ulid.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";

export interface BackupRecord {
  id: string;
  server_id: string;
  file_name: string;
  checksum_sha256: string;
  bytes: number;
  locked: number;
  consistency: string;
  created_by: string | null;
  completed_at: number | null;
  created_at: number;
}

const RETAIN_UNLOCKED = 10;

let tarAvailable: boolean | null = null;

/** Probe once; `tar` ships with Linux, macOS, and Windows 10+. */
export function isTarAvailable(): boolean {
  if (tarAvailable === null) {
    try {
      const r = spawnSync("tar", ["--version"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      tarAvailable = r.status === 0;
    } catch {
      tarAvailable = false;
    }
  }
  return tarAvailable;
}

/**
 * Directory backups via the system `tar` (gzip). No new native deps, and the
 * format stays restorable by hand with plain tar — the operator is never
 * locked into the panel to get their data back.
 */
export class BackupsService {
  constructor(
    private readonly db: Database,
    private readonly servers: ServersRepo,
    private readonly blueprints: BlueprintRegistry,
    private readonly engine: LocalProcessEngine,
    private readonly dataDir: string,
  ) {}

  list(serverId: string): BackupRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM backups WHERE server_id = ? AND purged_at IS NULL ORDER BY created_at DESC",
      )
      .all(serverId) as unknown as BackupRecord[];
  }

  byId(id: string): BackupRecord | null {
    const row = this.db
      .prepare("SELECT * FROM backups WHERE id = ? AND purged_at IS NULL")
      .get(id) as BackupRecord | undefined;
    return row ?? null;
  }

  pathFor(record: BackupRecord): string {
    return join(this.dataDir, "backups", record.server_id, record.file_name);
  }

  create(serverId: string, actorUserId: string | null, opts?: { locked?: boolean }): BackupRecord {
    const server = this.servers.byId(serverId);
    if (!server) throw new NotFoundError("Server not found");
    if (!isTarAvailable()) {
      throw new ConflictError("Backup tool (tar) is not available on this machine");
    }
    const doc = this.tryDoc(server.blueprint_slug, server.blueprint_version_tag);
    const running = this.engine.stateOf(serverId) !== "offline";
    if (doc?.backupPolicy?.consistency === "stopped" && running) {
      throw new ConflictError("This blueprint requires the server to be stopped for backup");
    }

    const now = Date.now();
    const id = ulid(now);
    const fileName = `${id}.tar.gz`;
    const srcDir = join(this.dataDir, "servers", serverId);
    const destDir = join(this.dataDir, "backups", serverId);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, fileName);

    if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true });
    // Denied files (e.g. live socket files) are excluded by exact relative path.
    const excludes = (doc?.fileDenylist ?? []).flatMap((p) => ["--exclude", sanitizeExclude(p)]);
    const tar = spawnSync("tar", ["-czf", dest, ...excludes, "-C", srcDir, "."], {
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    if (tar.status !== 0) {
      rmSync(dest, { force: true });
      throw new ConflictError("Backup failed while archiving the server directory");
    }

    const bytes = statSync(dest).size;
    const checksum = sha256File(dest);
    const record: BackupRecord = {
      id,
      server_id: serverId,
      file_name: fileName,
      checksum_sha256: checksum,
      bytes,
      locked: opts?.locked ? 1 : 0,
      consistency: running ? "best-effort" : "stopped",
      created_by: actorUserId,
      completed_at: now,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO backups (id, server_id, file_name, checksum_sha256, bytes, locked,
           consistency, created_by, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        serverId,
        fileName,
        checksum,
        bytes,
        record.locked,
        record.consistency,
        actorUserId,
        now,
        now,
      );
    this.enforceRetention(serverId);
    const created = this.byId(id);
    if (!created) throw new Error("backup record lost");
    return created;
  }

  restore(backupId: string): void {
    const record = this.byId(backupId);
    if (!record) throw new NotFoundError("Backup not found");
    if (this.engine.stateOf(record.server_id) !== "offline") {
      throw new ConflictError("Stop the server before restoring a backup");
    }
    const file = this.pathFor(record);
    if (!existsSync(file)) throw new NotFoundError("Backup file is missing from disk");
    if (sha256File(file) !== record.checksum_sha256) {
      throw new ConflictError("Backup file failed checksum verification — refusing to restore");
    }
    const destDir = join(this.dataDir, "servers", record.server_id);
    mkdirSync(destDir, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", file, "-C", destDir], {
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    if (tar.status !== 0) throw new ConflictError("Restore failed while extracting the archive");
  }

  remove(backupId: string): void {
    const record = this.byId(backupId);
    if (!record) throw new NotFoundError("Backup not found");
    if (record.locked === 1) throw new ConflictError("Locked backups cannot be deleted");
    rmSync(this.pathFor(record), { force: true });
    this.db.prepare("UPDATE backups SET purged_at = ? WHERE id = ?").run(Date.now(), backupId);
  }

  /** Keep the newest RETAIN_UNLOCKED unlocked backups; locked ones are never purged. */
  private enforceRetention(serverId: string): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM backups WHERE server_id = ? AND purged_at IS NULL AND locked = 0 ORDER BY created_at DESC",
      )
      .all(serverId) as Array<{ id: string }>;
    for (const extra of rows.slice(RETAIN_UNLOCKED)) {
      const record = this.byId(extra.id);
      if (record) rmSync(this.pathFor(record), { force: true });
      this.db
        .prepare("UPDATE backups SET purged_at = ?, retained_reason = 'retention' WHERE id = ?")
        .run(Date.now(), extra.id);
    }
  }

  private tryDoc(slug: string, tag: string) {
    try {
      return this.blueprints.getDoc(slug, tag);
    } catch {
      return null;
    }
  }
}

/** Exclude patterns must stay relative; absolute paths and `..` are dropped. */
export function sanitizeExclude(pattern: string): string {
  const trimmed = pattern.trim().replace(/^[./\\]+/, "");
  if (trimmed === "" || trimmed.includes("..")) return "__invalid__";
  return trimmed;
}

/** Synchronous hash (backups hash at creation/restore, never on hot paths). */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
