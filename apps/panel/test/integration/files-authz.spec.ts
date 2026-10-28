import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";

let app: ReturnType<typeof buildPanel>["app"];
let ctx: ReturnType<typeof buildPanel>["ctx"];
let dir: string;
let serverId: string;
let ownerToken = "";
const BOB_PASS = "bob-password-1";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "renom-files-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;

  const owner = ctx.users.create({ username: "owner", password: "owner-password", role: "owner" });
  const bob = ctx.users.create({ username: "bob", password: BOB_PASS, role: "user" });
  void bob;
  serverId = "srv-test-0001";

  const now = Date.now();
  // buildPanel seeds the 'local' node on every boot; top up paths idempotently.
  ctx.db
    .prepare(
      "INSERT INTO nodes (id,name,is_local,engine,data_root,backup_root,created_at) VALUES ('local','local',1,'docker',?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_root=excluded.data_root, backup_root=excluded.backup_root",
    )
    .run(join(dir, "servers"), join(dir, "backups"), now);
  ctx.db
    .prepare(
      "INSERT INTO blueprints (id,slug,name,category,source,created_at,updated_at) VALUES ('bp','generic','Generic','generic-runtime','builtin',?,?)",
    )
    .run(now, now);
  ctx.db
    .prepare(
      `INSERT INTO servers (id,name,owner_id,blueprint_id,blueprint_version_tag,image_ref,
         memory_mb,disk_quota_mb,status,runtime_state,created_at,updated_at)
       VALUES (?,'test',?,'bp','v1','img',512,1024,'ready','offline',?,?)`,
    )
    .run(serverId, owner.id, now, now);
  // The generic-writer server-port guard compares against the live
  // allocation; without a row here it short-circuits and the guard is
  // unreachable from any test.
  ctx.db
    .prepare(
      `INSERT INTO allocations (id, server_id, ip, port, released, created_at, updated_at)
       VALUES ('al-test', ?, '0.0.0.0', 25566, 0, ?, ?)`,
    )
    .run(serverId, now, now);

  const srvDir = join(dir, "servers", serverId);
  mkdirSync(srvDir, { recursive: true });
  writeFileSync(join(srvDir, "server.properties"), "motd=hello", "utf8");
});

afterAll(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/v3/auth/login").send({ username, password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`login(${username}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token as string;
}

