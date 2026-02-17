import { describe, it, expect, vi } from "vitest";

// Mock dotenv/config to prevent loading .env during tests
vi.mock("dotenv/config", () => ({}));

// Mock process.env BEFORE importing config
const mockEnv = {
  PORT: "3000",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:password@localhost:5432/testdb",
  BETTER_AUTH_SECRET: "test-secret-key-minimum-16-chars",
  FRONTEND_URL: "http://localhost:3000",
};

vi.stubEnv("PORT", mockEnv.PORT);
vi.stubEnv("NODE_ENV", mockEnv.NODE_ENV);
vi.stubEnv("DATABASE_URL", mockEnv.DATABASE_URL);
vi.stubEnv("BETTER_AUTH_SECRET", mockEnv.BETTER_AUTH_SECRET);
vi.stubEnv("FRONTEND_URL", mockEnv.FRONTEND_URL);

describe("Config", () => {
  it("should parse valid environment variables", async () => {
    const { config } = await import("#src/config/index.js");

    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("test");
    expect(config.DATABASE_URL).toBe(mockEnv.DATABASE_URL);
    expect(config.BETTER_AUTH_SECRET).toBe(mockEnv.BETTER_AUTH_SECRET);
    expect(config.FRONTEND_URL).toBe(mockEnv.FRONTEND_URL);
  });
});
