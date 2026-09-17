import type { ErrorBody } from "@renom/contracts";

/**
 * Domain error carrying an HTTP status and a stable machine code (RFC-7807-style mapping).
 * Services throw AppError subclasses; the HTTP layer maps them to responses — nothing else
 * may write error bodies (centralized error handling rule).
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super("bad_request", 400, message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown, message = "Validation failed") {
    super("validation_failed", 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("unauthorized", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super("forbidden", 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("not_found", 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super("conflict", 409, message, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body or upload exceeds configured limits") {
    super("payload_too_large", 413, message);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = "Too many requests") {
    super("rate_limited", 429, message, { retryAfterSec });
    this.retryAfterSec = retryAfterSec;
  }
}

/** Engine refused a power action (already running, suspended, not configured). */
export class EngineError extends AppError {
  constructor(message = "Engine operation failed") {
    super("conflict", 409, message);
  }
}
