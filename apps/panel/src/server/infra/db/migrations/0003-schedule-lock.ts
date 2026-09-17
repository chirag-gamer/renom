import type { Migration } from "../migrations.js";

/**
 * Migration 3 — schedule lock expiry.
 * A crashed run used to leave `is_processing = 1` forever, silently killing
 * the schedule. `lock_until` bounds every claim: locks expire, and the next
 * tick can fire again. Existing stuck rows (if any) become runnable on
 * upgrade. Downgrade: restore the pre-migration DB backup (NFR-015).
 */
export const scheduleLockMigration: Migration = {
  id: 3,
  name: "schedule-lock-expiry",
  up: (db) => {
    db.exec("ALTER TABLE schedules ADD COLUMN lock_until INTEGER NOT NULL DEFAULT 0");
  },
};
