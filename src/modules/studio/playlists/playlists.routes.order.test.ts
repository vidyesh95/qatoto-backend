import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The `/playlists` router's own header comment states the hazard directly: `/mine` MUST
 * be declared before `/:playlistId`, since Express matches in declaration order and a
 * `:playlistId` above it would capture "mine" as a playlist id. Flagged as unguarded by
 * the earlier repo audit — this closes that gap the same way `metrics.routes.order.test.ts`
 * closes it for `/admin/metrics/*`.
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

describe("the playlists router", () => {
  it("declares GET /mine before GET /:playlistId", async () => {
    const playlistsRouter = (await import("#src/modules/studio/playlists/playlists.routes.js")).default;
    const paths = declaredRoutes(playlistsRouter)
      .filter((route) => route.methods.includes("get"))
      .map((route) => route.path);

    const mineIndex = paths.indexOf("/mine");
    const paramIndex = paths.indexOf("/:playlistId");

    expect(mineIndex).toBeGreaterThanOrEqual(0);
    expect(paramIndex).toBeGreaterThanOrEqual(0);
    expect(mineIndex, "/:playlistId above /mine would swallow it as a playlist id").toBeLessThan(paramIndex);
  });

  it("puts auth middleware ahead of the controller on every route", async () => {
    const playlistsRouter = (await import("#src/modules/studio/playlists/playlists.routes.js")).default;

    const unguarded = declaredRoutes(playlistsRouter)
      .filter((route) => route.handlerCount < 2)
      .map((route) => route.path);

    expect(unguarded).toEqual([]);
  });
});
