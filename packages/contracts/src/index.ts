/**
 * Renom shared contracts: zod schemas + types consumed by server and client.
 * Keep this package dependency-light (zod only): it must stay cheap for the browser.
 */
import { z } from "zod";

/** RFC-7807-style error body: `{ error: { code, message, details? } }` (SPEC §1). */
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorSchema>;

/** Stable machine-readable error codes (mapped to HTTP status server-side). */
export const ErrorCode = {
  BadRequest: "bad_request",
  ValidationFailed: "validation_failed",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  PayloadTooLarge: "payload_too_large",
  RateLimited: "rate_limited",
  Internal: "internal_error",
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Cursor pagination envelope for list endpoints (`?cursor=&limit=`, max 100). */
export const pageQuerySchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Roles (ADR-0007). Exactly one owner is created by the installer (FR-006). */
export const roles = ["owner", "admin", "user"] as const;
export type Role = (typeof roles)[number];

/** Server lifecycle states (SPEC §2). */
export const serverStatuses = [
  "creating",
  "installing",
  "install_failed",
  "ready",
  "suspended",
  "restoring",
  "updating",
  "deleted",
] as const;
export type ServerStatus = (typeof serverStatuses)[number];

export const runtimeStates = ["offline", "starting", "running", "stopping"] as const;
export type RuntimeState = (typeof runtimeStates)[number];

/** Permission-string vocabulary (Pterodactyl-derived subset, PERMISSIONS-MATRIX.md). */
export const permissions = [
  "websocket.connect",
  "control.console",
  "control.start",
  "control.stop",
  "control.restart",
  "control.kill",
  "file.read",
  "file.read-content",
  "file.create",
  "file.update",
  "file.delete",
  "file.archive",
  "file.sftp",
  "backup.create",
  "backup.read",
  "backup.download",
  "backup.delete",
  "backup.restore",
  "allocation.read",
  "allocation.update",
  "startup.read",
  "startup.update",
  "schedule.create",
  "schedule.read",
  "schedule.update",
  "schedule.delete",
  "user.create",
  "user.read",
  "user.update",
  "user.delete",
  "activity.read",
  "settings.rename",
  "settings.reinstall",
  "settings.resources",
  "settings.delete",
] as const;
export type Permission = (typeof permissions)[number];
export const WILDCARD_PERMISSION = "*";

/** True when `granted` set authorizes `required` ('*' matches everything, deny-by-default). */
export function hasPermission(granted: readonly string[], required: string): boolean {
  return granted.includes(WILDCARD_PERMISSION) || granted.includes(required);
}

/** POST /servers body: a server is born from a blueprint + a name. */
export const createServerSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).default(""),
  blueprintSlug: z.string().min(1).max(64),
  memoryMb: z.number().int().min(128).max(1_048_576).default(1024),
  diskQuotaMb: z.number().int().min(256).max(10_485_760).default(5120),
  /** Owner username; admins/owner only. Defaults to the caller. */
  ownerUsername: z.string().min(1).max(32).optional(),
  /** Required when the blueprint ships the `eula` feature (Mojang EULA). */
  eulaAccepted: z.boolean().optional(),
});
export type CreateServer = z.infer<typeof createServerSchema>;

/** PATCH /servers/:id body: only safe-to-change fields; blueprint is immutable. */
export const patchServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).optional(),
  memoryMb: z.number().int().min(128).max(1_048_576).optional(),
  diskQuotaMb: z.number().int().min(256).max(10_485_760).optional(),
});
export type PatchServer = z.infer<typeof patchServerSchema>;

/** What the API returns for a server (never leaks internal snapshot blobs). */
export const publicServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerUsername: z.string(),
  blueprintSlug: z.string(),
  status: z.enum(serverStatuses),
  runtimeState: z.enum(runtimeStates).nullable(),
  memoryMb: z.number(),
  diskQuotaMb: z.number(),
  primaryAllocation: z.object({ ip: z.string(), port: z.number() }).nullable(),
  permissions: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PublicServer = z.infer<typeof publicServerSchema>;

/** PUT /servers/:id/variables body: overrides for blueprint-declared variables. */
export const updateVariablesSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type UpdateVariables = z.infer<typeof updateVariablesSchema>;
