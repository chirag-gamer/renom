import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import {
  requireServerPermission,
  assertNotSuspendedForMutation,
  assertSuspendedReadable,
} from "../middleware/authz.js";
import { requireAuth } from "../middleware/authn.js";
import type { AuthService } from "../../modules/auth/service.js";
import { parseQuery, parseBody } from "../../shared/validate.js";
import { FilesService, BinaryFileError } from "../../modules/files/service.js";
import { PathEscapeError } from "../../modules/files/confinement.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import { resolve as resolveFsPath, join } from "node:path";
import type { AuditService } from "../../modules/audit/service.js";
import type { Env } from "../../config/env.js";

const MAX_TEXT_WRITE = 2 * 1024 * 1024; // text editor writes bounded; uploads come separately

const listQuery = z.object({ path: z.string().max(1024).default("") });
const contentQuery = z.object({ path: z.string().min(1).max(1024) });
const contentBody = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(MAX_TEXT_WRITE),
});
const mkdirBody = z.object({ path: z.string().min(1).max(1024) });
const renameBody = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });
const deleteBody = z.object({ path: z.string().min(1).max(1024) });

/** Server file directories live at <DATA_DIR>/servers/<id> (matches JTG importer layout). */
export function serverDataDir(env: Env, serverId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverId)) {
    throw new BadRequestError("invalid server id");
  }
  return resolveFsPath(join(env.DATA_DIR, "servers", serverId));
}

export function filesRouter(
  db: Database,
  env: Env,
  files: FilesService,
  audit: AuditService,
  auth: AuthService,
): Router {
  const router = Router();

  // Router-level auth is safe here: this router only serves /servers/:id/files/*.
  router.use(requireAuth(auth));

  const guard = (perm: string) => requireServerPermission(perm, db);

  router.get("/servers/:id/files", guard("file.read"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const q = parseQuery(listQuery, req);
      const root = serverDataDir(env, req.params.id!);
      const entries = files.list(root, q.path);
      res.json({ path: q.path, items: entries });
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.get("/servers/:id/files/content", guard("file.read-content"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const q = parseQuery(contentQuery, req);
      const root = serverDataDir(env, req.params.id!);
      const result = files.readText(root, q.path);
      audit.record({
        event: "file.read",
        actorUserId: req.principal!.userId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: q.path },
      });
      res.json({ path: q.path, ...result });
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.put("/servers/:id/files/content", guard("file.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(contentBody, req);
      const root = serverDataDir(env, req.params.id!);
      files.writeText(root, body.path, body.content);
      audit.record({
        event: "file.write",
        actorUserId: req.principal!.userId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: body.path, bytes: Buffer.byteLength(body.content) },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.post("/servers/:id/files/mkdir", guard("file.create"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(mkdirBody, req);
      const root = serverDataDir(env, req.params.id!);
      files.createDirectory(root, body.path);
      audit.record({
        event: "file.create",
        actorUserId: req.principal!.userId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: body.path, kind: "directory" },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.post("/servers/:id/files/rename", guard("file.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(renameBody, req);
      const root = serverDataDir(env, req.params.id!);
      files.rename(root, body.from, body.to);
      audit.record({
        event: "file.rename",
        actorUserId: req.principal!.userId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { from: body.from, to: body.to },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.post("/servers/:id/files/delete", guard("file.delete"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(deleteBody, req);
      const root = serverDataDir(env, req.params.id!);
      files.remove(root, body.path);
      audit.record({
        event: "file.delete",
        actorUserId: req.principal!.userId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: body.path },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  return router;
}

function mapFileError(e: unknown): unknown {
  if (e instanceof PathEscapeError) return new BadRequestError(e.message);
  if (e instanceof BinaryFileError) return new BadRequestError(e.message);
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return new NotFoundError("No such file");
  if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return new BadRequestError("Already exists");
  return e;
}