describe("files API authorization + confinement", () => {
  beforeAll(async () => {
    ownerToken = await login("owner", "owner-password");
  });

  it("owner lists and reads files", async () => {
    const list = await request(app)
      .get(`/api/v3/servers/${serverId}/files`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { name: string }) => i.name)).toContain("server.properties");

    const read = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "server.properties" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toBe("motd=hello");
  });

  it("unrelated user gets existence-hiding 404 on read, 403 on mutation", async () => {
    const bobToken = await login("bob", BOB_PASS);

    const list = await request(app)
      .get(`/api/v3/servers/${serverId}/files`)
      .set("authorization", `Bearer ${bobToken}`);
    expect(list.status).toBe(404);

    const write = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${bobToken}`)
      .send({ path: "server.properties", content: "hacked" });
    expect(write.status).toBe(403);

    const raw = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "server.properties" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(raw.body.content).toBe("motd=hello");
  });

  it("subuser with only file.read can list but not write (granular strings)", async () => {
    const bobId = ctx.users.byUsername("bob")!.id;
    ctx.db
      .prepare(
        "INSERT INTO subusers (user_id, server_id, permissions_json, granted_by, created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        bobId,
        serverId,
        JSON.stringify(["file.read"]),
        ctx.users.byUsername("owner")!.id,
        Date.now(),
      );

    const bobToken = await login("bob", BOB_PASS);
    const list = await request(app)
      .get(`/api/v3/servers/${serverId}/files`)
      .set("authorization", `Bearer ${bobToken}`);
    expect(list.status).toBe(200);

    const write = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${bobToken}`)
      .send({ path: "server.properties", content: "nope" });
    expect(write.status).toBe(403);

    // revocation is immediate on next request (FR-102 HTTP side)
    ctx.db.prepare("DELETE FROM subusers WHERE user_id = ? AND server_id = ?").run(bobId, serverId);
    const afterRevoke = await request(app)
      .get(`/api/v3/servers/${serverId}/files`)
      .set("authorization", `Bearer ${bobToken}`);
    expect(afterRevoke.status).toBe(404);
  });

  it("rejects traversal attempts through the API (SEC-006)", async () => {
    const read = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "../../panel.db" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect([400, 404]).toContain(read.status); // mapped PathEscape/ENOENT, never contents

    // A real NUL byte in the path (not the literal text "%00").
    const nul = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "server.properties\0.png" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(nul.status).toBeLessThan(500);
    expect([400, 404]).toContain(nul.status);
  });

  it("suspension blocks file mutations even for the owner (FR-023)", async () => {
    ctx.db.prepare("UPDATE servers SET status='suspended' WHERE id=?").run(serverId);
    const write = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ path: "server.properties", content: "while suspended" });
    expect(write.status).toBe(403);

    const read = await request(app)
      .get(`/api/v3/servers/${serverId}/files`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(read.status).toBe(200); // reads still allowed for owner

    ctx.db.prepare("UPDATE servers SET status='ready' WHERE id=?").run(serverId);
  });

  it("refuses oversized writes at the ingress bound (SEC-010)", async () => {
    const big = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ path: "big.txt", content: "x".repeat(1_500_000) });
    expect(big.status).toBe(413);
  });

  it("downloads a file with attachment disposition", async () => {
    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/files/download`)
      .query({ path: "server.properties" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.body?.toString?.("utf8") ?? res.text).toBe("motd=hello");
  });

  it("compresses and decompresses files via API", async () => {
    const srvDir = join(dir, "servers", serverId);
    writeFileSync(join(srvDir, "comp1.txt"), "hello comp1", "utf8");
    writeFileSync(join(srvDir, "comp2.txt"), "hello comp2", "utf8");

    const compRes = await request(app)
      .post(`/api/v3/servers/${serverId}/files/compress`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ root: "", files: ["comp1.txt", "comp2.txt"], archiveName: "bundle.tar.gz" });
    expect(compRes.status).toBe(200);
    expect(compRes.body.archive).toBe("bundle.tar.gz");

    const decompRes = await request(app)
      .post(`/api/v3/servers/${serverId}/files/decompress`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ path: "bundle.tar.gz", destination: "decomp" });
    expect(decompRes.status).toBe(204);

    const check = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "decomp/comp1.txt" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(check.status).toBe(200);
    expect(check.body.content).toBe("hello comp1");

    const check2 = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "decomp/comp2.txt" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(check2.status).toBe(200);
    expect(check2.body.content).toBe("hello comp2");
  });

  it("bulk deletes multiple files via API", async () => {
    const srvDir = join(dir, "servers", serverId);
    writeFileSync(join(srvDir, "bulk1.txt"), "b1", "utf8");
    writeFileSync(join(srvDir, "bulk2.txt"), "b2", "utf8");

    const delRes = await request(app)
      .post(`/api/v3/servers/${serverId}/files/delete`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ paths: ["bulk1.txt", "bulk2.txt"] });
    expect(delRes.status).toBe(204);

    const check = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "bulk1.txt" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(check.status).toBe(404);

    const check2 = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "bulk2.txt" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(check2.status).toBe(404);
  });
});

describe("server.properties route guards", () => {
  beforeAll(async () => {
    ownerToken = await login("owner", "owner-password");
  });

  it("reads the file as typed fields with server-port marked readonly", async () => {
    writeFileSync(
      join(dir, "servers", serverId, "server.properties"),
      "motd=hello\nserver-port=25565\nmax-players=20\n",
      "utf8",
    );

    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/properties`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const byKey = new Map(
      (res.body.properties as Array<{ key: string; readonly: boolean }>).map((p) => [p.key, p]),
    );
    expect(byKey.get("server-port")!.readonly).toBe(true);
    expect(byKey.get("motd")!.readonly).toBe(false);
  });

  it("rejects a server-port write and leaves the file untouched", async () => {
    const before = readFileSync(join(dir, "servers", serverId, "server.properties"), "utf8");

    const res = await request(app)
      .put(`/api/v3/servers/${serverId}/properties`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { "server-port": "25599" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/managed by the panel/);

    // Nothing may have been written: the port drives the allocation, tunnel
    // and engine config together.
    expect(readFileSync(join(dir, "servers", serverId, "server.properties"), "utf8")).toBe(before);
  });

  it("rejects an out-of-range value while still accepting a valid change", async () => {
    const bad = await request(app)
      .put(`/api/v3/servers/${serverId}/properties`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { "max-players": "0" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/at least 1/);

    const good = await request(app)
      .put(`/api/v3/servers/${serverId}/properties`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { motd: "changed", "max-players": "42" } });
    expect(good.status).toBe(204);
    expect(readFileSync(join(dir, "servers", serverId, "server.properties"), "utf8")).toBe(
      "motd=changed\nserver-port=25565\nmax-players=42\n",
    );
  });

  it("refuses an empty numeric value rather than writing zero", async () => {
    const res = await request(app)
      .put(`/api/v3/servers/${serverId}/properties`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { "max-players": "" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/whole number/);
  });
});

describe("generic file writer protects server-port", () => {
  beforeAll(async () => {
    ownerToken = await login("owner", "owner-password");
  });

  it("refuses a save that changes the allocation port", async () => {
    const res = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        path: "server.properties",
        content: "motd=hi\nserver-port=25599\n",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/managed by the panel allocation/);
    // The file must not have been written at all.
    expect(readFileSync(join(dir, "servers", serverId, "server.properties"), "utf8")).not.toContain(
      "25599",
    );
  });

  it("allows a save that keeps the allocation port", async () => {
    const res = await request(app)
      .put(`/api/v3/servers/${serverId}/files/content`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        path: "server.properties",
        content: "motd=edited\nserver-port=25566\n",
      });
    expect(res.status).toBe(204);
    expect(readFileSync(join(dir, "servers", serverId, "server.properties"), "utf8")).toContain(
      "25566",
    );
  });
});
