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
      readonly stack?: readonly { readonly handle?: unknown; readonly name?: unknown }[];
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

  /**
   * The `/showcases` routes, added with the launch submission surface. The router's own docblock
   * states the hazard: `/showcases/write-up-images` and `/showcases/mine` are literals, and when
   * public reads add a `/showcases/:something` route it must be declared BELOW both, or "mine" is
   * captured as a launch slug. There is no `:param` route under `/showcases` yet, so this case is
   * the tripwire that fires the day one arrives in the wrong place.
   */
  it("declares the /showcases literals before any /showcases/:param route", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const paths = declaredRoutes(blueprintsRouter).map((route) => route.path);

    const writeUpImagesIndex = paths.indexOf("/showcases/write-up-images");
    const mineIndex = paths.indexOf("/showcases/mine");
    const parameterizedIndex = paths.findIndex((path) => /^\/showcases\/:/.test(path));

    expect(writeUpImagesIndex, "/showcases/write-up-images must be declared at all").toBeGreaterThanOrEqual(0);
    expect(mineIndex, "/showcases/mine must be declared at all").toBeGreaterThanOrEqual(0);
    if (parameterizedIndex >= 0) {
      expect(parameterizedIndex).toBeGreaterThan(writeUpImagesIndex);
      expect(parameterizedIndex).toBeGreaterThan(mineIndex);
    }
  });

  /**
   * EXACT handler counts, not a floor, because every one of these chains is load-bearing and the
   * failure mode of a dropped guard is silent. Five and six are the chains the router declares:
   * auth, limiter, identity, parser (, idempotency), controller.
   */
  it("gives each showcase route its exact guard chain", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    if (!isRouterInternals(blueprintsRouter)) throw new Error("router has no layer stack");

    const handlerCounts = new Map(
      blueprintsRouter.stack.flatMap((layer) => {
        const path = layer.route?.path;
        if (typeof path !== "string") return [];
        return [[path, layer.route?.stack?.length ?? 0] as const];
      }),
    );

    expect(handlerCounts.get("/showcases/write-up-images")).toBe(5);
    expect(handlerCounts.get("/showcases")).toBe(6);
    expect(handlerCounts.get("/showcases/mine")).toBe(2);
    expect(handlerCounts.get("/admin/showcases/review-queue")).toBe(2);
    expect(handlerCounts.get("/admin/showcases/:submissionId/moderate")).toBe(6);
  });

  /**
   * THE CHAIN ORDER ITSELF, which the counts above cannot see. The router docblock gives both
   * reasons: identity runs BEFORE the parser so an anonymous session is refused before multer
   * buffers 5 MB into memory, and idempotency runs AFTER it because its fingerprint hashes the
   * uploaded file — ahead of the parser there is no file to hash and one key reused with a
   * different image would replay the first answer.
   *
   * Matched by handler NAME rather than by identity because the middleware modules are not
   * imported here; the labelled guards below are what stop a rename from passing vacuously.
   */
  it("runs identity before the upload parser and idempotency after it on POST /showcases", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    if (!isRouterInternals(blueprintsRouter)) throw new Error("router has no layer stack");

    const submitLayer = blueprintsRouter.stack.find((layer) => layer.route?.path === "/showcases");
    const handlerNames = (submitLayer?.route?.stack ?? []).map((handler) => {
      const handle = handler.handle;
      return typeof handle === "function" ? handle.name : "";
    });

    const identityIndex = handlerNames.indexOf("requireIdentifiedUser");
    const parserIndex = handlerNames.findIndex((name) => name.startsWith("parseSingleFileUpload"));
    const idempotencyIndex = handlerNames.indexOf("idempotencyMiddleware");

    expect(identityIndex, "requireIdentifiedUser must be in the chain").toBeGreaterThanOrEqual(0);
    expect(parserIndex, "the upload parser must be in the chain").toBeGreaterThanOrEqual(0);
    expect(idempotencyIndex, "the idempotency guard must be in the chain").toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeLessThan(parserIndex);
    expect(parserIndex).toBeLessThan(idempotencyIndex);
  });

  /**
   * One limiter per mutating showcase route and none on the two reads. The shape check is the one
   * `rate-limit-coverage.test.ts` and `test-support/rate-limit-reset.ts` both use: an
   * express-rate-limit handler is a function carrying `resetKey` and `getKey`.
   */
  it("carries exactly one rate limiter on each mutating showcase route and none on the reads", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    if (!isRouterInternals(blueprintsRouter)) throw new Error("router has no layer stack");

    function limiterCount(routePath: string): number {
      const layer = blueprintsRouter.stack.find((candidate) => candidate.route?.path === routePath);
      const handlers = layer?.route?.stack ?? [];
      expect(handlers.length, `${routePath} must be declared at all`).toBeGreaterThan(0);
      return handlers.filter((handler) => {
        const handle = handler.handle;
        return typeof handle === "function" && "resetKey" in handle && "getKey" in handle;
      }).length;
    }

    expect(limiterCount("/showcases/write-up-images")).toBe(1);
    expect(limiterCount("/showcases")).toBe(1);
    expect(limiterCount("/admin/showcases/:submissionId/moderate")).toBe(1);
    expect(limiterCount("/showcases/mine")).toBe(0);
    expect(limiterCount("/admin/showcases/review-queue")).toBe(0);
  });
});
