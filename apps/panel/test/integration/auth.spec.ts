import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";

let app: ReturnType<typeof buildPanel>["app"];
let ctx: ReturnType<typeof buildPanel>["ctx"];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "renom-auth-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;
});

afterAll(() => {
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth + users + authorization", () => {
  let ownerToken = "";

  it("boots with no users; login fails uniformly for unknown user (SEC-002)", async () => {
    const res = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "ghost", password: "whatever1" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("requires authentication for user creation (401 before validation)", async () => {
    const res0 = await request(app)
      .post("/api/v3/users")
      .set("authorization", "Bearer none")
      .send({ username: "someone11", password: "short" });
    expect(res0.status).toBe(401);
  });

  it("owner created via repo can log in (FR-006 seed path; case-insensitive username)", async () => {
    const owner = ctx.users.create({
      username: "root",
      password: "root-password-1",
      role: "owner",
    });
    expect(owner.role).toBe("owner");

    const res = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "ROOT", password: "root-password-1" });
    expect(res.status).toBe(200);
    ownerToken = res.body.token;
    expect(res.body.user.username).toBe("root");
  });

  it("rejects wrong password without revealing existence (FR-001)", async () => {
    const res = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("rate limits login to 5/min per ip+username (FR-010/SEC-013)", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v3/auth/login")
        .send({ username: "ratelimit-user", password: "nope-nope" });
    }
    const sixth = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "ratelimit-user", password: "nope-nope" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("rate_limited");
    expect(sixth.body.error.details.retryAfterSec).toBeGreaterThan(0);
  }, 30000);

  it("admin creates a regular user; quotas visible (FR-007/FR-008)", async () => {
    const res = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "alice", password: "alice-password", role: "user" });
    expect(res.status).toBe(201);
    expect(res.body.user.quotas.maxServers).toBeGreaterThan(0);
  });

  it("admin user detail exposes owned servers and can edit username", async () => {
    const created = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "zoe", password: "zoe-password-1", role: "user" });
    const userId = created.body.user.id as string;
    const server = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        name: "zoe-owned",
        blueprintSlug: "paper",
        ownerUsername: "zoe",
        eulaAccepted: true,
      });

    const detail = await request(app)
      .get(`/api/v3/users/${userId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.user.username).toBe("zoe");
    expect(detail.body.servers).toHaveLength(1);
    expect(detail.body.servers[0].ownerUsername).toBe("zoe");

    const renamed = await request(app)
      .patch(`/api/v3/users/${userId}`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "zoe-renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.user.username).toBe("zoe-renamed");
    expect(server.status).toBe(201);
  });

  it("users can update their display name and password through account", async () => {
    const created = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "account-user", password: "account-password-1" });
    const userId = created.body.user.id as string;
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "account-user", password: "account-password-1" });
    const token = login.body.token as string;
    const key = await request(app)
      .post("/api/v3/api-keys")
      .set("authorization", `Bearer ${token}`)
      .send({ memo: "account test", scopes: ["*"] });
    const denied = await request(app)
      .patch("/api/v3/account")
      .set("authorization", `Bearer ${key.body.token}`)
      .send({ displayName: "Should not work" });
    expect(denied.status).toBe(403);
    const updated = await request(app)
      .patch("/api/v3/account")
      .set("authorization", `Bearer ${token}`)
      .send({ displayName: "Account User", password: "account-password-2" });
    expect(updated.status).toBe(200);
    expect(updated.body.passwordChanged).toBe(true);

    const stale = await request(app).get("/api/v3/auth/me").set("authorization", `Bearer ${token}`);
    expect(stale.status).toBe(401);
    const fresh = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "account-user", password: "account-password-2" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.displayName).toBe("Account User");
    expect(userId).toBeTruthy();
  });

  it("owner can update user roles while admins cannot promote accounts", async () => {
    const aliceId = ctx.users.byUsername("alice")!.id;
    try {
      const aliceLogin = await request(app)
        .post("/api/v3/auth/login")
        .send({ username: "alice", password: "alice-password" });
      const staleAliceToken = aliceLogin.body.token as string;
      const promote = await request(app)
        .patch(`/api/v3/users/${aliceId}`)
        .set("authorization", `Bearer ${ownerToken}`)
        .send({ role: "admin" });
      expect(promote.status).toBe(200);
      expect(promote.body.user.role).toBe("admin");

      const stale = await request(app)
        .get("/api/v3/auth/me")
        .set("authorization", `Bearer ${staleAliceToken}`);
      expect(stale.status).toBe(401);
    } finally {
      const demote = await request(app)
        .patch(`/api/v3/users/${aliceId}`)
        .set("authorization", `Bearer ${ownerToken}`)
        .send({ role: "user" });
      expect(demote.status).toBe(200);
      expect(demote.body.user.role).toBe("user");
    }
  });

  it("admins manage users but cannot mint or touch other admins (owner-only)", async () => {
    const mkAdmin = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "carol", password: "carol-password-1", role: "admin" });
    expect(mkAdmin.status).toBe(201);
    const carolLogin = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "carol", password: "carol-password-1" });
    const carol = carolLogin.body.token as string;

    const mkAdmin2 = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${carol}`)
      .send({ username: "dave-admin", password: "dave-password-1", role: "admin" });
    expect(mkAdmin2.status).toBe(403);

    const mkUser = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${carol}`)
      .send({ username: "erin", password: "erin-password-1", role: "user" });
    expect(mkUser.status).toBe(201);

    const promote = await request(app)
      .patch(`/api/v3/users/${mkUser.body.user.id}`)
      .set("authorization", `Bearer ${carol}`)
      .send({ role: "admin" });
    expect(promote.status).toBe(403);
  });

  it("non-admin cannot create users or list them (PERMISSIONS matrix)", async () => {
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "alice", password: "alice-password" });
    const aliceToken = login.body.token as string;

    const create = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${aliceToken}`)
      .send({ username: "mallory", password: "mallory-pass", role: "admin" });
    expect(create.status).toBe(403);

    const list = await request(app)
      .get("/api/v3/users")
      .set("authorization", `Bearer ${aliceToken}`);
    expect(list.status).toBe(403);
  });

  it("password change bumps version and invalidates old JWTs (FR-009/SEC-014)", async () => {
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "alice", password: "alice-password" });
    const oldToken = login.body.token as string;

    // direct repo-level password change (profile UI route comes later)
    const aliceId = ctx.users.byUsername("alice")!.id;
    ctx.users.setPassword(aliceId, "new-alice-password-2");
    ctx.users.bumpPasswordVersion(aliceId);

    const stale = await request(app)
      .get("/api/v3/auth/me")
      .set("authorization", `Bearer ${oldToken}`);
    expect(stale.status).toBe(401);

    const fresh = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "alice", password: "new-alice-password-2" });
    expect(fresh.status).toBe(200);

    const me = await request(app)
      .get("/api/v3/auth/me")
      .set("authorization", `Bearer ${fresh.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe("alice");
  });

  it("suspended users cannot authenticate (FR-023 user-level)", async () => {
    const aliceId = ctx.users.byUsername("alice")!.id;
    ctx.users.setSuspended(aliceId, true);
    ctx.users.bumpPasswordVersion(aliceId);

    const res = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "alice", password: "new-alice-password-2" });
    expect(res.status).toBe(401);

    ctx.users.setSuspended(aliceId, false);
  });

  it("admin password resets rotate credentials immediately", async () => {
    const mk = await request(app)
      .post("/api/v3/users")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ username: "ivan", password: "ivan-password-1" });
    expect(mk.status).toBe(201);
    const ivanId = mk.body.user.id as string;

    const reset = await request(app)
      .patch(`/api/v3/users/${ivanId}`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ password: "rotated-password-9" });
    expect(reset.status).toBe(200);

    const oldLogin = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "ivan", password: "ivan-password-1" });
    expect(oldLogin.status).toBe(401);

    const fresh = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "ivan", password: "rotated-password-9" });
    expect(fresh.status).toBe(200);

    const events = ctx.audit.query({ limit: 100 }).map((e) => e.event);
    expect(events).toContain("user.password.change");
  });

  it("the owner account cannot be suspended (no lockout without recovery)", async () => {
    const rootId = ctx.users.byUsername("root")!.id;
    const res = await request(app)
      .patch(`/api/v3/users/${rootId}`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ suspended: true });
    expect(res.status).toBe(409);

    const stillIn = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "root-password-1" });
    expect(stillIn.status).toBe(200);
  });

  it("audit trail records login success/fail (SEC-012)", () => {
    const events = ctx.audit.query({ limit: 50 }).map((e) => e.event);
    expect(events).toContain("auth.login.success");
    expect(events).toContain("auth.login.fail");
  });

  it("unknown authenticated API route is structured 404", async () => {
    const res = await request(app)
      .get("/api/v3/definitely-not-a-route")
      .set("authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("unauthenticated access to protected surface returns 401", async () => {
    const res = await request(app).get("/api/v3/users");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});
