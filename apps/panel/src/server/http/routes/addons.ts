import { Router } from "express";
import { z } from "zod";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
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
  installModrinthProjects,
  modrinthPlatform,
  searchModrinthProjects,
} from "../../modules/runtime/install.js";
import { storedVariables } from "./servers.js";

const searchQuery = z.object({
  q: z.string().max(64).default(""),
});

const addonsSchema = z.object({
  projects: z.array(z.string().min(1).max(64)).min(1).max(10),
});

const ADDON_DIRS = ["mods", "plugins"] as const;

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

  /** The server's exact Minecraft version, or null when it is unresolved. */
  const mcVersionOf = (id: string): string | null => {
    const row = db
      .prepare("SELECT value FROM server_variables WHERE server_id = ? AND key = 'mcVersion'")
      .get(id) as { value: string } | undefined;
    const version = row?.value?.trim();
    return version && version !== "latest" ? version : null;
  };

  const platformOf = (id: string) => {
    const server = servers.byId(id);
    if (!server) throw new NotFoundError("Not found");
    return modrinthPlatform(server.blueprint_slug);
  };

  // What the client needs to decide whether to show the Addons tab at all.
  router.get("/servers/:id/addons/capability", guard("startup.read"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const platform = platformOf(id);
      res.json({
        supported: platform !== null,
        folder: platform?.dir ?? null,
        projectType: platform?.projectType ?? null,
        mcVersion: mcVersionOf(id),
      });
    } catch (e) {
      next(e);
    }
  });

  // Search is filtered to this server's loader and exact Minecraft version, so
  // a Fabric server never sees Paper plugins and a 1.20.1 server never sees a
  // 1.21-only project.
  router.get("/servers/:id/addons/search", guard("startup.read"), (req, res, next) => {
    (async () => {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const platform = platformOf(id);
      if (!platform) {
        throw new ConflictError("This server software has no mod or plugin platform");
      }
      const mcVersion = mcVersionOf(id);
      if (!mcVersion) {
        throw new BadRequestError(
          "Set an exact Minecraft version on the Startup tab first — “latest” can't resolve addon files",
        );
      }
      const q = parseQuery(searchQuery, req);
      const hits = await searchModrinthProjects(
        fetch,
        { loaders: platform.loaders, projectType: platform.projectType },
        mcVersion,
        q.q,
      );
      res.json({ hits, mcVersion, folder: platform.dir });
    })().catch(next);
  });

  const dirFor = (serverId: string, folder: string): string | null => {
    if (!(ADDON_DIRS as readonly string[]).includes(folder)) return null;
    return join(dataDir, "servers", serverId, folder);
  };

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
      const vars = storedVariables(db, id, []);
      const mcRow = db
        .prepare("SELECT value FROM server_variables WHERE server_id = ? AND key = 'mcVersion'")
        .get(id) as { value: string } | undefined;
      if (mcRow) vars["mcVersion"] = mcRow.value;
      await installModrinthProjects(
        fetch,
        {
          serverId: id,
          dir: join(dataDir, "servers", id),
          vars,
          blueprintSlug: server.blueprint_slug,
        },
        body.projects,
      );
      audit.record({
        event: "server.addons.install",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
        target: { projects: body.projects },
      });
      res.status(201).json({ installed: body.projects });
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
