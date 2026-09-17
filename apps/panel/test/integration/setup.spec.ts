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
  dir = mkdtempSync(join(tmpdir(), "renom-setup-"));
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

describe("first-run setup", () => {
  it("reports needsSetup on a fresh database", async () => {
    const res = await request(app).get("/api/v3/setup/status");
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  it("rejects a weak owner password", async () => {
    const res = await request(app)
      .post("/api/v3/setup/admin")
      .send({ username: "admin", password: "short" });
    expect(res.status).toBe(400);
  });

  it("creates the owner, then closes the setup door behind it", async () => {
    const created = await request(app)
      .post("/api/v3/setup/admin")
      .send({ username: "admin", password: "a-long-admin-password-1" });
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe("owner");

    const status = await request(app).get("/api/v3/setup/status");
    expect(status.body.needsSetup).toBe(false);

    const second = await request(app)
      .post("/api/v3/setup/admin")
      .send({ username: "intruder", password: "another-long-password-2" });
    expect(second.status).toBe(409);

    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "admin", password: "a-long-admin-password-1" });
    expect(login.status).toBe(200);
  });

  it("serves the web client shell", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Renom");
    expect(res.text).toContain("/socket.io/socket.io.js");
  });

  it("serves the socket.io client for the live console", async () => {
    // Socket.IO owns its client bundle on the real HTTP server (supertest
    // bypasses it), so bind ephemerally and fetch the genuine artifact.
    const panel2 = buildPanel({
      NODE_ENV: "test",
      DATA_DIR: dir,
      LOG_LEVEL: "error",
      BCRYPT_COST: 10,
    } as NodeJS.ProcessEnv);
    await new Promise<void>((resolve) => panel2.server.listen(0, "127.0.0.1", () => resolve()));
    const port = (panel2.server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/socket.io/socket.io.js`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("socket.io");
    } finally {
      panel2.server.close();
      panel2.ctx.db.close();
    }
  });
});

describe("setup token gate", () => {
  let app2: ReturnType<typeof buildPanel>["app"];
  let ctx2: ReturnType<typeof buildPanel>["ctx"];
  let dir2: string;

  beforeAll(() => {
    dir2 = mkdtempSync(join(tmpdir(), "renom-setup-token-"));
    const panel = buildPanel({
      NODE_ENV: "test",
      DATA_DIR: dir2,
      LOG_LEVEL: "error",
      BCRYPT_COST: 10,
      SETUP_TOKEN: "one-time-secret",
    } as NodeJS.ProcessEnv);
    app2 = panel.app;
    ctx2 = panel.ctx;
  });

  afterAll(() => {
    ctx2.db.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("advertises that a token is required", async () => {
    const res = await request(app2).get("/api/v3/setup/status");
    expect(res.body.needsSetup).toBe(true);
    expect(res.body.tokenRequired).toBe(true);
  });

  it("refuses owner claim without the token (403), accepts with it", async () => {
    const denied = await request(app2)
      .post("/api/v3/setup/admin")
      .send({ username: "admin", password: "a-long-admin-password-1" });
    expect(denied.status).toBe(403);

    const created = await request(app2)
      .post("/api/v3/setup/admin")
      .set("x-setup-token", "one-time-secret")
      .send({ username: "admin", password: "a-long-admin-password-1" });
    expect(created.status).toBe(201);
  });
});
