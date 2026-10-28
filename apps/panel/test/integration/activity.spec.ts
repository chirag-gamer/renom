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

    // The permitted path matters as much as the denial: a wiring regression
    // that 403s everyone would pass the assertion above. Re-grant with the
    // permission and prove the same call now succeeds.
    const regrant = await request(app)
      .delete(`/api/v3/servers/${serverId}/users/${ctx.users.byUsername("bob")!.id}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(regrant.status).toBe(204);
    const grant2 = await request(app)
      .post(`/api/v3/servers/${serverId}/users`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "bob", permissions: ["activity.read"] });
    expect(grant2.status).toBe(201);

    const allowed = await request(app)
      .get(`/api/v3/servers/${serverId}/activity`)
      .set("authorization", `Bearer ${limitedToken}`);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.items)).toBe(true);
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

  it("walks a page boundary with nextCursor without repeating or skipping rows", async () => {
    // Enough rows that limit=2 cannot cover them, so nextCursor is real.
    for (let i = 0; i < 5; i += 1) {
      ctx.audit.record({ event: `test.page.${i}`, serverId, target: { i } });
    }

    const first = await request(app)
      .get(`/api/v3/servers/${serverId}/activity?limit=2`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(first.status).toBe(200);
    const page1 = first.body.items as Array<{ id: string }>;
    expect(page1).toHaveLength(2);
    expect(first.body.nextCursor).toBe(page1[1]!.id);

    const second = await request(app)
      .get(`/api/v3/servers/${serverId}/activity?limit=2&before=${first.body.nextCursor}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(second.status).toBe(200);
    const page2 = second.body.items as Array<{ id: string }>;
    expect(page2).toHaveLength(2);
    // No row may appear on both pages, and page 2 must continue below page 1.
    const firstIds = new Set(page1.map((item) => item.id));
    for (const item of page2) expect(firstIds.has(item.id)).toBe(false);
    expect(page2[0]!.id < page1[1]!.id).toBe(true);
    // Two pages of two cover exactly the seeded window, no row twice.
    const walked = [...page1, ...page2];
    expect(new Set(walked.map((i) => i.id)).size).toBe(walked.length);
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
