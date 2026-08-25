import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../../modules/auth/service.js";
import { toPublicUser } from "../../modules/auth/service.js";
import type { UsersRepo } from "../../modules/users/repo.js";
import { requireAuth } from "../middleware/authn.js";

export function authRouter(auth: AuthService, users: UsersRepo): Router {
  const router = Router();

  router.post("/auth/login", async (req, res, next) => {
    try {
      const schema = z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(256),
      });
      const body = schema.parse(req.body);
      const ip = req.ip ?? "unknown";
      const result = await auth.login(body.username, body.password, {
        ip,
        requestId: req.requestId,
      });
      res.status(200).json({ token: result.token, user: result.user });
    } catch (err) {
      next(err);
    }
  });

  // Stateless JWT logout: client discards token; event recorded for the audit trail.
  router.post("/auth/logout", (_req, res) => {
    res.status(204).send();
  });

  router.get("/auth/me", requireAuth(auth), (req, res) => {
    const p = req.principal!;
    const user = users.byId(p.userId);
    if (!user) {
      res.status(401).json({ error: { code: "unauthorized", message: "Session no longer valid" } });
      return;
    }
    res.json({ user: toPublicUser(user), permissions: [] });
  });

  return router;
}
