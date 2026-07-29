import { vi } from "vitest";

/**
 * The environment `#src/config/index.js` demands, stubbed for a suite that never talks to a
 * real service (§11l.2 item 9).
 *
 * WHY THIS FILE EXISTS. Ten test files repeated the same nine `vi.stubEnv` calls, and a
 * tenth that missed one failed with a config parse error naming the missing variable rather
 * than the test's actual subject. `config` is parsed once at module load and throws on a
 * bad shape by design (§4 — a missing env var is unrecoverable, not a domain error), so
 * every suite that imports anything importing `config` has to satisfy it before the first
 * dynamic import.
 *
 * NOT a `setupFiles` entry, deliberately. Stubbing the environment for suites that do not
 * need it would hide the dependency, and the ones that DO need it must call this ABOVE
 * their own `vi.mock` factories to stay ordered correctly.
 */
export function stubServerEnvironment(overrides: Readonly<Record<string, string>> = {}): void {
  const values: Record<string, string> = {
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
    ...overrides,
  };

  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}
