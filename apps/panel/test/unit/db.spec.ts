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
    expect(rows.map((r) => r.name)).toEqual([
      "schema-v1",
      "blueprint-maturity",
      "schedule-lock-expiry",
      "tunnel-endpoint-unique",
    ]);

    db.close();
    const again = openAndMigrate(file);
    const rows2 = again.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number };
    expect(Number(rows2.n)).toBe(4);
    again.close();
  });

  it("enforces one tunnel endpoint name across servers", () => {
    const db = openAndMigrate(tempDb());
    try {
      // `servers.node_id` defaults to 'local' and is a foreign key, so the
      // fixture needs the node row the real boot seeds.
      db.prepare(
        "INSERT INTO nodes (id,name,data_root,backup_root,status,created_at) VALUES ('local','Local','/d','/b','online',0)",
      ).run();
      db.prepare(
        "INSERT INTO users (id,username,role,created_at,updated_at) VALUES ('u1','alice','owner',0,0)",
      ).run();
      db.prepare(
        "INSERT INTO blueprints (id,slug,name,category,source,created_at,updated_at) VALUES ('b1','paper','Paper','minecraft-java','builtin',0,0)",
      ).run();
      for (const id of ["srv-a", "srv-b"]) {
        db.prepare(
          `INSERT INTO servers (id,name,owner_id,blueprint_id,blueprint_version_tag,image_ref,memory_mb,disk_quota_mb,created_at,updated_at)
           VALUES (?,?,'u1','b1','v1','img',1024,1024,0,0)`,
        ).run(id, id);
      }
      const setVar = db.prepare(
        `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
         ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
      );
      // `maxMemory` is stored for every server, so a unique index over the
      // whole table would break here — only the endpoint value must be unique.
      setVar.run("srv-a", "maxMemory", "2048");
      setVar.run("srv-b", "maxMemory", "4096");
      setVar.run("srv-a", "tunnel.endpoint", "vivid-lagoon-9784");
      expect(() => setVar.run("srv-b", "tunnel.endpoint", "vivid-lagoon-9784")).toThrow();
      setVar.run("srv-b", "tunnel.endpoint", "amber-meadow-1234");
    } finally {
      db.close();
    }
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
