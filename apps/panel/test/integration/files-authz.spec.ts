import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
      .run(bobId, serverId, JSON.stringify(["file.read"]), ctx.users.byUsername("owner")!.id, Date.now());

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

    const nul = await request(app)
      .get(`/api/v3/servers/${serverId}/files/content`)
      .query({ path: "server.properties%00.png" })
      .set("authorization", `Bearer ${ownerToken}`);
    expect(nul.status).toBeLessThan(500);
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
});
