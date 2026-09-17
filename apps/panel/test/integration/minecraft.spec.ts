import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";
import { runInstallOps } from "../../src/server/modules/runtime/install.js";
import {
  parsePublicAddress,
  scanHistoryForAddress,
  endpointValid,
} from "../../src/server/modules/tunnels/minekube.js";

const JAR_BYTES = Buffer.from("fake-jar-bytes-for-tests");
const JAR_SHA256 = createHash("sha256").update(JAR_BYTES).digest("hex");

function stubFetch(
  routes: Record<string, { status?: number; json?: unknown; bytes?: Buffer }>,
): typeof fetch {
  // Longest prefix first: "/versions" must not swallow "/versions/1.21.1/builds".
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (async (url: unknown) => {
    const u = String(url);
    for (const [prefix, route] of ordered) {
      if (u.startsWith(prefix)) {
        if (route.bytes) {
          return new Response(route.bytes as unknown as BodyInit, { status: route.status ?? 200 });
        }
        return Response.json(route.json ?? {}, { status: route.status ?? 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const PAPER_ROUTES = {
  "https://fill.papermc.io/v3/projects/paper/versions": {
    json: { versions: [{ version: { id: "1.21.1" }, support: { status: "SUPPORTED" } }] },
  },
  "https://fill.papermc.io/v3/projects/paper/versions/1.21.1/builds": {
    json: [
      {
        channel: "STABLE",
        downloads: {
          "server:default": {
            url: "https://fill-data.papermc.io/v1/paper.jar",
            checksums: { sha256: JAR_SHA256 },
          },
        },
      },
    ],
  },
  "https://fill-data.papermc.io/v1/paper.jar": { bytes: JAR_BYTES },
};

describe("install executor", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "renom-install-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches paper with checksum verification", async () => {
    const srv = join(dir, "paper");
    mkdirSync(srv, { recursive: true });
    await runInstallOps(
      {
        install: [{ op: "fetch-paper", version: "1.21.1" }],
      } as never,
      { serverId: "x", dir: srv, vars: {}, fetchImpl: stubFetch(PAPER_ROUTES) },
    );
    expect(readFileSync(join(srv, "paper.jar"))).toEqual(JAR_BYTES);
  });

  it("refuses a corrupt jar (checksum mismatch)", async () => {
    const srv = join(dir, "corrupt");
    mkdirSync(srv, { recursive: true });
    const bad = {
      ...PAPER_ROUTES,
      "https://fill-data.papermc.io/v1/paper.jar": { bytes: Buffer.from("tampered") },
    };
    await expect(
      runInstallOps({ install: [{ op: "fetch-paper", version: "1.21.1" }] } as never, {
        serverId: "x",
        dir: srv,
        vars: {},
        fetchImpl: stubFetch(bad),
      }),
    ).rejects.toThrow(/Checksum mismatch/);
    expect(existsSync(join(srv, "paper.jar"))).toBe(false);
  });

  it("writes files with substitution, accepts the EULA, confines paths", async () => {
    const srv = join(dir, "files");
    mkdirSync(srv, { recursive: true });
    await runInstallOps(
      {
        install: [
          { op: "mkdir", path: "plugins" },
          { op: "writefile", path: "server.properties", contentTemplate: "motd={MOTD}\n" },
          { op: "eula-accept" },
        ],
      } as never,
      { serverId: "x", dir: srv, vars: { MOTD: "hi" }, fetchImpl: stubFetch({}) },
    );
    expect(readFileSync(join(srv, "server.properties"), "utf8")).toBe("motd=hi\n");
    expect(readFileSync(join(srv, "eula.txt"), "utf8")).toContain("eula=true");
  });

  it("installs Modrinth addons with checksum verification", async () => {
    const addonBytes = Buffer.from("fake-addon-jar");
    const addonSha512 = createHash("sha512").update(addonBytes).digest("hex");
    const fetchImpl = stubFetch({
      "https://api.modrinth.com/v2/project/lithium/version": {
        json: [
          {
            files: [
              {
                url: "https://cdn.modrinth.com/lithium.jar",
                filename: "lithium.jar",
                hashes: { sha512: addonSha512 },
                primary: true,
              },
            ],
          },
        ],
      },
      "https://cdn.modrinth.com/lithium.jar": { bytes: addonBytes },
    });
    const srv = join(dir, "addons");
    mkdirSync(srv, { recursive: true });
    await runInstallOps({ install: [{ op: "modrinth-install", projects: ["lithium"] }] } as never, {
      serverId: "x",
      dir: srv,
      vars: { mcVersion: "1.21.1" },
      blueprintSlug: "fabric",
      fetchImpl,
    });
    expect(readFileSync(join(srv, "mods", "lithium.jar"))).toEqual(addonBytes);
  });

  it("refuses Modrinth on vanilla (no mod platform)", async () => {
    const srv = join(dir, "addons-vanilla");
    mkdirSync(srv, { recursive: true });
    await expect(
      runInstallOps({ install: [{ op: "modrinth-install", projects: ["lithium"] }] } as never, {
        serverId: "x",
        dir: srv,
        vars: { mcVersion: "1.21.1" },
        blueprintSlug: "vanilla",
        fetchImpl: stubFetch({}),
      }),
    ).rejects.toThrow(/not supported/);
  });

  it("refuses escaping paths and unwired ops", async () => {
    const srv = join(dir, "escape");
    mkdirSync(srv, { recursive: true });
    await expect(
      runInstallOps(
        { install: [{ op: "writefile", path: "../../evil", contentTemplate: "x" }] } as never,
        {
          serverId: "x",
          dir: srv,
          vars: {},
          fetchImpl: stubFetch({}),
        },
      ),
    ).rejects.toThrow(/escapes/);
    await expect(
      runInstallOps({ install: [{ op: "fetch-fabric", mcVersion: "1.21.1" }] } as never, {
        serverId: "x",
        dir: srv,
        vars: {},
        fetchImpl: stubFetch({}),
      }),
    ).rejects.toThrow(/not wired yet/);
  });
});

describe("minekube address scraping", () => {
  it("parses the documented console lines", () => {
    expect(parsePublicAddress("[connect] Your public address: live-beru.play.minekube.net")).toBe(
      "live-beru.play.minekube.net",
    );
    expect(parsePublicAddress("[connect] Enpoint name: live-beru")).toBe(null);
    expect(parsePublicAddress('Done (1.23s)! For help, type "help"')).toBe(null);
    expect(
      scanHistoryForAddress([
        { text: "a" },
        { text: "[connect] Your public address: one.play.minekube.net" },
        { text: "b" },
      ]),
    ).toBe("one.play.minekube.net");
  });

  it("validates endpoint names", () => {
    expect(endpointValid("my-server-1")).toBe(true);
    expect(endpointValid("UPPER")).toBe(false);
    expect(endpointValid("a")).toBe(false);
    expect(endpointValid("has space")).toBe(false);
  });
});

describe("EULA gate + variables + tunnel API", () => {
  let app: ReturnType<typeof buildPanel>["app"];
  let ctx: ReturnType<typeof buildPanel>["ctx"];
  let dir: string;
  let ownerToken = "";
  let serverId = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "renom-mc-"));
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
  });

  afterAll(() => {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses paper creation without EULA acceptance (400)", async () => {
    const res = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "mc", blueprintSlug: "paper" });
    expect(res.status).toBe(400);
  });

  it("creates with EULA, exposes variables, validates updates", async () => {
    const created = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "mc", blueprintSlug: "paper", eulaAccepted: true });
    expect(created.status).toBe(201);
    serverId = created.body.server.id as string;

    const vars = await request(app)
      .get(`/api/v3/servers/${serverId}/variables`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(vars.status).toBe(200);
    expect(vars.body.variables.map((v: { key: string }) => v.key)).toContain("MOTD");

    const badKey = await request(app)
      .put(`/api/v3/servers/${serverId}/variables`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { nope: "x" } });
    expect(badKey.status).toBe(400);

    const internal = await request(app)
      .put(`/api/v3/servers/${serverId}/variables`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { initMemory: 9999 } });
    expect(internal.status).toBe(403);

    const good = await request(app)
      .put(`/api/v3/servers/${serverId}/variables`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { MOTD: "hello world" } });
    expect(good.status).toBe(200);

    const again = await request(app)
      .get(`/api/v3/servers/${serverId}/variables`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(again.body.variables.find((v: { key: string }) => v.key === "MOTD").value).toBe(
      "hello world",
    );
  });

  it("tunnel endpoints validate and report no address before boot", async () => {
    const bad = await request(app)
      .post(`/api/v3/servers/${serverId}/tunnel`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ endpoint: "UPPER" });
    expect(bad.status).toBe(400);

    const before = await request(app)
      .get(`/api/v3/servers/${serverId}/tunnel`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(before.body).toEqual({ provider: null, endpoint: null, address: null });
  });

  it("Minekube refuses Bedrock servers with directions", async () => {
    const catalog = await request(app)
      .get("/api/v3/blueprints")
      .set("authorization", `Bearer ${ownerToken}`);
    const bds = (catalog.body.items as Array<{ slug: string; maturity: string }>).find(
      (b) => b.slug === "bedrock-bds",
    );
    expect(bds?.maturity).toBe("experimental");
    const paper = (catalog.body.items as Array<{ slug: string; maturity: string }>).find(
      (b) => b.slug === "paper",
    );
    expect(paper?.maturity).toBe("stable");

    const created = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "bedrock-one", blueprintSlug: "bedrock-bds" });
    expect(created.status).toBe(201);
    const bid = created.body.server.id as string;

    const tunnel = await request(app)
      .post(`/api/v3/servers/${bid}/tunnel`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ endpoint: "bedrock-one" });
    expect(tunnel.status).toBe(409);
    expect(String(tunnel.body.error.message)).toContain("docs/tunnels.md");
  });

  it("version change is a variable edit + reinstall (mechanics)", async () => {
    // Point at an exact version, then reinstall. Fabric's fetcher is unwired,
    // so the endpoint fails closed with 409 — proving the flow reaches the
    // installer with the edited variables instead of silently succeeding.
    const fabric = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "modded", blueprintSlug: "fabric", eulaAccepted: true });
    expect(fabric.status).toBe(201);
    const fid = fabric.body.server.id as string;

    const set = await request(app)
      .put(`/api/v3/servers/${fid}/variables`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ values: { mcVersion: "1.21.1" } });
    expect(set.status).toBe(200);

    const reinstall = await request(app)
      .post(`/api/v3/servers/${fid}/install`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(reinstall.status).toBe(409);

    const failed = await request(app)
      .get(`/api/v3/servers/${fid}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(failed.body.server.status).toBe("install_failed");
  });

  it("addons list scans plugin/mod folders", async () => {
    const list = await request(app)
      .get(`/api/v3/servers/${serverId}/addons`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.addons)).toBe(true);
  });

  it("reinstall succeeds end to end on a no-op blueprint", async () => {
    // A blueprint with zero install ops exercises the full reinstall path
    // (offline check, status flips, audit) with no network involved.
    const now = Date.now();
    const doc = {
      schemaVersion: 1,
      slug: "noop-proc",
      name: "Noop",
      category: "generic-process",
      tag: "v1",
      requirements: { engine: "process", arch: ["amd64"], hostOs: ["linux", "windows"] },
      image: "none",
      install: [],
      run: { command: ["node", "-e", "1"], workdir: "/data", stop: { kind: "signal" } },
      variables: [],
    };
    ctx.db
      .prepare(
        `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,maturity,created_at,updated_at)
         VALUES ('bp-noop','noop-proc','Noop','generic-process','v1',1,'import','stable',?,?)`,
      )
      .run(now, now);
    ctx.db
      .prepare(
        `INSERT INTO blueprint_versions (blueprint_id, tag, schema_version, doc, sha256, published_at)
         VALUES ('bp-noop','v1',1,?,'x',?)`,
      )
      .run(JSON.stringify(doc), now);
    const created = await request(app)
      .post("/api/v3/servers")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({ name: "noop", blueprintSlug: "noop-proc" });
    expect(created.status).toBe(201);
    const nid = created.body.server.id as string;

    const reinstall = await request(app)
      .post(`/api/v3/servers/${nid}/install`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(reinstall.status).toBe(200);

    const detail = await request(app)
      .get(`/api/v3/servers/${nid}`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(detail.body.server.status).toBe("ready");
  });
});
