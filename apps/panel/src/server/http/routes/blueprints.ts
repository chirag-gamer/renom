import { Router } from "express";
import { z } from "zod";
import type { BlueprintRegistry } from "../../modules/blueprints/registry.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth, requireAdmin } from "../middleware/authn.js";
import { parseQuery } from "../../shared/validate.js";
import { javaImageForVersion } from "../../modules/blueprints/schema.js";
import { BadRequestError } from "../../shared/errors.js";

const versionsQuery = z.object({ mc: z.string().max(32).optional() });

/** Blueprint catalog API. Authenticated users browse; admin-only import. */
export function blueprintsRouter(registry: BlueprintRegistry, auth: AuthService): Router {
  const router = Router();
  router.use(requireAuth(auth));

  router.get("/blueprints", (_req, res) => {
    res.json({ items: registry.list() });
  });

  router.get("/blueprints/:slug", (req, res, next) => {
    try {
      const doc = registry.getDoc(req.params.slug ?? "");
      const { variables, ports, run, healthcheck, backupPolicy, features } = doc;
      res.json({
        slug: doc.slug,
        name: doc.name,
        category: doc.category,
        description: doc.description,
        tag: doc.tag,
        requirements: doc.requirements,
        variables,
        ports,
        stop: run.stop,
        healthcheck,
        backupPolicy,
        features,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get("/blueprints/:slug/versions", (req, res, next) => {
    try {
      const q = parseQuery(versionsQuery, req);
      const doc = registry.getDoc(req.params.slug ?? "");
      const staticVersions = doc.resolvers
        .filter((r) => r.kind === "static")
        .flatMap((r) => r.versions ?? []);
      let items = staticVersions;
      if (q.mc && items.length > 0) {
        items = items.filter((v) => v === q.mc || q.mc!.startsWith(v));
      }
      const image = q.mc ? javaImageForVersion(doc, q.mc) : null;
      if (
        q.mc &&
        image === null &&
        doc.versions.javaMapping &&
        doc.versions.javaMapping.length > 0
      ) {
        throw new BadRequestError(
          `Minecraft ${q.mc} has no supported Java mapping for blueprint '${doc.slug}' (FR-044)`,
        );
      }
      res.json({
        slug: doc.slug,
        items,
        resolvedImage: image ?? doc.image,
        source: doc.resolvers.map((r) => ({ id: r.id, kind: r.kind })),
        note:
          staticVersions.length === 0 && !q.mc
            ? "versions resolve live from upstream APIs at create time; cached <=6h (FR-041)"
            : undefined,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post("/blueprints/import", requireAdmin, (req, res, next) => {
    try {
      const result = registry.importDoc(req.body, "import");
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
