import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../servers/repo.js";
import type { BlueprintRegistry } from "../blueprints/registry.js";
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
 * into a command line. `{{VAR}}` substitution happens per-argument against
 * validated server variables only.
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
    if (!live?.proc) return "offline";
    if (live.stopping) return "stopping";
    return live.proc.exitCode === null && live.proc.signalCode === null ? "running" : "offline";
  }

  async start(serverId: string): Promise<void> {
    const server = this.servers.byId(serverId);
    if (!server) throw new EngineError("Server not found");
    if (server.status === "suspended") throw new EngineError("Server is suspended");
    if (this.stateOf(serverId) !== "offline") throw new EngineError("Server is already running");

    const doc = this.blueprints.getDoc(server.blueprint_slug, server.blueprint_version_tag);
    if (doc.requirements?.engine !== "process") {
      throw new EngineError(
        `Blueprint '${doc.slug}' needs the Docker engine, which is not configured on this node`,
      );
    }

    const vars = this.variablesOf(
      serverId,
      (doc.variables ?? []).map((v) => v.key),
    );
    const argv = (doc.run?.command ?? []).map((arg) => substitute(arg, vars));
    const [cmd, ...args] = argv;
    if (!cmd) throw new EngineError("Blueprint has an empty start command");

    const dir = join(this.dataDir, "servers", serverId);
    mkdirSync(dir, { recursive: true });

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

    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, {
        cwd: dir,
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

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const text of String(chunk).split(/\r?\n/)) {
        if (text.length > 0) emit("stdout", text);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const text of String(chunk).split(/\r?\n/)) {
        if (text.length > 0) emit("stderr", text);
      }
    });
    proc.on("error", (err) => {
      emit("system", `process error: ${err.message}`);
      this.finish(serverId, "offline");
    });
    proc.on("exit", (code, signal) => {
      emit(
        "system",
        signal ? `process killed (${signal})` : `process exited (code ${code ?? "?"})`,
      );
      this.finish(serverId, "offline");
    });
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
    if (stop?.kind === "console" && stop.command) {
      this.sendInput(serverId, stop.command);
    } else {
      live.proc.kill(stop?.signal === "SIGINT" ? "SIGINT" : "SIGTERM");
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
    await this.waitForExit(serverId, 5000);
    this.finish(serverId, "offline");
  }

  async restart(serverId: string): Promise<void> {
    await this.stop(serverId);
    await this.start(serverId);
  }

  /** Write a line to the process stdin. Returns false when nothing is running. */
  sendInput(serverId: string, line: string): boolean {
    const live = this.live.get(serverId);
    const stdin = live?.proc?.stdin;
    if (!live?.proc || !stdin || live.proc.exitCode !== null) return false;
    stdin.write(`${line.slice(0, LINE_MAX)}\n`);
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

  private variablesOf(serverId: string, keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    if (keys.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT key, value FROM server_variables WHERE server_id = ? AND key IN (${keys.map(() => "?").join(",")})`,
      )
      .all(serverId, ...keys) as Array<{ key: string; value: string }>;
    for (const r of rows) out[r.key] = r.value;
    return out;
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
