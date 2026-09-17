import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Database } from "../infra/db/database.js";
import type { AuthService, Principal } from "../modules/auth/service.js";
import type { LocalProcessEngine, ConsoleLine } from "../modules/runtime/engine.js";
import { resolveEffectivePermissions } from "../modules/servers/permissions.js";
import { intersectScopes } from "./middleware/authz.js";
import { hasPermission } from "@renom/contracts";

export interface ConsoleGatewayDeps {
  db: Database;
  auth: AuthService;
  engine: LocalProcessEngine;
}

export interface ConsoleGateway {
  io: SocketIOServer;
  /**
   * Cut live console access: matching sockets leave their rooms, stop
   * streaming, and are told why. Called on collaborator removal, user or
   * server suspension, and key revocation. Omitted arguments are wildcards.
   */
  dropGrants(serverId?: string, userId?: string): void;
  /** Cut every socket authenticated with a revoked API key. */
  dropKey(apiKeyId: string): void;
}

interface JoinAck {
  ok: boolean;
  reason?: string;
}

const SEND_MAX = 20;
const SEND_WINDOW_MS = 10_000;
/** Command budget per user+server, shared across all their sockets. */
const sendBuckets = new Map<string, number[]>();

function takeBudget(userId: string, serverId: string): boolean {
  const key = `${userId}:${serverId}`;
  const now = Date.now();
  const times = sendBuckets.get(key) ?? [];
  while (times.length > 0 && now - (times[0] ?? 0) > SEND_WINDOW_MS) times.shift();
  if (times.length >= SEND_MAX) {
    sendBuckets.set(key, times);
    return false;
  }
  times.push(now);
  sendBuckets.set(key, times);
  return true;
}

/**
 * Real-time console.
 * - Auth: bearer token from the handshake ONLY (never query strings).
 * - `console:join` needs websocket.connect; `console:send` needs control.console.
 * - Suspended servers stream nothing and accept no input.
 * - Payloads carry `{v:1}` for additive evolution.
 * - Lines emit volatile: a stalled client is dropped, never buffered forever.
 */
export function attachConsoleGateway(
  httpServer: HttpServer,
  deps: ConsoleGatewayDeps,
): ConsoleGateway {
  const { db, auth, engine } = deps;
  const io = new SocketIOServer(httpServer, {
    path: "/socket.io/",
    maxHttpBufferSize: 1e5,
  });

  // Live subscriptions for revocation sweeps.
  const live = new Map<
    string,
    { socket: Socket; userId: string; apiKeyId?: string; servers: Set<string> }
  >();

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    const principal =
      typeof token === "string" && token.length > 0 ? auth.authenticateToken(token) : null;
    if (!principal) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.principal = principal;
    socket.data.unsubs = new Map<string, () => void>();
    next();
  });

  const unsubscribe = (socket: Socket, serverId: string): void => {
    const unsubs = socket.data.unsubs as Map<string, () => void> | undefined;
    unsubs?.get(serverId)?.();
    unsubs?.delete(serverId);
    void socket.leave(`server:${serverId}`);
    live.get(socket.id)?.servers.delete(serverId);
  };

  io.on("connection", (socket: Socket) => {
    const p0 = socket.data.principal as Principal;
    live.set(socket.id, { socket, userId: p0.userId, apiKeyId: p0.apiKeyId, servers: new Set() });

    socket.on("console:join", (serverId: unknown, ack?: (r: JoinAck) => void) => {
      if (typeof serverId !== "string" || serverId.length === 0 || serverId.length > 64) {
        ack?.({ ok: false, reason: "bad server id" });
        return;
      }
      const p = socket.data.principal as Principal;
      const effective = intersectScopes(
        resolveEffectivePermissions(db, {
          userId: p.userId,
          role: p.role,
          serverId,
        }),
        p.scopes,
      );
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
      unsubscribe(socket, serverId);
      void socket.join(`server:${serverId}`);
      socket.emit("console:history", { v: 1, lines: engine.history(serverId, 100) });
      const unsubs = socket.data.unsubs as Map<string, () => void>;
      unsubs.set(
        serverId,
        engine.onLine(serverId, (line: ConsoleLine) => {
          socket.volatile.emit("console:line", { v: 1, line });
        }),
      );
      live.get(socket.id)?.servers.add(serverId);
      ack?.({ ok: true });
    });

    socket.on("console:send", (msg: unknown, ack?: (r: { accepted: boolean }) => void) => {
      const { serverId, command } = (msg as { serverId?: unknown; command?: unknown } | null) ?? {};
      if (typeof serverId !== "string" || typeof command !== "string" || command.length === 0) {
        ack?.({ accepted: false });
        return;
      }
      const p = socket.data.principal as Principal;
      if (!takeBudget(p.userId, serverId)) {
        ack?.({ accepted: false });
        return;
      }
      const effective = intersectScopes(
        resolveEffectivePermissions(db, {
          userId: p.userId,
          role: p.role,
          serverId,
        }),
        p.scopes,
      );
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
      // Control characters stripped centrally in sendInput; empty residue refused.
      ack?.({ accepted: engine.sendInput(serverId, command.slice(0, 4096)) });
    });

    socket.on("disconnect", () => {
      const unsubs = socket.data.unsubs as Map<string, () => void> | undefined;
      unsubs?.forEach((unsub) => unsub());
      unsubs?.clear();
      live.delete(socket.id);
    });
  });

  return {
    io,
    dropGrants(serverId?: string, userId?: string): void {
      for (const entry of live.values()) {
        if (userId !== undefined && entry.userId !== userId) continue;
        const targets = serverId !== undefined ? [serverId] : [...entry.servers];
        for (const sid of targets) {
          if (!entry.servers.has(sid)) continue;
          unsubscribe(entry.socket, sid);
          entry.socket.emit("console:revoked", { v: 1, serverId: sid });
        }
      }
    },
    dropKey(apiKeyId: string): void {
      for (const entry of live.values()) {
        if (entry.apiKeyId !== apiKeyId) continue;
        for (const sid of [...entry.servers]) {
          unsubscribe(entry.socket, sid);
          entry.socket.emit("console:revoked", { v: 1, serverId: sid });
        }
      }
    },
  };
}
