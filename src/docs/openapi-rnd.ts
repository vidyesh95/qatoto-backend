import {
  declaredRoutes,
  pathParameterNames,
  toOpenApiPath,
  type DeclaredRoute,
} from "#src/docs/route-inventory.js";
import compensationRouter, { governanceRouter } from "#src/routes/compensation.routes.js";
import discoveryRouter from "#src/routes/discovery.routes.js";
import fundingRouter, { projectFundingRouter } from "#src/routes/funding.routes.js";
import notificationsRouter from "#src/routes/notifications.routes.js";
import platformAuditRouter from "#src/routes/platform-audit.routes.js";
import proofOfEffortRouter, {
  integrationCallbackRouter,
} from "#src/routes/proof-of-effort.routes.js";
import researchCatalogRouter from "#src/routes/research-catalog.routes.js";
import researchProjectsRouter, {
  applicationInboxRouter,
} from "#src/routes/research-projects.routes.js";
import supplierRouter, { projectGoToMarketRouter } from "#src/routes/suppliers.routes.js";
import workshopRouter, { dailyLogFeedRouter } from "#src/routes/workshop.routes.js";

/**
 * The R&D half of the OpenAPI document, DERIVED from the mounted routers
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 8).
 *
 * The hand-written spec beside this one covers auth, users, handles and discovery in full —
 * request bodies, response schemas, the lot — and covers **nothing else**. Two hundred R&D
 * routes were simply absent, which is worse than undocumented: a client generator emits
 * nothing for `POST …/compensation-periods/{periodId}/finalize`, and its author concludes
 * the endpoint does not exist.
 *
 * SO THIS IS DERIVED, NOT WRITTEN. Every path here comes from the same router objects
 * `src/app.ts` mounts, at spec-build time, which means it cannot drift: adding a route adds
 * a path, deleting one removes it, and nobody has to remember. That is the property the
 * hand-written half does not have and cannot get.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. No request bodies, no response schemas — those live
 * in the controllers' Zod schemas, and translating them wholesale is a job to do schema by
 * schema rather than in one sweep (see `route-inventory.ts`). Each entry says what it
 * honestly knows: the path, the verb, the path parameters, whether a session is required,
 * and where to read the contract. An honest inventory beats a detailed fiction.
 */

/** The mounts, mirroring `src/app.ts` — the same routers, the same prefixes. */
const RND_MOUNTS: readonly { readonly mountPath: string; readonly router: unknown }[] = [
  { mountPath: "/research-projects", router: researchProjectsRouter },
  { mountPath: "/research-projects", router: workshopRouter },
  { mountPath: "/research-projects", router: proofOfEffortRouter },
  { mountPath: "/research-projects", router: projectFundingRouter },
  { mountPath: "/research-projects", router: compensationRouter },
  { mountPath: "/research-projects", router: projectGoToMarketRouter },
  { mountPath: "/discovery", router: discoveryRouter },
  { mountPath: "/", router: researchCatalogRouter },
  { mountPath: "/", router: dailyLogFeedRouter },
  { mountPath: "/", router: governanceRouter },
  { mountPath: "/", router: supplierRouter },
  { mountPath: "/", router: applicationInboxRouter },
  { mountPath: "/", router: notificationsRouter },
  { mountPath: "/", router: platformAuditRouter },
  { mountPath: "/", router: fundingRouter },
  { mountPath: "/", router: integrationCallbackRouter },
];

/**
 * Which §11 subsection a path belongs to. Longest prefix wins, so
 * `/discovery/admin/market-insights` is moderation rather than plain discovery.
 */
const TAG_RULES: readonly { readonly prefix: string; readonly tag: string }[] = [
  { prefix: "/discovery/admin", tag: "Discovery moderation" },
  { prefix: "/discovery", tag: "Discovery" },
  { prefix: "/admin/audit-trail", tag: "Platform audit" },
  { prefix: "/notifications", tag: "Notifications" },
  { prefix: "/governance", tag: "Governance" },
  { prefix: "/daily-logs", tag: "Daily logs" },
  { prefix: "/suppliers", tag: "Go-to-market" },
  { prefix: "/supplier-capabilities", tag: "Go-to-market" },
  { prefix: "/launch-ready-projects", tag: "Go-to-market" },
  { prefix: "/funding", tag: "Funding" },
  { prefix: "/funding-rounds", tag: "Funding" },
  { prefix: "/pledges", tag: "Funding" },
  { prefix: "/milestones", tag: "Funding" },
  { prefix: "/open-roles", tag: "Projects" },
  { prefix: "/research-categories", tag: "Projects" },
  { prefix: "/applications", tag: "Projects" },
  { prefix: "/invites", tag: "Projects" },
  { prefix: "/integrations", tag: "Proof of Effort" },
  { prefix: "/research-projects", tag: "Research projects" },
];

