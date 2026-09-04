import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

const { default: importIntelligenceRouter } =
  await import("#src/modules/rnd/import-intelligence/import-intelligence.routes.js");

/**
 * Declaration order, asserted against the router's OWN layer stack.
 *
 * Express matches in declaration order and the first match wins, so
 * `/import-commodities/:hsCode` declared before `/import-commodities/:hsCode/trade-flows`
 * would be harmless (different segment counts) but `/import-commodities/:hsCode` declared
 * before a literal sibling at the same depth would silently swallow it — a 200 from the
 * wrong handler, no error anywhere.
 *
 * The general rule below is what actually guards this file; the explicit pairs are the
 * cases a reader wants named.
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

/**
 * A runtime guard rather than an assertion. An Express router is a FUNCTION with a `stack`
 * property, not a plain object — checking for "object" alone rejects every router and turns
 * this file into a suite that passes by never running.
 */
function isRouterInternals(value: unknown): value is RouterInternals {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

function declaredRoutes(router: unknown): readonly DeclaredRoute[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];
    return [{ path, methods: Object.keys(layer.route?.methods ?? {}) }];
  });
}

/**
 * Whether an earlier route swallows a later one.
 *
 * Per-segment: same segment count, every earlier segment matches or is a `:param`, and at
 * least one `:param` sits where the later path wants a literal. That last clause is what
 * makes this a bug report rather than a duplicate-route report.
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

describe("import-intelligence router declaration order", () => {
  it("declares the routes this domain is supposed to have", () => {
    const routes = declaredRoutes(importIntelligenceRouter);
    // A floor, so a router that stopped declaring anything cannot pass the sweep below by
    // comparing an empty list to an empty list.
    expect(routes.length).toBe(12);
  });

  it.each([
    ["/import-commodities/:hsCode/trade-flows", "/import-commodities/:hsCode"],
    ["/import-commodities/:hsCode/substitutes", "/import-commodities/:hsCode"],
  ])("declares %s before %s", (literalPath, paramPath) => {
    const paths = declaredRoutes(importIntelligenceRouter).map((route) => route.path);
    const literalIndex = paths.indexOf(literalPath);
    const paramIndex = paths.indexOf(paramPath);

    expect(literalIndex).toBeGreaterThanOrEqual(0);
    expect(paramIndex).toBeGreaterThanOrEqual(0);
    expect(literalIndex).toBeLessThan(paramIndex);
  });

  it("has no route shadowed by an earlier one", () => {
    const routes = declaredRoutes(importIntelligenceRouter);
    const collisions: string[] = [];

    for (const [earlierIndex, earlier] of routes.entries()) {
      for (const later of routes.slice(earlierIndex + 1)) {
        if (shadowedBy(earlier, later)) {
          collisions.push(`${earlier.path} shadows ${later.path}`);
        }
      }
    }

    expect(collisions).toEqual([]);
  });

  it("declares no write route for a commodity or a trade flow", () => {
    // The Comtrade ingest is their only author (§10A). A write route appearing here is a
    // design change, not a fix.
    const writes = declaredRoutes(importIntelligenceRouter).filter((route) =>
      route.methods.some((method) => ["post", "patch", "put", "delete"].includes(method)),
    );

    expect(writes.map((route) => route.path).toSorted()).toStrictEqual([
      "/domestic-substitutes",
      "/domestic-substitutes/:substituteId",
      // Authenticated because it spends a metered model call, and a write because it
      // enqueues one — even though it parses no body.
      "/localization-assessments/:assessmentId/pathway",
      "/localization-pathway-suggestions/:suggestionId/decision",
    ]);
  });

  it("declares no DELETE anywhere", () => {
    // Retirement is unpublishing: a deleted mapping orphans the assessment that counted it.
    const deleteRoutes = declaredRoutes(importIntelligenceRouter).filter((route) => route.methods.includes("delete"));
    expect(deleteRoutes).toEqual([]);
  });
});
