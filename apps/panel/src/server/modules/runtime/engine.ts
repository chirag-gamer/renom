import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../servers/repo.js";
import type { BlueprintRegistry } from "../blueprints/registry.js";
import type { BlueprintVariable } from "../blueprints/schema.js";
import { EngineError } from "../../shared/errors.js";

export type PowerAction = "start" | "stop" | "restart" | "kill";

export interface ConsoleLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

const HISTORY_LIMIT = 500;
const LINE_MAX = 4096;

function javaMajor(candidate: string): number | null {
  try {
    const result = spawnSync(candidate, ["-version"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return null;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return Number(output.match(/version "(\d+)(?:\.|\")/)?.[1] ?? NaN) || null;
  } catch {
    return null;
  }
}

function resolveJavaBinary(version?: string): string | null {
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const requested = version ? Number(version) : null;
  if (version && (requested === null || !Number.isInteger(requested) || requested <= 0))
    return null;
  const candidates = version
    ? [
        process.env[`JAVA_HOME_${version}`]
          ? join(process.env[`JAVA_HOME_${version}`]!, "bin", executable)
          : null,
        process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", executable) : null,
        `/usr/lib/jvm/java-${version}-openjdk-amd64/bin/${executable}`,
        `/usr/lib/jvm/java-${version}-openjdk-arm64/bin/${executable}`,
        `/usr/lib/jvm/java-${version}-openjdk/bin/${executable}`,
        `/usr/lib/jvm/temurin-${version}-jdk-amd64/bin/${executable}`,
        `/opt/java/openjdk-${version}/bin/${executable}`,
        executable,
      ]
    : [process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", executable) : null, executable];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      (candidate === executable || existsSync(candidate)) &&
      (!requested || javaMajor(candidate) === requested)
    )
      return candidate;
  }
  return null;
}
interface LiveProcess {
  /** Null when this slot only holds history + listeners (never started, or finished). */
  proc: ChildProcess | null;
  history: ConsoleLine[];
  seq: number;
  listeners: Set<(line: ConsoleLine) => void>;
  stopping: boolean;
}

/**
 * Local process engine (ADR-0004): runs the blueprint's argv template as a
 * child process in the server directory — no shell, no string interpolation
 * into a command line. `{VAR}` substitution happens per-argument against
 * blueprint defaults merged with stored server variables.
 *
 * Docker-backed blueprints refuse honestly until a Docker engine is configured.
 */
export class LocalProcessEngine {
  private readonly live = new Map<string, LiveProcess>();

  constructor(
    private readonly db: Database,
    private readonly servers: ServersRepo,
    private readonly blueprints: BlueprintRegistry,
    private readonly dataDir: string,
  ) {}

  stateOf(serverId: string): "offline" | "starting" | "running" | "stopping" {
    const live = this.live.get(serverId);
    if (!live?.proc) {
      // No live child: the DB record is the truth (covers "starting" between
      // state write and spawn, and "offline" after finish/shutdown).
      const row = this.servers.byId(serverId);
      if (row?.runtime_state === "starting") return "starting";
      return "offline";
    }
    if (live.stopping) return "stopping";
    return live.proc.exitCode === null && live.proc.signalCode === null ? "running" : "offline";
  }

  /** Drop all engine state for a server (called on delete; history goes with it). */
  forget(serverId: string): void {
    this.live.delete(serverId);
  }

  /** Engine health for readiness: what is tracked, what is actually alive. */
  health(): { tracked: number; running: number } {
    let running = 0;
    for (const id of this.live.keys()) {
      if (this.stateOf(id) === "running") running++;
    }
    return { tracked: this.live.size, running };
  }

  async start(serverId: string): Promise<void> {
    const server = this.servers.byId(serverId);
    if (!server) throw new EngineError("Server not found");
    if (server.status === "suspended") throw new EngineError("Server is suspended");
    // The state machine is enforced, not advisory: installs and failures
    // must finish before launch, or the process spawns into a half-built dir.
    if (server.status !== "ready") {
      throw new EngineError(`Server is not ready to start (status: ${server.status})`);
    }
    if (this.stateOf(serverId) !== "offline") throw new EngineError("Server is already running");

    const doc = this.blueprints.getDoc(server.blueprint_slug, server.blueprint_version_tag);
    // The EULA gate lives at the runtime boundary, not just the create
    // route: imports, reinstalls, and direct starts all pass through here.
    if (doc.features?.includes("eula") && !server.eula_accepted_at) {
      throw new EngineError("Minecraft EULA has not been accepted for this server");
    }
    if (doc.requirements?.engine !== "process") {
      throw new EngineError(
        `Blueprint '${doc.slug}' needs the Docker engine, which is not configured on this node`,
      );
    }

    const vars = this.variablesOf(serverId, (doc.variables ?? []) as BlueprintVariable[]);
    // Panel-namespaced keys (tunnel.*) ride outside blueprint variables.
    for (const [k, v] of this.namespacedVariables(serverId)) vars[k] = v;
    const argv = (doc.run?.command ?? []).map((arg) => substitute(arg, vars));
    const [rawCmd, ...args] = argv;
    if (!rawCmd) throw new EngineError("Blueprint has an empty start command");
    let cmd = rawCmd;
    if (rawCmd === "java") {
      const javaBinary = resolveJavaBinary(vars["javaVersion"]);
      if (!javaBinary) {
        throw new EngineError(
          `Java ${vars["javaVersion"] ?? "runtime"} is not installed on this host. Install it before starting this server.`,
        );
      }
      cmd = javaBinary;
    }
    // Cross-OS binaries: `bedrock_server` on Linux is `bedrock_server.exe`
    // next to it on Windows. Prefer the exact name, fall back to .exe there.
    // (Checked against the server root, where installs place binaries.)
    const dir = join(this.dataDir, "servers", serverId);
    if (process.platform === "win32" && !cmd.endsWith(".exe")) {
      const withExe = `${cmd}.exe`;
      try {
        if (existsSync(join(dir, withExe))) cmd = withExe;
      } catch {
        // keep the original name; spawn reports the real error
      }
    }

    // Blueprint workdir maps INSIDE the server directory (default: its root).
    // Anything escaping it is refused rather than launched elsewhere.
    mkdirSync(dir, { recursive: true });
    const cwd = confineWorkdir(dir, doc.run?.workdir ?? "/data");
    mkdirSync(cwd, { recursive: true });

    this.servers.setRuntimeState(serverId, "starting");
    // Reuse a lazy slot (history + listeners survive restarts) or create one.
    let entry = this.live.get(serverId);
    if (!entry) {
      entry = { proc: null, history: [], seq: 0, listeners: new Set(), stopping: false };
      this.live.set(serverId, entry);
    } else {
      entry.stopping = false;
    }
    const slot: LiveProcess = entry;
    const emit = (stream: ConsoleLine["stream"], text: string) => {
      const line: ConsoleLine = {
        seq: ++slot.seq,
        ts: Date.now(),
        stream,
        text: text.slice(0, LINE_MAX),
      };
      slot.history.push(line);
      if (slot.history.length > HISTORY_LIMIT)
        slot.history.splice(0, slot.history.length - HISTORY_LIMIT);
      for (const cb of slot.listeners) cb(line);
    };

    // Bare hosts disagree on the Python name: prefer `python`, take `python3`.
    if (cmd === "python") {
      const probe = spawnSync("python", ["--version"], { stdio: "ignore", windowsHide: true });
      if (probe.status !== 0) cmd = "python3";
    }
    let proc: ChildProcess;
    // Tunnel opt-in: the Minekube endpoint travels by environment (documented
    // precedence over the plugin's config file), never baked into argv.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    const tunnelEndpoint = vars["tunnel.endpoint"];
    if (tunnelEndpoint) childEnv.CONNECT_ENDPOINT = tunnelEndpoint;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      this.servers.setRuntimeState(serverId, "offline");
      throw new EngineError(
        `Failed to launch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    slot.proc = proc;
    this.live.set(serverId, slot);
    emit("system", `process started (pid ${proc.pid ?? "?"})`);

    // Per-stream line buffers: chunks split mid-line must not become
    // separate history entries. Remainders flush on process exit.
    // Hard cap: a newline-free firehose force-flushes at LINE_MAX instead of
    // growing the accumulator (and the panel with it) without bound.
    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
      buffers[stream] += String(chunk);
      if (buffers[stream].length > LINE_MAX) {
        emit(stream, buffers[stream].slice(0, LINE_MAX) + "…[truncated]");
        buffers[stream] = buffers[stream].slice(-1);
      }
      const parts = buffers[stream].split(/\r?\n/);
      buffers[stream] = parts.pop() ?? "";
      for (const text of parts) {
        if (text.length > 0) emit(stream, text);
      }
    };
    const flush = (stream: "stdout" | "stderr") => {
      if (buffers[stream].length > 0) emit(stream, buffers[stream]);
      buffers[stream] = "";
    };

    proc.stdout?.on("data", (chunk: Buffer) => feed("stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => feed("stderr", chunk));
    let startupFailed: Error | null = null;
    proc.on("error", (err) => {
      emit("system", `process error: ${err.message}`);
      startupFailed = err;
      this.finish(serverId, "offline");
    });
    proc.on("exit", (code, signal) => {
      flush("stdout");
      flush("stderr");
      if (!slot.stopping) {
        // Exited on its own (not via stop/kill): record fast failures so a
        // missing executable doesn't read as a healthy start.
        startupFailed = new Error(
          signal ? `process killed (${signal})` : `process exited (code ${code ?? "?"})`,
        );
      }
      emit(
        "system",
        signal ? `process killed (${signal})` : `process exited (code ${code ?? "?"})`,
      );
      this.finish(serverId, "offline");
    });

    // Startup grace: a missing executable (or instant crash) surfaces as an
    // async error/exit. Wait briefly so start() reports failure honestly
    // instead of claiming "running" for a dead process.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const failure = startupFailed as Error | null;
    if (failure || this.stateOf(serverId) === "offline") {
      const reason = failure?.message ?? "process exited during startup";
      // Keep the history (post-mortem reads) but report the failure.
      throw new EngineError(`Server failed to start: ${reason}`);
    }
    this.servers.setRuntimeState(serverId, "running");
  }

  async stop(serverId: string): Promise<void> {
    const live = this.live.get(serverId);
    if (!live?.proc) return; // idempotent: already offline
    const server = this.servers.byId(serverId);
    const doc = server ? this.tryDoc(server.blueprint_slug, server.blueprint_version_tag) : null;

    live.stopping = true;
    this.servers.setRuntimeState(serverId, "stopping");
    const stop = doc?.run?.stop;

    // Graceful console stop first (e.g. "stop" for Minecraft), then signal, then kill.
    if (stop?.kind === "console") {
      this.sendInput(serverId, stop.command);
    } else {
      live.proc.kill(stop?.kind === "signal" && stop.signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    }
    const timeoutSec = Math.min(Math.max(stop?.timeoutSec ?? 30, 1), 300);
    const exited = await this.waitForExit(serverId, timeoutSec * 1000);
    if (!exited) {
      await this.kill(serverId);
    }
  }

  async kill(serverId: string): Promise<void> {
    const live = this.live.get(serverId);
    if (!live?.proc) return; // idempotent
    live.stopping = true;
    try {
      live.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    const exited = await this.waitForExit(serverId, 5000);
    if (!exited) {
      // The child survived SIGKILL (kernel I/O, uninterruptible sleep):
      // keep tracking it as stopping and say so. Marking it offline would
      // orphan the process and hand its port to the next claimant.
      this.servers.setRuntimeState(serverId, "stopping");
      throw new EngineError("Process did not exit after SIGKILL; still tracked as stopping");
    }
    this.finish(serverId, "offline");
  }

  async restart(serverId: string): Promise<void> {
    await this.stop(serverId);
    await this.start(serverId);
  }

  /**
   * Panel shutdown: terminate every tracked child so a restart never leaves
   * orphaned processes holding ports while the DB says offline. Best-effort
   * and bounded — shutdown must not hang forever on a stuck child.
   */
  async shutdown(): Promise<void> {
    const ids = [...this.live.keys()];
    for (const id of ids) {
      try {
        await this.kill(id);
      } catch {
        // keep sweeping the rest
      }
    }
  }

  /**
   * Write a line to the process stdin. Returns false when nothing is running.
   * Control characters are stripped centrally (both socket and REST paths
   * land here): one message carries exactly one command, so embedded
   * newlines cannot smuggle extra commands past the rate limit.
   */
  sendInput(serverId: string, line: string): boolean {
    const live = this.live.get(serverId);
    const stdin = live?.proc?.stdin;
    if (!live?.proc || !stdin || live.proc.exitCode !== null) return false;
    const clean = line.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, LINE_MAX);
    if (clean.length === 0) return false;
    stdin.write(`${clean}\n`);
    return true;
  }

  history(serverId: string, limit = 100): ConsoleLine[] {
    const live = this.live.get(serverId);
    if (!live) return [];
    return live.history.slice(-Math.min(Math.max(limit, 1), HISTORY_LIMIT));
  }

  onLine(serverId: string, cb: (line: ConsoleLine) => void): () => void {
    // Lazy slot: subscribers and history survive processes coming and going.
    let live = this.live.get(serverId);
    if (!live) {
      live = { proc: null, history: [], seq: 0, listeners: new Set(), stopping: false };
      this.live.set(serverId, live);
    }
    live.listeners.add(cb);
    const slot = live;
    return () => {
      slot.listeners.delete(cb);
    };
  }

  /**
   * Blueprint defaults first, stored overrides win. A fresh server with no
   * `server_variables` rows still launches with sane values instead of
   * leaking `{placeholders}` into the child argv.
   */
  private variablesOf(serverId: string, declared: BlueprintVariable[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const v of declared) out[v.key] = String(v.default);
    const keys = declared.map((v) => v.key);
    if (keys.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT key, value FROM server_variables WHERE server_id = ? AND key IN (${keys.map(() => "?").join(",")})`,
      )
      .all(serverId, ...keys) as Array<{ key: string; value: string }>;
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** Panel-namespaced overrides (currently `tunnel.*`) kept out of blueprint argv. */
  private namespacedVariables(serverId: string): Array<[string, string]> {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM server_variables WHERE server_id = ? AND key LIKE 'tunnel.%'",
      )
      .all(serverId) as Array<{ key: string; value: string }>;
    return rows.map((r) => [r.key, r.value]);
  }

  private tryDoc(slug: string, tag: string) {
    try {
      return this.blueprints.getDoc(slug, tag);
    } catch {
      return null;
    }
  }

  private finish(serverId: string, state: "offline"): void {
    // History + listeners stay in the slot for post-mortem reads; only the
    // dead handle is cleared, so the next start() reuses the slot.
    const live = this.live.get(serverId);
    if (live) {
      live.proc = null;
      live.stopping = false;
    }
    try {
      this.servers.setRuntimeState(serverId, state);
    } catch {
      // DB gone during shutdown — nothing useful to do
    }
  }

  private waitForExit(serverId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const live = this.live.get(serverId);
      if (!live?.proc || live.proc.exitCode !== null || live.proc.signalCode !== null) {
        resolve(true);
        return;
      }
      const proc = live.proc;
      const timer = setTimeout(() => {
        proc.removeListener("exit", onExit);
        resolve(false);
      }, ms);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      proc.once("exit", onExit);
    });
  }
}

/** Replace {KEY} tokens against validated server variables (catalog convention). */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

/**
 * Resolve a blueprint workdir inside the server directory. Absolute paths
 * (`/data`, `/`) anchor at the server root; anything escaping it is refused.
 *
 * The process engine treats `/data` as the server root itself (in Docker it
 * is the mounted volume; locally there is no extra level). Deeper paths like
 * `/data/app` map to `<serverDir>/app`.
 */
export function confineWorkdir(serverDir: string, workdir: string): string {
  const trimmed = workdir.trim();
  if (
    trimmed === "" ||
    trimmed === "/" ||
    trimmed === "." ||
    trimmed === "./" ||
    trimmed === "/data" ||
    trimmed === "data"
  ) {
    return serverDir;
  }
  const noRoot = trimmed.replace(/^[/\\]+/, "").replace(/^data[/\\]+/, "");
  const resolved = resolve(serverDir, noRoot === "" ? "." : noRoot);
  if (resolved !== serverDir && !resolved.startsWith(serverDir + sep)) {
    throw new EngineError(`Blueprint workdir escapes the server directory: ${workdir}`);
  }
  return resolved;
}
