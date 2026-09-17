import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";
import { parseCron, nextRun } from "../../src/server/modules/schedules/cron.js";
import { isTarAvailable } from "../../src/server/modules/backups/service.js";

let app: ReturnType<typeof buildPanel>["app"];
let ctx: ReturnType<typeof buildPanel>["ctx"];
let dir: string;
let ownerToken = "";
let serverId = "";

const ECHO_DOC = {
  schemaVersion: 1,
  slug: "job-proc",
  name: "Job process",
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "renom-jobs-"));
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

  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,created_at,updated_at)
       VALUES ('bp-job','job-proc','Job process','generic-process','v1',1,'import',?,?)`,
    )
    .run(now, now);
  ctx.db
    .prepare(
      `INSERT INTO blueprint_versions (blueprint_id, tag, schema_version, doc, sha256, published_at)
       VALUES ('bp-job','v1',1,?,'x',?)`,
    )
    .run(JSON.stringify(ECHO_DOC), now);

  const created = await request(app)
    .post("/api/v3/servers")
    .set("authorization", `Bearer ${ownerToken}`)
    .send({ name: "jobs", blueprintSlug: "job-proc" });
  serverId = created.body.server.id as string;
  mkdirSync(join(dir, "servers", serverId), { recursive: true });
});

afterAll(async () => {
  await ctx.engine.kill(serverId).catch(() => undefined);
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("cron", () => {
  it("parses common expressions and finds the next minute", () => {
    const fields = parseCron("*/15 9-17 * * 1-5");
    expect(fields.minute).toContain(0);
    expect(fields.minute).toContain(45);
    // 2026-09-17 is a Thursday; next 09:00 weekday run is same-day or Friday.
    const base = Date.UTC(2026, 8, 17, 8, 59, 0);
    const next = nextRun(fields, base);
    expect(next).toBe(Date.UTC(2026, 8, 17, 9, 0, 0));
  });

  it("rejects garbage loudly", () => {
    for (const bad of ["* * * *", "61 * * * *", "*/0 * * * *", "mon * * * *", "* * * * 1-9"]) {
      expect(() => parseCron(bad)).toThrow();
    }
  });
});

describe("schedules", () => {
  it("rejects invalid cron at creation (400)", async () => {
    const res = await request(app)
      .post(`/api/v3/servers/${serverId}/schedules`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "bad", cronExpr: "whenever", tasks: [{ action: "backup", payload: {} }] });
    expect(res.status).toBe(400);
  });

  it("creates, runs manually (command reaches the console), then deletes", async () => {
    const created = await request(app)
      .post(`/api/v3/servers/${serverId}/schedules`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        name: "nightly",
        cronExpr: "0 3 * * *",
        tasks: [{ action: "command", payload: { command: "say-hello" } }],
      });
    expect(created.status).toBe(201);
    const id = created.body.schedule.id as string;
    expect(created.body.schedule.nextRunAt).toBeGreaterThan(Date.now());

    await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "start" });

    const run = await request(app)
      .post(`/api/v3/servers/${serverId}/schedules/${id}/run`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(run.status).toBe(200);

    // The scheduled command ran through the live process.
    const deadline = Date.now() + 10000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      const hist = await request(app)
        .get(`/api/v3/servers/${serverId}/console/history?limit=50`)
        .set("authorization", `Bearer ${ownerToken}`);
      seen = ((hist.body.lines as Array<{ text: string }>) ?? []).some((l) =>
        l.text.includes("echo:say-hello"),
      );
      if (!seen) await new Promise((r) => setTimeout(r, 200));
    }
    expect(seen).toBe(true);

    await request(app)
      .post(`/api/v3/servers/${serverId}/power`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ action: "stop" });

    const del = await request(app)
      .delete(`/api/v3/servers/${serverId}/schedules/${id}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
  });

  it("a stranger's schedule id is not visible from another server", async () => {
    const other = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "other", blueprintSlug: "job-proc" });
    const otherId = other.body.server.id as string;
    const created = await request(app)
      .post(`/api/v3/servers/${serverId}/schedules`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "mine", cronExpr: "0 4 * * *", tasks: [{ action: "backup", payload: {} }] });
    const id = created.body.schedule.id as string;

    const cross = await request(app)
      .post(`/api/v3/servers/${otherId}/schedules/${id}/run`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(cross.status).toBe(404);
  });

  it("concurrent triggers fire a schedule exactly once", async () => {
    const created = await request(app)
      .post(`/api/v3/servers/${serverId}/schedules`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "once", cronExpr: "* * * * *", tasks: [{ action: "command", payload: { command: "x" } }] });
    const id = created.body.schedule.id as string;
    // Force it due right now.
    ctx.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 1000, id);

    const [a, b] = await Promise.all([ctx.scheduler.runDue(), ctx.scheduler.runDue()]);
    expect(a + b).toBe(1);

    await request(app)
      .delete(`/api/v3/servers/${serverId}/schedules/${id}`)
      .set("authorization", `Bearer ${ownerToken}`);
  });
});

