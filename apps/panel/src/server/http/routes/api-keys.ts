import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { ApiKeysRepo } from "../../modules/auth/api-keys.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { parseBody } from "../../shared/validate.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import { permissions } from "@renom/contracts";

const createKeySchema = z.object({
  memo: z.string().max(128).default(""),
  scopes: z.array(z.string().min(1).max(64)).min(1).max(64),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const SCOPE_VOCABULARY = new Set<string>([...permissions, "*"]);

export function apiKeysRouter(keys: ApiKeysRepo, audit: AuditService, auth: AuthService): Router {
  const router = Router();
  router.use(requireAuth(auth));

  router.get("/api-keys", (req: Request, res: Response) => {
    res.json({ keys: keys.listForUser(req.principal!.userId) });
  });

  router.post("/api-keys", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseBody(createKeySchema, req);
      const unknown = body.scopes.filter((s) => !SCOPE_VOCABULARY.has(s));
      if (unknown.length > 0) {
        throw new BadRequestError(`Unknown scope: ${unknown[0]}`);
      }
      const { row, token } = keys.create(req.principal!.userId, {
        memo: body.memo,
        scopes: [...new Set(body.scopes)],
        expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
      });
      audit.record({
        event: "apikey.create",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        target: { keyId: row.id },
      });
      // The secret is shown exactly once, here. It is never stored or re-served.
      res.status(201).json({ key: row, token });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/api-keys/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const ok = keys.revoke(req.params.id ?? "", req.principal!.userId);
      if (!ok) throw new NotFoundError("API key not found");
      audit.record({
        event: "apikey.revoke",
        actorUserId: req.principal!.userId,
        actorApiKeyId: req.principal!.apiKeyId,
        actorIp: req.ip,
        requestId: req.requestId,
        target: { keyId: req.params.id },
      });
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
