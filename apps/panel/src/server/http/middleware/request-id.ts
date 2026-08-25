import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/** Attach a per-request correlation id; honor an inbound `x-request-id` (NFR-008). */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const id = incoming && /^[A-Za-z0-9_.:-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader("x-request-id", id);
  next();
}
