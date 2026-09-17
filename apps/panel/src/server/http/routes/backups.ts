import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { BackupsService } from "../../modules/backups/service.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission } from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import { createReadStream, statSync } from "node:fs";

const createBackupSchema = z.object({
  locked: z.boolean().optional(),
});

export interface BackupsDeps {
  db: Database;
  backups: BackupsService;
  audit: AuditService;
  auth: AuthService;
}

export function backupsRouter(deps: BackupsDeps): Router {
  const { db, backups, audit, auth } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  const auditIt = (
    req: Request,
    event: string,
    serverId: string,
    target?: Record<string, unknown>,
  ) =>
    audit.record({
      event,
      actorUserId: req.principal!.userId,
      actorApiKeyId: req.principal!.apiKeyId,
      actorIp: req.ip,
      requestId: req.requestId,
      serverId,
      target,
    });

  router.get("/servers/:id/backups", guard("backup.read"), (req, res) => {
    const items = backups.list(req.params.id ?? "").map((b) => ({
      id: b.id,
      fileName: b.file_name,
      checksumSha256: b.checksum_sha256,
      bytes: b.bytes,
      locked: b.locked === 1,
      consistency: b.consistency,
      createdAt: b.created_at,
    }));
    res.json({ backups: items });
  });

  router.post("/servers/:id/backups", guard("backup.create"), (req, res, next) => {
    try {
      const body = parseBody(createBackupSchema, req);
      const serverId = req.params.id ?? "";
      const record = backups.create(serverId, req.principal!.userId, { locked: body.locked });
      auditIt(req, "backup.create", serverId, { backupId: record.id });
      res.status(201).json({
        backup: { id: record.id, bytes: record.bytes, consistency: record.consistency },
      });
    } catch (e) {
      next(e);
    }
  });

  router.get(
    "/servers/:id/backups/:backupId/download",
    guard("backup.download"),
    (req, res, next) => {
      try {
        const record = backups.byId(req.params.backupId ?? "");
        if (!record || record.server_id !== (req.params.id ?? "")) {
          res.status(404).json({ error: { code: "not_found", message: "Not found" } });
          return;
        }
        const file = backups.pathFor(record);
        const size = statSync(file).size;
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Disposition", `attachment; filename="${record.file_name}"`);
        res.setHeader("Content-Length", String(size));
        createReadStream(file).on("error", next).pipe(res);
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/servers/:id/backups/:backupId/restore",
    guard("backup.restore"),
    (req, res, next) => {
      try {
        const serverId = req.params.id ?? "";
        const record = backups.byId(req.params.backupId ?? "");
        if (!record || record.server_id !== serverId) {
          res.status(404).json({ error: { code: "not_found", message: "Not found" } });
          return;
        }
        backups.restore(record.id);
        auditIt(req, "backup.restore", serverId, { backupId: record.id });
        res.json({ restored: true });
      } catch (e) {
        next(e);
      }
    },
  );

  router.delete("/servers/:id/backups/:backupId", guard("backup.delete"), (req, res, next) => {
    try {
      const serverId = req.params.id ?? "";
      const record = backups.byId(req.params.backupId ?? "");
      if (!record || record.server_id !== serverId) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      backups.remove(record.id);
      auditIt(req, "backup.delete", serverId, { backupId: record.id });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
