import { describe, expect, it } from "vitest";
import {
  addressForEndpoint,
  endpointValid,
  generateEndpointName,
  resolveJoinAddress,
} from "../../src/server/modules/tunnels/minekube.js";

describe("tunnel endpoint names", () => {
  it("derives the address Connect publishes for a reserved endpoint", () => {
    // The plugin prints this exact string; the panel needs it without the line,
    // because a busy server pushes it out of the retained console history.
    expect(addressForEndpoint("noble-fjord-2128")).toBe("noble-fjord-2128.play.minekube.net");
  });
  it("accepts only the Connect grammar the panel documents within 16 chars", () => {
    expect(endpointValid("noble-fjord-2128")).toBe(true);
    expect(endpointValid("calm-fjord-9784")).toBe(true);
    expect(endpointValid("amber-9784")).toBe(true);
  });

  it("rejects names the connector would silently refuse", () => {
    // Too short, leading digit, no numeric suffix, doubled dash, trailing dash.
    expect(endpointValid("ab")).toBe(false);
    expect(endpointValid("9lives-9784")).toBe(false);
    expect(endpointValid("vivid-lagoon")).toBe(false);
    expect(endpointValid("vivid--lagoon-9784")).toBe(false);
    expect(endpointValid("vivid-lagoon-")).toBe(false);
    // Over 16 characters (WatchService rejects with HTTP 400 invalid endpoint name format).
    expect(endpointValid("vivid-lagoon-9784")).toBe(false);
    expect(endpointValid("mellow-atlas-9245")).toBe(false);
    // Injection-ish input can never validate.
    expect(endpointValid("vivid;rm -rf-9784")).toBe(false);
  });

  it("mints names that always validate and are not sequential", () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const name = generateEndpointName();
      expect(endpointValid(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(16);
      names.add(name);
    }
    // Combinations <= 16 chars with 10000 suffixes: collisions in 200 draws
    // would mean the generator collapsed onto a tiny space.
    expect(names.size).toBeGreaterThan(195);
  });
});

describe("tunnel join address selection", () => {
  const printed = "noble-fjord-2128.play.minekube.net";

  it("uses the plugin's printed line while it names the reserved endpoint", () => {
    expect(resolveJoinAddress(printed, "noble-fjord-2128")).toBe(printed);
  });

  it("ignores a printed line left by a previous endpoint after a rename", () => {
    // The engine keeps the last run's scrollback while the server is stopped
    // (engine.ts history), so renaming the tunnel offline leaves the old
    // endpoint's line in it; that address is no longer dialable.
    expect(resolveJoinAddress(printed, "calm-fjord-9784")).toBe(
      "calm-fjord-9784.play.minekube.net",
    );
  });

  it("derives the address once the printed line has scrolled away", () => {
    expect(resolveJoinAddress(null, "noble-fjord-2128")).toBe("noble-fjord-2128.play.minekube.net");
  });

  it("falls back to the printed line when no endpoint is reserved", () => {
    expect(resolveJoinAddress(printed, null)).toBe(printed);
    expect(resolveJoinAddress(null, null)).toBe(null);
  });

  it("returns null when the reserved endpoint is overlong or invalid", () => {
    expect(resolveJoinAddress(printed, "mellow-atlas-9245")).toBe(null);
    expect(resolveJoinAddress(null, "vivid-lagoon-9784")).toBe(null);
    expect(resolveJoinAddress(printed, "")).toBe(null);
    expect(resolveJoinAddress(null, "")).toBe(null);
  });
});
