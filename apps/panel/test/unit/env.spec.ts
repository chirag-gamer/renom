import { describe, expect, it } from "vitest";
import { loadEnv, ConfigError } from "../../src/server/config/env.js";

const base = { NODE_ENV: "test" };

describe("loadEnv", () => {
  it("applies documented defaults", () => {
    const env = loadEnv({ ...base });
    expect(env.PORT).toBe(8080);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATA_DIR).toBe("./data");
    expect(env.BCRYPT_COST).toBe(12);
    expect(env.JWT_TTL_SECONDS).toBe(604_800); // 7d (FR-003)
  });

  it("rejects invalid port", () => {
    expect(() => loadEnv({ ...base, PORT: "99999" })).toThrow(ConfigError);
  });

  it("fails closed in production without JWT_SECRET (SEC-001)", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });

  it("fails closed in production with short JWT_SECRET (SEC-001)", () => {
    expect(() => loadEnv({ NODE_ENV: "production", JWT_SECRET: "a".repeat(31) })).toThrow(
      /at least 32/,
    );
  });

  it("accepts a production secret of >=32 chars", () => {
    const env = loadEnv({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32) });
    expect(env.isProduction).toBe(true);
  });

  it("parses CORS origins from a comma-separated list", () => {
    const env = loadEnv({ ...base, CORS_ORIGINS: "https://a.example, https://b.example ," });
    expect(env.CORS_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });

  it("never accepts a known default secret pattern as valid config shape (regression guard)", () => {
    // The upstream hardcoded fallback ("jtg-panel-super-secret") is 21 chars -> rejected in prod.
    expect(() => loadEnv({ NODE_ENV: "production", JWT_SECRET: "jtg-panel-super-secret" })).toThrow(
      ConfigError,
    );
  });
});
