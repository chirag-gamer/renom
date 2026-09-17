import { z } from "zod";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments,
 * optional single/double quotes. Real environment always wins — the file
 * only fills gaps. This is what makes the installer's generated `.env`
 * actually take effect under plain `npm start` / `node dist/...`.
 */
export function loadEnvFile(dir: string = process.cwd()): void {
  const file = resolve(dir, ".env");
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Environment configuration — parsed once at boot, fail-closed in production.
 * Precedence: env > .env > defaults. Secrets NEVER live in DB.
 *
 * SEC-001: no default production secret exists. When NODE_ENV=production the process refuses
 * to start unless JWT_SECRET is provided and >= 32 characters.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  JWT_SECRET: z.string().optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATA_DIR: z.string().min(1).default("./data"),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),
  /** One-time bootstrap token for POST /setup/admin (empty = local-trust mode, dev only). */
  SETUP_TOKEN: z.string().default(""),
});

export interface Env extends z.infer<typeof envSchema> {
  /** True when running under production rules (fail-closed secrets). */
  isProduction: boolean;
}

export class ConfigError extends Error {}

/** Parse and validate environment; throws ConfigError with actionable messages. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";

  if (isProduction) {
    const secret = env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      // SEC-001: fail closed rather than falling back to a known constant.
      throw new ConfigError(
        "JWT_SECRET must be set to at least 32 characters in production. " +
          "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(48).toString('base64url'))\"",
      );
    }
  }

  return { ...env, isProduction };
}

/** Ephemeral secret for development/test only; production never reaches this. */
export function generateEphemeralSecret(): string {
  return randomBytes(48).toString("base64url");
}
