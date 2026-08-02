import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * "No limiter was left on the per-process store" (§11l.2 item 7).
 *
 * WHY THIS EXISTS AS ITS OWN FILE. `config` is parsed ONCE at module load
 * (src/config/index.ts), so the production branch can only be reached by stubbing the
 * environment before any import of it — which means a file whose whole environment is
 * production, not a case inside one that is not. `TZ` is mandatory alongside it or
 * src/config/index.ts throws on the way past.
 *
 * WHY IT COUNTS RATHER THAN INSPECTS. A limiter built by `rateLimit()` closes over its
 * config and exposes only `resetKey` and `getKey`, so there is no way to ask an exported
 * limiter which store it holds. The identity below is equivalent and stronger: the factory
 * is the only thing that registers, so an inline `rateLimit({ … })` added later raises the
 * export count without raising the registration count and fails here by name.
 */

stubServerEnvironment({ NODE_ENV: "production", TZ: "UTC" });

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

/** An express-rate-limit handler is a function carrying these two methods. */
function isLimiter(value: unknown): boolean {
  return typeof value === "function" && "resetKey" in value && "getKey" in value;
}

/**
 * Every router the app mounts, with the prefix it is mounted at.
 *
 * DUPLICATED FROM `src/app.ts` rather than exported from it, because importing the built
 * app would drag in the database pool, better-auth and every middleware this suite has
 * spent thirty lines stubbing out. The cost is that a router added to `app.ts` and not
 * added here is simply unchecked — which is why the count assertion below exists.
 */
const MOUNTED_ROUTERS: readonly { readonly mountPath: string; readonly specifier: string; readonly exportName: string }[] = [
  { mountPath: "/", specifier: "#src/routes/auth.routes.js", exportName: "default" },
  { mountPath: "/users", specifier: "#src/routes/users.routes.js", exportName: "default" },
  { mountPath: "/handles", specifier: "#src/routes/handles.routes.js", exportName: "default" },
  { mountPath: "/products", specifier: "#src/routes/products.routes.js", exportName: "default" },
  { mountPath: "/promotions", specifier: "#src/routes/promotions.routes.js", exportName: "default" },
  { mountPath: "/feed", specifier: "#src/routes/feed.routes.js", exportName: "default" },
  { mountPath: "/videos", specifier: "#src/routes/videos.routes.js", exportName: "default" },
  { mountPath: "/videos", specifier: "#src/routes/engagement.routes.js", exportName: "default" },
  { mountPath: "/", specifier: "#src/routes/engagement.routes.js", exportName: "commentRouter" },
  { mountPath: "/", specifier: "#src/routes/engagement.routes.js", exportName: "creatorRouter" },
  { mountPath: "/playlists", specifier: "#src/routes/playlists.routes.js", exportName: "default" },
  { mountPath: "/series", specifier: "#src/routes/series.routes.js", exportName: "default" },
  { mountPath: "/research-projects", specifier: "#src/routes/research-projects.routes.js", exportName: "default" },
  { mountPath: "/research-programs", specifier: "#src/routes/research-programs.routes.js", exportName: "default" },
  { mountPath: "/discovery", specifier: "#src/routes/discovery.routes.js", exportName: "default" },
  { mountPath: "/suppliers", specifier: "#src/routes/suppliers.routes.js", exportName: "default" },
  { mountPath: "/notifications", specifier: "#src/routes/notifications.routes.js", exportName: "default" },
];

/** A write. GETs are excluded — §7's bounds are about writes and expensive reads. */
const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);

/**
 * Mutating routes that carry NO limiter today — a SNAPSHOT OF EXISTING DEBT, not a
 * blessing.
 *
 * Every entry predates the home-feed work; none of §5.2's engagement routes is here. The
 * list exists so the assertion below can be exact rather than "greater than": a new route
 * without a limiter fails the build, and adding it to this list is a deliberate, reviewable
 * act rather than something that happens by not noticing.
 *
 * The right direction for this list is DOWN.
 */
