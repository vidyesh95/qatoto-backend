import { RND_REQUEST_BODIES } from "#src/docs/openapi-rnd-bodies.js";
import {
  declaredRouteChains,
  declaredRoutes,
  pathParameterNames,
  toOpenApiPath,
  type DeclaredRoute,
  type RouteHandlerChain,
} from "#src/docs/route-inventory.js";
import {
  convertBodySchema,
  describeUnrepresentableConstraints,
  type UnrepresentableConstraint,
} from "#src/docs/zod-to-openapi.js";
import compensationRouter, { governanceRouter } from "#src/routes/compensation.routes.js";
import discoveryRouter from "#src/routes/discovery.routes.js";
import fundingRouter, { projectFundingRouter } from "#src/modules/rnd/funding/funding.routes.js";
import notificationsRouter from "#src/modules/platform/notifications/notifications.routes.js";
import platformAuditRouter from "#src/modules/platform/audit/platform-audit.routes.js";
import platformRolesRouter from "#src/modules/platform/roles/platform-roles.routes.js";
import promotionsRouter from "#src/modules/home/promotions/promotions.routes.js";
import proofOfEffortRouter, {
  integrationCallbackRouter,
} from "#src/modules/rnd/proof-of-effort/proof-of-effort.routes.js";
import researchCatalogRouter from "#src/modules/rnd/programs/research-catalog.routes.js";
import researchProgramsRouter, {
  researchPaperCategoryRouter,
} from "#src/modules/rnd/programs/research-programs.routes.js";
import researchProjectsRouter, {
  applicationInboxRouter,
} from "#src/modules/rnd/projects/research-projects.routes.js";
import spotlightRouter from "#src/modules/home/spotlight/spotlight.routes.js";
import supplierRouter, { projectGoToMarketRouter } from "#src/routes/suppliers.routes.js";
import workshopRouter, { dailyLogFeedRouter } from "#src/modules/rnd/workshop/workshop.routes.js";

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
 * REQUEST BODIES ARE NOW CLAIMED, for all 71 routes that take one. They come from
 * `openapi-rnd-bodies.ts`, which maps a route to the very Zod schema its controller parses
 * with, converted by `zod-to-openapi.ts`. That map is the one hand-maintained thing in a
 * derived document, so a test walks these same routers and fails the build if a body-taking
 * route is missing from it.
 *
 * WHERE A BODY IS BROADER THAN THE SERVER, THE OPERATION SAYS SO. A cross-field `.refine()`
 * cannot be expressed in JSON Schema and Zod drops it silently, so those constraints are
 * detected and disclosed — in the `description` for a human and in
 * `x-unrepresentable-constraints` for a tool. Loosened loudly, which is the requirement;
 * withholding the whole body would hide twenty correct field constraints to avoid
 * overstating one.
 *
 * WHAT IT STILL DOES NOT CLAIM. Response schemas. Each entry otherwise says what it honestly
 * knows: the path, the verb, the path parameters, the request body, whether a session is
 * required, and where to read the rest of the contract.
 */

/** The mounts, mirroring `src/app.ts` — the same routers, the same prefixes. */
const RND_MOUNTS: readonly { readonly mountPath: string; readonly router: unknown }[] = [
  { mountPath: "/research-projects", router: researchProjectsRouter },
  { mountPath: "/research-projects", router: workshopRouter },
  { mountPath: "/research-projects", router: proofOfEffortRouter },
  { mountPath: "/research-projects", router: projectFundingRouter },
  { mountPath: "/research-projects", router: compensationRouter },
  { mountPath: "/research-projects", router: projectGoToMarketRouter },
  { mountPath: "/research-programs", router: researchProgramsRouter },
  { mountPath: "/discovery", router: discoveryRouter },
  { mountPath: "/promotions", router: promotionsRouter },
  { mountPath: "/spotlight", router: spotlightRouter },
  { mountPath: "/", router: researchCatalogRouter },
  { mountPath: "/", router: researchPaperCategoryRouter },
  { mountPath: "/", router: dailyLogFeedRouter },
  { mountPath: "/", router: governanceRouter },
  { mountPath: "/", router: supplierRouter },
  { mountPath: "/", router: applicationInboxRouter },
  { mountPath: "/", router: notificationsRouter },
  { mountPath: "/", router: platformAuditRouter },
  { mountPath: "/", router: platformRolesRouter },
  { mountPath: "/", router: fundingRouter },
  { mountPath: "/", router: integrationCallbackRouter },
];

/**
 * The same routes, carrying the handler chain Express runs for each.
 *
 * FOR THE AUDIT TIER ONLY — `openapi-rnd-bodies.test.ts` uses it to find every route that
 * reads a body and check the map covers it. Exported so `RND_MOUNTS` can stay private and
 * there is exactly one mount table; deliberately NOT consumed by the emitter below, which
 * must derive nothing from handler identity (see `RouteHandlerChain`).
 */
export function rndRouteChains(): readonly RouteHandlerChain[] {
  return RND_MOUNTS.flatMap((mount) => declaredRouteChains(mount.mountPath, mount.router));
}

/**
 * Which §11 subsection a path belongs to. Longest prefix wins, so
 * `/discovery/admin/market-insights` is moderation rather than plain discovery.
 */
