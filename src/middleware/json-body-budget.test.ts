import type { Express } from "express";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { estimateBodyBytes, maxLengthFromPattern } from "#src/middleware/json-body-budget.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * Every route's body cap is real, and no cap is below what its own schema can produce
 * (§11l.4).
 *
 * THE PROPERTY THAT MAKES THE CHANGE SAFE is structural, not something this suite hopes to
 * notice. Making the caps real means TIGHTENING routes that had silently been on 128 kb, and
 * a cap picked by eye is how you reintroduce the bug being fixed. Because a route's cap is at
 * least its own schema's worst case, anything that trips it is a body Zod was going to reject
 * anyway — the caller sees a 413 where they would have seen a 422, and the outcome is the
 * same. Nothing that works today stops working.
 *
 * SWEEP 1 WALKS THE BUILT APP, not a hand-kept mount table, so the test and the application
 * cannot disagree about what is mounted where. Everything reachable through `app.use` is in
 * scope, including the routers outside the R&D surface.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

const COMPACT_BYTES = 16 * 1024;
const LONG_FORM_BYTES = 128 * 1024;

/**
 * A body read, in either the source spelling or Vite's interop form.
 *
 * THE `\)?` IS LOAD-BEARING. Vite's SSR transform rewrites a call to an imported function as
 * `(0,__vite_ssr_import_2__.optionalBody)(req)` — the identifier survives but is followed by
 * `)` rather than `(`. A naive `optionalBody\(` matches under `tsx` and matches NOTHING here,
 * which silently turns this whole sweep into a no-op. It did exactly that once already.
 */
