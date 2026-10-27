import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Express } from "express";
import { buildPanel, type PanelContext } from "../../src/server/index.js";

let app: Express;
let ctx: PanelContext;
let dir: string;
let ownerToken = "";
let limitedToken = "";
let serverId = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "renom-activity-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;

  ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
  ctx.users.create({ username: "bob", password: "bob-password", role: "user" });

  ownerToken = (
    await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "root-password-1" })
  ).body.token as string;
  limitedToken = (
    await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "bob", password: "bob-password" })
  ).body.token as string;

  const srv = await request(app)
    .post("/api/v3/servers")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ name: "audited", blueprintSlug: "paper", eulaAccepted: true });
  expect(srv.status).toBe(201);
  serverId = srv.body.server.id as string;
});

afterAll(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /servers/:id/activity", () => {
  it("403s a collaborator without activity.read", async () => {
    const grant = await request(app)
      .post(`/api/v3/servers/${serverId}/users`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "bob", permissions: ["control.console", "file.read"] });
    expect(grant.status).toBe(201);

    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/activity`)
      .set("authorization", `Bearer ${limitedToken}`);
    expect(res.status).toBe(403);
  });

  it("returns seeded rows newest-first with the actor resolved", async () => {
    const rootId = ctx.users.byUsername("root")!.id;
    // Seeded directly rather than via real mutations: creation rows carry no
    // actor here would otherwise own the top of the feed and make the order
    // assertion prove nothing about the new method.
    const first = ctx.audit.record({
      event: "file.write",
      actorUserId: rootId,
      serverId,
      target: { path: "a.txt" },
    });
    const second = ctx.audit.record({
      event: "server.properties.update",
      actorUserId: rootId,
      serverId,
      target: { keys: ["motd"] },
    });

    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/activity`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      id: string;
      event: string;
      actorUsername: string | null;
      target: Record<string, unknown>;
    }>;
    expect(items[0]!.id).toBe(second);
    expect(items[1]!.id).toBe(first);
    // The users join resolves the display name; ULID ids are seeded rows, so
    // these two sit above the server-creation rows from beforeAll.
    expect(items[0]!.actorUsername).toBe("root");
    expect(items[0]!.event).toBe("server.properties.update");
    expect(items[0]!.target).toEqual({ keys: ["motd"] });
  });

  it("pages older rows with the exclusive before cursor", async () => {
    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/activity`)
      .set("authorization", `Bearer ${ownerToken}`);
    const items = res.body.items as Array<{ id: string }>;
    const cursor = items[0]!.id;

    const older = await request(app)
      .get(`/api/v3/servers/${serverId}/activity?before=${cursor}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(older.status).toBe(200);
    const olderItems = older.body.items as Array<{ id: string }>;
    for (const item of olderItems) expect(item.id < cursor).toBe(true);
    // The row at the cursor itself must not repeat on the next page.
    expect(olderItems.some((item) => item.id === cursor)).toBe(false);
  });

  it("renders null-actor rows with a resolvable system attribution", async () => {
    ctx.audit.record({ event: "server.install.start", serverId, target: {} });
    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/activity`)
      .set("authorization", `Bearer ${ownerToken}`);
    const items = res.body.items as Array<{
      event: string;
      actorUserId: string | null;
      actorUsername: string | null;
    }>;
    const system = items.find((item) => item.event === "server.install.start");
    expect(system).toBeDefined();
    expect(system!.actorUserId).toBeNull();
    expect(system!.actorUsername).toBeNull();
  });
});
