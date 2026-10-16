import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Process resource sampling.
 *
 * Renom runs game servers as bare child processes (ADR-0004), not containers,
 * so there is no daemon to ask for container stats the way Pterodactyl asks
 * Wings. The readings below are taken straight from the host OS instead.
 *
 * CPU time and resident memory are genuinely per-process. Network byte
 * counters are NOT: neither Linux (/proc/<pid>/net/dev is namespace-wide) nor
 * Windows exposes per-process byte counters for a non-containerized process.
 * `readNetworkCounters` therefore reports this host's non-loopback interface
 * totals, and the UI labels them "host traffic" rather than pretending they
 * belong to one server.
 *
 * Unsupported platforms return null instead of a fabricated zero: a graph that
 * invents flat lines is worse than one that admits it has no data.
 */

/** Linux reports CPU time in clock ticks; USER_HZ is 100 on every supported ABI. */
const CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessReading {
  /** Total CPU time the process has consumed, in milliseconds. */
  cpuMs: number;
  /** Resident set size, in bytes. */
  memoryBytes: number;
}

/** Cumulative interface byte totals, never decreasing except on a counter wrap. */
export interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
}

/**
 * Parse a Linux `/proc/<pid>/stat` + `/proc/<pid>/status` pair.
 *
 * Pure and exported so it can be exercised on any platform. The reader below
 * only runs on Linux, and Linux is where the panel deploys — a wrong field
 * index here would report confidently wrong CPU on every production host
 * with nothing on a Windows dev machine to notice.
 */
export function parseProcStat(stat: string, status: string): ProcessReading | null {
  // `comm` is parenthesised and may contain spaces or ')' of its own, so the
  // field list starts after the LAST ')': everything before is pid + comm.
  // Fields are 1-indexed from `pid`, so the slice from field 3 (`state`)
  // puts utime (14) at index 11 and stime (15) at index 12.
  const tail = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const utime = Number(tail[11]);
  const stime = Number(tail[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  // VmRSS is already in kibibytes. `statm` counts pages, which would need a
  // page-size constant — and 4 KiB is wrong on 16 KiB and 64 KiB arm64 hosts,
  // understating memory by 4x or 16x there.
  const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
  return {
    cpuMs: ((utime + stime) / CLOCK_TICKS_PER_SECOND) * 1000,
    memoryBytes: Number.isFinite(rssKb) ? rssKb * 1024 : 0,
  };
}

async function readLinuxProcess(pid: number): Promise<ProcessReading | null> {
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8"),
  ]);
  return parseProcStat(stat, status);
}

async function readWindowsProcess(pid: number): Promise<ProcessReading | null> {
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($p) { [pscustomobject]@{ cpu = $p.TotalProcessorTime.TotalMilliseconds; ` +
    `mem = $p.WorkingSet64 } | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 10_000 },
  );
  const parsed = JSON.parse(stdout.trim()) as { cpu?: number; mem?: number };
  if (typeof parsed.cpu !== "number" || typeof parsed.mem !== "number") return null;
  return { cpuMs: parsed.cpu, memoryBytes: parsed.mem };
}

/** Current CPU time and resident memory for a running child, or null. */
export async function readProcessReading(pid: number): Promise<ProcessReading | null> {
  try {
    if (process.platform === "linux") return await readLinuxProcess(pid);
    if (process.platform === "win32") return await readWindowsProcess(pid);
    return null;
  } catch {
    // The process exited between the tick and the read. A missing sample is
    // normal, not an error worth surfacing.
    return null;
  }
}

async function readLinuxNetwork(): Promise<NetworkCounters | null> {
  const raw = await readFile("/proc/net/dev", "utf8");
  let rxBytes = 0;
  let txBytes = 0;
  for (const line of raw.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!name || name.trim() === "lo" || !rest) continue;
    const columns = rest.trim().split(/\s+/);
    rxBytes += Number(columns[0] ?? 0);
    txBytes += Number(columns[8] ?? 0);
  }
  return { rxBytes, txBytes };
}

async function readWindowsNetwork(): Promise<NetworkCounters | null> {
  // `netstat -e` reports one cumulative "Bytes" row summed over every adapter.
  const { stdout } = await execFileAsync("netstat.exe", ["-e"], {
    windowsHide: true,
    timeout: 10_000,
  });
  const row = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Bytes\s+\d+\s+\d+/.test(line));
  if (!row) return null;
  const [, rxBytes, txBytes] = /^Bytes\s+(\d+)\s+(\d+)/.exec(row) as RegExpExecArray;
  return { rxBytes: Number(rxBytes), txBytes: Number(txBytes) };
}

/** Cumulative non-loopback interface counters for this host, or null. */
export async function readNetworkCounters(): Promise<NetworkCounters | null> {
  try {
    if (process.platform === "linux") return await readLinuxNetwork();
    if (process.platform === "win32") return await readWindowsNetwork();
    return null;
  } catch {
    return null;
  }
}

/**
 * Per-second rate between two cumulative readings, or null when it cannot be
 * derived: an interval too short to divide by, or a counter that went
 * backwards (interface reset, adapter cycle). Never a negative rate.
 */
export function perSecond(
  previous: { value: number; at: number },
  current: { value: number; at: number },
): number | null {
  const elapsed = current.at - previous.at;
  const delta = current.value - previous.value;
  if (elapsed < 1 || delta < 0) return null;
  return (delta * 1000) / elapsed;
}
