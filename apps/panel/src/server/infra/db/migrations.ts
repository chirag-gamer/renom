import type { Database } from "./database.js";

export interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
  /** Documented downgrade or a comment explaining restore path (NFR-015). */
  down?: (db: Database) => void;
}

/**
 * Applies pending migrations in order inside transactions. Idempotent:
 * re-running on an up-to-date database is a no-op. Each migration is recorded
 * in `_migrations`; failures abort before recording, so restart resumes safely.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  )`);

  const appliedRows = db.prepare("SELECT id FROM _migrations ORDER BY id").all() as Array<{
    id: number;
  }>;
  const applied = new Set(appliedRows.map((r) => r.id));
  const sorted = [...migrations].sort((a, b) => a.id - b.id);

  for (const m of sorted) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        Date.now(),
      );
    });
  }
}
