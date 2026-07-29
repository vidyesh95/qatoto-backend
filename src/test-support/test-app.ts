import type { Express } from "express";

/**
 * The REAL app, imported once per suite (§11l.2 item 9).
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
 */
export async function buildTestApp(): Promise<Express> {
  const module = await import("#src/app.js");
  return module.default;
}
