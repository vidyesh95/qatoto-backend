import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The `/promotions` router's own docblock states the hazard verbatim: the literal
 * `/admin/slides/reorder` must precede `/admin/slides/:slideId`, or "reorder" is captured
 * as a slide id and every reorder 404s. Flagged as unguarded in the repo-wide audit that
 * drove this test pass; this file closes that gap the same way `metrics.routes.order.test.ts`
 * guards its own router.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

interface RouterInternals {
  readonly stack: readonly {
    readonly route?: {
      readonly path?: unknown;
      readonly methods?: Record<string, boolean>;
      readonly stack?: readonly unknown[];
    };
  }[];
}

function isRouterInternals(value: unknown): value is RouterInternals {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

interface DeclaredRoute {
  readonly path: string;
  readonly methods: readonly string[];
}

function declaredRoutes(router: unknown): readonly DeclaredRoute[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];
    return [{ path, methods: Object.keys(layer.route?.methods ?? {}) }];
  });
}

describe("the promotions router", () => {
  it("declares /admin/slides/reorder before /admin/slides/:slideId", async () => {
    const promotionsRouter = (await import("#src/modules/home/promotions/promotions.routes.js")).default;
    const paths = declaredRoutes(promotionsRouter).map((route) => route.path);

    const reorderIndex = paths.indexOf("/admin/slides/reorder");
    const paramIndex = paths.indexOf("/admin/slides/:slideId");

    expect(reorderIndex, "reorder must be declared at all").toBeGreaterThanOrEqual(0);
    expect(paramIndex, ":slideId must be declared at all").toBeGreaterThanOrEqual(0);
    expect(reorderIndex).toBeLessThan(paramIndex);
  });

  it("declares the public read with no auth middleware and every admin route with at least one guard", async () => {
    const promotionsRouter = (await import("#src/modules/home/promotions/promotions.routes.js")).default;
    const routes = declaredRoutes(promotionsRouter);
    if (!isRouterInternals(promotionsRouter)) throw new Error("router has no layer stack");

    const handlerCounts = new Map(
      promotionsRouter.stack.flatMap((layer) => {
        const path = layer.route?.path;
        if (typeof path !== "string") return [];
        return [[path, layer.route?.stack?.length ?? 0] as const];
      }),
    );

    expect(handlerCounts.get("/slides")).toBe(1);
    for (const route of routes) {
      if (route.path === "/slides") continue;
      expect(handlerCounts.get(route.path) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
