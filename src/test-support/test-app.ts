import express, { type Express } from "express";

import { stampTestSession } from "#src/test-support/auth-mock.js";

/**
 * The REAL app, imported once per suite (§11l.2 item 9), behind one test-only middleware.
 *
 * WHY THE REAL APP rather than a router mounted on a fresh Express instance: the thing
 * worth asserting is the wiring — mount order, the middleware chain, the 404 handler, the
 * error handler — and a probe app rebuilds all of that from the test's own assumptions.
 * `src/middleware/rate-limit.test.ts` and `not-found.test.ts` build probe apps deliberately,
 * because their subject IS one middleware; a route test's subject is the composition.
 *
 * The import is dynamic and deferred so it happens AFTER the caller's `vi.mock` factories
 * and `stubServerEnvironment()` have run. A static import would be hoisted above both, and
 * `config` would throw before the first assertion.
 *
 * WHY IT IS WRAPPED. `stampTestSession` has to run BEFORE anything in the real app, and the
 * real app is already fully assembled by the time this function sees it — `app.use()` on it
 * would append after every router and after the 404 handler, which is too late to be reached.
 * Mounting the assembled app inside a one-middleware outer app is the only way to get ahead
 * of it without reaching into Express's router stack. Paths are unaffected: the inner app is
 * mounted at the root, so every route keeps the URL it had, and the inner 404 and error
 * handlers still terminate the chain.
 *
 * See `auth-mock.ts` for what the stamp is for: it carries the caller's identity ON the
 * request, so a request that outlives its test cannot be answered with the next test's
 * session.
 */
export async function buildTestApp(): Promise<Express> {
  const module = await import("#src/app.js");
  const app = express();
  app.use(stampTestSession);
  app.use(module.default);
  return app;
}
