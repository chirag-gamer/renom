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
    const res = await request(app).get("/socket.io/socket.io.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("socket.io");
  });
});
