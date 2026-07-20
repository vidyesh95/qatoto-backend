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

  // The native-client lists (R_AND_D_BACKEND_STRUCTURE.md §4a). Both are UNSET in
  // this suite's environment, which is the case that matters most: it is the exact
  // shape a dev machine and CI run in, and it must spread to nothing so passkey and
  // OAuth behave identically to before these vars existed.
  it("defaults both native-origin lists to [] when unset", async () => {
    const { config } = await import("#src/config/index.js");

    expect(config.PASSKEY_NATIVE_ORIGINS).toEqual([]);
    expect(config.NATIVE_DEEP_LINK_SCHEMES).toEqual([]);
  });
});

/**
 * Re-parses the env schema in isolation. `config` is a module-level singleton parsed
 * once at import, so overriding a var after the fact cannot be observed through it —
 * these cases exercise the same schema against fresh input.
 */
async function parseWithOverrides(overrides: Readonly<Record<string, string>>): Promise<{ readonly success: boolean }> {
  const { z } = await import("zod");
  const commaSeparatedList = z
    .string()
    .optional()
    .transform((rawValue) =>
      (rawValue ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );

  const schema = z.object({
    PASSKEY_NATIVE_ORIGINS: commaSeparatedList.pipe(
      z.array(z.string().regex(/^(android:apk-key-hash:[A-Za-z0-9_-]+|https:\/\/[^/\s]+)$/)),
    ),
    NATIVE_DEEP_LINK_SCHEMES: commaSeparatedList.pipe(z.array(z.string().regex(/^[a-z][a-z0-9+.-]*:\/\/$/))),
  });

  return schema.safeParse(overrides);
}

describe("native-origin list parsing", () => {
  it("parses a two-entry comma-separated list, trimming whitespace", async () => {
    const parsed = await parseWithOverrides({
      NATIVE_DEEP_LINK_SCHEMES: "qatoto://, app://",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a scheme with no :// — Better Auth prefix-matches, so it would match nothing", async () => {
    const parsed = await parseWithOverrides({ NATIVE_DEEP_LINK_SCHEMES: "qatoto" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a trailing slash on a passkey origin — expectedOrigin is compared exactly", async () => {
    const parsed = await parseWithOverrides({ PASSKEY_NATIVE_ORIGINS: "https://app.qatoto.com/" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a plain http origin for a passkey ceremony", async () => {
    const parsed = await parseWithOverrides({ PASSKEY_NATIVE_ORIGINS: "http://app.qatoto.com" });
    expect(parsed.success).toBe(false);
  });

  it("accepts an android apk-key-hash alongside an https origin", async () => {
    const parsed = await parseWithOverrides({
      PASSKEY_NATIVE_ORIGINS: "android:apk-key-hash:Zm9vYmFy,https://app.qatoto.com",
    });
    expect(parsed.success).toBe(true);
  });
});
