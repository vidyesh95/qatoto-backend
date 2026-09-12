import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The Postgres rate-limit store (§11l.2 item 7).
 *
 * WHAT THIS TIER CAN AND CANNOT PROVE. The database is mocked here, so these cases cover the
 * store's own logic — key normalization, the degraded-mode circuit breaker, the shape it
 * hands back to express-rate-limit. They prove NOTHING about the SQL, because no test in this
 * repo touches a real database.
 *
 * The other half is `pnpm db:verify-rate-limit-store`, and it is not optional: the row-lock
 * claim (20 concurrent increments landing on exactly 20), the window rollover, the UTC round
 * trip through a `timestamp without time zone` column, and the oversized-key case are all
 * properties of Postgres, not of TypeScript. A store whose SQL has never run is not a store
 * worth shipping, and these limiters are the signup and credential-stuffing defenses.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

/** Set per-case. `null` makes the next database call reject, standing in for an outage. */
let upsertResult: { reject: boolean; rows: unknown[] } = { reject: false, rows: [] };
const executed = vi.fn<(...args: readonly unknown[]) => unknown>();

vi.mock("#src/db/index.js", () => {
  const returning = vi.fn<() => Promise<unknown[]>>(async () => {
    if (upsertResult.reject) {
      throw Object.assign(new Error("connection terminated"), { code: "57P01" });
    }
    return upsertResult.rows;
  });
  const onConflictDoUpdate = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ returning }));
  const values = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ onConflictDoUpdate }));
  const insert = vi.fn<(...args: readonly unknown[]) => unknown>(() => ({ values }));
  const execute = vi.fn<(...args: readonly unknown[]) => unknown>(async (...args) => {
    executed(...args);
    if (upsertResult.reject) throw new Error("connection terminated");
    return { rows: [] };
  });
  return {
    db: { insert, execute },
    pool: {
      query: vi.fn<(...args: readonly unknown[]) => unknown>(),
      end: vi.fn<() => unknown>(),
    },
    query: vi.fn<(...args: readonly unknown[]) => unknown>(),
  };
});

const loggedErrors = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/lib/logger.js", () => ({
  logger: {
    debug: vi.fn<(...args: readonly unknown[]) => void>(),
    info: vi.fn<(...args: readonly unknown[]) => void>(),
    warn: vi.fn<(...args: readonly unknown[]) => void>(),
    error: (...args: readonly unknown[]) => loggedErrors(...args),
  },
  errorFields: (error: unknown) => ({ errorMessage: String(error) }),
}));

async function loadStoreModule() {
  return import("#src/middleware/rate-limit-store.js");
}

