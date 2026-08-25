import { z } from "zod";

/**
 * Blueprint schema v1 (docs/extensions/BLUEPRINT-SPEC.md, FR-040).
 * Data-only by design (ADR-0004): declarative ops only; run.command MUST be an argv
 * template array — arbitrary shell strings are structurally impossible here.
 */

const slugRe = /^[a-z][a-z0-9-]{1,31}$/;
const semverTag = /^v\d+(\.\d+)?$/;

export const resolverKindSchema = z.enum([
  "mojang-manifest",
  "papermc-fill",
  "purpur-v2",
  "fabric-meta",
  "forge-promotions",
  "neoforge-maven",
  "bds-registry",
  "modrinth",
  "static",
]);

export const installOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("download"),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    dest: z.string().min(1),
    maxMB: z.number().int().min(1).max(2048),
  }),
  z.object({
    op: z.literal("extract"),
    src: z.string().min(1),
    dest: z.string().min(1),
    strip: z.number().int().min(0).max(8).default(0),
    safe: z.boolean(), // must be explicitly true; zip-slip guard required
  }),
  z.object({
    op: z.literal("writefile"),
    path: z.string().min(1),
    contentTemplate: z.string().max(65536),
  }),
  z.object({ op: z.literal("mkdir"), path: z.string().min(1) }),
  z.object({ op: z.literal("move"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ op: z.literal("chmod"), path: z.string().min(1), mode: z.number().int() }),
  z.object({ op: z.literal("delete"), path: z.string().min(1) }),
  z.object({ op: z.literal("fetch-vanilla"), version: z.string().min(1) }),
  z.object({
    op: z.literal("fetch-paper"),
    version: z.string().min(1),
    buildChannel: z.enum(["default", "experimental"]).optional(),
  }),
  z.object({ op: z.literal("fetch-purpur"), version: z.string().min(1) }),
  z.object({
    op: z.literal("fetch-fabric"),
    mcVersion: z.string().min(1),
    loaderVersion: z.string().optional(),
  }),
  z.object({ op: z.literal("fetch-neoforge"), mcVersion: z.string().min(1) }),
  z.object({ op: z.literal("fetch-forge"), mcVersion: z.string().min(1) }),
  z.object({
    op: z.literal("fetch-bds"),
    channel: z.enum(["stable", "preview"]).default("stable"),
  }),
  z.object({ op: z.literal("fetch-velocity"), version: z.string().min(1) }),
  z.object({ op: z.literal("eula-accept") }),
  z.object({ op: z.literal("modrinth-install"), projects: z.array(z.string().min(1)).min(1) }),
  z.object({
    op: z.literal("template-render"),
    src: z.string().min(1),
    dest: z.string().min(1),
  }),
]);

export const variableSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  label: z.string().min(1).max(128),
  type: z.enum(["string", "integer", "boolean", "enum"]),
  default: z.union([z.string(), z.number(), z.boolean()]),
  userViewable: z.boolean().default(true),
  userEditable: z.boolean().default(true),
  internal: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  rules: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      maxLength: z.number().optional(),
      pattern: z.string().max(256).optional(),
      required: z.boolean().optional(),
    })
    .optional(),
});

export const portSchema = z.object({
  name: z.string().min(1).max(32),
  protocol: z.enum(["tcp", "udp"]),
  default: z.number().int().min(1024).max(65535),
  required: z.boolean().default(true),
});

