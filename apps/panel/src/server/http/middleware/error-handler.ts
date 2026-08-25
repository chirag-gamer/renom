import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../shared/errors.js";
import type { Logger } from "../../shared/logger.js";

interface BodyLimitLikeError {
  type?: string;
  statusCode?: number;
}

/**
 * Central error mapper: every failure leaves the process as `{error:{code,message,details?}}`.
 * Unknown errors are logged with request-id and reduced to a generic 500 (no stack leakage).
 */
export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
      return;
    }

    if (isBodyLimitError(err)) {
      res.status(413).json(new AppError("payload_too_large", 413, "Request body too large").toBody());
      return;
    }

    if (isMalformedJsonError(err)) {
      res.status(400).json(new AppError("bad_request", 400, "Malformed JSON body").toBody());
      return;
    }

    if (err instanceof AppError) {
      res.status(err.status).json(err.toBody());
      return;
    }

    logger.error({ err, reqId: req.requestId, path: req.path }, "unhandled_error");
    res.status(500).json({
      error: { code: "internal_error", message: "Internal server error" },
    });
  };
}

function isBodyLimitError(err: unknown): boolean {
  const e = err as BodyLimitLikeError;
  return (
    typeof e === "object" && e !== null && (e.type === "entity.too.large" || e.statusCode === 413)
  );
}

function isMalformedJsonError(err: unknown): boolean {
  const e = err as BodyLimitLikeError;
  return typeof e === "object" && e !== null && e.type === "entity.parse.failed";
}
