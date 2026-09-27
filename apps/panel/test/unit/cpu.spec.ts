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

  it("never returns zero, and never leaves a server unbounded", () => {
    expect(cpuCores(0)).toBe(1);
    expect(cpuCores(-5)).toBe(1);
    expect(cpuCores(null)).toBe(1);
    expect(cpuCores(undefined)).toBe(1);
    expect(cpuCores(10)).toBe(1);
  });
});
