import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * "No limiter was left on the per-process store" (§11l.2 item 7).
 *
 * WHY THIS EXISTS AS ITS OWN FILE. `config` is parsed ONCE at module load
 * (src/config/index.ts), so the production branch can only be reached by stubbing the
 * environment before any import of it — which means a file whose whole environment is
 * production, not a case inside one that is not. `TZ` is mandatory alongside it or
 * src/config/index.ts throws on the way past.
 *
 * WHY IT COUNTS RATHER THAN INSPECTS. A limiter built by `rateLimit()` closes over its
 * config and exposes only `resetKey` and `getKey`, so there is no way to ask an exported
 * limiter which store it holds. The identity below is equivalent and stronger: the factory
 * is the only thing that registers, so an inline `rateLimit({ … })` added later raises the
 * export count without raising the registration count and fails here by name.
 */

stubServerEnvironment({ NODE_ENV: "production", TZ: "UTC" });

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

/** An express-rate-limit handler is a function carrying these two methods. */
function isLimiter(value: unknown): boolean {
  return typeof value === "function" && "resetKey" in value && "getKey" in value;
}

describe("rate-limit store coverage, in production", () => {
  it("routes every exported limiter through the factory", async () => {
    // Imported here rather than at module scope so the environment stub above is in place
    // before src/config/index.ts is evaluated.
    const limiterModule = await import("#src/middleware/rate-limit.js");
    const storeModule = await import("#src/middleware/rate-limit-store.js");

    const exportedLimiters = Object.values(limiterModule).filter(isLimiter);
    const registrations = storeModule.rateLimitStoreRegistrations();

    expect(exportedLimiters.length).toBeGreaterThan(30);
    expect(registrations).toHaveLength(exportedLimiters.length);
  });

  it("puts every one of them on Postgres, not on memory", async () => {
    await import("#src/middleware/rate-limit.js");
    const { rateLimitStoreRegistrations } = await import("#src/middleware/rate-limit-store.js");

    // The actual §11l.2 item 7 claim, asserted rather than assumed. One limiter left on
    // memory is one route whose documented limit multiplies by the instance count.
    const onMemory = rateLimitStoreRegistrations().filter((entry) => entry.storeKind !== "postgres");

    expect(onMemory).toEqual([]);
  });

  it("gives every limiter its own bucket namespace", async () => {
    await import("#src/middleware/rate-limit.js");
    const { rateLimitStoreRegistrations } = await import("#src/middleware/rate-limit-store.js");

    // `createRateLimitStore` already throws on a duplicate at load, so reaching this
    // assertion at all means the throw did not fire. Asserted anyway: if that guard is ever
    // softened, a copy-pasted namespace silently merges two limiters' buckets.
    const namespaces = rateLimitStoreRegistrations().map((entry) => entry.namespace);

    expect(new Set(namespaces).size).toBe(namespaces.length);
  });
});
