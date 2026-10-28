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
import { FilesService, BinaryFileError, ArchiveError } from "../../modules/files/service.js";
import {
  applyPropertyChanges,
  coercePropertyValue,
  parseProperties,
} from "../../modules/files/properties.js";
import { PathEscapeError } from "../../modules/files/confinement.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import { resolve as resolveFsPath, join, basename } from "node:path";
import type { AuditService } from "../../modules/audit/service.js";
import type { Env } from "../../config/env.js";

const MAX_TEXT_WRITE = 2 * 1024 * 1024; // text editor writes bounded; uploads come separately

const listQuery = z.object({ path: z.string().max(1024).default("") });
const contentQuery = z.object({ path: z.string().min(1).max(1024) });
const downloadQuery = z.object({ path: z.string().min(1).max(1024) });
const contentBody = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(MAX_TEXT_WRITE),
});
const mkdirBody = z.object({ path: z.string().min(1).max(1024) });
const renameBody = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });
const deleteBody = z
  .object({
    path: z.string().min(1).max(1024).optional(),
    paths: z.array(z.string().min(1).max(1024)).optional(),
  })
  .refine((data) => Boolean(data.path) || Boolean(data.paths && data.paths.length > 0), {
    message: "Either path or paths must be provided",
  });
const compressBody = z
  .object({
    root: z.string().max(1024).default(""),
    files: z.array(z.string().min(1).max(1024)).min(1).optional(),
    paths: z.array(z.string().min(1).max(1024)).min(1).optional(),
    archiveName: z.string().max(255).optional(),
  })
  .refine(
    (data) =>
      Boolean((data.files && data.files.length > 0) || (data.paths && data.paths.length > 0)),
    {
      message: "Either files or paths must be provided",
    },
  );
const decompressBody = z.object({
  path: z.string().min(1).max(1024),
  destination: z.string().max(1024).default(""),
});
const propertiesBody = z.object({
  /** Key -> new value; only keys present in the file (or defined here) are written. */
  values: z.record(z.string().max(64), z.string().max(1024)),
});

/**
 * server.properties is read through `FilesService.readText`, which caps at
 * MAX_TEXT_PREVIEW_BYTES (2 MiB) and flags the cut. Rewriting a truncated read
 * would erase every key past the cap, so both properties routes refuse it.
 */
