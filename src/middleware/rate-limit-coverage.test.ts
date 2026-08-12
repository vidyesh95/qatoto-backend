import { beforeAll, describe, expect, it, vi } from "vitest";

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
const MOUNTED_ROUTERS: readonly {
  readonly mountPath: string;
  readonly specifier: string;
  readonly exportName: string;
}[] = [
  { mountPath: "/", specifier: "#src/modules/auth/session/auth.routes.js", exportName: "default" },
  { mountPath: "/users", specifier: "#src/modules/auth/users/users.routes.js", exportName: "default" },
  { mountPath: "/handles", specifier: "#src/modules/auth/handles/handles.routes.js", exportName: "default" },
  { mountPath: "/products", specifier: "#src/modules/store/catalog/products.routes.js", exportName: "default" },
  { mountPath: "/promotions", specifier: "#src/modules/home/promotions/promotions.routes.js", exportName: "default" },
  { mountPath: "/spotlight", specifier: "#src/modules/home/spotlight/spotlight.routes.js", exportName: "default" },
  { mountPath: "/feed", specifier: "#src/modules/home/feed/feed.routes.js", exportName: "default" },
  { mountPath: "/videos", specifier: "#src/modules/studio/videos/videos.routes.js", exportName: "default" },
  { mountPath: "/videos", specifier: "#src/modules/home/engagement/engagement.routes.js", exportName: "default" },
  { mountPath: "/", specifier: "#src/modules/home/engagement/engagement.routes.js", exportName: "commentRouter" },
  { mountPath: "/", specifier: "#src/modules/home/engagement/engagement.routes.js", exportName: "creatorRouter" },
  { mountPath: "/playlists", specifier: "#src/modules/studio/playlists/playlists.routes.js", exportName: "default" },
  { mountPath: "/series", specifier: "#src/modules/studio/series/series.routes.js", exportName: "default" },
  {
    mountPath: "/research-projects",
    specifier: "#src/modules/rnd/projects/research-projects.routes.js",
    exportName: "default",
  },
  {
    mountPath: "/research-programs",
    specifier: "#src/modules/rnd/programs/research-programs.routes.js",
    exportName: "default",
  },
  { mountPath: "/discovery", specifier: "#src/modules/rnd/discovery/discovery.routes.js", exportName: "default" },
  { mountPath: "/suppliers", specifier: "#src/modules/rnd/suppliers/suppliers.routes.js", exportName: "default" },
  {
    mountPath: "/notifications",
    specifier: "#src/modules/platform/notifications/notifications.routes.js",
    exportName: "default",
  },
  {
    mountPath: "/commerce",
    specifier: "#src/modules/store/organizations/commerce-organizations.routes.js",
    exportName: "default",
  },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-providers.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-rfqs.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-quotes.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-messages.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-cart.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-orders.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-fulfillment.routes.js", exportName: "default" },
  // Phase 20 (§19.2–§19.3). This line lands in the SAME commit as the mount in app.ts:
  // a router missing from this table is silently unchecked, which has happened before.
  { mountPath: "/commerce", specifier: "#src/routes/commerce-freight-rates.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/modules/store/catalog/commerce-catalog.routes.js", exportName: "default" },
  /**
   * These three were mounted in `app.ts` and MISSING from this list, so every mutating
   * route they own passed the assertion below without ever being looked at — including
   * the whole trust surface. Found while adding Phase 10; the omission is the exact
   * failure mode the header comment above predicted.
   */
  { mountPath: "/commerce", specifier: "#src/routes/commerce-trust.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-payments.routes.js", exportName: "default" },
  {
    mountPath: "/commerce",
    specifier: "#src/modules/store/catalog/commerce-merchandising.routes.js",
    exportName: "default",
  },
  // Phase 10 (Appendix A9, A11, A12, A14).
  { mountPath: "/commerce", specifier: "#src/routes/commerce-product-qa.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-content-reports.routes.js", exportName: "default" },
  { mountPath: "/commerce", specifier: "#src/routes/commerce-product-inquiry.routes.js", exportName: "default" },
  {
    mountPath: "/store",
    specifier: "#src/modules/store/catalog/commerce-product-engagement.routes.js",
    exportName: "default",
  },
  { mountPath: "/store", specifier: "#src/routes/store.routes.js", exportName: "default" },
  // Phase 14. The webhook router is the only mounted router whose writes carry no session,
  // so its limiter is IP-keyed; it is listed here precisely because "no session" must not
  // become an excuse for "no bound".
  { mountPath: "/commerce", specifier: "#src/routes/commerce-settlement.routes.js", exportName: "default" },
  { mountPath: "/webhooks", specifier: "#src/routes/commerce-webhooks.routes.js", exportName: "default" },
  /**
   * Phase 15's trade attachments and Phase 16's taxonomy admin were mounted in `app.ts`
   * and missing from this list — the SAME omission the Phase 10 note above records, twice
   * more. Added while wiring Phase 17, along with Phase 17's own router.
   */
  { mountPath: "/commerce", specifier: "#src/routes/commerce-documents.routes.js", exportName: "default" },
  {
    mountPath: "/commerce",
    specifier: "#src/modules/store/catalog/commerce-categories.routes.js",
    exportName: "default",
  },
  { mountPath: "/commerce", specifier: "#src/modules/store/catalog/commerce-ranking.routes.js", exportName: "default" },
  {
    mountPath: "/commerce",
    specifier: "#src/modules/store/organizations/commerce-seller-profile.routes.js",
    exportName: "default",
  },
  // Phase 17 (§16, Appendix A32).
  { mountPath: "/commerce", specifier: "#src/routes/commerce-factories.routes.js", exportName: "default" },
  // Phase 18 (§17, Appendix A33). A new mount prefix — community is a sibling context.
  { mountPath: "/community", specifier: "#src/routes/community-forum.routes.js", exportName: "default" },
  // Phase 19 (§18, Appendix A34).
  { mountPath: "/community", specifier: "#src/routes/community-cofounder.routes.js", exportName: "default" },
];

