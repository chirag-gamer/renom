import type { Migration } from "../migrations.js";

/**
 * Migration 4 — one Connect endpoint name per server, enforced by the database.
 *
 * The panel reserves a tunnel name before it downloads the plugin, but a
 * check-then-write pair in application code still loses a race: two concurrent
 * requests can both read "free" before either writes. This index makes the
 * database the arbiter, so the second writer fails instead of silently
 * claiming a join address another server already advertises.
 *
 * Scoped to `tunnel.endpoint` deliberately: every server stores the same
 * `maxMemory` key, so a unique index over `server_variables` as a whole would
 * collide on ordinary startup variables. Only the endpoint value must be
 * globally unique, because it is a public address.
 *
 * Existing duplicates (only reachable through a pre-index race) are released
 * so the migration cannot fail on an upgrade. Downgrade: restore the
 * pre-migration DB backup (NFR-015).
 */
export const tunnelEndpointUniqueMigration: Migration = {
  id: 4,
  name: "tunnel-endpoint-unique",
  up: (db) => {
    // Installs that ran the old, unreserved code could already hold one name
    // on several servers, and CREATE UNIQUE INDEX aborts the whole migration
    // (so the panel would not boot). Keep the earliest claim for each name and
    // drop the losers. `rowid` is insertion order, so this is the first
    // server that claimed the name — it does not rely on the server-id format.
    db.exec(`
      DELETE FROM server_variables
      WHERE key = 'tunnel.endpoint'
        AND rowid NOT IN (
          SELECT MIN(rowid) FROM server_variables
          WHERE key = 'tunnel.endpoint'
          GROUP BY value
        )
    `);
    // A stray row must not brick startup: if anything survived, the unique
    // index is skipped and the app still runs with a best-effort guard.
    const dupes = db
      .prepare(
        `SELECT value FROM server_variables WHERE key = 'tunnel.endpoint'
         GROUP BY value HAVING COUNT(*) > 1 LIMIT 1`,
      )
      .get() as { value: string } | undefined;
    if (dupes) return;
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tunnel_endpoint_unique ON server_variables(value) WHERE key = 'tunnel.endpoint'",
    );
  },
  down: (db) => {
    db.exec("DROP INDEX IF EXISTS idx_tunnel_endpoint_unique");
  },
};
