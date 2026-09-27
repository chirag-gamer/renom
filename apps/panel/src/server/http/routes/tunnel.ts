import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../../modules/servers/repo.js";
import type { LocalProcessEngine } from "../../modules/runtime/engine.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import {
  requireServerPermission,
  assertNotSuspendedForMutation,
  assertSuspendedReadable,
} from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import {
  claimEndpointName,
  endpointTaken,
  endpointValid,
  installPlugin,
  scanHistoryForAddress,
} from "../../modules/tunnels/minekube.js";
import { join } from "node:path";

const tunnelSchema = z.object({
  /** Omit to have the panel mint a random Connect endpoint name. */
  endpoint: z.string().min(2).max(63).optional(),
});

export interface TunnelDeps {
  db: Database;
  servers: ServersRepo;
  engine: LocalProcessEngine;
  audit: AuditService;
  auth: AuthService;
  dataDir: string;
}

/**
 * Optional public tunnels (opt-in, off by default, never required for core
 * lifecycle). Today: Minekube Connect for Java servers — the panel installs
 * the plugin, passes the endpoint by environment, and surfaces the printed
 * public address as the join address.
 */
export function tunnelRouter(deps: TunnelDeps): Router {
  const { db, servers, engine, audit, auth, dataDir } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  const stored = (serverId: string, key: string): string | null => {
    const row = db
      .prepare("SELECT value FROM server_variables WHERE server_id = ? AND key = ?")
      .get(serverId, key) as { value: string } | undefined;
    return row?.value ?? null;
  };

  router.get("/servers/:id/tunnel", guard("allocation.read"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const id = req.params.id ?? "";
      const endpoint = stored(id, "tunnel.endpoint");
      const provider = stored(id, "tunnel.provider");
      const address =
        provider === "minekube" ? scanHistoryForAddress(engine.history(id, 500)) : null;
      res.json({ provider, endpoint, address });
    } catch (e) {
      next(e);
    }
  });

  router.post("/servers/:id/tunnel", guard("allocation.update"), (req, res, next) => {
    (async () => {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(tunnelSchema, req);
      const id = req.params.id ?? "";
      const server = servers.byId(id);
      if (!server) throw new NotFoundError("Not found");
      // Minekube ships a Java plugin: Java servers and Java proxies only.
      // Bedrock, Python, and Node servers tunnel another way (docs/tunnels.md).
      const category = db
        .prepare("SELECT category FROM blueprints WHERE id = ?")
        .get(server.blueprint_id) as { category: string } | undefined;
      if (!category || (category.category !== "minecraft-java" && category.category !== "proxy")) {
        throw new ConflictError(
          "Minekube tunnels work with Java servers. For Bedrock, Python, or Node, see docs/tunnels.md (Playit.gg / Cloudflare).",
        );
      }
      if (engine.stateOf(id) !== "offline") {
        throw new ConflictError("Stop the server before changing its tunnel (restart to activate)");
      }
      // A supplied name must be free for this server; a blank one is minted
      // from whatever is unclaimed, so two servers never share a join address.
      let endpoint: string;
      if (body.endpoint) {
        if (!endpointValid(body.endpoint)) {
          throw new BadRequestError(
            "Endpoint must look like vivid-lagoon-9784 (words, then four digits)",
          );
        }
        if (endpointTaken(db, body.endpoint, id)) {
          throw new ConflictError("That tunnel name is already used by another server");
        }
        endpoint = body.endpoint;
      } else {
        endpoint = claimEndpointName(db, id);
      }
      await installPlugin(join(dataDir, "servers", id));
      db.prepare(
        `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
         ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
      ).run(id, "tunnel.provider", "minekube");
      db.prepare(
        `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
         ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
      ).run(id, "tunnel.endpoint", endpoint);
      audit.record({
        event: "server.tunnel.enable",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
        target: { provider: "minekube", endpoint },
      });
      res.status(201).json({
        provider: "minekube",
        endpoint,
        note: "Restart the server to activate. Set enforce-secure-profile=false for 1.19+.",
      });
    })().catch(next);
  });

  router.delete("/servers/:id/tunnel", guard("allocation.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const id = req.params.id ?? "";
      db.prepare("DELETE FROM server_variables WHERE server_id = ? AND key LIKE 'tunnel.%'").run(
        id,
      );
      audit.record({
        event: "server.tunnel.disable",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