const READS_BODY = /req\.body|optionalBody\s*\)?\s*\(/;

interface MountedRoute {
  readonly method: string;
  readonly path: string;
  readonly handlers: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** Every verb route reachable through a router, recursing into mounted sub-routers. */
function collectRoutes(router: unknown, prefix: string): MountedRoute[] {
  if (!isRecord(router)) return [];
  const stack: unknown = Reflect.get(router, "stack");
  if (!Array.isArray(stack)) return [];

  const collected: MountedRoute[] = [];

  for (const layer of stack) {
    if (!isRecord(layer)) continue;
    const route: unknown = Reflect.get(layer, "route");

    if (isRecord(route)) {
      const path: unknown = Reflect.get(route, "path");
      const methods: unknown = Reflect.get(route, "methods");
      const routeStack: unknown = Reflect.get(route, "stack");
      if (typeof path !== "string" || !isRecord(methods) || !Array.isArray(routeStack)) continue;

      const verbs = Object.entries(methods)
        .filter(([, enabled]) => enabled === true)
        .map(([verb]) => verb.toLowerCase())
        .filter((verb) => verb !== "_all");

      for (const method of verbs) {
        collected.push({
          method,
          path: `${prefix}${path}`,
          // One `route.stack` serves every verb the route declares, so entries must be
          // filtered by method or a `.post(limiter, h).get(h)` route reports a cap on its GET.
          // A `router.all` handler carries no `.method` and belongs to all of them.
          handlers: routeStack
            .filter((entry) => {
              if (!isRecord(entry)) return false;
              const entryMethod: unknown = Reflect.get(entry, "method");
              return entryMethod === method || entryMethod === undefined;
            })
            .map((entry) => (isRecord(entry) ? Reflect.get(entry, "handle") : undefined)),
        });
      }
      continue;
    }

    // A mounted sub-router: recurse. The prefix is not recoverable from the layer's regexp
    // in a form worth trusting, and the route path alone identifies it well enough here.
    const handle: unknown = Reflect.get(layer, "handle");
    if (isRecord(handle) && Array.isArray(Reflect.get(handle, "stack"))) {
      collected.push(...collectRoutes(handle, prefix));
    }
  }

  return collected;
}

function sourceOf(route: MountedRoute): string {
  return route.handlers
    .map((handler) => (typeof handler === "function" ? Function.prototype.toString.call(handler) : ""))
    .join("\n");
}

let routes: readonly MountedRoute[];
/**
 * The R&D routes with their MOUNT PREFIXES applied, which `collectRoutes` cannot recover.
 *
 * The budget sweeps look each route up in `RND_REQUEST_BODIES`, whose keys are full OpenAPI
 * paths. Matching them against router-relative paths silently found only the root-mounted
 * routers and skipped the rest — three matches out of seventy-one, and both sweeps passing on
 * the strength of it. The handler references are the same objects either way.
 */
let rndChains: readonly { method: string; path: string; handlers: readonly unknown[] }[];
let bodyLimitOf: (handler: unknown) => number | undefined;
let multerHandlers: readonly unknown[];
let bodies: typeof import("#src/docs/openapi-rnd-bodies.js").RND_REQUEST_BODIES;
let convertBodySchema: typeof import("#src/docs/zod-to-openapi.js").convertBodySchema;
let toOpenApiPath: (expressPath: string) => string;

/** The cap this route declares, or undefined if it declares none. */
function declaredCap(route: MountedRoute): number | undefined {
  for (const handler of route.handlers) {
    const cap = bodyLimitOf(handler);
    if (cap !== undefined) return cap;
  }
  return undefined;
}

/**
 * A multipart route, matched by reference against the five multer wrappers.
 *
 * These DO read `req.body` — multer populates it with the text parts — but the JSON parser
 * never touched the request, so `rawBodyBytes` is unset and a cap here would be inert. They
 * are bounded by multer's own file-size limits instead. Excluded from both directions of the
 * sweep so neither a missing cap nor a present one is reported.
 */
function isMultipart(route: MountedRoute): boolean {
  return route.handlers.some((handler) => multerHandlers.includes(handler));
}

/**
 * Routes whose body never reaches the JSON parser at all (STORE Phase 14).
 *
 * `app.ts` mounts `express.raw({ type: "*\/*", limit: "512kb" })` on `/webhooks` ABOVE
 * `parseJsonBodyOnce`, so these handlers receive a Buffer and body-parser's `req._body`
 * short-circuit keeps the JSON parser away from them entirely. `compactBody` would be
 * meaningless there — it checks a byte length the JSON parser recorded, and no JSON parse
 * happened.
 *
 * THE CAP IS NOT MISSING, IT IS ELSEWHERE: `express.raw`'s own `limit`. Listed by exact
 * path rather than by prefix so a second webhook route has to be added here deliberately,
 * which is the same posture the multipart imports above take.
 */
const RAW_BODY_ROUTES: ReadonlySet<string> = new Set(["POST /escrow/:providerId"]);

function isRawBody(route: MountedRoute): boolean {
  return RAW_BODY_ROUTES.has(`${route.method.toUpperCase()} ${route.path}`);
}

describe("per-route body caps", () => {
  beforeAll(async () => {
    const app: Express = (await import("#src/app.js")).default;
    const jsonBody = await import("#src/middleware/json-body.js");
    const map = await import("#src/docs/openapi-rnd-bodies.js");
    const converter = await import("#src/docs/zod-to-openapi.js");
    const inventory = await import("#src/docs/route-inventory.js");
    const rnd = await import("#src/docs/openapi-rnd.js");
    const uploads = await Promise.all([
      import("#src/modules/auth/users/upload-avatar.js"),
      import("#src/middleware/upload-product-image.js"),
      import("#src/modules/rnd/projects/upload-project-cover.js"),
      import("#src/modules/studio/videos/upload-video-thumbnail.js"),
      import("#src/middleware/upload-physical-receipt.js"),
      // §10's research-paper PDF upload — the first NON-IMAGE multipart route in the
      // codebase. Its bytes are bounded by multer's 25 MB cap (imported from
      // `src/lib/pdf.ts` so the two cannot disagree), not by a JSON byte budget.
      import("#src/middleware/upload-research-paper.js"),
      // Commerce verification evidence is multipart and bounded by its upload middleware,
      // not by the JSON parser's per-route budget.
      import("#src/middleware/upload-commerce-verification-evidence.js"),
      // The promotional-carousel image routes. The create route carries TEXT PARTS
      // alongside the file, so without this import `isMultipart()` would not recognize
      // it, the sweep would treat it as a JSON body-reading route, and it would be
      // reported as missing a declared cap.
      import("#src/modules/home/promotions/upload-promotional-slide-image.js"),
      // A13's company photography. Like the promotional-carousel route above, it carries
      // TEXT PARTS (`mediaKind`, `altText`) alongside the file, so without this import
      // `isMultipart()` would not recognize it, the sweep would treat it as a JSON
      // body-reading route, and it would be reported as missing a declared cap.
      import("#src/middleware/upload-organization-media.js"),
      // A13's certificate upload. Its own module because the verification-evidence parser
      // caps multer at two text fields and a certification sends six.
      import("#src/middleware/upload-commerce-certificate.js"),
      // The store-category create/replace routes (0098). Create carries TEXT PARTS
      // (`name`, `slug`, `parentCategoryId`, `searchSynonyms`, `state`) alongside an
      // OPTIONAL file, so without this import `isMultipart()` would not recognize it, the
      // sweep would treat it as a JSON body-reading route, and it would be reported as
      // missing a declared cap.
      import("#src/middleware/upload-commerce-category-image.js"),
    ]);

    const router: unknown = Reflect.get(app, "router");
    routes = collectRoutes(router, "");
    rndChains = rnd.rndRouteChains();
    bodyLimitOf = jsonBody.bodyLimitOf;
    multerHandlers = uploads.flatMap((module) => Object.values(module));
    bodies = map.RND_REQUEST_BODIES;
    convertBodySchema = converter.convertBodySchema;
    toOpenApiPath = inventory.toOpenApiPath;
  });

  it("finds the mounted routes at all — the guard against a vacuous sweep", () => {
    // Every rule below filters on something. If the walk returns nothing, or the body
    // detector matches nothing, all of them pass by comparing zero to zero.
    expect(routes.length).toBeGreaterThan(180);
    expect(routes.filter((route) => READS_BODY.test(sourceOf(route))).length).toBeGreaterThanOrEqual(90);
  });

  it("gives every body-reading route a declared cap", () => {
    const undeclared = routes
      .filter((route) => READS_BODY.test(sourceOf(route)) && !isMultipart(route) && !isRawBody(route))
      .filter((route) => declaredCap(route) === undefined)
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    // The red build. Without a cap a route silently inherits the 128 kb ceiling.
    expect([...new Set(undeclared)].toSorted()).toEqual([]);
  });

  it("puts the cap BEFORE the handler it guards", () => {
    // Presence is not enough, and assuming it was cost a real bug: a cap appended after the
    // controller is registered, reachable by reference, and completely inert — the controller
    // has already answered by the time it runs. A mechanical insert lands there easily,
    // because most of these calls carry a trailing comma.
    const misordered = routes
      .filter((route) => declaredCap(route) !== undefined)
      .filter((route) => {
        const capIndex = route.handlers.findIndex((handler) => bodyLimitOf(handler) !== undefined);
        return capIndex === route.handlers.length - 1;
      })
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect([...new Set(misordered)].toSorted()).toEqual([]);
  });

  it("puts a cap on nothing that does not read a body", () => {
    // The mistake a mechanical pass makes: a limiter landing on a GET, or on a multipart
    // route whose body multer owns and where `rawBodyBytes` is never recorded. Harmless at
    // runtime, but it documents a cap that does not exist.
    const spurious = routes
      .filter((route) => declaredCap(route) !== undefined)
      .filter((route) => !READS_BODY.test(sourceOf(route)) || isMultipart(route))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`);

    expect([...new Set(spurious)].toSorted()).toEqual([]);
  });

  it("never caps an R&D route below what its own schema can produce", () => {
    const tooTight: string[] = [];

    let measured = 0;

    for (const route of rndChains) {
      const entry = bodies[`${route.method} ${toOpenApiPath(route.path)}`];
      // Multipart is multer's; a JSON byte budget says nothing about it.
      if (!entry || entry.contentType === "multipart/form-data") continue;
      measured++;

      const converted = convertBodySchema(entry.schema);
      if (converted.kind !== "ok") continue;

      const cap = declaredCap(route) ?? LONG_FORM_BYTES;
      const budget = estimateBodyBytes(converted.schema);

      if (budget.kind === "unbounded") {
        // Nothing safe to tighten to, so it keeps the ceiling.
        if (cap < LONG_FORM_BYTES) {
          tooTight.push(`${route.method} ${route.path} — unbounded (${budget.reason}), capped at ${String(cap)}B`);
        }
      } else if (budget.bytes > cap) {
        tooTight.push(`${route.method} ${route.path} — needs ${String(budget.bytes)}B, capped at ${String(cap)}B`);
      }
    }

    // A failure here is a route that would 413 a body its own schema accepts.
    expect([...new Set(tooTight)].toSorted()).toEqual([]);
    // And the loop actually ran. Keyed lookups that match nothing pass every assertion.
    expect(measured).toBeGreaterThanOrEqual(70);
  });

  it("puts every R&D route that fits on the compact tier", () => {
    // The other direction, and the point of the change: a cap that is real. Without this the
    // suite passes just as happily with everything back on 128 kb.
    const oversized: string[] = [];

    let measured = 0;

    for (const route of rndChains) {
      const entry = bodies[`${route.method} ${toOpenApiPath(route.path)}`];
      if (!entry || entry.contentType === "multipart/form-data") continue;

      const converted = convertBodySchema(entry.schema);
      if (converted.kind !== "ok") continue;
      const budget = estimateBodyBytes(converted.schema);
      if (budget.kind !== "bounded" || budget.bytes > COMPACT_BYTES) continue;
      measured++;

      const cap = declaredCap(route);
      if (cap !== undefined && cap > COMPACT_BYTES) {
        oversized.push(`${route.method} ${route.path} — fits ${String(budget.bytes)}B, carries ${String(cap)}B`);
      }
    }

    expect([...new Set(oversized)].toSorted()).toEqual([]);
    expect(measured).toBeGreaterThanOrEqual(40);
  });
});

describe("estimateBodyBytes", () => {
  it("counts four bytes per character, the astral-plane worst case", () => {
    // Three would cover Devanagari and CJK; four covers emoji. Over-estimating leaves a route
    // on a larger cap, which is the safe direction.
    const budget = estimateBodyBytes({ type: "string", maxLength: 1000 });

    expect(budget.kind === "bounded" && budget.bytes).toBeGreaterThanOrEqual(4000);
  });

  it("reports a string with no derivable maximum as unbounded", () => {
    expect(estimateBodyBytes({ type: "string", minLength: 1 }).kind).toBe("unbounded");
  });

  it("derives a bound from a format rather than calling it unbounded", () => {
    // `z.uuid()` emits no maxLength. Treating it as unmeasurable would leave a third of the
    // surface on the larger cap for no reason at all.
    expect(estimateBodyBytes({ type: "string", format: "uuid" }).kind).toBe("bounded");
  });

  it("takes the widest arm of a union", () => {
    const budget = estimateBodyBytes({
      anyOf: [
        { type: "string", maxLength: 10 },
        { type: "string", maxLength: 100 },
      ],
    });

    expect(budget.kind === "bounded" && budget.bytes).toBeGreaterThan(400);
  });

  it("propagates unboundedness out of a nested property", () => {
    const budget = estimateBodyBytes({
      type: "object",
      properties: { nested: { type: "object", properties: { open: { type: "string" } } } },
    });

    expect(budget.kind).toBe("unbounded");
  });
});

describe("maxLengthFromPattern", () => {
  it.each([
    { pattern: String.raw`^\d{1,15}$`, expected: 15, why: "a bounded repetition takes its maximum" },
    { pattern: String.raw`^\d{4}-\d{2}-\d{2}$`, expected: 10, why: "literals and repetitions sum" },
    { pattern: "^[A-Z]{2}$", expected: 2, why: "a character class is one atom" },
    { pattern: String.raw`^\d?$`, expected: 1, why: "`?` is at most one" },
  ])("bounds $why", ({ pattern, expected }) => {
    expect(maxLengthFromPattern(pattern)).toBe(expected);
  });

  it.each([
    { pattern: String.raw`^\d+$`, why: "an open repetition" },
    { pattern: String.raw`^\d*$`, why: "a star" },
    { pattern: String.raw`^\d{2,}$`, why: "an open lower bound" },
    { pattern: "^(a|b)$", why: "alternation this does not parse" },
    { pattern: String.raw`\d{2}`, why: "an unanchored pattern, which can match anywhere" },
  ])("refuses to bound $why", ({ pattern }) => {
    // Undefined keeps the route on the cap it already has. Guessing would shrink a cap below
    // what the server accepts, which is the one outcome to avoid.
    expect(maxLengthFromPattern(pattern)).toBeUndefined();
  });
});
