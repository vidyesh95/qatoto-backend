import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The `/blueprints` router's own docblock states the hazard verbatim: `/admin/hero-slides
 * /reorder` is a literal and must precede `/admin/hero-slides/:slideId`, or "reorder" is
 * captured as a slide id and the reorder handler never runs. Flagged as unguarded in the
 * repo-wide audit that drove this test pass; this file closes that gap the same way
 * `metrics.routes.order.test.ts` guards its own router.
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

describe("the blueprints router", () => {
  it("declares /admin/hero-slides/reorder before /admin/hero-slides/:slideId", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const paths = declaredRoutes(blueprintsRouter).map((route) => route.path);

    const reorderIndex = paths.indexOf("/admin/hero-slides/reorder");
    const paramIndex = paths.indexOf("/admin/hero-slides/:slideId");

    expect(reorderIndex, "reorder must be declared at all").toBeGreaterThanOrEqual(0);
    expect(paramIndex, ":slideId must be declared at all").toBeGreaterThanOrEqual(0);
    expect(reorderIndex).toBeLessThan(paramIndex);
  });

  it("declares the public read with no auth middleware and every admin route with at least one guard", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const routes = declaredRoutes(blueprintsRouter);
    if (!isRouterInternals(blueprintsRouter)) throw new Error("router has no layer stack");

    const handlerCounts = new Map(
      blueprintsRouter.stack.flatMap((layer) => {
        const path = layer.route?.path;
        if (typeof path !== "string") return [];
        return [[path, layer.route?.stack?.length ?? 0] as const];
      }),
    );

    expect(handlerCounts.get("/hero-slides")).toBe(1);
    for (const route of routes) {
      if (route.path === "/hero-slides") continue;
      expect(handlerCounts.get(route.path) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
