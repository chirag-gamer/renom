import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { UsersRepo } from "../../modules/users/repo.js";
import type { ServersRepo } from "../../modules/servers/repo.js";
import { toPublicServer } from "../../modules/servers/repo.js";
import type { BlueprintRegistry } from "../../modules/blueprints/registry.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import type { Database } from "../../infra/db/database.js";
import type { LocalProcessEngine } from "../../modules/runtime/engine.js";
import { requireAuth, requireAdmin } from "../middleware/authn.js";
import { requireServerPermission, assertNotSuspendedForMutation } from "../middleware/authz.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../shared/errors.js";
import { runInstallOps } from "../../modules/runtime/install.js";
import { createServerSchema, patchServerSchema, pageQuerySchema } from "@renom/contracts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ServersDeps {
  db: Database;
  users: UsersRepo;
  servers: ServersRepo;
  engine: LocalProcessEngine;
  blueprints: BlueprintRegistry;
  audit: AuditService;
  auth: AuthService;
  /** Resolved DATA_DIR; server directories live at <dataDir>/servers/<id>. */
  dataDir: string;
}

export function serversRouter(deps: ServersDeps): Router {
  const { users, servers, engine, blueprints, audit, auth, dataDir } = deps;
  const router = Router();
  router.use(requireAuth(auth));

  router.get("/servers", (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = parseQuery(pageQuerySchema, req);
      const p = req.principal!;
      const rows = servers.list({
        userId: p.userId,
        role: p.role,
        limit: q.limit,
        cursor: q.cursor,
      });
      res.json({
        items: rows.map((s) => toPublicServer(s, servers.primaryAllocation(s.id))),
        nextCursor: rows.length === q.limit ? (rows[rows.length - 1]?.id ?? null) : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post("/servers", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody(createServerSchema, req);
      const p = req.principal!;
      const privileged = p.role === "owner" || p.role === "admin";

      // Server creation is account-level, not server-scoped: a narrowed API
      // key has no ceiling to intersect against, so only sessions and full
      // keys may create.
      if (p.scopes !== undefined && !p.scopes.includes("*")) {
        throw new ForbiddenError("This API key cannot create servers");
      }

      // Owner assignment is a privilege; regular users create for themselves.
      let ownerId = p.userId;
      if (body.ownerUsername) {
        if (!privileged) throw new ForbiddenError("Only admins can assign servers to others");
        const target = users.byUsername(body.ownerUsername);
        if (!target) throw new NotFoundError("Owner account not found");
        ownerId = target.id;
      }
      const ownerRow = users.byId(ownerId)!;

      // Quotas: count, RAM, and disk — admins/owner are unbound, users stop
      // at their plan including what their existing servers already use.
      if (!privileged) {
        const usage = servers.resourceUsage(ownerId);
        if (usage.servers >= ownerRow.quota_max_servers) {
          throw new ConflictError("Server quota reached for this account");
        }
        if (usage.memoryMb + body.memoryMb > ownerRow.quota_ram_mb) {
          throw new ConflictError("Not enough RAM quota for this server");
        }
        if (usage.diskMb + body.diskQuotaMb > ownerRow.quota_disk_mb) {
          throw new ConflictError("Not enough disk quota for this server");
        }
      }

      const bp = blueprints.lookup(body.blueprintSlug);
      const doc = blueprints.getDoc(body.blueprintSlug);

      // Mojang's EULA must be accepted by a human, in the open — never implied.
      if (doc.features?.includes("eula") && body.eulaAccepted !== true) {
        throw new BadRequestError("This server needs the Minecraft EULA accepted first");
      }

      const created = servers.create({
        name: body.name,
        description: body.description,
        ownerId,
        blueprintId: bp.id,
        versionTag: doc.tag,
        imageRef: doc.image,
        memoryMb: body.memoryMb,
        diskQuotaMb: body.diskQuotaMb,
      });
      const serverDir = join(dataDir, "servers", created.id);
      mkdirSync(serverDir, { recursive: true });
      if (doc.features?.includes("eula")) {
        servers.recordEula(created.id, req.ip ?? null);
      }
      const alloc = servers.primaryAllocation(created.id);
      servers.setStatus(created.id, "ready");
      audit.record({
        event: "server.create",
        actorUserId: p.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: created.id,
        target: { blueprint: body.blueprintSlug },
      });

      // Install runs in the background: creation stays fast while downloads
      // land, and status tells the truth (installing → ready / install_failed).
      // Skipped under test: runInstallOps has its own suite with stubbed fetch.
      if (doc.install.length > 0 && process.env.NODE_ENV !== "test") {
        const installVars: Record<string, string> = {};
        for (const v of doc.variables ?? []) installVars[v.key] = String(v.default);
        if (alloc) {
          installVars["allocation.ip"] = alloc.ip;
          installVars["allocation.port"] = String(alloc.port);
        }
        servers.setStatus(created.id, "installing");
        void runInstallOps(doc, { serverId: created.id, dir: serverDir, vars: installVars })
          .then(() => {
            servers.setStatus(created.id, "ready");
            audit.record({ event: "server.install.done", serverId: created.id });
          })
          .catch((err: unknown) => {
            servers.setStatus(created.id, "install_failed");
            audit.record({
              event: "server.install.failed",
              serverId: created.id,
              target: { error: err instanceof Error ? err.message : String(err) },
            });
          });
      }
      const fresh = servers.byId(created.id)!;
      res.status(201).json({ server: toPublicServer(fresh, servers.primaryAllocation(fresh.id)) });
    } catch (e) {
      next(e);
    }
  });

  const guard = (perm: string | string[]) => requireServerPermission(perm, deps.db);

  router.get(
    "/servers/:id",
    guard("startup.read"),
    (req: Request, res: Response, next: NextFunction) => {
      const s = servers.byId(req.params.id ?? "");
      if (!s) {
        next(new NotFoundError("Not found"));
        return;
      }
      res.json({ server: toPublicServer(s, servers.primaryAllocation(s.id)) });
    },
  );

  router.patch("/servers/:id", guard("settings.rename"), (req, res, next) => {
    try {
      const body = parseBody(patchServerSchema, req);
      const updated = servers.update(req.params.id ?? "", body);
      if (!updated) throw new NotFoundError("Not found");
      audit.record({
        event: "server.update",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: updated.id,
      });
      res.json({ server: toPublicServer(updated, servers.primaryAllocation(updated.id)) });
    } catch (e) {
      next(e);
    }
  });

  // Re-run the blueprint install ops (download jars again, rewrite configs).
  // Offline-only: installing under a live process would mix old and new files.
  router.post("/servers/:id/install", guard("settings.reinstall"), (req, res, next) => {
    (async () => {
      const id = req.params.id ?? "";
      const s = servers.byId(id);
      if (!s) throw new NotFoundError("Not found");
      if (engine.stateOf(id) !== "offline") {
        throw new ConflictError("Stop the server before reinstalling it");
      }
      const doc = blueprints.getDoc(s.blueprint_slug, s.blueprint_version_tag);
      const vars = storedVariables(deps.db, id, doc.variables ?? []);
      const alloc = servers.primaryAllocation(id);
      if (alloc) {
        vars["allocation.ip"] = alloc.ip;
        vars["allocation.port"] = String(alloc.port);
      }
      servers.setStatus(id, "installing");
      audit.record({
        event: "server.install.start",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
      });
      try {
        await runInstallOps(doc, { serverId: id, dir: join(dataDir, "servers", id), vars });
        servers.setStatus(id, "ready");
        audit.record({ event: "server.install.done", serverId: id });
      } catch (err) {
        servers.setStatus(id, "install_failed");
        audit.record({
          event: "server.install.failed",
          serverId: id,
          target: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
      res.json({ status: "ready" });
    })().catch(next);
  });

  // Startup variables: blueprint declares, panel stores overrides.
  router.get("/servers/:id/variables", guard("startup.read"), (req, res, next) => {
    try {
      const s = servers.byId(req.params.id ?? "");
      if (!s) throw new NotFoundError("Not found");
      const doc = blueprints.getDoc(s.blueprint_slug, s.blueprint_version_tag);
      const values = storedVariables(deps.db, s.id, doc.variables ?? []);
      res.json({
        variables: (doc.variables ?? []).map((v) => ({
          key: v.key,
          label: v.label,
          type: v.type,
          default: String(v.default),
          value: values[v.key] ?? String(v.default),
          editable: v.userEditable && !v.internal,
          options: v.options ?? null,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.put("/servers/:id/variables", guard("startup.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const schema = z.object({
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      });
      const body = parseBody(schema, req);
      const s = servers.byId(req.params.id ?? "");
      if (!s) throw new NotFoundError("Not found");
      const doc = blueprints.getDoc(s.blueprint_slug, s.blueprint_version_tag);
      const defs = new Map((doc.variables ?? []).map((v) => [v.key, v]));
      for (const [key, raw] of Object.entries(body.values)) {
        const def = defs.get(key);
        if (!def) throw new BadRequestError(`Unknown variable '${key}'`);
        if (def.internal || !def.userEditable) {
          throw new ForbiddenError(`Variable '${key}' is managed by the panel`);
        }
        const value = validateVariable(def, raw);
        deps.db
          .prepare(
            `INSERT INTO server_variables (server_id, key, value) VALUES (?,?,?)
             ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`,
          )
          .run(s.id, key, value);
      }
      audit.record({
        event: "server.variables.update",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: s.id,
      });
      res.json({ updated: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/servers/:id", guard("settings.reinstall"), (req, res, next) => {
    (async () => {
      const id = req.params.id ?? "";
      // Stop first: deleting a running server must not orphan its process
      // (or leak its port to the next claimant).
      await engine.kill(id);
      servers.remove(id);
      audit.record({
        event: "server.delete",
        actorUserId: req.principal!.userId,
        actorIp: req.ip,
        requestId: req.requestId,
        serverId: id,
      });
      res.status(204).send();
    })().catch(next);
  });

  // Suspension is an admin-only state flip (FR-023). The running process is
  // killed first: a suspended server must be inert, not merely flagged, and
  // the power API refuses to stop suspended rows — so suspension stops them.
  router.post(
    "/servers/:id/suspend",
    requireAdmin,
    guard("settings.reinstall"),
    (req: Request, res: Response, next: NextFunction) => {
      (async () => {
        const id = req.params.id ?? "";
        await engine.kill(id);
        servers.setStatus(id, "suspended");
        audit.record({
          event: "server.suspend",
          actorUserId: req.principal!.userId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId: req.params.id,
        });
        res.status(204).send();
      })().catch(next);
    },
  );

  router.post(
    "/servers/:id/unsuspend",
    requireAdmin,
    guard("settings.reinstall"),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        servers.setStatus(req.params.id ?? "", "ready");
        audit.record({
          event: "server.unsuspend",
          actorUserId: req.principal!.userId,
          actorIp: req.ip,
          requestId: req.requestId,
          serverId: req.params.id,
        });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}

/** Stored overrides merged over blueprint defaults (allocation context added by callers). */
export function storedVariables(
  db: Database,
  serverId: string,
  declared: Array<{ key: string; default: string | number | boolean }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of declared) out[v.key] = String(v.default);
  if (declared.length === 0) return out;
  const rows = db
    .prepare("SELECT key, value FROM server_variables WHERE server_id = ?")
    .all(serverId) as Array<{ key: string; value: string }>;
  for (const r of rows) {
    if (r.key in out) out[r.key] = r.value;
  }
  return out;
}

/** Coerce + bound a variable value against its blueprint definition. */
export function validateVariable(
  def: {
    key: string;
    type: string;
    options?: string[];
    rules?: { min?: number; max?: number; maxLength?: number; pattern?: string };
  },
  raw: string | number | boolean,
): string {
  const str = String(raw);
  if (str.length > 512) throw new BadRequestError(`Variable '${def.key}' is too long`);
  if (def.type === "integer") {
    const n = Number(str);
    if (!Number.isInteger(n)) throw new BadRequestError(`Variable '${def.key}' must be an integer`);
    if (def.rules?.min !== undefined && n < def.rules.min) {
      throw new BadRequestError(`Variable '${def.key}' is below minimum ${def.rules.min}`);
    }
    if (def.rules?.max !== undefined && n > def.rules.max) {
      throw new BadRequestError(`Variable '${def.key}' is above maximum ${def.rules.max}`);
    }
    return String(n);
  }
  if (def.type === "boolean") {
    if (str !== "true" && str !== "false") {
      throw new BadRequestError(`Variable '${def.key}' must be true or false`);
    }
    return str;
  }
  if (def.type === "enum" && def.options && !def.options.includes(str)) {
    throw new BadRequestError(`Variable '${def.key}' must be one of: ${def.options.join(", ")}`);
  }
  if (def.rules?.maxLength !== undefined && str.length > def.rules.maxLength) {
    throw new BadRequestError(`Variable '${def.key}' exceeds ${def.rules.maxLength} characters`);
  }
  if (def.rules?.pattern && !new RegExp(def.rules.pattern).test(str)) {
    throw new BadRequestError(`Variable '${def.key}' has an invalid format`);
  }
  return str;
}
