import { describe, expect, it } from "vitest";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { confineWorkdir, substitute } from "../../src/server/modules/runtime/engine.js";
import { confine } from "../../src/server/modules/runtime/install.js";

const ROOT = resolve(tmpdir(), "renom-confine-test");

describe("workdir mapping", () => {
  it("treats /data as the server root, nests deeper paths", () => {
    expect(confineWorkdir(ROOT, "/data")).toBe(ROOT);
    expect(confineWorkdir(ROOT, "/")).toBe(ROOT);
    expect(confineWorkdir(ROOT, "")).toBe(ROOT);
    expect(confineWorkdir(ROOT, "/data/app")).toBe(join(ROOT, "app"));
    expect(confineWorkdir(ROOT, "app")).toBe(join(ROOT, "app"));
  });

  it("refuses escape", () => {
    expect(() => confineWorkdir(ROOT, "/data/../../etc")).toThrow(/escapes/);
    expect(() => confineWorkdir(ROOT, "..")).toThrow(/escapes/);
  });
});

describe("install path confinement", () => {
  it("keeps op paths inside the server dir", () => {
    expect(confine(ROOT, "paper.jar")).toBe(join(ROOT, "paper.jar"));
    expect(confine(ROOT, "plugins/x.jar")).toBe(join(ROOT, "plugins", "x.jar"));
    expect(() => confine(ROOT, "../../evil")).toThrow(/escapes/);
    expect(confine(ROOT, "/abs")).toBe(join(ROOT, "abs"));
  });
});

describe("variable substitution", () => {
  it("replaces known keys, leaves unknown literal", () => {
    expect(substitute("motd={MOTD} x={MISSING}", { MOTD: "hi" })).toBe("motd=hi x={MISSING}");
  });
});