describe("PostgresRateLimitStore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    upsertResult = { reject: false, rows: [] };
    (await loadStoreModule()).resetRateLimitStoreDegradation();
  });

  it("maps the row Postgres returns onto express-rate-limit's shape", async () => {
    const { PostgresRateLimitStore } = await loadStoreModule();
    const resetTime = new Date("2026-07-30T12:15:00.000Z");
    upsertResult = { reject: false, rows: [{ hitCount: 3, expiresAt: resetTime }] };

    const store = new PostgresRateLimitStore("probe", 60_000);
    store.init({ windowMs: 60_000 });

    expect(await store.increment("user_1")).toEqual({ totalHits: 3, resetTime });
  });

  it("declares itself non-local so the library knows the bucket is shared", async () => {
    const { PostgresRateLimitStore } = await loadStoreModule();

    // If this were true, express-rate-limit would treat two instances as independent and
    // its double-count check would stop protecting /signup/start's stacked limiters.
    expect(new PostgresRateLimitStore("probe", 1000).localKeys).toBe(false);
  });

  it("gives each namespace a distinct prefix", async () => {
    const { PostgresRateLimitStore } = await loadStoreModule();

    expect(new PostgresRateLimitStore("otpRequestIp", 1000).prefix).toBe("otpRequestIp:");
    expect(new PostgresRateLimitStore("otpRequestEmail", 1000).prefix).toBe("otpRequestEmail:");
  });

  describe("key normalization — the btree guard", () => {
    it("passes an ordinary key through untouched", async () => {
      const { normalizeBucketKey } = await loadStoreModule();

      expect(normalizeBucketKey("user_1")).toBe("user_1");
    });

    it("hashes a key too long for a btree index row", async () => {
      const { normalizeBucketKey } = await loadStoreModule();

      // `emailKey` reads an unbounded body field and runs BEFORE the controller validates
      // anything, so this is attacker-triggerable on the OTP path. Unhashed it would raise
      // "index row size exceeds btree maximum" and take the signup route down.
      const normalized = normalizeBucketKey(`${"a".repeat(5000)}@example.com`);

      expect(normalized).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(normalized.length).toBeLessThanOrEqual(256);
    });

    it("is deterministic, so an oversized key keeps its own bucket", async () => {
      const { normalizeBucketKey } = await loadStoreModule();
      const oversized = "b".repeat(4000);

      // Not merely "it is short enough" — a non-deterministic normalizer would give the same
      // caller a fresh bucket every request, which is no limit at all.
      expect(normalizeBucketKey(oversized)).toBe(normalizeBucketKey(oversized));
      expect(normalizeBucketKey(oversized)).not.toBe(normalizeBucketKey("c".repeat(4000)));
    });
  });

  describe("degraded mode", () => {
    it("serves the request from memory instead of throwing when the database fails", async () => {
      const { PostgresRateLimitStore } = await loadStoreModule();
      upsertResult = { reject: true, rows: [] };

      const store = new PostgresRateLimitStore("probe", 60_000);
      store.init({ windowMs: 60_000 });

      // Fail-closed would 500 a signup because a bookkeeping table hiccuped; fail-open would
      // lift the OTP bound entirely during a partial outage. Memory keeps the bound.
      const first = await store.increment("user_1");
      expect(first.totalHits).toBe(1);

      const second = await store.increment("user_1");
      expect(second.totalHits).toBe(2);
    });

    it("stops retrying the database for the whole window, and logs once", async () => {
      const { PostgresRateLimitStore } = await loadStoreModule();
      upsertResult = { reject: true, rows: [] };

      const store = new PostgresRateLimitStore("probe", 60_000);
      store.init({ windowMs: 60_000 });
      await store.increment("user_1");

      // The breaker is the point: connectionTimeoutMillis is 10s, so retrying per request
      // under pool exhaustion would add ten seconds to every rate-limited request and make
      // the limiter itself the outage.
      const callsAfterFirstFailure = loggedErrors.mock.calls.length;
      await store.increment("user_2");
      await store.increment("user_3");

      expect(loggedErrors).toHaveBeenCalledTimes(callsAfterFirstFailure);
      expect(callsAfterFirstFailure).toBe(1);
    });

    it("names the namespace in the log line so the hot limiter is identifiable", async () => {
      const { PostgresRateLimitStore } = await loadStoreModule();
      upsertResult = { reject: true, rows: [] };

      const store = new PostgresRateLimitStore("otpRequestEmail", 60_000);
      store.init({ windowMs: 60_000 });
      await store.increment("someone@example.com");

      expect(loggedErrors).toHaveBeenCalledWith(
        expect.stringContaining("degraded"),
        expect.objectContaining({ namespace: "otpRequestEmail" }),
      );
    });
  });

  describe("createRateLimitStore", () => {
    it("refuses a duplicate namespace at module load rather than merging two buckets", async () => {
      const { createRateLimitStore } = await loadStoreModule();

      createRateLimitStore("uniqueProbeNamespace", 1000);

      // Two limiters sharing a namespace is a limit that is silently wrong for both, and
      // nothing at runtime would reveal it.
      expect(() => createRateLimitStore("uniqueProbeNamespace", 1000)).toThrow(/Duplicate/);
    });

    /**
     * ⚠️ THIS ASSERTION USED TO BE `toBeUndefined()`, AND THAT WAS THE FLAKE.
     *
     * Returning `undefined` makes express-rate-limit build its own `MemoryStore`, which nothing
     * in this repo holds a reference to — so `resetRateLimiters()` could only reach a bucket by
     * NAMING ITS KEY, and it guessed `TEST_SESSION_USER.id`. That is right for the ~108 limiters
     * behind `requireAuth` and wrong for the three signup ones, whose buckets are keyed on the
     * IP and the email and were therefore never emptied between tests.
     *
     * Owning the store is what makes the reset key-independent, so this is now the guarantee
     * every one of the 62 suites that calls `resetRateLimiters()` depends on.
     */
    it("returns a store this module owns and can reset, outside production", async () => {
      const { createRateLimitStore, MemoryRateLimitStore } = await loadStoreModule();

      // stubServerEnvironment() pins NODE_ENV to "test", so this is the dev/test branch.
      const store = createRateLimitStore("anotherProbeNamespace", 1000);

      expect(store).toBeInstanceOf(MemoryRateLimitStore);
    });
  });

  describe("resetAllRateLimitBuckets", () => {
    /**
     * THE PROPERTY THE OLD RESET COULD NOT HAVE: emptying a bucket WITHOUT KNOWING ITS KEY.
     *
     * The key here is deliberately not a user id — it is the shape `signupCompleteIpLimiter`
     * produces, which is exactly the bucket the previous implementation left behind.
     */
    it("empties a bucket nobody named, whatever its key", async () => {
      const { createRateLimitStore, resetAllRateLimitBuckets, MemoryRateLimitStore } = await loadStoreModule();

      const created = createRateLimitStore("resetProbeNamespace", 60_000);
      // Narrowed by `instanceof` rather than an assertion: `Store["init"]` is declared over the
      // whole `Options` object, and only the concrete class exposes the `Pick` this can satisfy.
      if (!(created instanceof MemoryRateLimitStore)) {
        throw new Error("the dev/test branch must return a MemoryRateLimitStore");
      }
      created.init({ windowMs: 60_000 });

      const key = "::ffff:127.0.0.1";
      created.increment(key);
      const beforeReset = created.get(key);

      resetAllRateLimitBuckets();

      expect(beforeReset?.totalHits).toBe(1);
      expect(created.get(key)).toBeUndefined();
    });

    /**
     * ⚠️ A NO-OP HERE DOES NOT LOOK LIKE A FAILURE — it looks like a suite that passes until the
     * day its test order changes, which is the bug this whole change replaced. So the absence of
     * anything to reset has to be loud.
     *
     * `vi.resetModules()` IS THE WHOLE TEST. `resettableMemoryStores` is module state, and every
     * other case in this file has already pushed into it, so the empty case is unreachable
     * without a fresh module registry. An earlier draft asserted the guard's MESSAGE TEXT
     * instead, which would have passed just as happily with the throw unreachable.
     */
    it("throws rather than silently resetting nothing", async () => {
      vi.resetModules();
      const { resetAllRateLimitBuckets } = await loadStoreModule();

      expect(() => resetAllRateLimitBuckets()).toThrow(/silently do nothing/);
    });
  });
});
