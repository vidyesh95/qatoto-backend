import { describe, expect, it, vi } from "vitest";

/**
 * Route DECLARATION ORDER on the proof-of-effort router (§11l.1).
 *
 * WHY THIS FILE EXISTS. This is the router with the most `/:param` segments in the repo —
 * every path opens with `/:projectSlug`, and three families (`/effort-claims`, `/disputes`,
 * `/allocation-proposals`) now carry both a list and a detail. The route file states the
 * rule in prose at three places; nothing asserted it, and the discovery router already
 * proved that prose is not enough (see `discovery.routes.order.test.ts`).
 *
 * The failure this prevents is silent: a literal declared below a `/:param` in the same
 * position resolves as a lookup whose id is that literal, returns a plausible 404, and looks
 * like missing data rather than a routing bug.
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
 * middleware layer and is dropped rather than assumed.
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

/** A runtime guard rather than an assertion: Express does not type its layer stack, and
 * asserting the shape would be a claim rather than a check. */
function isRouterInternals(value: unknown): value is RouterInternals {
  // An Express router is a FUNCTION with a `stack` property, not a plain object — checking
  // for "object" alone silently rejects every router and turns this file into a suite that
  // passes by never running.
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

/** The routes this router declares, in declaration order, each with its verbs. */
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
 * Whether the earlier route swallows the later one. Same segment count, every earlier
 * segment matching or `:param`, and at least one `:param` where the later path wants a
 * literal — that last clause is what makes this a bug report rather than a duplicate-route
 * report. A GET cannot shadow a POST, so the verbs must overlap.
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

describe("proof-of-effort router declaration order", () => {
  it("declares no route that swallows a later one", async () => {
    const router = (await import("#src/routes/proof-of-effort.routes.js")).default;
    const routes = declaredRoutes(router);

    const collisions = routes.flatMap((earlier, index) =>
      routes
        .slice(index + 1)
        .filter((later) => shadowedBy(earlier, later))
        .map((later) => `${earlier.path} (declared first) swallows ${later.path}`),
    );

    expect(collisions).toEqual([]);
  });

  /**
   * The three §11l.1 reads, asserted present. A detail route that silently stopped being
   * declared would fail no other test in the suite: its controller keeps compiling and its
   * service keeps its own tests.
   */
  it.each([
    { path: "/:projectSlug/allocation-proposals/:proposalId", reads: "one allocation proposal" },
    { path: "/:projectSlug/fair-market-rates", reads: "the roster's current rates" },
    { path: "/:projectSlug/override-queue", reads: "the steps awaiting human review" },
    { path: "/:projectSlug/integrations/available", reads: "the provider catalogue" },
  ])("declares $path, which $reads", async ({ path }) => {
    const router = (await import("#src/routes/proof-of-effort.routes.js")).default;
    expect(declaredRoutes(router).map((route) => route.path)).toContain(path);
  });

  /**
   * `/integrations/available` is a literal in the position `/integrations/:provider` fills
   * on the DELETE, and a GET for `:provider` is the obvious next addition. Pinning the order
   * now costs nothing; discovering it later costs a silent 404.
   *
   * The parameterised path is already declared — as the DELETE that revokes a grant — so
   * both indexes are real and the assertion is a plain comparison. The verbs differ today,
   * which is why nothing is broken; the order is what keeps it that way when a GET arrives.
   */
  it("declares /integrations/available before any /integrations/:provider route", async () => {
    const router = (await import("#src/routes/proof-of-effort.routes.js")).default;
    const paths = declaredRoutes(router).map((route) => route.path);

    const literalIndex = paths.indexOf("/:projectSlug/integrations/available");
    const parameterisedIndex = paths.indexOf("/:projectSlug/integrations/:provider");

    expect(literalIndex).toBeGreaterThanOrEqual(0);
    expect(parameterisedIndex).toBeGreaterThan(literalIndex);
  });
});
