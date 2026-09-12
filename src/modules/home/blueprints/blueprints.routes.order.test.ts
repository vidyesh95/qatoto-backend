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

/**
 * Handler counts keyed by `"<method> <path>"`, NOT by path alone.
 *
 * `GET /showcases` and `POST /showcases` share a path and differ by six handlers — the public read
 * is bare, the submit carries auth, a limiter, identity, a parser and idempotency. Keyed by path,
 * whichever was declared last would silently win and the other's chain would go unchecked.
 */
function handlerCountsByMethodAndPath(router: unknown): Map<string, number> {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  return new Map(
    router.stack.flatMap((layer) => {
      const path = layer.route?.path;
      if (typeof path !== "string") return [];
      const handlerCount = layer.route?.stack?.length ?? 0;
      return Object.keys(layer.route?.methods ?? {}).map((method) => [`${method} ${path}`, handlerCount] as const);
    }),
  );
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

  it("declares every bare public read with one handler and every guarded route with at least two", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const routes = declaredRoutes(blueprintsRouter);
    const handlerCounts = handlerCountsByMethodAndPath(blueprintsRouter);

    /*
     * THE BARE PUBLIC READS, listed rather than inferred. Each is a controller and nothing else —
     * no auth, no optional user, no limiter — because its answer is identical for every visitor.
     * Listing them by hand is the point: adding a route to this set is a decision to serve it to
     * anyone, and it should cost an edit here rather than happening because a count changed.
     */
    const barePublicRoutes = new Set([
      "get /hero-slides",
      "get /showcases",
      "get /showcases/slugs",
      "get /showcases/:launchSlug",
      "get /teardowns",
      "get /teardowns/options",
      "get /teardowns/slugs",
      "get /teardowns/:teardownSlug",
      "get /teardowns/:teardownSlug/claim-targets",
      "get /case-studies",
      "get /case-studies/options",
      "get /case-studies/slugs",
      "get /case-studies/:caseStudySlug",
    ]);

    for (const routeKey of barePublicRoutes) {
      expect(handlerCounts.get(routeKey), `${routeKey} must be declared and bare`).toBe(1);
    }
    for (const route of routes) {
      for (const method of route.methods) {
        const routeKey = `${method} ${route.path}`;
        if (barePublicRoutes.has(routeKey)) continue;
        expect(handlerCounts.get(routeKey) ?? 0, `${routeKey} must carry a guard`).toBeGreaterThanOrEqual(2);
      }
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
    const parameterizedIndex = paths.findIndex((path) => path.startsWith("/showcases/:"));
    // No `/showcases/:param` route exists yet, and "not declared" has to pass the same comparison as
    // "declared last" — otherwise this case would have to skip itself today and would never fail.
    const effectiveParameterizedIndex = parameterizedIndex === -1 ? Number.MAX_SAFE_INTEGER : parameterizedIndex;

    expect(writeUpImagesIndex, "/showcases/write-up-images must be declared at all").toBeGreaterThanOrEqual(0);
    expect(mineIndex, "/showcases/mine must be declared at all").toBeGreaterThanOrEqual(0);
    expect(effectiveParameterizedIndex).toBeGreaterThan(writeUpImagesIndex);
    expect(effectiveParameterizedIndex).toBeGreaterThan(mineIndex);
  });

  /**
   * EXACT handler counts, not a floor, because every one of these chains is load-bearing and the
   * failure mode of a dropped guard is silent. Five and six are the chains the router declares:
   * auth, limiter, identity, parser (, idempotency), controller.
   */
  it("gives each showcase route its exact guard chain", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const handlerCounts = handlerCountsByMethodAndPath(blueprintsRouter);

    expect(handlerCounts.get("post /showcases/write-up-images")).toBe(5);
    expect(handlerCounts.get("post /showcases")).toBe(6);
    expect(handlerCounts.get("get /showcases/mine")).toBe(2);
    expect(handlerCounts.get("get /admin/showcases/review-queue")).toBe(2);
    // The public reads: a controller and nothing else.
    expect(handlerCounts.get("get /showcases")).toBe(1);
    expect(handlerCounts.get("get /showcases/slugs")).toBe(1);
    expect(handlerCounts.get("get /showcases/:launchSlug")).toBe(1);
    expect(handlerCounts.get("post /admin/showcases/:submissionId/moderate")).toBe(6);
  });

  /**
   * The five teardown reads, each a controller and nothing else.
   *
   * EXACT COUNTS, so a guard added here is a failure rather than a silent change of surface. It
   * would be a change of surface: two of these five are READABLE-gated and serve a quarantined
   * teardown its notice, and anything that turned them into authenticated routes would take that
   * page away from the reader who followed an existing link.
   */
  it("gives each teardown read its exact bare chain", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const handlerCounts = handlerCountsByMethodAndPath(blueprintsRouter);

    expect(handlerCounts.get("get /teardowns")).toBe(1);
    expect(handlerCounts.get("get /teardowns/options")).toBe(1);
    expect(handlerCounts.get("get /teardowns/slugs")).toBe(1);
    expect(handlerCounts.get("get /teardowns/:teardownSlug")).toBe(1);
    expect(handlerCounts.get("get /teardowns/:teardownSlug/claim-targets")).toBe(1);
  });

  /**
   * `options` and `slugs` are literals under `/teardowns/`, and `/teardowns/:teardownSlug` captures
   * either word as a slug if it is declared first — answering "no such teardown" to the launch
   * composer's select and to the frontend's prerender step, both of which would then fall back to
   * an empty list rather than an error anybody notices.
   *
   * The literal list is DERIVED rather than named, so the next literal under `/teardowns/` is
   * guarded without anyone remembering to add it here.
   */
  it("declares every /teardowns literal before /teardowns/:teardownSlug", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const paths = declaredRoutes(blueprintsRouter).map((route) => route.path);

    const parameterizedIndex = paths.indexOf("/teardowns/:teardownSlug");
    expect(parameterizedIndex, "/teardowns/:teardownSlug must be declared at all").toBeGreaterThanOrEqual(0);

    const literalPaths = paths.filter((path) => path.startsWith("/teardowns/") && !path.includes(":"));
    expect(literalPaths, "the derived literal list must not be empty").toEqual([
      "/teardowns/options",
      "/teardowns/slugs",
    ]);
    for (const literalPath of literalPaths) {
      expect(paths.indexOf(literalPath), `${literalPath} must precede /teardowns/:teardownSlug`).toBeLessThan(
        parameterizedIndex,
      );
    }
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
   * The case-study chains, exact.
   *
   * ⚠️ FOUR BARE AND FOUR GUARDED, and the split is the surface. A guard added to one of the four
   * reads would take the public case-study pages away from a reader; a guard DROPPED from one of the
   * four writer or moderator routes would open a write path or the one read that serves a withheld
   * company's real name. Exact counts fail on either.
   */
  it("gives each case-study route its exact chain", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const handlerCounts = handlerCountsByMethodAndPath(blueprintsRouter);

    // The public reads: a controller and nothing else.
    expect(handlerCounts.get("get /case-studies")).toBe(1);
    expect(handlerCounts.get("get /case-studies/options")).toBe(1);
    expect(handlerCounts.get("get /case-studies/slugs")).toBe(1);
    expect(handlerCounts.get("get /case-studies/:caseStudySlug")).toBe(1);
    // auth, limiter, identity, compactBody, idempotency, controller.
    expect(handlerCounts.get("post /case-studies")).toBe(6);
    expect(handlerCounts.get("get /case-studies/mine")).toBe(2);
    expect(handlerCounts.get("get /admin/case-studies/review-queue")).toBe(2);
    expect(handlerCounts.get("post /admin/case-studies/:submissionId/moderate")).toBe(6);
  });

  /**
   * `mine`, `options` and `slugs` are literals under `/case-studies/`, and `/:caseStudySlug`
   * captures any of them as a slug if declared first.
   *
   * ⚠️ `mine` IS THE ONE THAT MATTERS. Captured as a slug it would answer a STRANGER'S published
   * case study to a writer asking for their own — the hazard the router docblock already states for
   * `/showcases/mine`. The literal list is DERIVED, so the next literal is guarded without anyone
   * remembering to add it here.
   */
  it("declares every /case-studies literal before /case-studies/:caseStudySlug", async () => {
    const blueprintsRouter = (await import("#src/modules/home/blueprints/blueprints.routes.js")).default;
    const paths = declaredRoutes(blueprintsRouter).map((route) => route.path);

    const parameterizedIndex = paths.indexOf("/case-studies/:caseStudySlug");
    expect(parameterizedIndex, "/case-studies/:caseStudySlug must be declared at all").toBeGreaterThanOrEqual(0);

    const literalPaths = paths.filter((path) => path.startsWith("/case-studies/") && !path.includes(":"));
    expect(literalPaths, "the derived literal list must not be empty").toEqual([
      "/case-studies/mine",
      "/case-studies/options",
      "/case-studies/slugs",
    ]);
    for (const literalPath of literalPaths) {
      expect(paths.indexOf(literalPath), `${literalPath} must precede /case-studies/:caseStudySlug`).toBeLessThan(
        parameterizedIndex,
      );
    }
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
