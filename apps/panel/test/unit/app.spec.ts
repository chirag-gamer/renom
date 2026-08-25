import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server/http/app.js";
import { loadEnv } from "../../src/server/config/env.js";
import { createLogger } from "../../src/server/shared/logger.js";
import { ForbiddenError } from "../../src/server/shared/errors.js";

function makeApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const env = loadEnv({ NODE_ENV: "test" });
  return createApp({ env, logger: createLogger("silent", false), ...overrides });
}

describe("http skeleton", () => {
  it("GET /healthz returns ok (FR-154)", async () => {
    const res = await request(makeApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz aggregates registered components", async () => {
    const app = makeApp({
      readiness: async () => [
        { name: "db", ok: true },
        { name: "engine", ok: false, detail: "docker socket unreachable" },
      ],
    });
    const bad = await request(app).get("/readyz");
    expect(bad.status).toBe(503);
    expect(bad.body.status).toBe("degraded");

    const good = await request(makeApp({ readiness: async () => [{ name: "db", ok: true }] })).get(
      "/readyz",
    );
    expect(good.status).toBe(200);
    expect(good.body.status).toBe("ready");
  });

  it("echoes x-request-id and generates one when absent (NFR-008)", async () => {
    const generated = await request(makeApp()).get("/healthz");
    expect(generated.headers["x-request-id"]).toMatch(/[A-Za-z0-9-]{8,}/);

    const echoed = await request(makeApp()).get("/healthz").set("x-request-id", "my-trace-id-123");
    expect(echoed.headers["x-request-id"]).toBe("my-trace-id-123");
  });

  it("rejects untrusted CORS origin and allows configured one", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      CORS_ORIGINS: "https://panel.example",
    });
    const app = createApp({ env, logger: createLogger("silent", false) });

    const denied = await request(app).get("/healthz").set("origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();

    const allowed = await request(app).get("/healthz").set("origin", "https://panel.example");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://panel.example");
  });

  it("maps unknown routes to structured 404 (RFC-7807 shape)", async () => {
    const res = await request(makeApp()).get("/api/v3/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: "not_found", message: "Not found" });
  });

  it("returns 413 for bodies above 1 MB (SEC-010)", async () => {
    const big = "x".repeat(1024 * 1024 + 10_000);
    const res = await request(makeApp())
      .post("/api/v3/anything")
      .set("content-type", "application/json")
      .send(JSON.stringify({ blob: big }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const res = await request(makeApp())
      .post("/api/v3/anything")
      .set("content-type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("maps AppError subclasses to their status/code", async () => {
    const app = makeApp({
      registerRoutes: (a) => {
        a.use("/boom", (_req, _res, next) => next(new ForbiddenError()));
      },
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("hides stack traces on unexpected errors (500 body is generic)", async () => {
    const app = makeApp({
      registerRoutes: (a) => {
        a.use("/explode", () => {
          throw new Error("secret internals /stack/trace");
        });
      },
    });
    const res = await request(app).get("/explode");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("secret internals");
  });
});
