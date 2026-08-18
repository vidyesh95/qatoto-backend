import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The `/admin/metrics/*` router — §3.3a.
 *
 * TWO PROPERTIES, both silent when broken.
 *
 * FIRST, ALL FIVE ROUTES EXIST AND ARE AUTHENTICATED. The capability check (`view_platform_metrics`,
 * `admin` only) lives inside each service call rather than in middleware, so a route wired without
 * `requireAuth` would reach the service with no session and fail on a missing caller id — a 500
 * where the honest answer is 401. Counting the middleware on each layer is the only place that is
 * visible before runtime.
 *
 * SECOND, NO PARAMETERISED ROUTE MAY PRECEDE THE LITERALS. Every path here is a distinct literal
 * today, so nothing shadows anything; the moment a `/admin/metrics/:something` is added above
 * them, `/admin/metrics/users` resolves as "the metric named users" and answers a plausible 404.
 * That route is the audited one — the read that names accounts — so the failure would also stop
 * writing the audit entries without anything looking wrong.
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
  /** Handlers on the layer: middleware plus the controller. */
  readonly handlerCount: number;
}

function declaredRoutes(router: unknown): readonly DeclaredRoute[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];
    return [
      {
        path,
        methods: Object.keys(layer.route?.methods ?? {}),
        handlerCount: layer.route?.stack?.length ?? 0,
      },
    ];
  });
}

const EXPECTED_PATHS = [
  "/admin/metrics/active-users",
  "/admin/metrics/watch-time",
  "/admin/metrics/activity-hours",
  "/admin/metrics/retention-cohorts",
  "/admin/metrics/users",
] as const;

describe("the platform metrics router", () => {
  it("declares exactly the five GET reads", async () => {
    const metricsRouter = (await import("#src/modules/platform/metrics/metrics.routes.js")).default;
    const routes = declaredRoutes(metricsRouter);

    expect(routes.map((route) => route.path)).toEqual([...EXPECTED_PATHS]);
    // READS ONLY. A POST or DELETE appearing here would mean the metrics surface had grown a
    // mutation, which belongs behind a different capability than "look at the dashboard".
    expect(routes.flatMap((route) => route.methods)).toEqual(EXPECTED_PATHS.map(() => "get"));
  });

  it("puts auth middleware ahead of the controller on every route", async () => {
    const metricsRouter = (await import("#src/modules/platform/metrics/metrics.routes.js")).default;

    const unguarded = declaredRoutes(metricsRouter)
      .filter((route) => route.handlerCount < 2)
      .map((route) => route.path);

    expect(unguarded, "a bare controller here reaches the service with no session and 500s").toEqual([]);
  });

  it("declares no parameterised route ahead of the literals", async () => {
    const metricsRouter = (await import("#src/modules/platform/metrics/metrics.routes.js")).default;
    const paths = declaredRoutes(metricsRouter).map((route) => route.path);

    const firstParamIndex = paths.findIndex((path) => path.includes("/:"));
    const shadowed = firstParamIndex === -1 ? [] : paths.slice(firstParamIndex + 1);

    expect(shadowed, "a param route above these makes /admin/metrics/users a plausible 404").toEqual([]);
  });
});