const truncatedPropertiesMessage =
  "server.properties is larger than the 2 MiB the panel can edit safely — edit it from the Files tab";

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
        actorApiKeyId: req.principal!.apiKeyId,
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
      // The editor writes whole files, so a save can walk straight past the
      // Properties tab's server-port guard and desync the allocation the
      // engine and tunnel dial. Only an actual change is refused; a save that
      // keeps the current value is allowed through.
      if (basename(body.path) === "server.properties") {
        const requested = parseProperties(body.content).properties.find(
          (p) => p.key === "server-port",
        );
        const alloc = db
          .prepare(
            "SELECT port FROM allocations WHERE server_id = ? AND released = 0 ORDER BY created_at LIMIT 1",
          )
          .get(req.params.id!) as { port: number } | undefined;
        if (requested && alloc && requested.value !== String(alloc.port)) {
          throw new BadRequestError(
            `server-port is managed by the panel allocation (${alloc.port}) — change it on the Network tab, not in the file`,
          );
        }
      }
      files.writeText(root, body.path, body.content);
      audit.record({
        event: "file.write",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
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
        actorApiKeyId: req.principal!.apiKeyId,
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
        actorApiKeyId: req.principal!.apiKeyId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { from: body.from, to: body.to },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.get("/servers/:id/files/download", guard("file.read-content"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const q = parseQuery(downloadQuery, req);
      const root = serverDataDir(env, req.params.id!);
      const file = files.resolveFile(root, q.path);
      if (file.isDir) {
        throw new BadRequestError("Cannot download a directory directly; archive it first");
      }
      audit.record({
        event: "file.download",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: q.path },
      });
      res.download(file.fullPath, file.fileName);
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.post("/servers/:id/files/compress", guard("file.archive"), (req, res, next) => {
    (async () => {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(compressBody, req);
      const root = serverDataDir(env, req.params.id!);
      const targetFiles = body.files ?? body.paths ?? [];
      const archive = await files.compress(root, body.root, targetFiles, body.archiveName);
      audit.record({
        event: "file.compress",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { root: body.root, files: targetFiles, archive },
      });
      res.json({ archive });
    })().catch((e) => next(mapFileError(e)));
  });

  router.post("/servers/:id/files/decompress", guard("file.archive"), (req, res, next) => {
    (async () => {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(decompressBody, req);
      const root = serverDataDir(env, req.params.id!);
      await files.decompress(root, body.path, body.destination);
      audit.record({
        event: "file.decompress",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { path: body.path, destination: body.destination },
      });
      res.status(204).send();
    })().catch((e) => next(mapFileError(e)));
  });

  router.post("/servers/:id/files/delete", guard("file.delete"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(deleteBody, req);
      const root = serverDataDir(env, req.params.id!);
      const targets = body.paths && body.paths.length > 0 ? body.paths : [body.path!];
      files.removeMany(root, targets);
      audit.record({
        event: "file.delete",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { paths: targets },
      });
      res.status(204).send();
    } catch (e) {
      next(mapFileError(e));
    }
  });

  // server.properties as typed fields rather than one textarea. The file is read
  // for real on every request (Minecraft rewrites it on each start), and only
  // the keys sent back are changed — unknown keys and comments survive.
  router.get("/servers/:id/properties", guard("file.read-content"), (req, res, next) => {
    try {
      assertSuspendedReadable(req, res);
      const root = serverDataDir(env, req.params.id!);
      const { content, truncated } = files.readText(root, "server.properties");
      // Say so plainly rather than render a partial file the user would then
      // "save" back over the real one.
      if (truncated) throw new BadRequestError(truncatedPropertiesMessage);
      const parsed = parseProperties(content);
      res.json({
        properties: parsed.properties.map((p) => ({
          key: p.key,
          value: p.value,
          label: p.definition?.label ?? p.key,
          kind: p.definition?.kind ?? "text",
          help: p.definition?.help ?? null,
          group: p.definition?.group ?? "Other",
          options: p.definition?.options ?? null,
          min: p.definition?.min ?? null,
          max: p.definition?.max ?? null,
          readonly: p.definition?.readonly === true,
        })),
      });
    } catch (e) {
      next(mapFileError(e));
    }
  });

  router.put("/servers/:id/properties", guard("file.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(propertiesBody, req);
      const root = serverDataDir(env, req.params.id!);
      const { content, truncated } = files.readText(root, "server.properties");
      // Re-writing a truncated read would silently drop everything past the cap.
      if (truncated) throw new BadRequestError(truncatedPropertiesMessage);
      const parsed = parseProperties(content);
      // Validate every submitted key before writing anything: a rejected value
      // must not leave the file half-updated.
      const accepted: Record<string, string> = {};
      for (const [key, raw] of Object.entries(body.values)) {
        const matches = parsed.properties.filter((p) => p.key === key);
        if (matches.length > 1) {
          // applyPropertyChanges rewrites the first match only, so the later
          // duplicate would keep the old value and win at server boot.
          throw new BadRequestError(
            `'${key}' appears ${matches.length} times in server.properties — fix the duplicates by hand first`,
          );
        }
        const existing = matches[0];
        if (existing?.definition) {
          if (existing.definition.readonly === true) {
            // The engine, allocation table and tunnel all derive the port from
            // the panel's allocation; a hand edit here would desync them.
            throw new BadRequestError(
              `'${key}' is managed by the panel — change it on the Network tab`,
            );
          }
          try {
            accepted[key] = coercePropertyValue(existing.definition, raw);
          } catch (err) {
            throw new BadRequestError(err instanceof Error ? err.message : String(err));
          }
        } else if (existing) {
          // Unknown key: free text, but still no newline injection.
          if (/[\r\n]/.test(raw)) throw new BadRequestError(`'${key}' must be a single line`);
          accepted[key] = raw;
        }
        // A key the file does not contain is ignored rather than invented: the
        // server writes its own defaults and would fight an appended guess.
      }
      files.writeText(root, "server.properties", applyPropertyChanges(content, accepted));
      audit.record({
        event: "server.properties.update",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        serverId: req.params.id!,
        requestId: req.requestId,
        target: { keys: Object.keys(accepted) },
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
  if (e instanceof ArchiveError) return new BadRequestError(e.message);
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return new NotFoundError("No such file");
  if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return new BadRequestError("Already exists");
  return e;
}
