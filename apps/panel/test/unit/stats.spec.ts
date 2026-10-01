import { describe, expect, it } from "vitest";
import { parseProcStat } from "../../src/server/modules/runtime/stats.js";

// Shapes transcribed from proc(5): /proc/pid/stat is
//   pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt
//   majflt cmajflt utime stime ...
// with utime/stime in clock ticks (USER_HZ, 100 on every supported ABI).
//
// These fixtures stand in for a Linux host: the reader that calls this
// function only runs when process.platform === "linux", and Linux is where
// the panel deploys. Without them the field arithmetic — the part most
// likely to be silently wrong, and silently wrong only in production —
// would never execute anywhere.
const STATUS = [
  "Name:\tjava",
  "State:\tS (sleeping)",
  "VmPeak:\t  1048576 kB",
  "VmRSS:\t   524288 kB",
  "VmSize:\t  1048576 kB",
  "Threads:\t64",
].join("\n");

function statLine(comm: string, utime: number, stime: number): string {
  // Fields 3..13 (state through cmajflt) are fixed; utime (14) and stime
  // (15) vary. Eleven values here put utime at tail index 11, which is the
  // whole point of the fixture — a miscount here is a miscount in prod.
  const head = "4242 (" + comm + ") S 1 4242 4242 0 -1 4194560 1234 0 0 0";
  return `${head} ${utime} ${stime} 0 0 20 0 1 0 100 0`;
}

describe("parseProcStat", () => {
  it("reads user+system CPU time as milliseconds", () => {
    const reading = parseProcStat(statLine("java", 150, 50), STATUS);
    // 200 ticks at 100 Hz is 2 seconds of CPU.
    expect(reading?.cpuMs).toBe(2000);
  });

  it("reads VmRSS in kibibytes rather than guessing a page size", () => {
    const reading = parseProcStat(statLine("java", 0, 0), STATUS);
    expect(reading?.memoryBytes).toBe(524288 * 1024);
  });

  it("handles a comm containing spaces and parentheses", () => {
    // A JVM or shell wrapper can be named almost anything. Splitting on the
    // FIRST ')' would shift every field and report a plausible, wrong number.
    const reading = parseProcStat(statLine("my (weird) proc", 400, 100), STATUS);
    expect(reading?.cpuMs).toBe(5000);
    expect(reading?.memoryBytes).toBe(524288 * 1024);
  });

  it("returns null rather than a wrong number when the fields are not there", () => {
    expect(parseProcStat("not a stat line", STATUS)).toBeNull();
  });

  it("reports zero memory when status carries no VmRSS", () => {
    const reading = parseProcStat(statLine("java", 10, 10), "Name:\tjava\n");
    expect(reading?.cpuMs).toBe(200);
    expect(reading?.memoryBytes).toBe(0);
  });
});
