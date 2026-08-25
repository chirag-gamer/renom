/**
 * Database abstraction (ADR-0002): the ONLY module allowed to touch SQLite.
 * Implemented over Node's built-in `node:sqlite` driver — zero native build dependencies,
 * which keeps the installer requirement to "Node >= 24" (no compiler toolchain).
 *
 * WAL + busy_timeout are set at open (NFR-004); foreign keys enforced.
 */
import { DatabaseSync } from "node:sqlite";

export interface DbRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint | undefined;
}

export interface DbStatement {
  run(...params: unknown[]): DbRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  /** Runs fn inside BEGIN IMMEDIATE / COMMIT; rolls back on throw. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(file: string): Database {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const wrap = (stmt: ReturnType<DatabaseSync["prepare"]>): DbStatement => {
    const runArgs = stmt.run.bind(stmt) as (...p: unknown[]) => DbRunResult;
    const getArgs = stmt.get.bind(stmt) as (...p: unknown[]) => unknown;
    const allArgs = stmt.all.bind(stmt) as (...p: unknown[]) => unknown[];
    return {
      run: (...params) => runArgs(...params),
      get: (...params) => getArgs(...params),
      all: (...params) => allArgs(...params),
    };
  };

  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => wrap(db.prepare(sql)),
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // connection already rolled back / closed
        }
        throw err;
      }
    },
    close: () => db.close(),
  };
}
