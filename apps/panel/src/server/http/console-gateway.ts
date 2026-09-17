import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Database } from "../infra/db/database.js";
import type { AuthService, Principal } from "../modules/auth/service.js";
import type { LocalProcessEngine } from "../modules/runtime/engine.js";
import { resolveEffectivePermissions } from "../modules/servers/permissions.js";
import { hasPermission } from "@renom/contracts";

export interface ConsoleGatewayDeps {
  db: Database;
  auth: AuthService;
  engine: LocalProcessEngine;
}

interface JoinAck {
  ok: boolean;
  reason?: string;
}

/**
 * Real-time console (FR-0xx user operations).
 * - Auth: JWT from handshake, same rules as the REST layer (SEC-004).
 * - `console:join` needs websocket.connect; `console:send` needs control.console.
 * - Suspended servers stream nothing and accept no input.
 * - Per-socket send rate limit: 30 commands / 10 s (automation uses the REST endpoint).
 */
export function attachConsoleGateway(
  httpServer: HttpServer,
  deps: ConsoleGatewayDeps,
): SocketIOServer {
  const { db, auth, engine } = deps;
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io/",
    maxHttpBufferSize: 1e5,
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
      (socket.handshake.query as { token?: unknown } | undefined)?.token;
    const principal =
      typeof token === "string" && token.length > 0 ? auth.authenticateToken(token) : null;
    if (!principal) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.principal = principal;
    socket.data.unsubs = new Map<string, () => void>();
    socket.data.sendTimes = [] as number[];
    next();
  });

  io.on("connection", (socket: Socket) => {
    socket.on("console:join", (serverId: unknown, ack?: (r: JoinAck) => void) => {
      if (typeof serverId !== "string" || serverId.length === 0 || serverId.length > 64) {
        ack?.({ ok: false, reason: "bad server id" });
        return;
      }
      const p = socket.data.principal as Principal;
      const effective = resolveEffectivePermissions(db, {
        userId: p.userId,
        role: p.role,
        serverId,
      });
      const row = db
        .prepare("SELECT owner_id, status FROM servers WHERE id = ? AND deleted_at IS NULL")
        .get(serverId) as { owner_id: string; status: string } | undefined;
      const related = row !== undefined && (row.owner_id === p.userId || effective.length > 0);
      if (!row || !related || !hasPermission(effective, "websocket.connect")) {
        // Same existence-hiding rule as the REST layer: strangers learn nothing.
        ack?.({ ok: false, reason: "not found" });
        return;
      }
      if (row.status === "suspended") {
        ack?.({ ok: false, reason: "suspended" });
        return;
      }
      const unsubs = socket.data.unsubs as Map<string, () => void>;
      unsubs.get(serverId)?.();
      void socket.join(`server:${serverId}`);
      socket.emit("console:history", engine.history(serverId, 100));
      unsubs.set(
        serverId,
        engine.onLine(serverId, (line) => socket.emit("console:line", line)),
      );
      ack?.({ ok: true });
    });

    socket.on("console:send", (msg: unknown, ack?: (r: { accepted: boolean }) => void) => {
      const { serverId, command } = (msg as { serverId?: unknown; command?: unknown } | null) ?? {};
      if (typeof serverId !== "string" || typeof command !== "string" || command.length === 0) {
        ack?.({ accepted: false });
        return;
      }
      const now = Date.now();
      const times = socket.data.sendTimes as number[];
      while (times.length > 0 && now - (times[0] ?? 0) > 10_000) times.shift();
      if (times.length >= 30) {
        ack?.({ accepted: false });
        return;
      }
      times.push(now);

      const p = socket.data.principal as Principal;
      const effective = resolveEffectivePermissions(db, {
        userId: p.userId,
        role: p.role,
        serverId,
      });
      if (!hasPermission(effective, "control.console")) {
        ack?.({ accepted: false });
        return;
      }
      const row = db
        .prepare("SELECT status FROM servers WHERE id = ? AND deleted_at IS NULL")
        .get(serverId) as { status: string } | undefined;
      if (!row || row.status === "suspended") {
        ack?.({ accepted: false });
        return;
      }
      ack?.({ accepted: engine.sendInput(serverId, command.slice(0, 4096)) });
    });

    socket.on("disconnect", () => {
      const unsubs = socket.data.unsubs as Map<string, () => void> | undefined;
      unsubs?.forEach((unsub) => unsub());
      unsubs?.clear();
    });
  });

  return io;
}