/** A write. GETs are excluded — §7's bounds are about writes and expensive reads. */
const MUTATING_METHODS = new Set(["post", "put", "patch", "delete"]);

/** A mount paired with its loaded module, resolved ONCE in `beforeAll`. */
interface LoadedMount {
  readonly mount: (typeof MOUNTED_ROUTERS)[number];
  readonly routerModule: Record<string, unknown>;
}

/**
 * LOADED IN A HOOK, NOT IN A TEST BODY, and that is the whole point.
 *
 * Both route-coverage cases below used to `await import()` every entry of MOUNTED_ROUTERS
 * inside themselves — the same ~40 modules, twice. Vite transforms each one on first sight,
 * and that cost is billed against the default 5 s `testTimeout`, so the file passed only when
 * an earlier file had already warmed the transform cache and timed out at
 * `Test timed out in 5000ms` when it had not: alone it measured 4481 ms of a 5000 ms budget,
 * and `--sequence.shuffle` (which runs it early, cold) killed it outright.
 *
 * This is SETUP, so it belongs where setup goes. A hook gets the 10 s `hookTimeout`, and the
 * loop now runs once rather than per case. Kept at file scope deliberately: the router graph
 * pulls in `rate-limit.js`, so the store-coverage cases above stop paying transform cost
 * inside a test body too.
 */
let loadedMounts: readonly LoadedMount[];
let declaredRouteChains: typeof import("#src/docs/route-inventory.js").declaredRouteChains;

beforeAll(async () => {
  ({ declaredRouteChains } = await import("#src/docs/route-inventory.js"));

  loadedMounts = await Promise.all(
    MOUNTED_ROUTERS.map(async (mount) => {
      const routerModule: Record<string, unknown> = await import(mount.specifier);
      return { mount, routerModule };
    }),
  );
});

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
  it("puts a limiter on every mutating route, or names it as known debt", () => {
    // §7 claims this file "enforces coverage and will fail the build otherwise". Until
    // this case existed that was false: the assertions above count exported limiters
    // against store registrations and never look at a route, so a POST with no limiter
    // passed cleanly. This is the case that makes the claim true.
    const uncovered: string[] = [];
    let mutatingRouteCount = 0;

    for (const { mount, routerModule } of loadedMounts) {
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

  it("keeps the debt list honest — no entry for a route that now has one", () => {
    // The other direction: an allowlist that outlives its route, or outlives the missing
    // limiter, is a line that quietly re-permits the next gap at that path.
    const declared = new Set<string>();
    for (const { mount, routerModule } of loadedMounts) {
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
