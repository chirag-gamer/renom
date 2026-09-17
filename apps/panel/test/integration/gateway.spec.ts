import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { io, type Socket } from "socket.io-client";
import { buildPanel } from "../../src/server/index.js";

let ctx: ReturnType<typeof buildPanel>["ctx"];
let server: ReturnType<typeof buildPanel>["server"];
let dir: string;
let port = 0;
let ownerToken = "";
let serverId = "";

const ECHO_DOC = {
  schemaVersion: 1,
  slug: "sock-proc",
  name: "Socket process",
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
  dir = mkdtempSync(join(tmpdir(), "renom-sock-"));
  const panel = buildPanel({
    NODE_ENV: "test",
    DATA_DIR: dir,
    LOG_LEVEL: "error",
    BCRYPT_COST: 10,
  } as NodeJS.ProcessEnv);
  ctx = panel.ctx;
  server = panel.server;

  ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
  // token via engine-level login path: use the service through a stub HTTP call
  const { default: request } = await import("supertest");
  ownerToken = (
    await request(panel.app)
      .post("/api/v3/auth/login")
      .send({ username: "root", password: "root-password-1" })
  ).body.token as string;

  const now = Date.now();
  ctx.db
    .prepare(
      `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,created_at,updated_at)
       VALUES ('bp-sock','sock-proc','Socket process','generic-process','v1',1,'import',?,?)`,
    )
    .run(now, now);
  ctx.db
    .prepare(
      `INSERT INTO blueprint_versions (blueprint_id, tag, schema_version, doc, sha256, published_at)
       VALUES ('bp-sock','v1',1,?,'x',?)`,
    )
    .run(JSON.stringify(ECHO_DOC), now);

  const created = ctx.servers.create({
    name: "sock",
    description: "",
    ownerId: ctx.users.byUsername("root")!.id,
    blueprintId: "bp-sock",
    versionTag: "v1",
    imageRef: "none",
    memoryMb: 512,
    diskQuotaMb: 1024,
  });
  serverId = created.id;

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await ctx.engine.kill(serverId).catch(() => undefined);
  server.close();
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function connect(token?: string): Socket {
  return io(`http://127.0.0.1:${port}`, {
    path: "/socket.io/",
    auth: token ? { token } : {},
    reconnection: false,
    timeout: 5000,
  });
}

describe("console gateway", () => {
  it("refuses sockets without a token", async () => {
    const socket = connect();
    const err = await new Promise<Error>((resolve) => socket.on("connect_error", resolve));
    expect(err.message).toBe("unauthorized");
    socket.close();
  });

  it("joins, streams live output, and sends input with ack", async () => {
    await ctx.engine.start(serverId);
    const socket = connect(ownerToken);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));

    const joined = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit("console:join", serverId, resolve),
    );
    expect(joined.ok).toBe(true);

    const linePromise = new Promise<{ v: number; line: { text: string } }>((resolve) =>
      socket.on("console:line", resolve),
    );
    const sent = await new Promise<{ accepted: boolean }>((resolve) =>
      socket.emit("console:send", { serverId, command: "ping-sock" }, resolve),
    );
    expect(sent.accepted).toBe(true);
    const line = await linePromise;
    expect(line.v).toBe(1);
    expect(line.line.text).toContain("echo:ping-sock");
    socket.close();
    await ctx.engine.stop(serverId);
  });

  it("returns not-found for unknown server ids (no id oracle)", async () => {
    ctx.users.create({ username: "mallory", password: "mallory-pass", role: "user" });
    const socket = connect(ownerToken);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    const joined = await new Promise<{ ok: boolean; reason?: string }>((resolve) =>
      socket.emit("console:join", "no-such-server", resolve),
    );
    expect(joined.ok).toBe(false);
    expect(joined.reason).toBe("not found");
    socket.close();
  });

  it("a stranger cannot join someone else's live server", async () => {
    const { default: request } = await import("supertest");
    const login = await request(`http://127.0.0.1:${port}`)
      .post("/api/v3/auth/login")
      .send({ username: "mallory", password: "mallory-pass" });
    const malloryToken = login.body.token as string;

    const socket = connect(malloryToken);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    const joined = await new Promise<{ ok: boolean; reason?: string }>((resolve) =>
      socket.emit("console:join", serverId, resolve),
    );
    expect(joined.ok).toBe(false);
    expect(joined.reason).toBe("not found");
    socket.close();
  });

  it("a granted subuser joins; revocation cuts the live stream", async () => {
    const { default: request } = await import("supertest");
    const api = request(`http://127.0.0.1:${port}`);
    const mallory = (
      await api.post("/api/v3/auth/login").send({ username: "mallory", password: "mallory-pass" })
    ).body.token as string;
    const rootRow = ctx.users.byUsername("root")!;
    const malloryRow = ctx.users.byUsername("mallory")!;
    ctx.db
      .prepare(
        "INSERT INTO subusers (user_id, server_id, permissions_json, granted_by, created_at) VALUES (?,?,?,?,?)",
      )
      .run(malloryRow.id, serverId, JSON.stringify(["websocket.connect"]), rootRow.id, Date.now());

    await ctx.engine.start(serverId);
    const socket = connect(mallory);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    const joined = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit("console:join", serverId, resolve),
    );
    expect(joined.ok).toBe(true);

    const revoked = new Promise<{ serverId: string }>((resolve) =>
      socket.on("console:revoked", resolve),
    );
    // Owner removes the grant through the real route (which sweeps sockets).
    await api
      .delete(`/api/v3/servers/${serverId}/users/${malloryRow.id}`)
      .set("authorization", `Bearer ${ownerToken}`)
      .expect(204);
    const notice = await revoked;
    expect(notice.serverId).toBe(serverId);

    const rejoined = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit("console:join", serverId, resolve),
    );
    expect(rejoined.ok).toBe(false);
    socket.close();
    await ctx.engine.stop(serverId).catch(() => undefined);
  });
});
