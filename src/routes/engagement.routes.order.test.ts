import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The `/videos` prefix has TWO routers on it (HOME_BACKEND_STRUCTURE.md §5.2), and the
 * failure mode of getting that wrong is silent.
 *
 * `videosRouter` (Creator Studio) is mounted FIRST and declares `GET /:videoId` behind
 * `requireAuth`. Express matches routers in `app.use` declaration order, so a public
 * single-segment route added to `engagementRouter` would never run: every logged-out
 * viewer would get a 401 from the studio route instead. Nothing type-checks wrong, no
 * other test goes red, and the symptom reads as an auth bug rather than a routing one.
 *
 * That is the entire reason the public watch payload is `GET /feed/watch/:videoId` and
 * not `GET /videos/:videoId`. The route files say so; this asserts it.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

/**
 * Express does not type its layer stack, so reading declaration order means describing
 * the runtime shape — narrowed through `unknown`, and defensively: a layer with no
 * `route` is middleware and is dropped rather than assumed.
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
  // An Express router is a FUNCTION carrying a `stack`, not a plain object. Checking for
  // "object" alone silently rejects every router and turns this into a suite that passes
  // by never running.
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

/** `/:videoId/like` is two; `/` and `/:videoId` are one. */
function segmentCount(path: string): number {
  return path.split("/").filter((segment) => segment !== "").length;
}

describe("the /videos prefix, shared by two routers", () => {
  it("declares nothing single-segment on the engagement router", async () => {
    const engagementRouter = (await import("#src/routes/engagement.routes.js")).default;

    const shadowedRoutes = declaredRoutes(engagementRouter).filter((route) => segmentCount(route.path) < 2);

    expect(
      shadowedRoutes.map((route) => `${route.methods.join("|")} ${route.path}`),
      "a single-segment route here is permanently shadowed by videosRouter's requireAuth /:videoId",
    ).toEqual([]);
  });

  it("shares no (method, path) pair with the studio router", async () => {
    const engagementRouter = (await import("#src/routes/engagement.routes.js")).default;
    const videosRouter = (await import("#src/modules/studio/videos/videos.routes.js")).default;

    const studioKeys = new Set(
      declaredRoutes(videosRouter).flatMap((route) => route.methods.map((method) => `${method} ${route.path}`)),
    );

    const collisions = declaredRoutes(engagementRouter)
      .flatMap((route) => route.methods.map((method) => `${method} ${route.path}`))
      .filter((key) => studioKeys.has(key));

    expect(collisions, "the studio router is mounted first and wins every one of these").toEqual([]);
  });

  it("keeps the public watch payload off the /videos prefix entirely", async () => {
    const feedRouter = (await import("#src/routes/feed.routes.js")).default;
    const engagementPaths = declaredRoutes((await import("#src/routes/engagement.routes.js")).default).map(
      (route) => route.path,
    );

    expect(declaredRoutes(feedRouter).map((route) => route.path)).toContain("/watch/:videoId");
    expect(engagementPaths).not.toContain("/:videoId");
  });
});