const ROUTES_WITHOUT_A_LIMITER: readonly string[] = [
  "PATCH /users/me",
  "PATCH /users/me/photo",
  "DELETE /users/me/photo",
  "PATCH /users/me/handle",
  "PATCH /products/:id",
  "DELETE /products/:id",
  "PATCH /products/:id/images/reorder",
  "DELETE /products/:id/images/:imageId",
  "POST /products/:id/publish",
  "POST /products/:id/unpublish",
  "PATCH /videos/:videoId",
  "PUT /videos/:videoId/chapters",
  "PUT /videos/:videoId/products",
  "PUT /videos/:videoId/playlists",
  "POST /videos/:videoId/publish",
  "POST /videos/:videoId/unpublish",
  "DELETE /videos/:videoId",
  "POST /playlists/",
  "PATCH /playlists/:playlistId",
  "DELETE /playlists/:playlistId",
  "PUT /playlists/:playlistId/videos",
  "POST /series/",
  "PATCH /series/:seriesId",
  "DELETE /series/:seriesId",
  "POST /series/:seriesId/seasons",
  "PATCH /series/:seriesId/seasons/:seasonId",
  "DELETE /series/:seriesId/seasons/:seasonId",
  "POST /series/:seriesId/seasons/:seasonId/episodes",
  "PATCH /series/:seriesId/seasons/:seasonId/episodes/:episodeId",
  "DELETE /series/:seriesId/seasons/:seasonId/episodes/:episodeId",
  "PATCH /research-projects/:projectSlug",
  "DELETE /research-projects/:projectSlug/cover",
  "POST /research-projects/:projectSlug/publish",
  "POST /research-projects/:projectSlug/unpublish",
  "POST /research-projects/:projectSlug/archive",
  "PATCH /research-projects/:projectSlug/stage",
  "DELETE /research-projects/:projectSlug/members/me",
  "PATCH /research-projects/:projectSlug/members/:memberId",
  "DELETE /research-projects/:projectSlug/members/:memberId",
  "POST /research-projects/:projectSlug/roles/:roleId/close",
  "POST /research-projects/:projectSlug/roles/:roleId/reopen",
  "DELETE /research-projects/:projectSlug/roles/:roleId",
  "POST /research-projects/:projectSlug/applications/:applicationId/accept",
  "POST /research-projects/:projectSlug/applications/:applicationId/decline",
  "POST /research-projects/:projectSlug/applications/:applicationId/withdraw",
  "POST /research-projects/:projectSlug/invites/:inviteId/accept",
  "POST /research-projects/:projectSlug/invites/:inviteId/decline",
  "DELETE /research-projects/:projectSlug/invites/:inviteId",
  "POST /notifications/notifications/read",
];

describe("rate-limit store coverage, in production", () => {
  it("routes every exported limiter through the factory", async () => {
    // Imported here rather than at module scope so the environment stub above is in place
    // before src/config/index.ts is evaluated.
    const limiterModule = await import("#src/middleware/rate-limit.js");
    const storeModule = await import("#src/middleware/rate-limit-store.js");

    const exportedLimiters = Object.values(limiterModule).filter(isLimiter);
    const registrations = storeModule.rateLimitStoreRegistrations();

    expect(exportedLimiters.length).toBeGreaterThan(30);
    expect(registrations).toHaveLength(exportedLimiters.length);
  });

  it("puts every one of them on Postgres, not on memory", async () => {
    await import("#src/middleware/rate-limit.js");
    const { rateLimitStoreRegistrations } = await import("#src/middleware/rate-limit-store.js");

    // The actual §11l.2 item 7 claim, asserted rather than assumed. One limiter left on
    // memory is one route whose documented limit multiplies by the instance count.
    const onMemory = rateLimitStoreRegistrations().filter((entry) => entry.storeKind !== "postgres");

    expect(onMemory).toEqual([]);
  });

  it("gives every limiter its own bucket namespace", async () => {
    await import("#src/middleware/rate-limit.js");
    const { rateLimitStoreRegistrations } = await import("#src/middleware/rate-limit-store.js");

    // `createRateLimitStore` already throws on a duplicate at load, so reaching this
    // assertion at all means the throw did not fire. Asserted anyway: if that guard is ever
    // softened, a copy-pasted namespace silently merges two limiters' buckets.
    const namespaces = rateLimitStoreRegistrations().map((entry) => entry.namespace);

    expect(new Set(namespaces).size).toBe(namespaces.length);
  });
});

describe("rate-limit route coverage", () => {
  it("puts a limiter on every mutating route, or names it as known debt", async () => {
    // §7 claims this file "enforces coverage and will fail the build otherwise". Until
    // this case existed that was false: the assertions above count exported limiters
    // against store registrations and never look at a route, so a POST with no limiter
    // passed cleanly. This is the case that makes the claim true.
    const { declaredRouteChains } = await import("#src/docs/route-inventory.js");

    const uncovered: string[] = [];
    let mutatingRouteCount = 0;

    for (const mount of MOUNTED_ROUTERS) {
      const routerModule: Record<string, unknown> = await import(mount.specifier);
      for (const chain of declaredRouteChains(mount.mountPath, routerModule[mount.exportName])) {
        if (!MUTATING_METHODS.has(chain.method)) continue;
        mutatingRouteCount += 1;
        if (!chain.handlers.some(isLimiter)) {
          uncovered.push(`${chain.method.toUpperCase()} ${chain.path}`);
        }
      }
    }

    // A router dropped from MOUNTED_ROUTERS would silently shrink the surface being
    // checked and turn this whole case green for the wrong reason.
    expect(mutatingRouteCount).toBeGreaterThan(120);

    expect(uncovered.toSorted()).toEqual([...ROUTES_WITHOUT_A_LIMITER].toSorted());
  });

  it("keeps the debt list honest — no entry for a route that now has one", async () => {
    // The other direction: an allowlist that outlives its route, or outlives the missing
    // limiter, is a line that quietly re-permits the next gap at that path.
    const { declaredRouteChains } = await import("#src/docs/route-inventory.js");

    const declared = new Set<string>();
    for (const mount of MOUNTED_ROUTERS) {
      const routerModule: Record<string, unknown> = await import(mount.specifier);
      for (const chain of declaredRouteChains(mount.mountPath, routerModule[mount.exportName])) {
        if (!chain.handlers.some(isLimiter)) {
          declared.add(`${chain.method.toUpperCase()} ${chain.path}`);
        }
      }
    }

    const stale = ROUTES_WITHOUT_A_LIMITER.filter((entry) => !declared.has(entry));
    expect(stale).toEqual([]);
  });
});
