import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAndMigrate, openDatabase } from "../../src/server/infra/db/index.js";
import { runMigrations } from "../../src/server/infra/db/migrations.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "renom-db-"));
  dirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("database layer", () => {
  it("applies migrations and is idempotent on re-run", () => {
    const file = tempDb();
    const db = openAndMigrate(file);
    const rows = db.prepare("SELECT name FROM _migrations ORDER BY id").all() as Array<{
      name: string;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["schema-v1"]);

    db.close();
    const again = openAndMigrate(file);
    const rows2 = again.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number };
    expect(Number(rows2.n)).toBe(1);
    again.close();
  });

  it("creates core tables with enforced foreign keys", () => {
    const db = openAndMigrate(tempDb());
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of [
      "users",
      "servers",
      "allocations",
      "blueprints",
      "api_keys",
      "backups",
      "schedules",
      "audit_log",
      "settings",
      "jobs",
      "subusers",
      "nodes",
    ]) {
      expect(names).toContain(t);
    }

    expect(() =>
      db
        .prepare(
          "INSERT INTO servers (id,name,owner_id,blueprint_id,blueprint_version_tag,image_ref,memory_mb,disk_quota_mb,created_at,updated_at) VALUES ('s1','x','nouser','nobp','v1','img',1024,1024,0,0)",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("rolls back transactions on failure", () => {
    const db = openAndMigrate(tempDb());
    db.prepare(
      "INSERT INTO users (id,username,role,created_at,updated_at) VALUES ('u1','alice','owner',0,0)",
    ).run();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO users (id,username,role,created_at,updated_at) VALUES ('u2','bob','user',0,0)",
        ).run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const n = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(Number(n.n)).toBe(1); // bob rolled back
    db.close();
  });

  it("enforces allocation uniqueness for unreleased rows only", () => {
    const db = openAndMigrate(tempDb());
    const ins = db.prepare(
      "INSERT INTO allocations (id,ip,port,created_at,updated_at,released) VALUES (?,?,?,?,?,0)",
    );
    ins.run("a1", "0.0.0.0", 25565, 0, 0);
    expect(() => ins.run("a2", "0.0.0.0", 25565, 0, 0)).toThrow(); // duplicate active
    db.prepare("UPDATE allocations SET released=1 WHERE id='a1'").run();
    expect(() => ins.run("a3", "0.0.0.0", 25565, 0, 0)).not.toThrow();
    db.close();
  });

  it("rejects out-of-range ports", () => {
    const db = openAndMigrate(tempDb());
    expect(() =>
      db
        .prepare(
          "INSERT INTO allocations (id,ip,port,created_at,updated_at) VALUES ('p1','0.0.0.0',80,0,0)",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("WAL mode is active on file databases", () => {
    const db = openDatabase(tempDb());
    runMigrations(db, []);
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
    db.close();
  });
});
