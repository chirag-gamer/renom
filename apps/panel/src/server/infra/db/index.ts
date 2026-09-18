export * from "./database.js";
export * from "./migrations.js";
export * from "./migrations/0001-schema-v1.js";

import type { Database } from "./database.js";
import { runMigrations } from "./migrations.js";
import { schemaV1 } from "./migrations/0001-schema-v1.js";
import { maturityMigration } from "./migrations/0002-maturity.js";
import { scheduleLockMigration } from "./migrations/0003-schedule-lock.js";

/** All known migrations in order. */
export const allMigrations = [schemaV1, maturityMigration, scheduleLockMigration];

/** Open and migrate a database to head. */
export function openAndMigrate(file: string): Database {
  const db = openDatabaseImpl(file);
  runMigrations(db, allMigrations);
  return db;
}

// indirection keeps tree-shaking simple in tests that import openDatabase directly
import { openDatabase as openDatabaseImpl } from "./database.js";
