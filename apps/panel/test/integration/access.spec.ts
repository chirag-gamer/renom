import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";

let app: ReturnType<typeof buildPanel>["app"];
let ctx: ReturnType<typeof buildPanel>["ctx"];
let dir: string;
let ownerToken = "";
let aliceToken = "";
let serverId = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "renom-access-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;

  ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
  ctx.users.create({ username: "alice", password: "alice-password", role: "user" });
  ownerToken = (
    await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "root-password-1" })
  ).body.token as string;
  aliceToken = (
    await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "alice", password: "alice-password" })
  ).body.token as string;

  const created = await request(app)
    .post("/api/v3/servers")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ name: "shared", blueprintSlug: "paper" });
  serverId = created.body.server.id as string;
});

afterAll(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("api keys", () => {
  let keyToken = "";
  let keyId = "";

  it("creates a key whose secret is shown once, then authenticates", async () => {
    const res = await request(app)
      .post("/api/v3/api-keys")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ memo: "backup script", scopes: ["backup.create", "backup.read"] });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^jtgsk\./);
    keyToken = res.body.token as string;
    keyId = res.body.key.id as string;

    const list = await request(app)
      .get("/api/v3/api-keys")
      .set("authorization", `Bearer ${ownerToken}`);
    expect(list.body.keys.map((k: { id: string }) => k.id)).toContain(keyId);
    expect(JSON.stringify(list.body)).not.toContain(res.body.token);

    const me = await request(app).get("/api/v3/auth/me").set("authorization", `Bearer ${keyToken}`);
    expect(me.status).toBe(200);
  });

  it("rejects unknown scopes at creation (400)", async () => {
    const res = await request(app)
      .post("/api/v3/api-keys")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ scopes: ["teleport"] });
    expect(res.status).toBe(400);
  });

  it("a file.read-scoped owner key cannot start servers", async () => {
    const res = await request(app)
      .post("/api/v3/api-keys")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ scopes: ["file.read"] });
    const narrow = res.body.token as string;

    const start = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${narrow}`)
      .send({ action: "start" });
    expect(start.status).toBe(403);
  });

  it("revoked keys stop working immediately", async () => {
    const del = await request(app)
      .delete(`/api/v3/api-keys/${keyId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const me = await request(app).get("/api/v3/auth/me").set("authorization", `Bearer ${keyToken}`);
    expect(me.status).toBe(401);
  });
});

describe("subusers", () => {
  it("owner grants alice console-only access; she reads but cannot start", async () => {
    const grant = await request(app)
      .post(`/api/v3/servers/${serverId}/users`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "alice", permissions: ["websocket.connect", "control.console"] });
    expect(grant.status).toBe(201);

    const start = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ action: "start" });
    expect(start.status).toBe(403);

    const history = await request(app)
      .get(`/api/v3/servers/${serverId}/console/history`)
      .set("authorization", `Bearer ${aliceToken}`);
    expect(history.status).toBe(200);
  });

  it("rejects unknown permissions and duplicate grants", async () => {
    const bad = await request(app)
      .post(`/api/v3/servers/${serverId}/users`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "alice", permissions: ["fly"] });
    expect(bad.status).toBe(400);

    const dup = await request(app)
      .post(`/api/v3/servers/${serverId}/users`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "alice", permissions: ["control.console"] });
    expect(dup.status).toBe(409);
  });

  it("removal revokes access (reads become 404 again)", async () => {
    const aliceId = ctx.users.byUsername("alice")!.id;
    const del = await request(app)
      .delete(`/api/v3/servers/${serverId}/users/${aliceId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const read = await request(app)
      .get(`/api/v3/servers/${serverId}`)
      .set("authorization", `Bearer ${aliceToken}`);
    expect(read.status).toBe(404);
  });
});

describe("allocations", () => {
  it("lists the primary, assigns a second, refuses conflicts and last-release", async () => {
    const list = await request(app)
      .get(`/api/v3/servers/${serverId}/allocations`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(list.body.allocations.length).toBe(1);
    const primary = list.body.allocations[0] as { id: string; port: number };

    const add = await request(app)
      .post(`/api/v3/servers/${serverId}/allocations`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ ip: "127.0.0.1", port: 25570 });
    expect(add.status).toBe(201);

    const clash = await request(app)
      .post(`/api/v3/servers/${serverId}/allocations`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ ip: "0.0.0.0", port: primary.port });
    expect(clash.status).toBe(409);

    const release = await request(app)
      .delete(`/api/v3/servers/${serverId}/allocations/${add.body.allocation.id}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(release.status).toBe(204);

    const last = await request(app)
      .delete(`/api/v3/servers/${serverId}/allocations/${primary.id}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(last.status).toBe(400);
  });
});
