import pino from "pino";

export type Logger = pino.Logger;

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.secret",
  "*.jwt",
];

/** Structured logger with secret redaction (IMPLEMENTATION.md §5). Never log credentials. */
export function createLogger(level: string, isProduction: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: isProduction ? undefined : { env: "dev" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
