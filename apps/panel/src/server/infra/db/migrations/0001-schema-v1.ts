import type { Migration } from "../migrations.js";

/**
 * Schema v1 — mirrors docs/architecture/DATA-MODEL.md of the planning workspace.
 * Timestamps: INTEGER unix-ms UTC. PKs: TEXT ULID. FKs enforced (PRAGMA at open).
 *
 * Downgrade note (NFR-015): v1 is the initial schema; downgrade = restore pre-migration
 * backup of the DB file (documented in UPDATE-ROLLBACK.md).
 */
export const schemaV1: Migration = {
  id: 1,
  name: "schema-v1",
  up: (db) => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        email TEXT UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('owner','admin','user')),
        totp_secret_enc TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL DEFAULT '',
        quota_max_servers INTEGER NOT NULL DEFAULT 5,
        quota_ram_mb INTEGER NOT NULL DEFAULT 8192,
        quota_disk_mb INTEGER NOT NULL DEFAULT 40960,
        password_version INTEGER NOT NULL DEFAULT 0,
        suspended INTEGER NOT NULL DEFAULT 0,
        last_login_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_local INTEGER NOT NULL DEFAULT 1,
        engine TEXT NOT NULL DEFAULT 'docker',
        data_root TEXT NOT NULL,
        backup_root TEXT NOT NULL,
        public_ip TEXT,
        status TEXT NOT NULL DEFAULT 'online',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE blueprints (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        latest_tag TEXT NOT NULL DEFAULT 'v1',
        enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL CHECK(source IN ('builtin','import','registry')),
        registry_url TEXT,
        docs_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE blueprint_versions (
        blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        doc TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        PRIMARY KEY (blueprint_id, tag)
      );

      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL REFERENCES users(id),
        blueprint_id TEXT NOT NULL REFERENCES blueprints(id),
        blueprint_version_tag TEXT NOT NULL,
        mc_version TEXT,
        image_ref TEXT NOT NULL,
        node_id TEXT NOT NULL DEFAULT 'local' REFERENCES nodes(id),
        status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN
          ('creating','installing','install_failed','ready','suspended','restoring','updating','deleted')),
        runtime_state TEXT CHECK(runtime_state IN ('offline','starting','running','stopping')),
        memory_mb INTEGER NOT NULL,
        cpu_weight INTEGER NOT NULL DEFAULT 50,
        disk_quota_mb INTEGER NOT NULL,
        startup_snapshot TEXT NOT NULL DEFAULT '{}',
        eula_accepted_at INTEGER,
        eula_ip TEXT,
        crash_guard INTEGER NOT NULL DEFAULT 0,
        suspended_reason TEXT,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_servers_owner ON servers(owner_id) WHERE deleted_at IS NULL;
      CREATE INDEX idx_servers_status ON servers(status);

      CREATE TABLE allocations (
        id TEXT PRIMARY KEY,
        server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL CHECK(port BETWEEN 1024 AND 65535),
        notes TEXT NOT NULL DEFAULT '',
        reserved_until INTEGER,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_alloc_ip_port ON allocations(ip, port) WHERE released = 0;

      CREATE TABLE server_variables (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, key)
      );

      CREATE TABLE subusers (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        permissions_json TEXT NOT NULL,
        granted_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, server_id)
      );

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL CHECK(prefix IN ('jtgsk','jtga')),
        identifier TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        memo TEXT NOT NULL DEFAULT '',
        expires_at INTEGER,
        allowed_ips_json TEXT,
        last_used_at INTEGER,
        revoked_at INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_api_keys_user ON api_keys(user_id);

      CREATE TABLE sftp_credentials (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        host_key_fingerprint TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE backups (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        locked INTEGER NOT NULL DEFAULT 0,
        consistency TEXT NOT NULL DEFAULT 'best-effort' CHECK(consistency IN ('stopped','best-effort')),
        created_by TEXT REFERENCES users(id),
        completed_at INTEGER,
        purged_at INTEGER,
        retained_reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_backups_server ON backups(server_id, created_at);

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        tz TEXT NOT NULL DEFAULT 'UTC',
        is_active INTEGER NOT NULL DEFAULT 1,
        is_processing INTEGER NOT NULL DEFAULT 0,
        only_when_online INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_schedules_next ON schedules(is_active, next_run_at);

      CREATE TABLE tasks (
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('power','command','backup')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        offset_sec INTEGER NOT NULL DEFAULT 0,
        continue_on_failure INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (schedule_id, seq)
      );

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor_user_id TEXT,
        actor_api_key_id TEXT,
        actor_ip TEXT,
        event TEXT NOT NULL,
        server_id TEXT,
        target_json TEXT NOT NULL DEFAULT '{}',
        batch_uuid TEXT,
        request_id TEXT
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);
      CREATE INDEX idx_audit_server ON audit_log(server_id, ts);
      CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, ts);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        sensitive INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
        progress INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        run_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        request_id TEXT
      );
      CREATE INDEX idx_jobs_state ON jobs(state, run_at);
    `);
  },
};
