import type { Request } from "express";
import { z } from "zod";
import { ValidationError } from "../shared/errors.js";

/** One password rule everywhere: setup, admin-created accounts, and CLI (min 12). */
export const passwordSchema = z.string().min(12).max(128);

/** Parse and validate a request body against a schema (handler pattern step 1). */
export function parseBody<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.output<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
