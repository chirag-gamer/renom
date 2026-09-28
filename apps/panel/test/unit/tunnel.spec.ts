import { describe, expect, it } from "vitest";
import { endpointValid, generateEndpointName } from "../../src/server/modules/tunnels/minekube.js";

describe("tunnel endpoint names", () => {
  it("accepts only the Connect grammar the panel documents", () => {
    expect(endpointValid("vivid-lagoon-9784")).toBe(true);
    expect(endpointValid("amber-9784")).toBe(true);
  });

  it("rejects names the connector would silently refuse", () => {
    // Too short, leading digit, no numeric suffix, doubled dash, trailing dash.
    expect(endpointValid("ab")).toBe(false);
    expect(endpointValid("9lives-9784")).toBe(false);
    expect(endpointValid("vivid-lagoon")).toBe(false);
    expect(endpointValid("vivid--lagoon-9784")).toBe(false);
    expect(endpointValid("vivid-lagoon-")).toBe(false);
    // Injection-ish input can never validate.
    expect(endpointValid("vivid;rm -rf-9784")).toBe(false);
  });

  it("mints names that always validate and are not sequential", () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const name = generateEndpointName();
      expect(endpointValid(name)).toBe(true);
      names.add(name);
    }
    // 24 * 24 * 10000 candidates: collisions in 200 draws would mean the
    // generator collapsed onto a tiny space.
    expect(names.size).toBeGreaterThan(195);
  });
});