export const blueprintDocSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(slugRe),
  name: z.string().min(1).max(64),
  category: z.enum([
    "minecraft-java",
    "minecraft-bedrock",
    "proxy",
    "generic-runtime",
    "generic-process",
  ]),
  description: z.string().max(512).default(""),
  docsUrl: z.string().url().optional(),
  tag: z.string().regex(semverTag).default("v1"),
  requirements: z.object({
    engine: z.enum(["docker", "process"]),
    arch: z.array(z.enum(["amd64", "arm64"])).min(1),
    hostOs: z.array(z.enum(["linux", "windows"])).min(1),
  }),
  resolvers: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        kind: resolverKindSchema,
        project: z.string().max(64).optional(),
        /** static resolvers declare their versions inline (no network). */
        versions: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  versions: z
    .object({
      javaMapping: z
        .array(
          z.object({
            mcRange: z.string().min(1).max(32),
            image: z.string().min(1).max(128),
          }),
        )
        .optional(),
    })
    .default({}),
  image: z.string().min(1).max(160), // runtime container image for this blueprint
  install: z.array(installOpSchema).max(64),
  uninstall: z.array(installOpSchema).max(64).optional(),
  run: z.object({
    command: z.array(z.string().max(4096)).min(1), // argv template; never a shell string
    workdir: z.string().max(256).default("/data"),
    stop: z.object({
      kind: z.enum(["console", "signal"]),
      command: z.string().max(256).optional(),
      signal: z.enum(["SIGTERM", "SIGINT"]).optional(),
      timeoutSec: z.number().int().min(1).max(300).default(30),
    }),
    envCanon: z.record(z.string(), z.string().max(512)).default({}),
  }),
  variables: z.array(variableSchema).max(64).default([]),
  ports: z.array(portSchema).max(16).default([]),
  healthcheck: z
    .object({
      kind: z.enum(["tcp", "none"]),
      port: z.string().max(32).optional(), // named port reference
      timeoutSec: z.number().int().min(1).max(120).default(10),
      startPeriodSec: z.number().int().min(0).max(600).default(90),
    })
    .default({ kind: "none", timeoutSec: 10, startPeriodSec: 90 }),
  backupPolicy: z
    .object({ consistency: z.enum(["stopped", "best-effort"]).default("best-effort") })
    .default({ consistency: "best-effort" }),
  update: z
    .object({
      strategy: z.enum(["resolver-refetch", "none"]).default("none"),
      onStart: z.boolean().default(false),
    })
    .default({ strategy: "none", onStart: false }),
  fileDenylist: z.array(z.string().max(128)).max(64).default([]),
  features: z.array(z.enum(["eula", "query"])).default([]),
});

export type BlueprintDoc = z.infer<typeof blueprintDocSchema>;
/** Input form (defaults not yet applied) — used for literal catalogs. */
export type BlueprintDocInput = z.input<typeof blueprintDocSchema>;
export type InstallOp = z.infer<typeof installOpSchema>;
export type BlueprintVariable = z.infer<typeof variableSchema>;

/** Java mapping enforcement helper (FR-044). Returns matching image or null. */
export function javaImageForVersion(doc: BlueprintDoc, mcVersion: string): string | null {
  const mappings = doc.versions.javaMapping ?? [];
  for (const m of mappings) {
    if (rangeMatches(m.mcRange, mcVersion)) return m.image;
  }
  return null;
}

/** Supports ">=26", "1.20.5 - 1.21.x", and exact "1.21.1". */
export function rangeMatches(range: string, version: string): boolean {
  const v = parseMc(version);
  if (!v) return false;
  const m = /^\s*(>=|<=|>)?\s*([\d.]+)\s*(?:-\s*(<=)?\s*([\dx.*]+))?\s*$/.exec(range);
  if (!m) return range === version;
  const [, lowOpRaw, lowStr, , highStr] = m;
  const lowOp = lowOpRaw ?? ">=";
  const low = parseMc(lowStr ?? "");
  if (!low) return false;

  if (lowOp === ">=" && cmp(v, low) < 0) return false;
  if (lowOp === ">" && cmp(v, low) <= 0) return false;

  if (!highStr) {
    if (!lowOpRaw && cmp(v, low) !== 0) return false;
    return true;
  }

  if (/\.x$|\*$/.test(highStr)) {
    const base = highStr.replace(/\.x$/, "").replace(/\*$/, "").replace(/\.$/, "");
    const hb = parseMc(base);
    if (!hb) return false;
    if (v[0] === hb[0] && v[1] === hb[1]) return true;
    const nextFamily: [number, number, number] = [hb[0], hb[1] + 1, 0];
    if (cmp(v, nextFamily) >= 0) return false;
    return true;
  }

  const high = parseMc(highStr);
  if (!high) return false;
  return cmp(v, high) <= 0; // inclusive upper bound
}

function parseMc(s: string): [number, number, number] | null {
  const parts = s.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
