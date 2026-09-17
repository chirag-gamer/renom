import type { Migration } from "../migrations.js";

/**
 * Migration 2 — blueprint maturity flag.
 * Existing rows default to 'stable'; the seeder corrects each row from its
 * document on every boot, so catalog edits converge without a data migration.
 * Downgrade: restore the pre-migration DB backup (NFR-015).
 */
export const maturityMigration: Migration = {
  id: 2,
  name: "blueprint-maturity",
  up: (db) => {
    db.exec("ALTER TABLE blueprints ADD COLUMN maturity TEXT NOT NULL DEFAULT 'stable'");
  },
};
