import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { BUILTIN_BLUEPRINTS } from "../../src/server/modules/blueprints/builtin-catalog.js";
import { runInstallOps } from "../../src/server/modules/runtime/install.js";

const SUPPORTED_SLUGS = [
  "paper",
  "purpur",
  "vanilla",
  "bedrock-bds",
  "pocketmine-mp",
  "endstone",
  "generic-nodejs",
  "generic-python",
] as const;

const TARGET_SLUG = process.env.SOFTWARE_SLUG?.trim();

if (TARGET_SLUG && !SUPPORTED_SLUGS.includes(TARGET_SLUG as (typeof SUPPORTED_SLUGS)[number])) {
  throw new Error(
    `Unsupported SOFTWARE_SLUG: '${TARGET_SLUG}'. Expected one of: ${SUPPORTED_SLUGS.join(", ")}`,
  );
}

function shouldRun(slug: string): boolean {
  return !TARGET_SLUG || TARGET_SLUG === slug;
}

function stubFetch(
  routes: Record<string, { status?: number; json?: unknown; bytes?: Buffer }>,
): typeof fetch {
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

describe("Software & Egg Matrix Test Suite", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "renom-matrix-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(shouldRun("paper"))("paper egg initializes and executes installation ops", async () => {
    const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "paper");
    expect(bp).toBeDefined();
    expect(bp?.category).toBe("minecraft-java");

    const jarBytes = Buffer.from("fake-paper-jar");
    const jarSha256 = createHash("sha256").update(jarBytes).digest("hex");
    const fetchImpl = stubFetch({
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
                checksums: { sha256: jarSha256 },
              },
            },
          },
        ],
      },
      "https://fill-data.papermc.io/v1/paper.jar": { bytes: jarBytes },
    });

    const vars: Record<string, string> = { mcVersion: "1.21.1", MOTD: "Paper Matrix Test" };
    await runInstallOps(bp as never, {
      serverId: "srv-paper",
      dir,
      vars,
      blueprintSlug: "paper",
      fetchImpl,
    });

    expect(existsSync(join(dir, "paper.jar"))).toBe(true);
    expect(existsSync(join(dir, "eula.txt"))).toBe(true);
    expect(existsSync(join(dir, "server.properties"))).toBe(true);
  });

  it.runIf(shouldRun("purpur"))(
    "purpur egg initializes and executes installation ops",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "purpur");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("minecraft-java");

      const jarBytes = Buffer.from("fake-purpur-jar");
      const jarMd5 = createHash("md5").update(jarBytes).digest("hex");
      const fetchImpl = stubFetch({
        "https://api.purpurmc.org/v2/purpur/1.21.1/2345/download": { bytes: jarBytes },
        "https://api.purpurmc.org/v2/purpur/1.21.1/2345": {
          json: { md5: jarMd5 },
        },
        // The resolver reads the family document, not /v2/paper/... — that
        // URL was the live 404 this suite's fixture used to encode.
        "https://api.purpurmc.org/v2/purpur/1.21.1": {
          json: { version: "1.21.1", builds: { latest: "2345" } },
        },
      });

      const vars: Record<string, string> = { mcVersion: "1.21.1", MOTD: "Purpur Matrix Test" };
      await runInstallOps(bp as never, {
        serverId: "srv-purpur",
        dir,
        vars,
        blueprintSlug: "purpur",
        fetchImpl,
      });

      expect(existsSync(join(dir, "purpur.jar"))).toBe(true);
      expect(existsSync(join(dir, "eula.txt"))).toBe(true);
      expect(existsSync(join(dir, "server.properties"))).toBe(true);
    },
  );

  it.runIf(shouldRun("vanilla"))(
    "vanilla egg initializes and executes installation ops",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "vanilla");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("minecraft-java");

      const jarBytes = Buffer.from("fake-vanilla-jar");
      const jarSha1 = createHash("sha1").update(jarBytes).digest("hex");
      const fetchImpl = stubFetch({
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json": {
          json: {
            latest: { release: "1.21.1" },
            versions: [
              { id: "1.21.1", url: "https://piston-meta.mojang.com/v1/packages/1.21.1.json" },
            ],
          },
        },
        "https://piston-meta.mojang.com/v1/packages/1.21.1.json": {
          json: {
            downloads: {
              server: {
                url: "https://piston-data.mojang.com/v1/objects/server.jar",
                sha1: jarSha1,
              },
            },
          },
        },
        "https://piston-data.mojang.com/v1/objects/server.jar": { bytes: jarBytes },
      });

      const vars: Record<string, string> = { mcVersion: "1.21.1", MOTD: "Vanilla Matrix Test" };
      await runInstallOps(bp as never, {
        serverId: "srv-vanilla",
        dir,
        vars,
        blueprintSlug: "vanilla",
        fetchImpl,
      });

      expect(existsSync(join(dir, "server.jar"))).toBe(true);
      expect(existsSync(join(dir, "eula.txt"))).toBe(true);
      expect(existsSync(join(dir, "server.properties"))).toBe(true);
    },
  );

  it.runIf(shouldRun("bedrock-bds"))(
    "bedrock-bds egg initializes and verifies blueprint configuration",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "bedrock-bds");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("minecraft-bedrock");
      expect(bp?.run?.command[0]).toBe("bedrock_server");
      expect(bp?.requirements.engine).toBe("process");
      expect(bp?.variables.some((v) => v.key === "mcVersion")).toBe(true);
    },
  );

  it.runIf(shouldRun("pocketmine-mp"))(
    "pocketmine-mp egg initializes and verifies blueprint configuration",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "pocketmine-mp");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("minecraft-bedrock");
      expect(bp?.requirements.engine).toBe("process");
      expect(bp?.install.some((op) => op.op === "fetch-pocketmine")).toBe(true);
    },
  );

  it.runIf(shouldRun("endstone"))(
    "endstone egg initializes and verifies blueprint configuration",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "endstone");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("minecraft-bedrock");
      expect(bp?.requirements.engine).toBe("process");
      expect(bp?.install.some((op) => op.op === "fetch-endstone")).toBe(true);
    },
  );

  it.runIf(shouldRun("generic-nodejs"))(
    "generic-nodejs egg initializes and executes installation ops",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "generic-nodejs");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("generic-runtime");

      const vars: Record<string, string> = { entryFile: "index.js" };
      await runInstallOps(bp as never, {
        serverId: "srv-nodejs",
        dir,
        vars,
        blueprintSlug: "generic-nodejs",
      });

      expect(existsSync(join(dir, "app"))).toBe(true);
    },
  );

  it.runIf(shouldRun("generic-python"))(
    "generic-python egg initializes and executes installation ops",
    async () => {
      const bp = BUILTIN_BLUEPRINTS.find((b) => b.slug === "generic-python");
      expect(bp).toBeDefined();
      expect(bp?.category).toBe("generic-runtime");

      const vars: Record<string, string> = { entryFile: "main.py" };
      await runInstallOps(bp as never, {
        serverId: "srv-python",
        dir,
        vars,
        blueprintSlug: "generic-python",
      });

      expect(existsSync(join(dir, "app"))).toBe(true);
    },
  );
});
