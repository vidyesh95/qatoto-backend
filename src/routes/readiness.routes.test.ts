import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * `/health` vs `/ready` (§11l.2 item 5).
 *
 * THE DISTINCTION IS THE SUBJECT. `/health` must stay dependency-free — a liveness probe
 * that fails when Postgres blips gets a healthy process killed, turning a brief outage into
 * a rolling restart. `/ready` must do the opposite: fail loudly, with a breakdown, so an
 * orchestrator stops routing traffic and an operator knows which dependency is down.
 *
 * A test that only asserted "both return 200" would pass on a `/ready` that checks nothing,
 * which is exactly the endpoint this replaced.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

const query = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/db/index.js", () => ({
  pool: {
    query: vi.fn<(...args: readonly unknown[]) => unknown>().mockResolvedValue({ rows: [] }),
    end: vi.fn<() => unknown>(),
  },
  db: {},
  query: (...args: readonly unknown[]) => query(...args),
}));

vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

describe("liveness and readiness", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([]);
  });

  it("answers /health without touching the database", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it("answers /ready 200 with every check ok", async () => {
    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.data.checks).toEqual({ database: "ok", jobs: "ok" });
    // Two probes: the database, and pg-boss's schema — the deploy step most likely skipped.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("answers 503 and names the failing dependency", async () => {
    query.mockRejectedValueOnce(new Error("connection refused"));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.data.checks.database).toBe("failed");
    // The other check still runs and still reports: an operator needs to know whether one
    // thing is down or everything is.
    expect(response.body.data.checks.jobs).toBe("ok");
  });

  it("answers 503 when the job schema is missing", async () => {
    query.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('relation "version" missing'));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.data.checks).toEqual({ database: "ok", jobs: "failed" });
  });

  it("returns a request id on every response", async () => {
    // The correlation id the error path also puts in the body. Without it a user reporting
    // a failure hands support a string that appears in no log (§11l.2 item 6).
    const response = await request(app).get("/health");

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a well-formed inbound request id but replaces a hostile one", async () => {
    const clean = await request(app).get("/health").set("X-Request-Id", "trace-abc123");
    expect(clean.headers["x-request-id"]).toBe("trace-abc123");

    // Too long to echo into a header, and containing characters a log parser would have to
    // escape. Node's HTTP client refuses a literal newline before it ever reaches Express,
    // so the realistic hostile shapes are length and charset.
    const tooLong = await request(app).get("/health").set("X-Request-Id", "a".repeat(400));
    expect(tooLong.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const unsafeCharacters = await request(app)
      .get("/health")
      .set("X-Request-Id", '{"level":"error","message":"forged"}');
    expect(unsafeCharacters.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
