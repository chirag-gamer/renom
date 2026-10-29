import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../../src/server/index.js";
import {
  runInstallOps,
  installModrinthProjects,
  searchModrinthProjects,
} from "../../src/server/modules/runtime/install.js";
import {
  parsePublicAddress,
  scanHistoryForAddress,
  endpointValid,
} from "../../src/server/modules/tunnels/minekube.js";

const JAR_BYTES = Buffer.from("fake-jar-bytes-for-tests");
const JAR_SHA256 = createHash("sha256").update(JAR_BYTES).digest("hex");

function stubFetch(
  routes: Record<string, { status?: number; json?: unknown; bytes?: Buffer }>,
  /**
   * Called for every URL the stub sees. The prefix match ignores the query
   * string, so without this a dropped `loaders`/`game_versions` parameter
   * would still hit the fixture and the test would pass.
   */
  onRequest?: (url: string) => void,
): typeof fetch {
  // Longest prefix first: "/versions" must not swallow "/versions/1.21.1/builds".
  const ordered = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  return (async (url: unknown) => {
    const u = String(url);
    onRequest?.(u);
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

  it("records the version it resolved, so Modrinth can filter on it", async () => {
    const srv = join(dir, "paper-latest");
    mkdirSync(srv, { recursive: true });
    const vars: Record<string, string> = { mcVersion: "latest" };
    await runInstallOps({ install: [{ op: "fetch-paper", version: "{mcVersion}" }] } as never, {
      serverId: "x",
      dir: srv,
      vars,
      fetchImpl: stubFetch(PAPER_ROUTES),
    });
    // The stub's only version is 1.21.1, so "latest" must have resolved to it.
    // Without this write-back a new server stores no version at all and every
    // Modrinth search and install refuses.
    expect(vars.mcVersion).toBe("1.21.1");
  });

  it("leaves mcVersion alone when the op did not read it", async () => {
    const srv = join(dir, "paper-literal");
    mkdirSync(srv, { recursive: true });
    const vars: Record<string, string> = {};
    await runInstallOps({ install: [{ op: "fetch-paper", version: "1.21.1" }] } as never, {
      serverId: "x",
      dir: srv,
      vars,
      fetchImpl: stubFetch(PAPER_ROUTES),
    });
    // An imported blueprint may name its version key differently. Persisting
    // under mcVersion a value this op never read would drive the Modrinth
    // filter off a version the server is not running.
    expect(vars.mcVersion).toBeUndefined();
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

  it("keeps a Modrinth project id's casing — Modrinth ids are case-sensitive", async () => {
    const addonBytes = Buffer.from("fake-mixed-case-addon");
    const addonSha512 = createHash("sha512").update(addonBytes).digest("hex");
    // Registered under the exact casing Modrinth hands the client. A
    // lowercased request misses this route and 404s, which is what made every
    // mixed-case project ('Vebnzrzj' is LuckPerms) uninstallable.
    const fetchImpl = stubFetch({
      "https://api.modrinth.com/v2/project/Vebnzrzj/version": {
        json: [
          {
            files: [
              {
                url: "https://cdn.modrinth.com/luckperms.jar",
                filename: "LuckPerms.jar",
                hashes: { sha512: addonSha512 },
                primary: true,
              },
            ],
          },
        ],
      },
      // No `/project/Vebnzrzj` route: compatibility now comes from the
      // loader-filtered version list, so the project lookup is not called.
      "https://cdn.modrinth.com/luckperms.jar": { bytes: addonBytes },
    });
    const srv = join(dir, "addons-case");
    mkdirSync(srv, { recursive: true });
    await runInstallOps(
      { install: [{ op: "modrinth-install", projects: ["Vebnzrzj"] }] } as never,
      {
        serverId: "x",
        dir: srv,
        vars: { mcVersion: "1.21.1" },
        blueprintSlug: "paper",
        fetchImpl,
      },
    );
    expect(readFileSync(join(srv, "plugins", "LuckPerms.jar"))).toEqual(addonBytes);
  });

  it("refuses a project with no build for this server's loader", async () => {
    // Compatibility is decided by the loader-filtered version list, not by
    // Modrinth's `project_type`: that field reads "mod" for plugins too (it
    // reports "mod" for EssentialsX, LuckPerms, WorldEdit), so an equality
    // check against "plugin" rejected every real plugin.
    const seen: string[] = [];
    const fetchImpl = stubFetch(
      { "https://api.modrinth.com/v2/project/lithium/version": { json: [] } },
      (url) => seen.push(url),
    );
    const srv = join(dir, "addons-mod-on-plugin");
    mkdirSync(srv, { recursive: true });
    await expect(
      runInstallOps({ install: [{ op: "modrinth-install", projects: ["lithium"] }] } as never, {
        serverId: "x",
        dir: srv,
        vars: { mcVersion: "1.21.1" },
        blueprintSlug: "paper",
        fetchImpl,
      }),
    ).rejects.toThrow(/Project 'lithium' has no 1\.21\.1 build for paper\/purpur\/spigot\/bukkit/);

    // The stub matches on path only, so assert the filters actually travelled:
    // without this, dropping `loaders`/`game_versions` from the request would
    // still return the empty fixture and this test would keep passing.
    const versionCall = seen.find((u) => u.includes("/lithium/version"));
    expect(versionCall).toBeDefined();
    const params = new URL(versionCall!).searchParams;
    expect(params.get("loaders")).toContain("paper");
    expect(params.get("game_versions")).toContain("1.21.1");
  });

  it("installs a plugin whose Modrinth project_type reads 'mod'", async () => {
    // The regression this guards: EssentialsX is a plugin, Modrinth calls it a
    // "mod", and the loader filter is the only honest compatibility signal.
    const addonBytes = Buffer.from("fake-essentialsx-jar");
    const addonSha512 = createHash("sha512").update(addonBytes).digest("hex");
    const seen: string[] = [];
    const fetchImpl = stubFetch(
      {
        "https://api.modrinth.com/v2/project/essentialsx/version": {
          json: [
            {
              files: [
                {
                  url: "https://cdn.modrinth.com/essentialsx.jar",
                  filename: "EssentialsX.jar",
                  hashes: { sha512: addonSha512 },
                  primary: true,
                },
              ],
            },
          ],
        },
        "https://cdn.modrinth.com/essentialsx.jar": { bytes: addonBytes },
      },
      (url) => seen.push(url),
    );
    const srv = join(dir, "addons-plugin-as-mod");
    mkdirSync(srv, { recursive: true });
    await runInstallOps(
      { install: [{ op: "modrinth-install", projects: ["essentialsx"] }] } as never,
      {
        serverId: "x",
        dir: srv,
        vars: { mcVersion: "1.21.1" },
        blueprintSlug: "paper",
        fetchImpl,
      },
    );
    expect(readFileSync(join(srv, "plugins", "EssentialsX.jar"))).toEqual(addonBytes);
    // Loader + version filters are what make a plugin whose project_type says
    // "mod" installable; assert they were actually sent.
    const versionCall = seen.find((u) => u.includes("/essentialsx/version"));
    expect(versionCall).toBeDefined();
    const params = new URL(versionCall!).searchParams;
    expect(params.get("loaders")).toContain("paper");
    expect(params.get("game_versions")).toContain("1.21.1");
  });

  it("searches mods with the platform's own project_type facet", async () => {
    // The regression this guards: the search route once hardcoded
    // project_type:"plugin", so a Fabric/Forge server's Mods tab returned
    // zero hits for Sodium/JEI/Fabric API (Modrinth's facet matches
    // all_project_types, and those projects are bucketed "mod").
    const seen: string[] = [];
    const fetchImpl = stubFetch(
      {
        "https://api.modrinth.com/v2/search?query=sodium&facets=%5B%5B%22categories%3Afabric%22%5D%2C%5B%22versions%3A1.21.1%22%5D%2C%5B%22project_type%3Amod%22%5D%5D&index=downloads&limit=10&offset=0":
          {
            json: { total_hits: 1, hits: [] },
          },
      },
      (url) => seen.push(url),
    );
    await searchModrinthProjects(
      fetchImpl,
      { loaders: ["fabric"], projectType: "mod" },
      "1.21.1",
      "sodium",
    );
    const searchCall = seen.find((u) => u.includes("/v2/search"));
    expect(searchCall).toBeDefined();
    const params = new URL(searchCall!).searchParams;
    const facets = JSON.parse(params.get("facets") ?? "[]") as string[][];
    expect(facets.flat()).toContain("project_type:mod");
    expect(facets.flat()).not.toContain("project_type:plugin");
  });

  it("re-installing the same project skips the download (dedupe on sha512)", async () => {
    // Modrinth publishes sha512 + sha1, never sha256 — the dedupe key must
    // be a hash the API actually serves, or every repeat install re-downloads.
    const addonBytes = Buffer.from("fake-dedupe-jar");
    const addonSha512 = createHash("sha512").update(addonBytes).digest("hex");
    const fetchImpl = stubFetch({
      "https://api.modrinth.com/v2/project/luckperms/version": {
        json: [
          {
            files: [
              {
                url: "https://cdn.modrinth.com/luckperms.jar",
                filename: "LuckPerms.jar",
                hashes: { sha512: addonSha512 },
                primary: true,
              },
            ],
          },
        ],
      },
      "https://cdn.modrinth.com/luckperms.jar": { bytes: addonBytes },
    });
    const srv = join(dir, "addons-dedupe");
    mkdirSync(srv, { recursive: true });
    const ctxBase = {
      serverId: "x",
      dir: srv,
      vars: { mcVersion: "1.21.1" },
      blueprintSlug: "paper",
      fetchImpl,
    };
    const first = await installModrinthProjects(fetchImpl, ctxBase, ["luckperms"]);
    expect(first.downloaded).toEqual(["LuckPerms.jar"]);
    expect(first.skipped).toEqual([]);
    const second = await installModrinthProjects(fetchImpl, ctxBase, ["luckperms"]);
    expect(second.downloaded).toEqual([]);
    expect(second.skipped).toEqual(["LuckPerms.jar"]);
  });

  it("refuses versionId when installing multiple projects to prevent partial installs", async () => {
    const srv = join(dir, "addons-multi-version");
    mkdirSync(srv, { recursive: true });
    await expect(
      installModrinthProjects(
        stubFetch({}),
        {
          serverId: "x",
          dir: srv,
          vars: { mcVersion: "1.21.1" },
          blueprintSlug: "paper",
        },
        ["p1", "p2"],
        "some-version-id",
      ),
    ).rejects.toThrow(/Cannot specify versionId when installing multiple projects/);
  });

  it("resolves 'latest' version target when installing plugins", async () => {
    const addonBytes = Buffer.from("fake-latest-plugin");
    const addonSha512 = createHash("sha512").update(addonBytes).digest("hex");
    const requestedUrls: string[] = [];
    const baseFetch = stubFetch({
      "https://fill.papermc.io/v3/projects/paper/versions": {
        json: {
          versions: [{ version: { id: "1.21.4" }, support: { status: "SUPPORTED" } }],
        },
      },
      "https://api.modrinth.com/v2/project/luckperms/version": {
        json: [
          {
            files: [
              {
                url: "https://cdn.modrinth.com/luckperms.jar",
                filename: "LuckPerms.jar",
                hashes: { sha512: addonSha512 },
                primary: true,
              },
            ],
          },
        ],
      },
      "https://api.modrinth.com/v2/project/luckperms": {
        json: { project_type: "plugin" },
      },
      "https://cdn.modrinth.com/luckperms.jar": { bytes: addonBytes },
    });
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      requestedUrls.push(String(url));
      return baseFetch(url, init);
    }) as typeof fetch;

    const srv = join(dir, "addons-latest-version");
    mkdirSync(srv, { recursive: true });
    await installModrinthProjects(
      fetchImpl,
      {
        serverId: "x",
        dir: srv,
        vars: { mcVersion: "latest" },
        blueprintSlug: "paper",
      },
      ["luckperms"],
    );
    expect(readFileSync(join(srv, "plugins", "LuckPerms.jar"))).toEqual(addonBytes);
    const modrinthVersionCall = requestedUrls.find((u) => u.includes("/luckperms/version"));
    expect(modrinthVersionCall).toBeDefined();
    expect(decodeURIComponent(modrinthVersionCall!)).toContain('"1.21.4"');
    expect(decodeURIComponent(modrinthVersionCall!)).not.toContain('"latest"');
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

  it("refuses escaping paths and fails cleanly on unreachable loader metadata", async () => {
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
    // Concrete mcVersion means no version lookup; the loader registry 404s and
    // the install fails with a status-bearing message rather than a silent
    // half-install.
    await expect(
      runInstallOps({ install: [{ op: "fetch-fabric", mcVersion: "1.21.1" }] } as never, {
        serverId: "x",
        dir: srv,
        vars: {},
        fetchImpl: stubFetch({}),
      }),
    ).rejects.toThrow(/loader\/1\.21\.1/);
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

  it("validates endpoint names against the Connect grammar and 16-char limit", () => {
    // 4-8 letters, then four digits, optionally joined by a second word, max 16 chars.
    expect(endpointValid("noble-fjord-2128")).toBe(true);
    expect(endpointValid("calm-fjord-9784")).toBe(true);
    expect(endpointValid("amber-9784")).toBe(true);
    expect(endpointValid("vivid-lagoon-9784")).toBe(false);
    expect(endpointValid("mellow-atlas-9245")).toBe(false);
    expect(endpointValid("UPPER")).toBe(false);
    expect(endpointValid("a")).toBe(false);
    expect(endpointValid("has space")).toBe(false);
    // Rejected by the connector, so rejected here too.
    expect(endpointValid("my-server-1")).toBe(false);
    expect(endpointValid("9lives-9784")).toBe(false);
  });

  it("installs the tunnel plugin checksum-verified", async () => {
    const { installPlugin } = await import("../../src/server/modules/tunnels/minekube.js");
    const jarBytes = Buffer.from("fake-connect-jar");
    const jarSha256 = createHash("sha256").update(jarBytes).digest("hex");
    const fetchImpl = stubFetch({
      "https://api.github.com/repos/minekube/connect-java/releases/latest": {
        json: {
          assets: [
            {
              name: "connect-spigot.jar",
              browser_download_url: "https://github.com/mk/connect-spigot.jar",
              digest: `sha256:${jarSha256}`,
            },
          ],
        },
      },
      "https://github.com/mk/connect-spigot.jar": { bytes: jarBytes },
    });
    const srv = mkdtempSync(join(tmpdir(), "renom-tunnel-"));
    try {
      const dest = await installPlugin(srv, fetchImpl);
      expect(readFileSync(dest)).toEqual(jarBytes);
    } finally {
      rmSync(srv, { recursive: true, force: true });
    }
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

  it("still names the join address after the printed line scrolls away", async () => {
    // A reserved endpoint is enough: a busy server pushes the plugin's
    // "Your public address" line out of the 500-line history within minutes,
    // and the panel used to answer `null` from then on.
    const setVar = ctx.db.prepare(
      "INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?) " +
        "ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value",
    );
    setVar.run(serverId, "tunnel.provider", "minekube");
    setVar.run(serverId, "tunnel.endpoint", "noble-fjord-2128");

    const res = await request(app)
      .get(`/api/v3/servers/${serverId}/tunnel`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe("noble-fjord-2128.play.minekube.net");
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

  it("version change is a variable edit; fabric exposes a mod platform", async () => {
    // Fabric's installer is wired now, so a reinstall genuinely reaches
    // Fabric's registry — which would make this test a network test. What
    // stays deterministic here: the version is a plain variable edit, and
    // the addons capability answers "mod platform" (the old code hid the
    // tab on every mod loader; it must not).
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

    // Verify the variable was actually persisted in the database
    const vars = await request(app)
      .get(`/api/v3/servers/${fid}/variables`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(vars.status).toBe(200);
    const mcVar = vars.body.variables.find((v: { key: string }) => v.key === "mcVersion");
    expect(mcVar?.value).toBe("1.21.1");

    const cap = await request(app)
      .get(`/api/v3/servers/${fid}/addons/capability`)
      .set("authorization", `Bearer ${ownerToken}`);
    expect(cap.status).toBe(200);
    expect(cap.body.supported).toBe(true);
    expect(cap.body.kind).toBe("mod");
    expect(cap.body.folder).toBe("mods");

    // Deterministic reinstall assertion: mock the Fabric registry so the reinstall
    // flow runs end-to-end against the persisted version without external network dependencies.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("meta.fabricmc.net")) {
        return new Response("not found", { status: 404 });
      }
      return originalFetch(url as never);
    }) as typeof fetch;
    try {
      const reinstall = await request(app)
        .post(`/api/v3/servers/${fid}/install`)
        .set("authorization", `Bearer ${ownerToken}`);
      expect(reinstall.status).toBe(409);

      const failed = await request(app)
        .get(`/api/v3/servers/${fid}`)
        .set("authorization", `Bearer ${ownerToken}`);
      expect(failed.body.server.status).toBe("install_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
