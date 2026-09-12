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
 *
 * ## ⚠️ A SESSION-DEPENDENT SUITE MUST COME THROUGH HERE. IT IS NOT A STYLE PREFERENCE.
 *
 * `stampTestSession` is mounted here and nowhere else, so a test that reaches `#src/app.js`
 * directly gets NO stamp — and `getSession` then falls back to the module-level box, which is
 * the exact race `8fe09c2` fixed, restored in full. It shows up as `expected 401 to be 200`
 * against an innocent test, in roughly one shuffled run in five, and it took a month to
 * attribute the first time.
 *
 * Three files do reach the app directly (`app.test.ts`, `json-body-budget.test.ts`,
 * `rate-limit.test.ts`) and every one of them is session-free, which is what makes that safe.
 * `src/test-support/test-isolation.test.ts` is what keeps it true: it fails if any file uses
 * `signInAs`/`signOut` without `buildTestApp`, and it fails if any test DISCARDS a supertest
 * request — the pre-arrival half of the same race, which the stamp cannot close and which
 * `typescript/no-floating-promises` cannot see, because supertest's `Test` is a thenable rather
 * than a `Promise`.
 */
export async function buildTestApp(): Promise<Express> {
  const module = await import("#src/app.js");
  const app = express();
  app.use(stampTestSession);
  app.use(module.default);
  return app;
}
