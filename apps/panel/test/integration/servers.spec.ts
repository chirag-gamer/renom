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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "renom-servers-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;

  ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
  // Alice is allowed exactly 1 server.
  ctx.users.create({
    username: "alice",
    password: "alice-password",
    role: "user",
    quotas: { quota_max_servers: 1 },
  });

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
});

afterAll(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("servers CRUD + ownership + quotas", () => {
  let aliceServerId = "";

  it("rejects unknown blueprints with 404", async () => {
    const res = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ name: "nope", blueprintSlug: "does-not-exist" });
    expect(res.status).toBe(404);
  });

  it("alice creates her server with a primary allocation", async () => {
    const res = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ name: "survival", blueprintSlug: "paper", eulaAccepted: true });
    expect(res.status).toBe(201);
    expect(res.body.server.status).toBe("ready");
    expect(res.body.server.primaryAllocation.port).toBeGreaterThanOrEqual(25565);
    aliceServerId = res.body.server.id as string;
  });

  it("quota stops alice at one server (409)", async () => {
    const res = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ name: "second", blueprintSlug: "paper", eulaAccepted: true });
    expect(res.status).toBe(409);
  });

  it("RAM and disk quotas count what you already run (409)", async () => {
    ctx.users.create({
      username: "dave",
      password: "dave-password-1",
      role: "user",
      quotas: { quota_max_servers: 5, quota_ram_mb: 1024, quota_disk_mb: 40_960 },
    });
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "dave", password: "dave-password-1" });
    const dave = login.body.token as string;

    const tooBig = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${dave}`)
      .send({ name: "big", blueprintSlug: "paper", memoryMb: 2048, eulaAccepted: true });
    expect(tooBig.status).toBe(409);

    const tooFat = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${dave}`)
      .send({ name: "fat", blueprintSlug: "paper", memoryMb: 512, diskQuotaMb: 50_000, eulaAccepted: true });
    expect(tooFat.status).toBe(409);

    const fits = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${dave}`)
      .send({ name: "small", blueprintSlug: "paper", memoryMb: 512, eulaAccepted: true });
    expect(fits.status).toBe(201);
  });

  it("alice cannot assign servers to other people (403)", async () => {
    const res = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ name: "sneaky", blueprintSlug: "paper", ownerUsername: "root", eulaAccepted: true });
    expect(res.status).toBe(403);
  });

  it("owner lists all servers; alice lists only hers", async () => {
    const all = await request(app)
      .get("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(1);

    const mine = await request(app)
      .get("/api/v3/servers")
      .set("authorization", `Bearer ${aliceToken}`);
    expect(mine.body.items.map((s: { id: string }) => s.id)).toEqual([aliceServerId]);
  });

  it("strangers get existence-hiding 404 on reads, 403 on writes", async () => {
    ctx.users.create({ username: "mallory", password: "mallory-pass", role: "user" });
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "mallory", password: "mallory-pass" });
    const mallory = login.body.token as string;

    const read = await request(app)
      .get(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${mallory}`);
    expect(read.status).toBe(404);

    const write = await request(app)
      .patch(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${mallory}`)
      .send({ name: "hijacked" });
    expect(write.status).toBe(403);
  });

  it("alice renames her server; blueprint stays immutable", async () => {
    const res = await request(app)
      .patch(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ name: "survival-2", blueprintSlug: "vanilla" });
    expect(res.status).toBe(200);
    expect(res.body.server.name).toBe("survival-2");
    expect(res.body.server.blueprintSlug).toBe("paper");
  });

  it("admin suspends and unsuspends; delete releases the server", async () => {
    const susp = await request(app)
      .post(`/api/v3/servers/${aliceServerId}/suspend`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(susp.status).toBe(204);

    const detail = await request(app)
      .get(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(detail.body.server.status).toBe("suspended");

    const unsusp = await request(app)
      .post(`/api/v3/servers/${aliceServerId}/unsuspend`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(unsusp.status).toBe(204);

    const unsuspAgain = await request(app)
      .post(`/api/v3/servers/${aliceServerId}/unsuspend`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(unsuspAgain.status).toBe(409);

    const delDenied = await request(app)
      .delete(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${aliceToken}`);
    expect(delDenied.status).toBe(403);

    const del = await request(app)
      .delete(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const gone = await request(app)
      .get(`/api/v3/servers/${aliceServerId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(gone.status).toBe(404);
  });

  it("audit trail records the server lifecycle", () => {
    const events = ctx.audit.query({ limit: 100 }).map((e) => e.event);
    for (const want of ["server.create", "server.update", "server.suspend", "server.delete"]) {
      expect(events).toContain(want);
    }
  });
});
