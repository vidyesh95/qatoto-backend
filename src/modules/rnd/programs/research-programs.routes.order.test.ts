import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

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
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

function declaredPaths(router: unknown): readonly string[] {
  if (!isRouterInternals(router)) throw new Error("router has no layer stack");
  const { stack } = router;
  return stack.map((layer) => layer.route?.path).filter((path): path is string => typeof path === "string");
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

describe("research-programs router declaration order", () => {
  it.each([
    {
      literal: "/slugs",
      parameterised: "/:programSlug",
      breaks: "slugs lookup for generateStaticParams",
    },
    {
      literal: "/mine",
      parameterised: "/:programSlug",
      breaks: "caller's own programs list",
    },
    {
      literal: "/review-queue",
      parameterised: "/:programSlug",
      breaks: "moderation review queue",
    },
  ])(
    "declares $literal before $parameterised, or $breaks silently resolves as a programSlug",
    async ({ literal, parameterised }) => {
      const router = (await import("#src/modules/rnd/programs/research-programs.routes.js")).default;
      const paths = declaredPaths(router);

      const literalIndex = paths.indexOf(literal);
      const parameterisedIndex = paths.indexOf(parameterised);

      expect(literalIndex, `${literal} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(parameterisedIndex, `${parameterised} is not declared at all`).toBeGreaterThanOrEqual(0);
      expect(literalIndex).toBeLessThan(parameterisedIndex);
    },
  );

  it("declares no route that swallows a later one", async () => {
    const router = (await import("#src/modules/rnd/programs/research-programs.routes.js")).default;
    const routes = declaredRoutes(router);

    const collisions = routes.flatMap((earlier, index) =>
      routes
        .slice(index + 1)
        .filter((later) => shadowedBy(earlier, later))
        .map((later) => `${earlier.path} (declared first) swallows ${later.path}`),
    );

    expect(collisions).toEqual([]);
  });
});
