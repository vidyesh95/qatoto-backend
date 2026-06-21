import { describe, it, expect, vi } from "vitest";

// Mock dotenv/config to prevent loading .env during tests
vi.mock("dotenv/config", () => ({}));

// Mock process.env BEFORE importing config
const mockEnv = {
  PORT: "3000",
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:password@localhost:5432/testdb",
  BETTER_AUTH_SECRET: "test-secret-key-minimum-16-chars",
  BETTER_AUTH_URL: "http://localhost:8000",
  FRONTEND_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
};

vi.stubEnv("PORT", mockEnv.PORT);
vi.stubEnv("NODE_ENV", mockEnv.NODE_ENV);
vi.stubEnv("DATABASE_URL", mockEnv.DATABASE_URL);
vi.stubEnv("BETTER_AUTH_SECRET", mockEnv.BETTER_AUTH_SECRET);
vi.stubEnv("BETTER_AUTH_URL", mockEnv.BETTER_AUTH_URL);
vi.stubEnv("FRONTEND_URL", mockEnv.FRONTEND_URL);
vi.stubEnv("GOOGLE_CLIENT_ID", mockEnv.GOOGLE_CLIENT_ID);
vi.stubEnv("GOOGLE_CLIENT_SECRET", mockEnv.GOOGLE_CLIENT_SECRET);
vi.stubEnv("GITHUB_CLIENT_ID", mockEnv.GITHUB_CLIENT_ID);
vi.stubEnv("GITHUB_CLIENT_SECRET", mockEnv.GITHUB_CLIENT_SECRET);

describe("Config", () => {
  it("should parse valid environment variables", async () => {
    const { config } = await import("#src/config/index.js");

    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("test");
    expect(config.DATABASE_URL).toBe(mockEnv.DATABASE_URL);
    expect(config.BETTER_AUTH_SECRET).toBe(mockEnv.BETTER_AUTH_SECRET);
    expect(config.BETTER_AUTH_URL).toBe(mockEnv.BETTER_AUTH_URL);
    expect(config.FRONTEND_URL).toBe(mockEnv.FRONTEND_URL);
  });
});