const TAG_RULES: readonly { readonly prefix: string; readonly tag: string }[] = [
  { prefix: "/promotions/admin", tag: "Promotions moderation" },
  { prefix: "/promotions", tag: "Promotions" },
  { prefix: "/spotlight/admin", tag: "Spotlight moderation" },
  { prefix: "/spotlight", tag: "Spotlight" },
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
  { prefix: "/research-paper-categories", tag: "Research programs" },
  { prefix: "/research-programs", tag: "Research programs" },
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
  // §10. `moderation` and `reports` are program-only segments; the four content ones
  // are too, but they are listed explicitly rather than relying on the
  // `/research-programs` prefix rule so a future project-scoped `/papers` cannot
  // silently inherit this tag.
  { segment: "branches", tag: "Research programs" },
  { segment: "papers", tag: "Research programs" },
  { segment: "posts", tag: "Research programs" },
  { segment: "contributors", tag: "Research programs" },
  { segment: "product-opportunities", tag: "Research programs" },
  { segment: "effort-logs", tag: "Research programs" },
  { segment: "contributions", tag: "Research programs" },
  { segment: "moderation", tag: "Research programs" },
  { segment: "review-queue", tag: "Research programs" },
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
  // The home-page carousel. Bare on purpose — no requireAuth AND no attachOptionalUser,
  // because nothing about a slide depends on who is asking.
  "get /promotions/slides",
  // The home-page Spotlight rail. Bare on purpose — same rationale as promotions.
  "get /spotlight/videos",
]);

const CONTRACT_NOTE =
  "Contract: docs/R_AND_D_BACKEND_STRUCTURE.md §11. Request and response shapes are the " +
  "Zod schemas in src/controllers/*.ts — this entry is derived from the router and " +
  "deliberately claims only what a router knows (§11l.2 item 8). Money is integer cents in " +
  "a decimal string, equity is integer basis points, effort is integer minutes (§1, §4b).";

/**
 * The `requestBody` for one operation, plus anything the schema could not carry.
 *
 * Returns nothing at all for a route with no mapped body — and also for one whose schema
 * FAILED to convert. That second case is a soft failure on purpose: `openApiSpec` is a
 * module-level constant, so throwing here would take `/health` down the moment somebody put
 * a `z.date()` in a body. The description says the body was withheld and why, and
 * `openapi-rnd-bodies.test.ts` asserts the branch is never reached — so documentation
 * degrades in production while the build goes red.
 */
function buildRequestBody(routeKey: string): {
  readonly requestBody?: Record<string, unknown>;
  readonly descriptionSuffix?: string;
  readonly unrepresentable?: readonly UnrepresentableConstraint[];
} {
  const mapped = RND_REQUEST_BODIES[routeKey];
  if (!mapped) return {};

  const converted = convertBodySchema(mapped.schema);
  if (converted.kind === "failed") {
    return {
      descriptionSuffix:
        `REQUEST BODY OMITTED — the Zod schema for this route could not be represented in ` +
        `OpenAPI 3.0 (${converted.message}). The contract is the schema mapped for ` +
        `"${routeKey}" in src/docs/openapi-rnd-bodies.ts.`,
    };
  }

  const contentType = mapped.contentType ?? "application/json";
  // The one multipart route. The file part is not in the Zod schema — multer takes it off
  // the request before the controller parses the text fields — so it is merged in here, and
  // `additionalProperties: false` stays correct because it is the only other permitted part.
  const schema =
    mapped.binaryField === undefined
      ? converted.schema
      : mergeBinaryField(converted.schema, mapped.binaryField);

  return {
    requestBody: { required: mapped.required, content: { [contentType]: { schema } } },
    ...(converted.unrepresentable.length > 0
      ? {
          descriptionSuffix: describeUnrepresentableConstraints(converted.unrepresentable),
          unrepresentable: converted.unrepresentable,
        }
      : {}),
  };
}

/** Adds the multipart file part to a converted object schema, and to its `required` list. */
function mergeBinaryField(
  schema: Record<string, unknown>,
  binaryField: string,
): Record<string, unknown> {
  const properties = schema["properties"];
  const required = schema["required"];

  return {
    ...schema,
    properties: {
      ...(typeof properties === "object" && properties !== null ? properties : {}),
      [binaryField]: { type: "string", format: "binary" },
    },
    required: [...(Array.isArray(required) ? required : []), binaryField],
  };
}

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

    const routeKey = `${route.method} ${openApiPath}`;
    const isPublic = PUBLICLY_RESOLVABLE.has(routeKey);
    const body = buildRequestBody(routeKey);

    const pathItem = (paths[openApiPath] ??= {});
    pathItem[route.method] = {
      tags: [tagFor(openApiPath)],
      summary: `${route.method.toUpperCase()} ${openApiPath}`,
      description:
        body.descriptionSuffix === undefined
          ? CONTRACT_NOTE
          : `${CONTRACT_NOTE}\n\n${body.descriptionSuffix}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body.requestBody ? { requestBody: body.requestBody } : {}),
      // The machine-readable half of the same disclosure, so a linter or a codegen plugin
      // can act on what the prose above only states.
      ...(body.unrepresentable ? { "x-unrepresentable-constraints": body.unrepresentable } : {}),
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
