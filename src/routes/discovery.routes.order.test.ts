import type { Router } from "express";
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
  readonly stack: readonly { readonly route?: { readonly path?: unknown } }[];
}

/** The paths this router declares, in declaration order. */
function declaredPaths(router: Router): readonly string[] {
  const { stack } = router as unknown as RouterInternals;
  return stack.map((layer) => layer.route?.path).filter((path): path is string => typeof path === "string");
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
      const router = (await import("#src/routes/discovery.routes.js")).default;
      const paths = declaredPaths(router);

      const literalIndex = paths.indexOf(literal);
      const parameterisedIndex = paths.indexOf(parameterised);

      expect(literalIndex, `${literal} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(parameterisedIndex, `${parameterised} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(literalIndex).toBeLessThan(parameterisedIndex);
    },
  );
});
