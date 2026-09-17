import { createHash } from "node:crypto";
import type { Database } from "../../infra/db/database.js";
import { ulid } from "../../shared/ulid.js";
import { blueprintDocSchema, type BlueprintDoc } from "./schema.js";
import { BUILTIN_BLUEPRINTS } from "./builtin-catalog.js";
import { ValidationError, NotFoundError } from "../../shared/errors.js";

export interface BlueprintSummary {
  slug: string;
  name: string;
  category: string;
  tag: string;
  enabled: boolean;
  source: string;
  maturity: string;
}

/**
 * DB-backed blueprint registry (FR-040/045/140).
 * - Built-ins are seeded idempotently at boot and validated against schema v1.
 * - Imported docs are validated, hashed, versioned, and stored as history.
 * - A corrupted/invalid builtin fails LOUDLY at boot (never silently skipped) —
 *   the opposite of upstream's silent hardcoded fallback.
 */
export class BlueprintRegistry {
  constructor(private readonly db: Database) {}

  /** Seed built-ins; returns slugs seeded on THIS call (empty when already present). */
  seedBuiltins(now = Date.now()): string[] {
    const seeded: string[] = [];
    for (const doc of BUILTIN_BLUEPRINTS) {
      const parsed = blueprintDocSchema.safeParse(doc);
      if (!parsed.success) {
        throw new Error(
          `builtin blueprint '${(doc as { slug?: string }).slug}' failed validation: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const exists = this.db.prepare("SELECT id FROM blueprints WHERE slug = ?").get(doc.slug) as
        { id: string } | undefined;
      const maturity = parsed.data.maturity;
      if (exists) {
        // Converge catalog edits (maturity flips, renames) on every boot.
        this.db
          .prepare("UPDATE blueprints SET maturity = ?, updated_at = ? WHERE slug = ?")
          .run(maturity, now, doc.slug);
        // Re-store the document when the shipped content changed: fixes to
        // install ops, checksums, and commands must reach existing installs.
        const current = this.db
          .prepare("SELECT sha256 FROM blueprint_versions WHERE blueprint_id = ? AND tag = ?")
          .get(exists.id, parsed.data.tag) as { sha256: string } | undefined;
        if (!current || current.sha256 !== sha256(JSON.stringify(parsed.data))) {
          this.storeVersion(exists.id, parsed.data, now);
        }
        continue;
      }
      const id = ulid(now);
      this.db
        .prepare(
          `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,docs_url,maturity,created_at,updated_at)
           VALUES (?,?,?,?,?,1,'builtin',?,?,?,?)`,
        )
        .run(
          id,
          doc.slug,
          doc.name,
          doc.category,
          doc.tag,
          doc.docsUrl ?? null,
          maturity,
          now,
          now,
        );
      this.storeVersion(id, parsed.data, now);
      seeded.push(doc.slug);
    }
    return seeded;
  }

  storeVersion(blueprintId: string, doc: BlueprintDoc, now = Date.now()): void {
    const json = JSON.stringify(doc);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO blueprint_versions (blueprint_id, tag, schema_version, doc, sha256, published_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(blueprintId, doc.tag, doc.schemaVersion, json, sha256(json), now);
    this.db
      .prepare("UPDATE blueprints SET latest_tag = ?, updated_at = ? WHERE id = ?")
      .run(doc.tag, now, blueprintId);
  }

  /** Validate + import a document; creates or updates the blueprint entry. */
  importDoc(
    raw: unknown,
    source: "import" | "registry" = "import",
    registryUrl?: string,
  ): { slug: string; tag: string } {
    const parsed = blueprintDocSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        "Blueprint failed schema v1 validation",
      );
    }
    const doc = parsed.data;
    const now = Date.now();
    const existing = this.db.prepare("SELECT id FROM blueprints WHERE slug = ?").get(doc.slug) as
      { id: string } | undefined;
    let id: string;
    if (existing) {
      id = existing.id;
      this.db
        .prepare(
          "UPDATE blueprints SET name=?, category=?, latest_tag=?, maturity=?, updated_at=? WHERE id=?",
        )
        .run(doc.name, doc.category, doc.tag, doc.maturity, now, id);
    } else {
      id = ulid(now);
      this.db
        .prepare(
          `INSERT INTO blueprints (id,slug,name,category,latest_tag,enabled,source,registry_url,maturity,created_at,updated_at)
           VALUES (?,?,?,?,?,1,?,?,?, ?,?)`,
        )
        .run(
          id,
          doc.slug,
          doc.name,
          doc.category,
          doc.tag,
          source,
          registryUrl ?? null,
          doc.maturity,
          now,
          now,
        );
    }
    this.storeVersion(id, doc, now);
    return { slug: doc.slug, tag: doc.tag };
  }

  list(includeDisabled = false): BlueprintSummary[] {
    const rows = this.db
      .prepare(
        `SELECT slug,name,category,latest_tag,enabled,source,maturity FROM blueprints
         ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY category, name`,
      )
      .all() as Array<{
      slug: string;
      name: string;
      category: string;
      latest_tag: string;
      enabled: number;
      source: string;
      maturity: string;
    }>;
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.category,
      tag: r.latest_tag,
      enabled: r.enabled === 1,
      source: r.source,
      maturity: r.maturity ?? "stable",
    }));
  }

  /** Resolve a slug to its row for server creation (throws NotFound when unknown/disabled). */
  lookup(slug: string): { id: string; slug: string; latestTag: string } {
    const bp = this.db
      .prepare("SELECT id, slug, latest_tag, enabled FROM blueprints WHERE slug = ?")
      .get(slug) as { id: string; slug: string; latest_tag: string; enabled: number } | undefined;
    if (!bp || bp.enabled !== 1) throw new NotFoundError(`Unknown blueprint '${slug}'`);
    return { id: bp.id, slug: bp.slug, latestTag: bp.latest_tag };
  }

  getDoc(slug: string, tag?: string): BlueprintDoc {
    const bp = this.db.prepare("SELECT id, latest_tag FROM blueprints WHERE slug = ?").get(slug) as
      { id: string; latest_tag: string } | undefined;
    if (!bp) throw new NotFoundError(`Unknown blueprint '${slug}'`);
    const row = this.db
      .prepare("SELECT doc FROM blueprint_versions WHERE blueprint_id = ? AND tag = ?")
      .get(bp.id, tag ?? bp.latest_tag) as { doc: string } | undefined;
    if (!row) throw new NotFoundError(`Blueprint '${slug}' has no version ${tag ?? bp.latest_tag}`);
    return JSON.parse(row.doc) as BlueprintDoc;
  }

  setEnabled(slug: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE blueprints SET enabled = ?, updated_at = ? WHERE slug = ?")
      .run(enabled ? 1 : 0, Date.now(), slug);
  }

  count(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM blueprints").get() as { n: number };
    return Number(r.n);
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
