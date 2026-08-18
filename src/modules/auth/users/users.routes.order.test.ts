import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * `GET /users/me/watch-time` (§3.3a) must be declared BEFORE `GET /users/:id`, and the failure
 * mode of getting that wrong is silent in the way route-order bugs always are.
 *
 * Express matches layers in declaration order, so `/:id` declared first swallows `/me/*` — the
 * literal `me` binds as an id and the handler answers a perfectly plausible 404 for "no such
 * user". Nothing type-checks wrong, no other test goes red, and the symptom reads as a data
 * problem rather than a routing one. The same class of bug `engagement.routes.order.test.ts`
 * pins for the two routers sharing `/videos`.
 *
 * The other `/me/*` routes are covered by the same assertion because they have the same shape,
 * and because the ordering only holds if it holds for ALL of them: a future `/:id` moved up one
 * line breaks whichever routes it passes, not the one someone was thinking about.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

interface RouterInternals {
  readonly stack: readonly {
    readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
  }[];
}

function isRouterInternals(value: unknown): value is RouterInternals {
  // A router is a FUNCTION carrying a `stack`. Checking for "object" alone rejects every router
  // and turns this into a suite that passes by never running.
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

/** Declaration order, flattened to `"get /me/watch-time"` keys. */
function declaredRouteKeys(router: unknown): readonly string[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];
    return Object.keys(layer.route?.methods ?? {}).map((method) => `${method} ${path}`);
  });
}

describe("the /users router's literal-before-param ordering", () => {
  it("declares GET /me/watch-time before GET /:id", async () => {
    const usersRouter = (await import("#src/modules/auth/users/users.routes.js")).default;
    const keys = declaredRouteKeys(usersRouter);

    const watchTimeIndex = keys.indexOf("get /me/watch-time");
    const paramIndex = keys.indexOf("get /:id");

    expect(watchTimeIndex, "GET /users/me/watch-time is not declared at all").toBeGreaterThanOrEqual(0);
    expect(paramIndex, "GET /users/:id is not declared at all").toBeGreaterThanOrEqual(0);
    expect(
      watchTimeIndex,
      "/:id declared first binds the literal 'me' as an id and answers a plausible 404",
    ).toBeLessThan(paramIndex);
  });

  it("declares every /me/* route before the first single-segment param route", async () => {
    const usersRouter = (await import("#src/modules/auth/users/users.routes.js")).default;
    const keys = declaredRouteKeys(usersRouter);

    const firstParamIndex = keys.findIndex((key) => /^[a-z]+ \/:[^/]+$/.test(key));
    if (firstParamIndex === -1) return;

    const shadowed = keys
      .map((key, index) => ({ key, index }))
      .filter(({ key, index }) => key.includes(" /me/") && index > firstParamIndex)
      .map(({ key }) => key);

    expect(shadowed, "these are declared after a single-segment param route and can never match").toEqual([]);
  });
});
