import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, renameSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve, sep } from "node:path";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../servers/repo.js";
import type { BlueprintRegistry } from "../blueprints/registry.js";
import type { LocalProcessEngine } from "../runtime/engine.js";
import type { AuditService } from "../audit/service.js";
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
 * Directory backups via the system `tar` (gzip). Archival runs in a child
 * process (never blocks the panel's event loop), and the format stays
 * restorable by hand with plain tar — the operator is never locked into
 * the panel to get their data back.
 */
export class BackupsService {
  private readonly execTar = promisify(execFile);

  constructor(
    private readonly db: Database,
    private readonly servers: ServersRepo,
    private readonly blueprints: BlueprintRegistry,
    private readonly engine: LocalProcessEngine,
    private readonly dataDir: string,
    private readonly audit?: AuditService,
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

  async create(
    serverId: string,
    actorUserId: string | null,
    opts?: { locked?: boolean },
  ): Promise<BackupRecord> {
    const server = this.servers.byId(serverId);
    if (!server) throw new NotFoundError("Server not found");
    if (!isTarAvailable()) {
      throw new ConflictError("Backup tool (tar) is not available on this machine");
    }
    // Fail closed: without the blueprint doc we cannot verify the backup
    // policy, so we refuse rather than silently taking a weaker backup.
    let doc;
    try {
      doc = this.blueprints.getDoc(server.blueprint_slug, server.blueprint_version_tag);
    } catch {
      throw new ConflictError("Cannot verify this server's backup policy right now");
    }
    const running = this.engine.stateOf(serverId) !== "offline";
    if (doc.backupPolicy?.consistency === "stopped" && running) {
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
    // Blueprint denylist plus the hardcoded secret excludes (n2: tar emits
    // `./`-prefixed members, so both spellings ship).
    const excludes = [...DEFAULT_SECRET_EXCLUDES, ...(doc.fileDenylist ?? [])].flatMap((p) => [
      "--exclude",
      sanitizeExclude(p),
    ]);
    try {
      await this.execTar("tar", ["-czf", dest, ...excludes, "-C", srcDir, "."], {
        timeout: 10 * 60_000,
        windowsHide: true,
      });
    } catch {
      rmSync(dest, { force: true });
      throw new ConflictError("Backup failed while archiving the server directory");
    }

    const bytes = statSync(dest).size;
    const checksum = await sha256File(dest);
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

  /**
   * Restore replaces the server directory wholesale: extract into a sibling
   * temp dir, then swap. Files created after the backup do NOT survive —
   * that is the documented meaning of "restore", and overlaying would leave
   * a half-old half-new directory nobody can reason about.
   */
  async restore(backupId: string): Promise<void> {
    const record = this.byId(backupId);
    if (!record) throw new NotFoundError("Backup not found");
    if (this.engine.stateOf(record.server_id) !== "offline") {
      throw new ConflictError("Stop the server before restoring a backup");
    }
    const file = this.pathFor(record);
    if (!existsSync(file)) throw new NotFoundError("Backup file is missing from disk");
    if ((await sha256File(file)) !== record.checksum_sha256) {
      throw new ConflictError("Backup file failed checksum verification — refusing to restore");
    }
    const destDir = join(this.dataDir, "servers", record.server_id);
    const staging = join(this.dataDir, "servers", `${record.server_id}.restore-${record.id}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      await assertTarMembersSafe(file, staging);
      await this.execTar("tar", ["-xzf", file, "-C", staging], {
        timeout: 10 * 60_000,
        windowsHide: true,
      });
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (err instanceof ConflictError) throw err;
      throw new ConflictError("Restore failed while extracting the archive");
    }
    // Swap: move the live dir aside, move staging in, drop the old copy.
    // A crash between the moves leaves `<id>.pre-restore-<backup>` behind —
    // the next restore (or the operator) recovers from it, nothing is lost.
    const displaced = join(this.dataDir, "servers", `${record.server_id}.pre-restore-${record.id}`);
    rmSync(displaced, { recursive: true, force: true });
    if (existsSync(destDir)) renameSync(destDir, displaced);
    renameSync(staging, destDir);
    rmSync(displaced, { recursive: true, force: true });
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
      // Mark first, delete second: a crash between them leaves a purged row
      // pointing at a live file (recoverable) rather than a live row with a
      // missing file (confusing). Either way the audit trail says what happened.
      this.db
        .prepare("UPDATE backups SET purged_at = ?, retained_reason = 'retention' WHERE id = ?")
        .run(Date.now(), extra.id);
      const file = this.db
        .prepare("SELECT file_name FROM backups WHERE id = ?")
        .get(extra.id) as { file_name: string } | undefined;
      if (file) rmSync(join(this.dataDir, "backups", serverId, file.file_name), { force: true });
      this.audit?.record({
        event: "backup.retention.purge",
        actorIp: "system",
        serverId,
        target: { backupId: extra.id },
      });
    }
  }

  /** Unlock a locked backup so it becomes deletable and retention-eligible. */
  unlock(backupId: string): boolean {
    const res = this.db
      .prepare("UPDATE backups SET locked = 0 WHERE id = ? AND purged_at IS NULL AND locked = 1")
      .run(backupId);
    return Number(res.changes) === 1;
  }
}

/** Exclude patterns must stay relative; absolute paths and `..` are dropped. */
export function sanitizeExclude(pattern: string): string {
  const trimmed = pattern.trim().replace(/^[./\\]+/, "");
  if (trimmed === "" || trimmed.includes("..")) return "__invalid__";
  return trimmed;
}

/**
 * Files that never belong in a backup, no matter what a blueprint says.
 * Secrets kept inside server directories (plugin configs love them) must not
 * ride along into downloadable archives. Tar matches these against the
 * `./`-prefixed member names it actually emits, so both spellings ship.
 */
export const DEFAULT_SECRET_EXCLUDES = [
  ".env",
  "./.env",
  "*.pem",
  "./*.pem",
  "*.key",
  "./*.key",
  "id_rsa*",
  "./id_rsa*",
  "*.pfx",
  "./*.pfx",
  "*.p12",
  "./*.p12",
];

/** Streaming hash (archives are routinely hundreds of MB; never buffer them). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** List tar.gz members for zip-slip validation before extraction. */
async function assertTarMembersSafe(archive: string, destDir: string): Promise<void> {
  const execFileAsync = promisify(execFile);
  let listing: string;
  try {
    const { stdout } = await execFileAsync("tar", ["-tzf", archive], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    listing = String(stdout);
  } catch {
    throw new ConflictError(`Could not list archive members of ${archive}`);
  }
  for (const member of listing.split(/\r?\n/)) {
    const cleaned = member.replace(/^\.\//, "");
    if (cleaned === "" || cleaned === "." || cleaned.endsWith("/")) continue;
    const resolved = resolve(destDir, cleaned);
    if (resolved !== destDir && !resolved.startsWith(destDir + sep)) {
      throw new ConflictError(`Archive member escapes destination: ${member}`);
    }
  }
}
