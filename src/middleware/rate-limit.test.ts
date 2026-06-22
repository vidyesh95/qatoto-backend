import type { Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeAll, vi } from "vitest";

/**
 * End-to-end rate-limit tests against the REAL Express app.
 *
 * Strategy: the limiters in src/middleware/rate-limit.ts run BEFORE the auth
 * controllers in the middleware chain. So we stub Better Auth + the DB to remove
 * all external I/O, then drive the real routes through supertest and assert the
 * limiter fires (429) once the configured threshold is crossed.
 *
 * Per-test isolation: the limiters are module-level singletons backed by an
 * in-memory store, so their counters persist for the whole file run. Each test
 * therefore uses its own `X-Forwarded-For` IP (app.ts sets `trust proxy = 1`, so
 * req.ip resolves to that value) and its own email namespace, giving every test
 * fresh per-IP and per-email buckets.
 */

// Mirror app.test.ts: dotenv is a no-op and env is stubbed so config + Better Auth load.
vi.mock("dotenv/config", () => ({}));
vi.stubEnv("PORT", "3000");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/testdb");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-key-minimum-16-chars");
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:8000");
vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client-id");
vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-client-secret");

// No real DB connection. Support the db.update().set().where() chain completeSignup uses.
vi.mock("#src/db/index.js", () => {
  const whereStub = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined);
  const setStub = vi.fn<(...args: unknown[]) => unknown>(() => ({ where: whereStub }));
  const updateStub = vi.fn<(...args: unknown[]) => unknown>(() => ({ set: setStub }));
  return {
    pool: { query: vi.fn<(...args: unknown[]) => unknown>(), end: vi.fn<(...args: unknown[]) => unknown>() },
    db: { update: updateStub },
    query: vi.fn<(...args: unknown[]) => unknown>(),
  };
});

// Stub the Better Auth surface the controllers touch. The limiters sit in front of
// these, so the happy path returns 2xx without any DB / email / network call.
vi.mock("#src/lib/auth.js", () => ({
  auth: {
    handler: vi.fn<(...args: unknown[]) => unknown>(),
    api: {
      sendVerificationOTP: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      checkVerificationOTP: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      signUpEmail: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ headers: { getSetCookie: (): string[] => [] } }),
      getSession: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(null),
    },
  },
}));

describe("rate limiting (e2e via real app)", () => {
  let app: Express;

  beforeAll(async () => {
    app = (await import("#src/app.js")).default;
  });

  const startSignup = (forwardedIp: string, email: string) =>
    request(app).post("/signup/start").set("X-Forwarded-For", forwardedIp).send({ email });

  const completeSignup = (forwardedIp: string, email: string) =>
    request(app)
      .post("/signup/complete")
      .set("X-Forwarded-For", forwardedIp)
      .send({ email, otp: "123456", password: "password123" });

  describe("/signup/start — per-IP limiter (limit = 8 / 15 min)", () => {
    it("allows 8 requests from one IP then blocks the 9th with 429", async () => {
      const forwardedIp = "10.10.0.1";

      // Distinct emails so the per-email limiter (4) never trips first — only the IP count grows.
      for (let attempt = 1; attempt <= 8; attempt++) {
        const allowed = await startSignup(forwardedIp, `ip-test-${attempt}@example.com`);
        expect(allowed.status).toBe(200);
      }

      const blocked = await startSignup(forwardedIp, "ip-test-9@example.com");
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ status: "error", statusCode: 429 });
      expect(blocked.body.message).toMatch(/too many requests/i);
    });
  });

  describe("/signup/start — per-email limiter (limit = 4 / 15 min, anti email-bomb)", () => {
    it("blocks the 5th code to one inbox even when each request comes from a new IP", async () => {
      const targetEmail = "bomb-target@example.com";

      // New IP every time, so the per-IP limiter (8) cannot be what trips.
      for (let attempt = 1; attempt <= 4; attempt++) {
        const allowed = await startSignup(`10.20.0.${attempt}`, targetEmail);
        expect(allowed.status).toBe(200);
      }

      const blocked = await startSignup("10.20.0.99", targetEmail);
      expect(blocked.status).toBe(429);
    });
  });

  describe("/signup/complete — per-IP limiter (limit = 12 / 15 min)", () => {
    it("allows 12 requests from one IP then blocks the 13th with 429", async () => {
      const forwardedIp = "10.30.0.1";

      for (let attempt = 1; attempt <= 12; attempt++) {
        const allowed = await completeSignup(forwardedIp, `complete-${attempt}@example.com`);
        expect(allowed.status).not.toBe(429);
      }

      const blocked = await completeSignup(forwardedIp, "complete-13@example.com");
      expect(blocked.status).toBe(429);
    });
  });

  describe("429 response shape", () => {
    it("returns the ApiResponse envelope, a Retry-After hint, and standard RateLimit headers", async () => {
      const forwardedIp = "10.40.0.1";
      for (let attempt = 1; attempt <= 8; attempt++) {
        await startSignup(forwardedIp, `env-${attempt}@example.com`);
      }

      const blocked = await startSignup(forwardedIp, "env-9@example.com");

      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({
        status: "error",
        statusCode: 429,
        message: expect.stringMatching(/too many requests/i),
      });

      // standardHeaders: true → draft RateLimit headers present; legacyHeaders: false → no X-RateLimit-*.
      const hasStandardHeader = "ratelimit-limit" in blocked.headers || "ratelimit" in blocked.headers;
      expect(hasStandardHeader).toBe(true);
      expect(blocked.headers["x-ratelimit-limit"]).toBeUndefined();

      // The handler surfaces the retry delay from the Retry-After header.
      expect(typeof blocked.body.data?.retryAfterSeconds).toBe("number");
      expect(blocked.body.data.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe("standard headers under the limit", () => {
    it("advertises the configured limit (12) on /signup/complete", async () => {
      const allowed = await completeSignup("10.50.0.1", "limit-header@example.com");

      const limitHeader = allowed.headers["ratelimit-limit"] ?? allowed.headers["ratelimit"];
      expect(limitHeader).toBeDefined();
      expect(limitHeader).toContain("12");
    });
  });
});
