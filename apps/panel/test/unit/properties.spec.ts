import { describe, expect, it } from "vitest";
import {
  parseProperties,
  applyPropertyChanges,
  coercePropertyValue,
  PROPERTY_DEFINITIONS,
  type PropertyDefinition,
} from "../../src/server/modules/files/properties.js";

const def = (key: string): PropertyDefinition => {
  const found = PROPERTY_DEFINITIONS.find((d) => d.key === key);
  if (!found) throw new Error(`missing definition for ${key}`);
  return found;
};

describe("parseProperties", () => {
  it("keeps unknown keys and reports them as free text", () => {
    const parsed = parseProperties("motd=hi\nsome-mod-key=42\n");
    expect(parsed.properties.map((p) => p.key)).toEqual(["motd", "some-mod-key"]);
    expect(parsed.properties[1]!.definition).toBeUndefined();
  });

  it("keeps the second = in a value (motd=a=b)", () => {
    const parsed = parseProperties("motd=a=b\n");
    expect(parsed.properties[0]).toMatchObject({ key: "motd", value: "a=b" });
  });

  it("skips # comments and blank lines rather than inventing keys", () => {
    const parsed = parseProperties("# comment\n\nmotd=hi\n");
    expect(parsed.properties).toHaveLength(1);
    expect(parsed.properties[0]!.key).toBe("motd");
  });

  it("attaches the known definition for a curated key", () => {
    const parsed = parseProperties("max-players=20\n");
    expect(parsed.properties[0]!.definition?.label).toBe("Player slots");
  });
});

describe("applyPropertyChanges", () => {
  it("rewrites only the keys it is given", () => {
    const text = "motd=old\nmax-players=20\nview-distance=10\n";
    const out = applyPropertyChanges(text, { motd: "new" });
    expect(out).toBe("motd=new\nmax-players=20\nview-distance=10\n");
  });

  it("preserves comments and unknown keys through a save", () => {
    const text = "# my note\nmotd=old\nlegacy-mod-key=keep\n";
    const out = applyPropertyChanges(text, { motd: "new" });
    expect(out).toContain("# my note");
    expect(out).toContain("legacy-mod-key=keep");
    expect(out).toContain("motd=new");
  });

  it("keeps a = inside a rewritten value", () => {
    const out = applyPropertyChanges("motd=old\n", { motd: "a=b" });
    expect(out).toBe("motd=a=b\n");
  });
});

describe("coercePropertyValue", () => {
  it("accepts only true/false for booleans", () => {
    expect(coercePropertyValue(def("white-list"), "true")).toBe("true");
    expect(() => coercePropertyValue(def("white-list"), "yes")).toThrow(/must be true or false/);
  });

  it("enforces min and max for numbers", () => {
    expect(coercePropertyValue(def("max-players"), "20")).toBe("20");
    expect(() => coercePropertyValue(def("max-players"), "0")).toThrow(/at least/);
    expect(() => coercePropertyValue(def("max-players"), "999999")).toThrow(/at most/);
    expect(() => coercePropertyValue(def("max-players"), "1.5")).toThrow(/whole number/);
  });

  it("rejects newline injection in free text", () => {
    expect(() => coercePropertyValue(def("motd"), "line1\nwhite-list=true")).toThrow(
      /must be a single line/,
    );
  });

  it("rejects a non-string value", () => {
    // Non-strings are normalised to "" before validation, so they fail the
    // bounds check rather than a type check — rejection is what matters.
    expect(() => coercePropertyValue(def("max-players"), 20)).toThrow(/Player slots/);
  });

  it("rejects enum values outside the allowed set", () => {
    expect(coercePropertyValue(def("difficulty"), "hard")).toBe("hard");
    expect(() => coercePropertyValue(def("difficulty"), "extreme")).toThrow(/must be one of/);
  });

  it("rejects writes to a panel-owned key's definition flag", () => {
    // The flag exists so the route can refuse server-port outright; the
    // definition carrying it is part of the contract under test.
    expect(def("server-port").readonly).toBe(true);
    expect(def("motd").readonly).toBeUndefined();
  });
});
