import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  RateLimitError,
  UnauthorizedError,
} from "../../src/server/shared/errors.js";

describe("error mapping", () => {
  it("serializes to RFC-7807-style body without details when absent", () => {
    const body = new UnauthorizedError().toBody();
    expect(body).toEqual({
      error: { code: "unauthorized", message: "Authentication required" },
    });
  });

  it("includes details when provided", () => {
    const body = new ConflictError("port in use", { port: 25565 }).toBody();
    expect(body.error.details).toEqual({ port: 25565 });
  });

  it("rate limit errors carry retry-after hint", () => {
    const err = new RateLimitError(42);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBe(42);
    expect(err.toBody().error.code).toBe("rate_limited");
  });

  it("preserves instanceof chains", () => {
    expect(new ConflictError()).toBeInstanceOf(AppError);
    expect(new ConflictError()).toBeInstanceOf(Error);
  });
});
