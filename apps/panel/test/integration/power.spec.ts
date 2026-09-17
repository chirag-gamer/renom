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
let serverId = "";

const ECHO_DOC = {
  schemaVersion: 1,
  slug: "test-proc",
  name: "Test process",
  category: "generic-process",
  tag: "v1",
  requirements: { engine: "process", arch: ["amd64", "arm64"], hostOs: ["linux", "windows"] },
  image: "none",
  install: [],
  run: {
    command: ["node", "-e", "process.stdin.on('data',(d)=>process.stdout.write('echo:'+d))"],
    workdir: "/data",
    stop: { kind: "signal", signal: "SIGTERM", timeoutSec: 5 },
  },
  variables: [],
};

function seedTestBlueprint(): void {
  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,created_at,updated_at)
       VALUES ('bp-test-proc','test-proc','Test process','generic-process','v1',1,'import',?,?)`,
    )
    .run(now, now);
  const doc = JSON.stringify(ECHO_DOC);
  ctx.db
    .prepare(
      `INSERT INTO blueprint_versions (blueprint_id, tag, schema_version, doc, sha256, published_at)
       VALUES ('bp-test-proc','v1',1,?,'test',?)`,
    )
    .run(doc, now);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "renom-power-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  app = panel.app;
  ctx = panel.ctx;

  ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
  ownerToken = (
    await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "root-password-1" })
  ).body.token as string;

  seedTestBlueprint();
  const created = await request(app)
    .post("/api/v3/servers")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ name: "echo", blueprintSlug: "test-proc" });
  expect(created.status).toBe(201);
  serverId = created.body.server.id as string;
});

afterAll(async () => {
  await ctx.engine.kill(serverId).catch(() => undefined);
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitForHistory(match: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/console/history?limit=200`)
      .set("authorization", `Bearer ${ownerToken}`);
    const lines = (res.body.lines as Array<{ text: string }>) ?? [];
    if (lines.some((l) => l.text.includes(match))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("power + console", () => {
  it("docker blueprints refuse honestly on a process-only node (409)", async () => {
    const created = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "modded", blueprintSlug: "fabric", eulaAccepted: true });
    expect(created.status).toBe(201);
    const id = created.body.server.id as string;

    const start = await request(app)
      .post(`/api/v3/servers/${id}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "start" });
    expect(start.status).toBe(409);
    expect(String(start.body.error.message)).toContain("Docker");
  });

  it("start runs the process; console streams and accepts input", async () => {
    const start = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "start" });
    expect(start.status).toBe(200);
    expect(start.body.state).toBe("running");

    expect(await waitForHistory("process started")).toBe(true);

    const send = await request(app)
      .post(`/api/v3/servers/${serverId}/console/send`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ command: "hello-panel" });
    expect(send.body.accepted).toBe(true);
    expect(await waitForHistory("echo:hello-panel")).toBe(true);
  });

  it("stop is graceful and idempotent; restart cycles", async () => {
    const stop = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "stop" });
    expect(stop.status).toBe(200);
    expect(stop.body.state).toBe("offline");

    const stopAgain = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "stop" });
    expect(stopAgain.status).toBe(200);

    const restart = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "restart" });
    expect(restart.body.state).toBe("running");
    expect(await waitForHistory("process started")).toBe(true);
  });

  it("kill ends the process; suspended servers refuse power", async () => {
    const kill = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "kill" });
    expect(kill.status).toBe(200);
    expect(kill.body.state).toBe("offline");

    await request(app)
      .post(`/api/v3/servers/${serverId}/suspend`)
      .set("authorization", `Bearer ${ownerToken}`);
    const start = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "start" });
    expect(start.status).toBe(403);
    await request(app)
      .post(`/api/v3/servers/${serverId}/unsuspend`)
      .set("authorization", `Bearer ${ownerToken}`);
  });

  it("tenant isolation: subuser without control.start cannot start", async () => {
    ctx.users.create({ username: "bob", password: "bob-password-1", role: "user" });
    const login = await request(app)
      .post("/api/v3/auth/login")
      .send({ username: "bob", password: "bob-password-1" });
    const bob = login.body.token as string;
    const bobRow = ctx.users.byUsername("bob")!;
    const rootRow = ctx.users.byUsername("root")!;
    ctx.db
      .prepare(
        "INSERT INTO subusers (user_id, server_id, permissions_json, granted_by, created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        bobRow.id,
        serverId,
        JSON.stringify(["websocket.connect", "control.console"]),
        rootRow.id,
        Date.now(),
      );

    const start = await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${bob}`)
      .send({ action: "start" });
    expect(start.status).toBe(403);

    const history = await request(app)
      .get(`/api/v3/servers/${serverId}/console/history`)
      .set("authorization", `Bearer ${bob}`);
    expect(history.status).toBe(200);
  });
});
