import { TEST_SESSION_USER } from "#src/test-support/auth-mock.js";

/**
 * Empty every rate-limit bucket the current test file has filled.
 *
 * WHY THIS IS NEEDED, and it is not obvious from any test file. Under `NODE_ENV=test`
 * `createRateLimitStore` returns `undefined` (`src/middleware/rate-limit-store.ts`, gated on
 * `isRateLimitStoreShared` in `src/config/index.ts`), so express-rate-limit falls back to
 * building its OWN `MemoryStore` for each of the ~111 limiters. Those stores are created
 * once, when `rate-limit.ts` is imported, and nothing ever resets them.
 *
 * THE KEY IS THE SAME FOR EVERY TEST. `userKey` in `rate-limit.ts` returns `req.user?.id`,
 * and every route suite signs in as `TEST_SESSION_USER` — so all tests in a file share one
 * bucket per limiter, and the count only rolls on express-rate-limit's own wall-clock
 * window (a minute, for the commerce limiters). A suite that makes fifteen writes against a
 * limit of twenty is five requests from a 429 that would be reported against whichever test
 * happened to run last. `commerce-trust.routes.test.ts` is exactly that suite today.
 *
 * That failure mode is wall-clock dependent, not worker dependent: it reproduces at
 * `--maxWorkers=1`, and `--sequence.shuffle` only changes which test wears it.
 *
 * The import is LAZY, inside the function, on purpose. `rate-limit.ts` pulls in `config`,
 * which throws unless the environment is stubbed — and `stubServerEnvironment()` runs in the
 * suite, after this module is imported but before this function is called.
 */
export async function resetRateLimiters(): Promise<void> {
  const limiterModule = await import("#src/middleware/rate-limit.js");

  for (const exported of Object.values(limiterModule)) {
    // The same shape check `rate-limit-coverage.test.ts` uses: an express-rate-limit handler
    // is a function carrying `resetKey` and `getKey`.
    if (typeof exported !== "function" || !("resetKey" in exported) || !("getKey" in exported)) {
      continue;
    }

    const resetKey = (exported as { readonly resetKey: (key: string) => void }).resetKey;
    resetKey(TEST_SESSION_USER.id);
  }
}
