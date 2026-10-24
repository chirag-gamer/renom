import type { Migration } from "../migrations.js";
import { claimEndpointName } from "../../../modules/tunnels/minekube.js";

/**
 * Migration 5 — repair overlong Minekube Connect endpoint names in server_variables.
 *
 * Minekube Connect's WatchService strictly enforces a 16-character maximum
 * length limit on endpoint names. Older releases of Renom minted names up to
 * 20 characters (such as `mellow-atlas-9245`), which caused the connector
 * plugin to fail on startup with HTTP 400 "invalid endpoint name format" and
 * loop infinitely during reconnection.
 *
 * This migration scans for any existing `tunnel.endpoint` values with length > 16,
 * mints a new valid endpoint name (<= 16 chars) for each server, and updates the database.
 */
export const repairOverlongTunnelEndpointsMigration: Migration = {
  id: 5,
  name: "repair-overlong-tunnel-endpoints",
  up: (db) => {
    const rows = db
      .prepare(
        "SELECT server_id, value FROM server_variables WHERE key = 'tunnel.endpoint' AND LENGTH(value) > 16",
      )
      .all() as Array<{ server_id: string; value: string }>;

    const update = db.prepare(
      "UPDATE server_variables SET value = ? WHERE server_id = ? AND key = 'tunnel.endpoint'",
    );

    for (const row of rows) {
      try {
        const fresh = claimEndpointName(db, row.server_id);
        update.run(fresh, row.server_id);
      } catch {
        db.prepare(
          "DELETE FROM server_variables WHERE server_id = ? AND key = 'tunnel.endpoint'",
        ).run(row.server_id);
      }
    }
  },
  down: () => {
    // Irreversible: overlong endpoint names were permanently invalid upstream.
  },
};