/** Segment-level markers, checked after the prefix rules for project-scoped paths. */
const NESTED_TAG_RULES: readonly { readonly segment: string; readonly tag: string }[] = [
  { segment: "workshop", tag: "Workshop" },
  { segment: "daily-logs", tag: "Daily logs" },
  { segment: "compensation-periods", tag: "Compensation" },
  { segment: "compensation-agreements", tag: "Compensation" },
  { segment: "compensation-period-lines", tag: "Compensation" },
  { segment: "compensation-agreement", tag: "Compensation" },
  { segment: "effort-claims", tag: "Proof of Effort" },
  { segment: "allocation-proposals", tag: "Proof of Effort" },
  { segment: "disputes", tag: "Proof of Effort" },
  { segment: "audit-trail", tag: "Proof of Effort" },
  { segment: "slice-ledger", tag: "Proof of Effort" },
  { segment: "equity", tag: "Proof of Effort" },
  { segment: "fair-market-rate", tag: "Proof of Effort" },
  { segment: "fair-market-rates", tag: "Proof of Effort" },
  { segment: "override-queue", tag: "Proof of Effort" },
  { segment: "integrations", tag: "Proof of Effort" },
  { segment: "physical-receipts", tag: "Proof of Effort" },
  { segment: "pie-bake", tag: "Proof of Effort" },
  { segment: "optimization-suggestions", tag: "Proof of Effort" },
  { segment: "proof-of-effort", tag: "Proof of Effort" },
  { segment: "funding-rounds", tag: "Funding" },
  { segment: "milestones", tag: "Funding" },
  { segment: "supplier-engagements", tag: "Go-to-market" },
  { segment: "launch-readiness", tag: "Go-to-market" },
  { segment: "market-insight-links", tag: "Discovery" },
];

function tagFor(openApiPath: string): string {
  for (const rule of NESTED_TAG_RULES) {
    if (openApiPath.includes(`/${rule.segment}`)) return rule.tag;
  }
  for (const rule of TAG_RULES) {
    if (openApiPath.startsWith(rule.prefix)) return rule.tag;
  }
  return "Research and development";
}

/**
 * The two routes in this surface that resolve WITHOUT a session, and the reason each does.
 *
 * Everything else is `requireAuth` or `attachOptionalUser`; marking the whole surface
 * "requires a session" would be wrong for the public reads, and marking none of it would be
 * wrong for the rest. The honest middle is to say that most require one and name the
 * exceptions the spec can be sure about.
 */
const PUBLICLY_RESOLVABLE = new Set([
  "get /integrations/{provider}/callback",
  "get /daily-logs/streak-leaderboard",
]);

const CONTRACT_NOTE =
  "Contract: docs/R_AND_D_BACKEND_STRUCTURE.md §11. Request and response shapes are the " +
  "Zod schemas in src/controllers/*.ts — this entry is derived from the router and " +
  "deliberately claims only what a router knows (§11l.2 item 8). Money is integer cents in " +
  "a decimal string, equity is integer basis points, effort is integer minutes (§1, §4b).";

export function buildRndPathItems(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};

  const routes: DeclaredRoute[] = RND_MOUNTS.flatMap((mount) => [
    ...declaredRoutes(mount.mountPath, mount.router),
  ]);

  for (const route of routes) {
    const openApiPath = toOpenApiPath(route.path);
    const parameters = pathParameterNames(openApiPath).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    const isPublic = PUBLICLY_RESOLVABLE.has(`${route.method} ${openApiPath}`);

    const pathItem = (paths[openApiPath] ??= {});
    pathItem[route.method] = {
      tags: [tagFor(openApiPath)],
      summary: `${route.method.toUpperCase()} ${openApiPath}`,
      description: CONTRACT_NOTE,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(isPublic ? {} : { security: [{ sessionCookie: [] }] }),
      responses: {
        "200": { description: "Success. Envelope: { status, statusCode, message, data }." },
        "401": { $ref: "#/components/responses/Unauthorized" },
        // The rule worth publishing, because a client has to render it: a project-scoped
        // refusal is 404 and is indistinguishable from a project that does not exist (§0).
        "404": { $ref: "#/components/responses/NotFound" },
        "422": { $ref: "#/components/responses/ValidationFailed" },
      },
    };
  }

  return paths;
}

/** The count, so a caller can log or assert it. Derived, never remembered. */
export function countRndRoutes(): number {
  return RND_MOUNTS.reduce(
    (total, mount) => total + declaredRoutes(mount.mountPath, mount.router).length,
    0,
  );
}
