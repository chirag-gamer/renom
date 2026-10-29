import { Router } from "express";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../../modules/servers/repo.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import {
  requireServerPermission,
  assertNotSuspendedForMutation,
  assertSuspendedReadable,
} from "../middleware/authz.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import {
  fetchModrinthProjectVersions,
  installModrinthProjects,
  modrinthPlatform,
  resolveMinecraftVersion,
  searchModrinthProjects,
} from "../../modules/runtime/install.js";
import { storedVariables } from "./servers.js";

const searchQuery = z.object({
  q: z.string().max(64).default(""),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const addonsSchema = z
  .object({
    projects: z.array(z.string().min(1).max(64)).min(1).max(10).optional(),
    project: z.string().min(1).max(64).optional(),
    versionId: z.string().min(1).max(64).optional(),
  })
  .refine((d) => (d.projects && d.projects.length > 0) || Boolean(d.project), {
    message: "Either project or projects must be provided",
  });

const ADDON_DIRS = ["mods", "plugins"] as const;
const BEDROCK_PACK_TYPES = ["behavior_packs", "resource_packs"] as const;

export interface AddonsDeps {
  db: Database;
  servers: ServersRepo;
  audit: AuditService;
  auth: AuthService;
  dataDir: string;
}

/**
 * Addons (mods + plugins) from Modrinth — the JTG-era workflow, rebuilt on
 * verified downloads: newest file for this server's loader + MC version,
 * checksum-checked, jar-only. Vanilla refuses (no mod platform).
 */
export function addonsRouter(deps: AddonsDeps): Router {
  const { db, servers, audit, auth, dataDir } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  /** The server's exact Minecraft version, resolving "latest" dynamically when needed. */
  const mcVersionOf = async (id: string): Promise<string> => {
    const row = db
      .prepare("SELECT value FROM server_variables WHERE server_id = ? AND key = 'mcVersion'")
      .get(id) as { value: string } | undefined;
    const version = row?.value?.trim();
    if (!version) {
      throw new BadRequestError(
        "Set an exact Minecraft version on the Startup tab first — version variable is missing.",
      );
    }
    if (version === "latest") {
      return await resolveMinecraftVersion(fetch, version);
    }
    return version;
  };

  const platformOf = (id: string) => {
    const server = servers.byId(id);
    if (!server) throw new NotFoundError("Not found");
    return modrinthPlatform(server.blueprint_slug);
  };

  // What the client needs to decide whether to show the Addons tab at all,
  // and which flavor it is: "plugin" (Paper/Purpur/Velocity search Modrinth
  // plugins), "mod" (Fabric/Forge search mods — hiding the tab there would
  // leave mod servers with no way to install anything), "bedrock" (BDS
  // manages .mcaddon packs from disk; Modrinth publishes zero bedrock
  // loaders, verified live, so there is no search backend to call).
  router.get("/servers/:id/addons/capability", guard("startup.read"), (req, res, next) => {
    (async () => {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const server = servers.byId(id);
      if (!server) throw new NotFoundError("Not found");
      const platform = modrinthPlatform(server.blueprint_slug);
      const kind =
        server.blueprint_slug === "bedrock-bds"
          ? "bedrock"
          : platform
            ? platform.projectType
            : null;
      let mcVersion: string | null = null;
      if (kind === "plugin" || kind === "mod") {
        try {
          mcVersion = await mcVersionOf(id);
        } catch {
          mcVersion = null;
        }
      }
      res.json({
        supported: kind !== null,
        kind,
        folder: platform ? platform.dir : null,
        projectType: platform ? platform.projectType : null,
        mcVersion,
      });
    })().catch(next);
  });

  // Search is filtered to this server's loader and exact Minecraft version.
  router.get("/servers/:id/addons/search", guard("startup.read"), (req, res, next) => {
    (async () => {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const platform = platformOf(id);
      if (!platform) {
        throw new ConflictError("This server software has no Modrinth platform");
      }
      const mcVersion = await mcVersionOf(id);
      const q = parseQuery(searchQuery, req);
      const offset = (q.page - 1) * q.limit;
      const result = await searchModrinthProjects(
        fetch,
        { loaders: platform.loaders, projectType: platform.projectType },
        mcVersion,
        q.q,
        q.limit,
        offset,
      );
      const totalPages = Math.ceil(result.totalHits / q.limit) || 1;
      res.json({
        hits: result.hits,
        totalHits: result.totalHits,
        totalPages,
        page: q.page,
        limit: q.limit,
        mcVersion,
        folder: platform.dir,
      });
    })().catch(next);
  });

  router.get("/servers/:id/addons/versions/:projectId", guard("startup.read"), (req, res, next) => {
    (async () => {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const platform = platformOf(id);
      if (!platform) {
        throw new ConflictError("This server software has no Modrinth platform");
      }
      const mcVersion = await mcVersionOf(id);
      const projectId = req.params.projectId ?? "";
      const versions = await fetchModrinthProjectVersions(
        fetch,
        { loaders: platform.loaders, projectType: platform.projectType },
        mcVersion,
        projectId,
      );
      res.json({ versions, mcVersion, projectId });
    })().catch(next);
  });

  const dirFor = (serverId: string, folder: string): string | null => {
    if (!(ADDON_DIRS as readonly string[]).includes(folder)) return null;
    return join(dataDir, "servers", serverId, folder);
  };

  // --- Bedrock addon packs (BDS) ---
  // BDS has no search backend to call: Modrinth publishes zero bedrock
  // loaders/categories (probed live 2026-10-29) and CurseForge needs an API
  // key the panel does not have. What IS real and verifiable: BDS loads packs
  // from `behavior_packs/` and `resource_packs/`, each folder carrying a
  // manifest.json. Addons land there via the file manager (upload a
  // .mcpack/.mcaddon and extract it — the Files tab decompress supports both
  // shapes); this endpoint lists and removes what is installed.

  const packDirFor = (serverId: string, type: string, name: string): string => {
    if (!(BEDROCK_PACK_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestError("Pack type must be behavior_packs or resource_packs");
    }
    // `name` is a folder under the pack root: no separators, no dot-storms.
    if (!name || name.startsWith(".") || /[\\/\0]/.test(name) || name.includes("..")) {
      throw new BadRequestError("Invalid pack folder name");
    }
    return join(dataDir, "servers", serverId, type, name);
  };

  router.get("/servers/:id/addons/bedrock", guard("startup.read"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const server = servers.byId(id);
      if (!server) throw new NotFoundError("Not found");
      if (server.blueprint_slug !== "bedrock-bds") {
        throw new ConflictError("Bedrock packs only apply to the Bedrock Dedicated Server");
      }
      const packs: Array<{
        name: string;
        uuid: string | null;
        version: string | null;
        type: string;
        folder: string;
      }> = [];
      for (const type of BEDROCK_PACK_TYPES) {
        const root = join(dataDir, "servers", id, type);
        if (!existsSync(root)) continue;
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = join(root, entry.name, "manifest.json");
          if (!existsSync(manifestPath)) continue;
          try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
              header?: { name?: string; uuid?: string; version?: number[] };
            };
            const header = manifest.header ?? {};
            const version = Array.isArray(header.version)
              ? header.version.map(String).join(".")
              : null;
            packs.push({
              name: header.name ?? entry.name,
              uuid: header.uuid ?? null,
              version,
              type,
              folder: entry.name,
            });
          } catch {
            // A pack with a broken manifest still shows up, by folder name.
            packs.push({
              name: entry.name,
              uuid: null,
              version: null,
              type,
              folder: entry.name,
            });
          }
        }
      }
      res.json({ packs });
    } catch (e) {
      next(e);
    }
  });

  router.delete(
    "/servers/:id/addons/bedrock/:type/:name",
    guard("startup.update"),
    (req, res, next) => {
      try {
        assertNotSuspendedForMutation(req, res);
        const id = req.params.id ?? "";
        const server = servers.byId(id);
        if (!server) throw new NotFoundError("Not found");
        if (server.blueprint_slug !== "bedrock-bds") {
          throw new ConflictError("Bedrock packs only apply to the Bedrock Dedicated Server");
        }
        const packDir = packDirFor(id, req.params.type ?? "", req.params.name ?? "");
        if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
          throw new NotFoundError("Pack not found");
        }
        rmSync(packDir, { recursive: true, force: true });
        // Drop the pack from BDS's known-packs registry when it was listed;
        // a stale entry pointing at a deleted folder makes BDS log warnings.
        const knownPath = join(dataDir, "servers", id, "valid_known_packs.json");
        if (existsSync(knownPath)) {
          try {
            const known = JSON.parse(readFileSync(knownPath, "utf8")) as Array<{
              pack_id?: string;
              path?: string;
            }>;
            // Match the exact registry entry for the removed folder —
            // `includes("/<name>")` would also drop sibling folders whose
            // names merely start with the removed one (my_pack vs my_pack_v2).
            // BDS writes paths like "behavior_packs/<folder>" (no leading
            // slash); normalize the leading "./" or "/" away before comparing.
            const wanted = `${req.params.type}/${req.params.name}`;
            const filtered = known.filter((entry) => {
              const path = (entry.path ?? "").replace(/^\.{0,2}\//, "");
              return path !== wanted;
            });
            if (filtered.length !== known.length) {
              writeFileSync(knownPath, `${JSON.stringify(filtered, null, 2)}\n`, "utf8");
            }
          } catch {
            // An unparsable registry is BDS's problem, not a reason to fail
            // the deletion — the folder itself is gone, which is what the
            // user asked for.
          }
        }
        audit.record({
          event: "server.addons.remove",
          actorUserId: req.principal!.userId,
          actorApiKeyId: req.principal!.apiKeyId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId: id,
          target: { type: req.params.type, name: req.params.name },
        });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/servers/:id/addons", guard("startup.read"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const items: Array<{ name: string; folder: string; bytes: number }> = [];
      for (const folder of ADDON_DIRS) {
        const dir = dirFor(id, folder)!;
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (!/\.jar$/i.test(name)) continue;
          try {
            items.push({ name, folder, bytes: statSync(join(dir, name)).size });
          } catch {
            // vanished mid-listing; skip
          }
        }
      }
      res.json({ addons: items });
    } catch (e) {
      next(e);
    }
  });

  router.post("/servers/:id/addons", guard("startup.update"), (req, res, next) => {
    (async () => {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(addonsSchema, req);
      const id = req.params.id ?? "";
      const server = servers.byId(id);
      if (!server) throw new NotFoundError("Not found");
      const platform = modrinthPlatform(server.blueprint_slug);
      if (!platform) {
        throw new ConflictError("This server software has no Modrinth platform");
      }
      const vars = storedVariables(db, id, []);
      const mcRow = db
        .prepare("SELECT value FROM server_variables WHERE server_id = ? AND key = 'mcVersion'")
        .get(id) as { value: string } | undefined;
      if (mcRow) vars["mcVersion"] = mcRow.value;
      const targets = body.projects && body.projects.length > 0 ? body.projects : [body.project!];
      const result = await installModrinthProjects(
        fetch,
        {
          serverId: id,
          dir: join(dataDir, "servers", id),
          vars,
          blueprintSlug: server.blueprint_slug,
        },
        targets,
        body.versionId,
      );
      audit.record({
        event: "server.addons.install",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
        target: { projects: targets, versionId: body.versionId, skipped: result.skipped },
      });
      // 200 when everything was already installed (a repeat click must not
      // look like a fresh download), 201 when something new landed.
      res.status(result.downloaded.length > 0 ? 201 : 200).json({
        installed: result.downloaded,
        skipped: result.skipped,
        versionId: body.versionId ?? null,
      });
    })().catch(next);
  });

  router.delete("/servers/:id/addons/:folder/:name", guard("startup.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const id = req.params.id ?? "";
      const dir = dirFor(id, req.params.folder ?? "");
      const name = req.params.name ?? "";
      if (!dir || !/^[\w][\w.+-]*\.jar$/i.test(name)) {
        throw new BadRequestError("Invalid addon path");
      }
      const file = join(dir, name);
      if (!existsSync(file)) throw new NotFoundError("Addon not found");
      // Refuse directories/symlinks masquerading as jars.
      if (!statSync(file).isFile()) throw new BadRequestError("Not a removable addon file");
      rmSync(file);
      audit.record({
        event: "server.addons.remove",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
        target: { name },
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
