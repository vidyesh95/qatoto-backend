import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock dotenv/config
vi.mock("dotenv/config", () => ({}));

// Set env vars before importing app modules
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

// Mock the database module to avoid real DB connections
vi.mock("#src/db/index.js", () => ({
  pool: {
    query: vi.fn<(...args: unknown[]) => unknown>(),
    end: vi.fn<() => unknown>(),
  },
  db: {},
  query: vi.fn<(...args: unknown[]) => unknown>(),
}));

describe("App Routes", () => {
  let app: express.Express;

  beforeAll(async () => {
    const module = await import("#src/app.js");
    app = module.default;
  });

  describe("GET /", () => {
    it("should return welcome message", async () => {
      const res = await request(app).get("/");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.message).toBe("Welcome to QAToto API");
    });
  });

  describe("GET /health", () => {
    it("should return health check response", async () => {
      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.message).toBe("OK");
      expect(res.body.uptime).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe("404 handling", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await request(app).get("/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.status).toBe("error");
      expect(res.body.message).toContain("Route not found");
    });
  });

  /**
   * Per-route body caps, end to end against the REAL app (§11l.4).
   *
   * NOTHING IN THIS SUITE EXERCISED A CAP BEFORE, which is why 77 dead parser registrations
   * went unnoticed for as long as they did — every test passed just as happily with none of
   * them in force.
   *
   * THE CAP SITS BEHIND `requireAuth` in the documented chain order
   * (`auth → limiter → idempotency → requireIdentifiedUser → body limit → controller`), so a
   * signed-out request to a guarded route answers 401 and never reaches the check. The two
   * cases that assert a 413 therefore use routes reachable without a session; the two that
   * assert "not 413" work on any route, since 401 is also not 413.
   */
  describe("per-route JSON body caps", () => {
    /** Over 16 KB, comfortably under the 128 KB ceiling. */
    const OVERSIZED_BODY = { note: "x".repeat(20_000) };

    it("accepts a large body on PUT /playlists/:id/videos — the route that was broken", async () => {
      // THE REGRESSION TEST. This schema takes 500 ids of 64 characters, about 33 KB of pure
      // ASCII, and the route sat behind a 10 KB cap it never declared. It failed for every
      // user, not only for non-English ones. A 413 here means the fix did not land.
      const res = await request(app)
        .put("/playlists/playlist_1/videos")
        .send({ videoIds: Array.from({ length: 400 }, (_, index) => `video_${String(index).padStart(56, "0")}`) });

      expect(res.status).not.toBe(413);
    });

    it("refuses an oversized body on a compact route, naming the cap", async () => {
      // `/signup/start` is unauthenticated, so the cap is reachable. A body this size is one
      // Zod would reject anyway, so the caller sees a 413 where they would have seen a 422 —
      // the request fails either way and no working traffic changes outcome.
      const res = await request(app).post("/signup/start").send(OVERSIZED_BODY);

      expect(res.status).toBe(413);
      expect(res.body.message).toBe("Request body exceeds the 16 KB size limit.");
    });

    it("still accepts a long-form body where the schema needs one", async () => {
      // `POST /discovery/problem-reports` carries a 5,000-character description, ~15 KB in
      // Devanagari or CJK. A 413 here would be the original non-English-users-only bug.
      const res = await request(app).post("/discovery/problem-reports").send(OVERSIZED_BODY);

      expect(res.status).not.toBe(413);
    });

    it("enforces the 128 KB ceiling above every per-route cap", async () => {
      // From the parser itself rather than a route check, so it applies everywhere including
      // routes behind auth — the body never finishes being read.
      const res = await request(app)
        .post("/signup/complete")
        .send({ note: "x".repeat(200_000) });

      expect(res.status).toBe(413);
      expect(res.body.message).toBe("Request body exceeds the 128 KB size limit.");
    });
  });
});
