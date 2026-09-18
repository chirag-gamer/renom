import type { Database } from "../../infra/db/database.js";
import type { ServersRepo } from "../servers/repo.js";
import type { LocalProcessEngine } from "../runtime/engine.js";
import type { BackupsService } from "../backups/service.js";
import type { AuditService } from "../audit/service.js";
import { ulid } from "../../shared/ulid.js";
import { parseCron, nextRun, CronError } from "./cron.js";
import { BadRequestError } from "../../shared/errors.js";

/** Crashed runs block their schedule for at most this long, then expire. */
export const LOCK_TTL_MS = 15 * 60_000;

export interface ScheduleTask {
  seq: number;
  action: "power" | "command" | "backup";
  payload: Record<string, unknown>;
  offsetSec: number;
}

export interface ScheduleRow {
  id: string;
  server_id: string;
  name: string;
  cron_expr: string;
  is_active: number;
  only_when_online: number;
  next_run_at: number | null;
  last_run_at: number | null;
}

/**
 * Schedule runner (FR-025). Ticks call runDue(): due schedules are claimed
 * atomically (is_processing compare-and-set) so two panel processes never
 * double-fire, long runs never overlap themselves, and crashes release the
 * lock only via explicit completion — a crashed run stays marked until an
 * operator re-triggers it (visible, never silent).
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly servers: ServersRepo,
    private readonly engine: LocalProcessEngine,
    private readonly backups: BackupsService,
    private readonly audit: AuditService,
  ) {}

  /** Production wiring: tick every 30 s. Tests call runDue() directly. */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runDue().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  createSchedule(
    serverId: string,
    input: { name: string; cronExpr: string; onlyWhenOnline?: boolean; tasks: ScheduleTask[] },
  ): ScheduleRow {
    const fields = checkedCron(input.cronExpr);
    validateTasks(input.tasks);
    const now = Date.now();
    const id = ulid(now);
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO schedules (id, server_id, name, cron_expr, tz, is_active, is_processing,
             only_when_online, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'UTC', 1, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          serverId,
          input.name,
          input.cronExpr,
          input.onlyWhenOnline ? 1 : 0,
          nextRun(fields, now),
          now,
          now,
        );
      this.replaceTasks(id, input.tasks);
      const row = this.byId(id);
      if (!row) throw new Error("schedule creation failed");
      return row;
    });
  }

  byId(id: string): ScheduleRow | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      ScheduleRow | undefined;
    return row ?? null;
  }

  list(serverId: string): ScheduleRow[] {
    return this.db
      .prepare("SELECT * FROM schedules WHERE server_id = ? ORDER BY name")
      .all(serverId) as ScheduleRow[];
  }

  tasksOf(scheduleId: string): ScheduleTask[] {
    const rows = this.db
      .prepare(
        "SELECT seq, action, payload_json, offset_sec FROM tasks WHERE schedule_id = ? ORDER BY seq",
      )
      .all(scheduleId) as Array<{
      seq: number;
      action: string;
      payload_json: string;
      offset_sec: number;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      action: r.action as ScheduleTask["action"],
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      offsetSec: r.offset_sec,
    }));
  }

  updateSchedule(
    id: string,
    patch: {
      name?: string;
      cronExpr?: string;
      isActive?: boolean;
      onlyWhenOnline?: boolean;
      tasks?: ScheduleTask[];
    },
  ): ScheduleRow | null {
    const current = this.byId(id);
    if (!current) return null;
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      params.push(patch.name);
    }
    if (patch.cronExpr !== undefined) {
      const fields = checkedCron(patch.cronExpr);
      sets.push("cron_expr = ?");
      params.push(patch.cronExpr);
      sets.push("next_run_at = ?");
      params.push(nextRun(fields, Date.now()));
    }
    if (patch.isActive !== undefined) {
      sets.push("is_active = ?");
      params.push(patch.isActive ? 1 : 0);
    }
    if (patch.onlyWhenOnline !== undefined) {
      sets.push("only_when_online = ?");
      params.push(patch.onlyWhenOnline ? 1 : 0);
    }
    this.db.transaction(() => {
      if (sets.length > 0) {
        sets.push("updated_at = ?");
        params.push(Date.now(), id);
        this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      }
      if (patch.tasks !== undefined) {
        validateTasks(patch.tasks);
        this.replaceTasks(id, patch.tasks);
      }
    });
    return this.byId(id);
  }

  remove(id: string): boolean {
    const res = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return Number(res.changes) === 1;
  }

  /** Fire all due schedules once. Returns the number of schedules executed. */
  async runDue(now = Date.now()): Promise<number> {
    const due = this.db
      .prepare(
        `SELECT * FROM schedules WHERE is_active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND (is_processing = 0 OR lock_until <= ?) ORDER BY next_run_at`,
      )
      .all(now, now) as ScheduleRow[];
    let ran = 0;
    for (const s of due) {
      // Atomic claim that rechecks state: an admin disabling or rescheduling
      // between our SELECT and this UPDATE wins, and we skip the stale run.
      // The lock expires (LOCK_TTL_MS): a crashed run blocks at most one
      // window instead of killing the schedule forever.
      const claimed = this.db
        .prepare(
          `UPDATE schedules SET is_processing = 1, lock_until = ?, updated_at = ?
           WHERE id = ? AND is_active = 1
             AND next_run_at IS NOT NULL AND next_run_at <= ?
             AND (is_processing = 0 OR lock_until <= ?)`,
        )
        .run(now + LOCK_TTL_MS, now, s.id, now, now);
      if (Number(claimed.changes) !== 1) continue;
      try {
        await this.execute(s);
        ran++;
      } finally {
        this.finalize(s.id);
      }
    }
    return ran;
  }

  /** Run one schedule immediately (manual trigger): bypasses the clock, not the lock. */
  async runOnce(id: string): Promise<void> {
    const s = this.byId(id);
    if (!s) throw new BadRequestError("Schedule not found");
    const now = Date.now();
    const claimed = this.db
      .prepare(
        `UPDATE schedules SET is_processing = 1, lock_until = ?, updated_at = ?
         WHERE id = ? AND (is_processing = 0 OR lock_until <= ?)`,
      )
      .run(now + LOCK_TTL_MS, now, id, now);
    if (Number(claimed.changes) !== 1) {
      throw new BadRequestError("Schedule is already running");
    }
    try {
      await this.execute(s);
    } finally {
      // Manual runs don't advance the clock, but they must always release.
      this.db
        .prepare(
          "UPDATE schedules SET is_processing = 0, lock_until = 0, last_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), Date.now(), id);
    }
  }

  /**
   * Release the lock and schedule the next run from the CURRENT row — never
   * the stale copy we started with, so edits made mid-run survive.
   */
  private finalize(id: string): void {
    const current = this.byId(id);
    if (!current) return;
    let next: number | null = null;
    try {
      next = nextRun(parseCron(current.cron_expr), Date.now());
    } catch {
      next = null;
    }
    this.db
      .prepare(
        "UPDATE schedules SET is_processing = 0, lock_until = 0, last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), next, Date.now(), id);
  }

  private async execute(s: ScheduleRow): Promise<void> {
    const server = this.servers.byId(s.server_id);
    if (!server || server.status === "suspended") return;
    if (s.only_when_online === 1 && this.engine.stateOf(s.server_id) === "offline") return;
    const tasks = this.tasksOf(s.id);
    let failed = 0;
    for (const task of tasks) {
      try {
        await this.runTask(s.server_id, task);
      } catch (err) {
        // Task failure stops this run's remaining tasks unless flagged to continue —
        // and it is recorded, never silently swallowed.
        failed++;
        this.audit.record({
          event: "schedule.run.failed",
          actorIp: "system",
          serverId: s.server_id,
          target: {
            scheduleId: s.id,
            seq: task.seq,
            action: task.action,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        const cont = (task.payload.continueOnFailure as boolean | undefined) ?? false;
        if (!cont) break;
      }
    }
    this.audit.record({
      event: "schedule.run",
      actorIp: "system",
      serverId: s.server_id,
      target: { scheduleId: s.id, failedTasks: failed },
    });
  }

  private async runTask(serverId: string, task: ScheduleTask): Promise<void> {
    if (task.offsetSec > 0) {
      await new Promise((r) => setTimeout(r, Math.min(task.offsetSec, 300) * 1000));
    }
    if (task.action === "power") {
      const action = (task.payload.action as string | undefined) ?? "restart";
      if (action === "start") await this.engine.start(serverId);
      else if (action === "stop") await this.engine.stop(serverId);
      else if (action === "kill") await this.engine.kill(serverId);
      else await this.engine.restart(serverId);
    } else if (task.action === "command") {
      const command = task.payload.command;
      if (typeof command !== "string" || command.length === 0)
        throw new Error("command task needs a command");
      this.engine.sendInput(serverId, command);
    } else {
      await this.backups.create(serverId, null, { locked: false });
    }
  }

  private replaceTasks(scheduleId: string, tasks: ScheduleTask[]): void {
    this.db.prepare("DELETE FROM tasks WHERE schedule_id = ?").run(scheduleId);
    tasks.forEach((t, i) => {
      this.db
        .prepare(
          "INSERT INTO tasks (schedule_id, seq, action, payload_json, offset_sec, continue_on_failure) VALUES (?,?,?,?,?,?)",
        )
        .run(scheduleId, i, t.action, JSON.stringify(t.payload), t.offsetSec, 0);
    });
  }
}

function checkedCron(expr: string) {
  try {
    return parseCron(expr);
  } catch (err) {
    throw new BadRequestError(err instanceof CronError ? err.message : "Invalid cron expression");
  }
}

export function validateTasks(tasks: ScheduleTask[]): void {
  if (tasks.length === 0 || tasks.length > 16) {
    throw new BadRequestError("A schedule needs 1-16 tasks");
  }
  for (const t of tasks) {
    if (t.action === "power") {
      const a = (t.payload.action as string | undefined) ?? "restart";
      if (!["start", "stop", "restart", "kill"].includes(a)) {
        throw new BadRequestError(`Unknown power action '${a}'`);
      }
    } else if (t.action === "command") {
      if (
        typeof t.payload.command !== "string" ||
        t.payload.command.length === 0 ||
        t.payload.command.length > 4096
      ) {
        throw new BadRequestError("Command tasks need a 1-4096 char command");
      }
    } else if (t.action !== "backup") {
      throw new BadRequestError(`Unknown task action '${String(t.action)}'`);
    }
    if (!Number.isInteger(t.offsetSec) || t.offsetSec < 0 || t.offsetSec > 300) {
      throw new BadRequestError("Task offset must be 0-300 seconds");
    }
  }
}
