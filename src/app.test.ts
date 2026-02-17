import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

// Mock dotenv/config
vi.mock("dotenv/config", () => ({}));

// Set env vars before importing app modules
vi.stubEnv("PORT", "3000");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/testdb");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-key-minimum-16-chars");
vi.stubEnv("FRONTEND_URL", "http://localhost:3000");

// Mock the database module to avoid real DB connections
vi.mock("#src/db/index.js", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  query: vi.fn(),
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
});
