import { describe, expect, it } from "vitest";
import { cpuCores } from "../../src/server/modules/runtime/engine.js";

describe("cpu limit to JVM processor count", () => {
  it("maps a percentage of one core to whole cores, rounding up", () => {
    expect(cpuCores(100)).toBe(1);
    expect(cpuCores(150)).toBe(2);
    expect(cpuCores(200)).toBe(2);
    expect(cpuCores(300)).toBe(3);
    expect(cpuCores(1000)).toBe(10);
  });

  it("treats an absent or non-positive weight as unlimited, never as one core", () => {
    // 0 is the default for a fresh server: capping it to a single core would
    // silently throttle every new server, so unlimited must return null (no
    // -XX:ActiveProcessorCount flag at all).
    expect(cpuCores(0)).toBeNull();
    expect(cpuCores(null)).toBeNull();
    expect(cpuCores(undefined)).toBeNull();
    expect(cpuCores(-5)).toBeNull();
  });

  it("never caps a limited server below one core", () => {
    expect(cpuCores(1)).toBe(1);
    expect(cpuCores(10)).toBe(1);
  });
});
