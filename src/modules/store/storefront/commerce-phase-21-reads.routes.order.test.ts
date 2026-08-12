import { describe, expect, it, vi } from "vitest";

/**
 * Route DECLARATION ORDER for the reads Phase 21b added (Appendix A38).
 *
 * WHY THIS FILE EXISTS. Every route this phase added is a BARE COLLECTION PATH sitting beside
 * an existing `/:id` detail route at the same depth — `/threads` beside `/threads/:threadId`,
 * `/documents` beside `/documents/:documentId`, `/shipments` beside `/shipments/:shipmentId`,
 * `/provider/quotes` beside `/quotes/:quoteId`. That is exactly the shape
 * `commerce-factories.routes.order.test.ts` was written to police, and the failure mode is the
 * same: the list resolves as a detail lookup for an id literally named "documents", which
 * answers a plausible 404 rather than an error. The bug reads as missing data.
 *
 * The shadowing sweep below is the one from that file, applied to all four routers at once —
 * it catches the next insert as well as this one.
 */

vi.mock("dotenv/config", () => ({}));
vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/testdb");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-key-minimum-16-chars");
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:8000");
vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client-id");
vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-client-secret");

vi.mock("#src/db/index.js", () => ({
  pool: {
    query: vi.fn<(...args: unknown[]) => unknown>(),
    end: vi.fn<() => unknown>(),
  },
  db: {},
  query: vi.fn<(...args: unknown[]) => unknown>(),
}));

/**
 * Express does not type its layer stack, so reading declaration order means describing the
 * runtime shape. Narrowed through `unknown` and defensively — a layer with no `route` is a
 * middleware layer, not a route, and is dropped rather than assumed.
 */
interface RouterInternals {
  readonly stack: readonly {
    readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
  }[];
}

interface DeclaredRoute {
  readonly path: string;
  readonly methods: readonly string[];
}

function isRouterInternals(value: unknown): value is RouterInternals {
  // An Express router is a FUNCTION with a `stack` property, not a plain object.
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

function declaredRoutes(router: unknown): readonly DeclaredRoute[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  const { stack } = router;
  return stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];
    return [{ path, methods: Object.keys(layer.route?.methods ?? {}) }];
  });
}

/**
 * Every later route this earlier one swallows — the rule from
 * `commerce-factories.routes.order.test.ts`, unchanged.
 *
 * Shadowing is per-segment: an earlier path shadows a later one when they have the same
 * segment count and every earlier segment either matches or is a `:param`, with at least one
 * `:param` sitting where the later path wants a literal.
 */
function shadowedBy(earlier: DeclaredRoute, later: DeclaredRoute): boolean {
  if (!earlier.methods.some((method) => later.methods.includes(method))) return false;

  const earlierSegments = earlier.path.split("/");
  const laterSegments = later.path.split("/");
  if (earlierSegments.length !== laterSegments.length) return false;

  let swallowsALiteral = false;
  for (const [index, earlierSegment] of earlierSegments.entries()) {
    const laterSegment = laterSegments[index] ?? "";
    if (earlierSegment.startsWith(":")) {
      if (!laterSegment.startsWith(":")) swallowsALiteral = true;
      continue;
    }
    if (earlierSegment !== laterSegment) return false;
  }
  return swallowsALiteral;
}

/** Every read this phase added, and the feature that does not exist without it. */
const PHASE_21_COLLECTION_READS = [
  {
    router: "#src/modules/store/procurement/commerce-messages.routes.js",
    collection: "/threads",
    breaks: "the thread inbox, and with it settlement agreements",
  },
  {
    router: "#src/modules/store/fulfillment/commerce-documents.routes.js",
    collection: "/documents",
    breaks: "the attachment picker's backing list",
  },
  {
    router: "#src/modules/store/fulfillment/commerce-fulfillment.routes.js",
    collection: "/shipments",
    breaks: "the buyer's inbound shipment queue",
  },
  {
    router: "#src/modules/store/procurement/commerce-quotes.routes.js",
    collection: "/provider/quotes",
    breaks: "a provider's own bid list",
  },
  {
    router: "#src/modules/store/orders/commerce-payments.routes.js",
    collection: "/refunds",
    breaks: "the only reader a refund has",
  },
] as const;

/**
 * The subset with a GENUINE ordering hazard — a detail route sharing their first segment at
 * the same depth.
 *
 * `/refunds` and `/provider/quotes` are deliberately absent. `/payments/:paymentIntentId` and
 * `/quotes/:quoteId` share no prefix with them, so neither can shadow the other and asserting
 * an order between them would be a test that passes for no reason. The sweep below still
 * covers those routers.
 */
const PHASE_21_SHADOWING_HAZARDS = [
  {
    router: "#src/modules/store/procurement/commerce-messages.routes.js",
    collection: "/threads",
    detail: "/threads/:threadId/messages",
  },
  {
    router: "#src/modules/store/fulfillment/commerce-documents.routes.js",
    collection: "/documents",
    detail: "/documents/:documentId",
  },
  {
    router: "#src/modules/store/fulfillment/commerce-fulfillment.routes.js",
    collection: "/shipments",
    detail: "/shipments/:shipmentId",
  },
] as const;

describe("Phase 21b collection reads", () => {
  it.each(PHASE_21_COLLECTION_READS)(
    "declares $collection, or $breaks does not exist",
    async ({ router, collection }) => {
      const routes = declaredRoutes((await import(router)).default);
      expect(routes.map((route) => route.path)).toContain(collection);
    },
  );

  it.each(PHASE_21_SHADOWING_HAZARDS)(
    "declares $collection before $detail, or the list resolves as a detail lookup",
    async ({ router, collection, detail }) => {
      const paths = declaredRoutes((await import(router)).default).map((route) => route.path);

      const collectionIndex = paths.indexOf(collection);
      const detailIndex = paths.indexOf(detail);

      expect(collectionIndex, `${collection} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(detailIndex, `${detail} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(collectionIndex).toBeLessThan(detailIndex);
    },
  );

  /**
   * The rule itself rather than the five instances above, across every router this phase
   * touched. This is what catches the NEXT bare collection path somebody adds below a
   * `/:param` of the same depth.
   */
  it.each([
    "#src/modules/store/procurement/commerce-messages.routes.js",
    "#src/modules/store/fulfillment/commerce-documents.routes.js",
    "#src/modules/store/fulfillment/commerce-fulfillment.routes.js",
    "#src/modules/store/procurement/commerce-quotes.routes.js",
    "#src/modules/store/orders/commerce-payments.routes.js",
  ])("%s declares no route that swallows a later one", async (routerModule) => {
    const routes = declaredRoutes((await import(routerModule)).default);

    const collisions = routes.flatMap((earlier, index) =>
      routes
        .slice(index + 1)
        .filter((later) => shadowedBy(earlier, later))
        .map((later) => `${earlier.path} (declared first) swallows ${later.path}`),
    );

    expect(collisions).toEqual([]);
  });
});
