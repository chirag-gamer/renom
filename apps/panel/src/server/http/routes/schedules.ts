import { Router, type Request } from "express";
import { z } from "zod";
import type { Database } from "../../infra/db/database.js";
import type { Scheduler, ScheduleTask } from "../../modules/schedules/runner.js";
import type { AuditService } from "../../modules/audit/service.js";
import type { AuthService } from "../../modules/auth/service.js";
import { requireAuth } from "../middleware/authn.js";
import { requireServerPermission, assertNotSuspendedForMutation, assertSuspendedReadable } from "../middleware/authz.js";
import { parseBody } from "../../shared/validate.js";
import { NotFoundError } from "../../shared/errors.js";

const taskSchema = z.object({
  action: z.enum(["power", "command", "backup"]),
  payload: z.record(z.string(), z.unknown()).default({}),
  offsetSec: z.number().int().min(0).max(300).default(0),
});

const createScheduleSchema = z.object({
  name: z.string().min(1).max(64),
  cronExpr: z.string().min(9).max(64),
  onlyWhenOnline: z.boolean().optional(),
  tasks: z.array(taskSchema).min(1).max(16),
});

const patchScheduleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  cronExpr: z.string().min(9).max(64).optional(),
  isActive: z.boolean().optional(),
  onlyWhenOnline: z.boolean().optional(),
  tasks: z.array(taskSchema).min(1).max(16).optional(),
});

export interface SchedulesDeps {
  db: Database;
  scheduler: Scheduler;
  audit: AuditService;
  auth: AuthService;
}

export function schedulesRouter(deps: SchedulesDeps): Router {
  const { db, scheduler, audit, auth } = deps;
  const router = Router();
  router.use(requireAuth(auth));
  const guard = (perm: string) => requireServerPermission(perm, db);

  const auditIt = (
    req: Request,
    event: string,
    serverId: string,
    target?: Record<string, unknown>,
  ) =>
    audit.record({
      event,
      actorUserId: req.principal!.userId,
      actorApiKeyId: req.principal!.apiKeyId,
      actorIp: req.ip,
      requestId: req.requestId,
      serverId,
      target,
    });

  const shape = (id: string) => {
    const s = scheduler.byId(id);
    if (!s) return null;
    return {
      id: s.id,
      name: s.name,
      cronExpr: s.cron_expr,
      isActive: s.is_active === 1,
      onlyWhenOnline: s.only_when_online === 1,
      nextRunAt: s.next_run_at,
      lastRunAt: s.last_run_at,
      tasks: scheduler.tasksOf(id),
    };
  };

  router.get("/servers/:id/schedules", guard("schedule.read"), (req, res) => {
    assertSuspendedReadable(req, res);
    const items = scheduler.list(req.params.id ?? "").map((s) => shape(s.id));
    res.json({ schedules: items });
  });

  router.post("/servers/:id/schedules", guard("schedule.create"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(createScheduleSchema, req);
      const serverId = req.params.id ?? "";
      const created = scheduler.createSchedule(serverId, {
        name: body.name,
        cronExpr: body.cronExpr,
        onlyWhenOnline: body.onlyWhenOnline,
        tasks: body.tasks as ScheduleTask[],
      });
      auditIt(req, "schedule.create", serverId, { scheduleId: created.id });
      res.status(201).json({ schedule: shape(created.id) });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/servers/:id/schedules/:scheduleId", guard("schedule.update"), (req, res, next) => {
    try {
      assertNotSuspendedForMutation(req, res);
      const body = parseBody(patchScheduleSchema, req);
      const serverId = req.params.id ?? "";
      // Ownership first: never touch a schedule through the wrong server URL.
      const current = scheduler.byId(req.params.scheduleId ?? "");
      if (!current || current.server_id !== serverId) throw new NotFoundError("Schedule not found");
      const updated = scheduler.updateSchedule(current.id, {
        name: body.name,
        cronExpr: body.cronExpr,
        isActive: body.isActive,
        onlyWhenOnline: body.onlyWhenOnline,
        tasks: body.tasks as ScheduleTask[] | undefined,
      });
      if (!updated || updated.server_id !== serverId) throw new NotFoundError("Schedule not found");
      auditIt(req, "schedule.update", serverId, { scheduleId: updated.id });
      res.json({ schedule: shape(updated.id) });
    } catch (e) {
      next(e);
    }
  });

  router.delete(
    "/servers/:id/schedules/:scheduleId",
    guard("schedule.delete"),
    (req, res, next) => {
      try {
        assertNotSuspendedForMutation(req, res);
        const serverId = req.params.id ?? "";
        const current = scheduler.byId(req.params.scheduleId ?? "");
        if (!current || current.server_id !== serverId)
          throw new NotFoundError("Schedule not found");
        scheduler.remove(current.id);
        auditIt(req, "schedule.delete", serverId, { scheduleId: current.id });
        res.status(204).send();
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/servers/:id/schedules/:scheduleId/run",
    guard("schedule.update"),
    (req, res, next) => {
      (async () => {
        assertNotSuspendedForMutation(req, res);
        const serverId = req.params.id ?? "";
        const current = scheduler.byId(req.params.scheduleId ?? "");
        if (!current || current.server_id !== serverId)
          throw new NotFoundError("Schedule not found");
        await scheduler.runOnce(current.id);
        auditIt(req, "schedule.run.manual", serverId, { scheduleId: current.id });
        res.json({ ran: true });
      })().catch(next);
    },
  );

  return router;
}