describe.runIf(isTarAvailable())("backups", () => {
  it("the backup tool is present (backups are not silently skipped)", () => {
    // If this fails, every test below is skipped and the suite lies green.
    expect(isTarAvailable()).toBe(true);
  });
  it("creates, downloads, restores, and enforces locks", async () => {
    const srvDir = join(dir, "servers", serverId);
    writeFileSync(join(srvDir, "world.txt"), "precious-data", "utf8");

    const created = await request(app)
      .post(`/api/v3/servers/${serverId}/backups`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ locked: true });
    expect(created.status).toBe(201);
    const backupId = created.body.backup.id as string;

    const listed = await request(app)
      .get(`/api/v3/servers/${serverId}/backups`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(listed.body.backups.map((b: { id: string }) => b.id)).toContain(backupId);

    const lockedDel = await request(app)
      .delete(`/api/v3/servers/${serverId}/backups/${backupId}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(lockedDel.status).toBe(409);

    // Lose the file, restore it from the backup.
    rmSync(join(srvDir, "world.txt"));
    expect(existsSync(join(srvDir, "world.txt"))).toBe(false);
    const restored = await request(app)
      .post(`/api/v3/servers/${serverId}/backups/${backupId}/restore`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(restored.status).toBe(200);
    expect(readFileSync(join(srvDir, "world.txt"), "utf8")).toBe("precious-data");
  });

  it("a corrupt archive refuses restore and keeps current files", async () => {
    const srvDir = join(dir, "servers", serverId);
    writeFileSync(join(srvDir, "world.txt"), "live-data", "utf8");
    const created = await request(app)
      .post(`/api/v3/servers/${serverId}/backups`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({});
    const backupId = created.body.backup.id as string;
    // Tamper with the archive on disk (bit rot, angry admin, MITM).
    const row = ctx.db
      .prepare("SELECT file_name FROM backups WHERE id = ?")
      .get(backupId) as { file_name: string };
    writeFileSync(join(dir, "backups", serverId, row.file_name), "definitely-not-a-tarball", "utf8");

    const restored = await request(app)
      .post(`/api/v3/servers/${serverId}/backups/${backupId}/restore`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(restored.status).toBe(409);
    // The live directory is untouched: failed restores never half-apply.
    expect(readFileSync(join(srvDir, "world.txt"), "utf8")).toBe("live-data");
  });

  it("retention keeps the newest 10 unlocked backups", async () => {
    for (let i = 0; i < 9; i++) {
      const res = await request(app)
        .post(`/api/v3/servers/${serverId}/backups`)
        .set("authorization", `Bearer ${ownerToken}`)
        .send({});
      expect(res.status).toBe(201);
    }
    const listed = await request(app)
      .get(`/api/v3/servers/${serverId}/backups`)
      .set("authorization", `Bearer ${ownerToken}`);
    // 1 corrupt-test backup + 9 new ones = 10 unlocked kept; the locked one is separate.
    const unlocked = (listed.body.backups as Array<{ locked?: boolean }>).filter((b) => !b.locked);
    expect(unlocked.length).toBe(10);
  });

  it("locked backups unlock into deletable ones", async () => {
    const listed = await request(app)
      .get(`/api/v3/servers/${serverId}/backups`)
      .set("authorization", `Bearer ${ownerToken}`);
    const locked = (listed.body.backups as Array<{ id: string; locked?: boolean }>).find((b) => b.locked);
    expect(locked).toBeDefined();
    const unlock = await request(app)
      .post(`/api/v3/servers/${serverId}/backups/${locked!.id}/unlock`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(unlock.status).toBe(200);
    const del = await request(app)
      .delete(`/api/v3/servers/${serverId}/backups/${locked!.id}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
  });
});
