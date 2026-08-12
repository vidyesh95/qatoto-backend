import { describe, expect, it, vi } from "vitest";

/**
 * Route DECLARATION ORDER on the discovery router (§11j.2).
 *
 * WHY THIS FILE EXISTS. Express matches in declaration order, so a literal segment declared
 * BELOW a `/:param` in the same position is dead — the param swallows it. Adding
 * `/talent/:talentUserIdOrHandle` and `/problem-reports/:submissionId` put two shipped
 * routes one careless reorder away from silently resolving as something else:
 *
 *   GET /discovery/talent/me           → "the user whose handle is `me`"
 *   GET /discovery/problem-reports/mine → "the submission whose id is `mine`"
 *
 * Neither breaks a type, neither breaks any other test, and both return a plausible 404
 * rather than an error — so the failure looks like missing data, not a routing bug. The
 * route files carry comments stating the rule; this asserts it.
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

/** A runtime guard rather than an assertion: Express does not type its layer stack, and
 * asserting the shape would be a claim rather than a check. */
function isRouterInternals(value: unknown): value is RouterInternals {
  // An Express router is a FUNCTION with a `stack` property, not a plain object — checking
  // for "object" alone silently rejects every router and turns this file into a suite that
  // passes by never running.
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

/** The paths this router declares, in declaration order. */
function declaredPaths(router: unknown): readonly string[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  const { stack } = router;
  return stack.map((layer) => layer.route?.path).filter((path): path is string => typeof path === "string");
}

/** The same, carrying each route's verbs — a GET cannot shadow a POST. */
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
 * Every later route this earlier one swallows.
 *
 * Shadowing is per-segment: an earlier path shadows a later one when they have the same
 * segment count and every earlier segment either matches or is a `:param` — with at least
 * one `:param` sitting where the later path wants a literal. That last clause is what makes
 * this a bug report rather than a duplicate-route report.
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

describe("discovery router declaration order", () => {
  it.each([
    {
      literal: "/talent/me",
      parameterised: "/talent/:talentUserIdOrHandle",
      breaks: "the caller's own profile read",
    },
    {
      literal: "/problem-reports/mine",
      parameterised: "/problem-reports/:submissionId",
      breaks: "the caller's own reports list",
    },
  ])(
    "declares $literal before $parameterised, or $breaks silently resolves as a lookup",
    async ({ literal, parameterised }) => {
      const router = (await import("#src/modules/rnd/discovery/discovery.routes.js")).default;
      const paths = declaredPaths(router);

      const literalIndex = paths.indexOf(literal);
      const parameterisedIndex = paths.indexOf(parameterised);

      expect(literalIndex, `${literal} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(parameterisedIndex, `${parameterised} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(literalIndex).toBeLessThan(parameterisedIndex);
    },
  );

  /**
   * The rule itself, rather than the two instances of it above. The table only knows about
   * mistakes already made; this catches the next one — including on
   * `/market-insights/:insightId`, added for the demand-evidence chips, which is exactly the
   * shape that swallows a future `/market-insights/<literal>`.
   */
  it("declares no route that swallows a later one", async () => {
    const router = (await import("#src/modules/rnd/discovery/discovery.routes.js")).default;
    const routes = declaredRoutes(router);

    const collisions = routes.flatMap((earlier, index) =>
      routes
        .slice(index + 1)
        .filter((later) => shadowedBy(earlier, later))
        .map((later) => `${earlier.path} (declared first) swallows ${later.path}`),
    );

    expect(collisions).toEqual([]);
  });

  it("declares the market-insight detail read", async () => {
    const paths = declaredPaths((await import("#src/modules/rnd/discovery/discovery.routes.js")).default);
    expect(paths).toContain("/market-insights/:insightId");
  });
});
