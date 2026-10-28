import type { Migration } from "../migrations.js";

/**
 * Migration 6 — index the Activity feed's access path.
 *
 * `AuditService.activityForServer` filters on `server_id` and walks backwards
 * with `id < ? ORDER BY id DESC`. The existing `idx_audit_server(server_id, ts)`
 * covers the filter but not the ordering, so SQLite sorts every matching row in
 * a temp b-tree — and the feed is read every time a server tab opens.
 *
 * `(server_id, id)` serves both halves: equality on the prefix, then the
 * descending scan in index order. `id` is the ULID primary key, so this is also
 * the chronological order the feed wants.
 */
export const auditServerIdIndexMigration: Migration = {
  id: 6,
  name: "audit-server-id-index",
  up: (db) => {
    db.exec("CREATE INDEX IF NOT EXISTS idx_audit_server_id_id ON audit_log(server_id, id DESC);");
  },
  /** Reversing is dropping the index: it holds no data of its own. */
  down: (db) => {
    db.exec("DROP INDEX IF EXISTS idx_audit_server_id_id;");
  },
};
