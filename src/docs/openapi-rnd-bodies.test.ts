import { beforeAll, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The guard that keeps the request-body map honest (§11l.2 item 8).
 *
 * `openapi-rnd-bodies.ts` is the ONE hand-maintained thing in a document whose whole point
 * is that it is derived, so it is the one thing that can drift. This suite walks the same
 * routers the emitter walks, finds every route whose handler actually reads a body, and
 * fails naming any key the map is missing. Adding a body-taking route without an entry is a
 * red build rather than a silently undocumented endpoint.
 *
 * WHY THE DETECTOR READS HANDLER SOURCE RATHER THAN LOOKING FOR A BODY PARSER. Because the
 * parser is not a reliable signal: `src/app.ts` mounts `longFormBody` on three
 * PREFIXES, so five routes read a body with nothing in their own `route.stack` — including
 * `post /research-projects/`, the most important body on the surface. Reference-matching the
 * parsers alone would pass while omitting it. Assertion 2 keeps the parser check as a
 * SUPERSET so that if `optionalBody` is ever renamed, rule 1 fails loudly instead of
 * silently weakening.
 *
 * `Function.prototype.toString` is safe here: `pnpm build` is bare `tsc` with no minifier,
 * and vitest resolves `#src/*` to TypeScript source, so identifiers survive either way.
 *
 * BUT THE CALL FORM DOES NOT SURVIVE, and missing that silently guts rule 1. Vite's SSR
 * transform rewrites a call to an imported function as
 * `(0,__vite_ssr_import_2__.optionalBody)(req)` — the identifier is still there, but it is
 * followed by `)` rather than `(`. A naive `/optionalBody\s*\(/` therefore matches under
 * `tsx` and matches NOTHING here, which makes rule 1 pass vacuously on exactly the nine
 * routes it most needs to cover. `CALLS_OPTIONAL_BODY` tolerates both spellings.
 */

/**
 * `optionalBody(req)` in either the source form or Vite's interop form.
 * The optional `\)?` is the whole point — see the note above.
 */
const CALLS_OPTIONAL_BODY = /optionalBody\s*\)?\s*\(\s*req\s*\)/;

/** Any read of the request body, however the transform spelled the call. */
const READS_BODY = /req\.body|optionalBody\s*\)?\s*\(/;

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());

type RouteChain = { readonly method: string; readonly path: string; readonly handlers: readonly unknown[] };

let chains: readonly RouteChain[];
let bodies: typeof import("#src/docs/openapi-rnd-bodies.js").RND_REQUEST_BODIES;
let paths: Record<string, Record<string, unknown>>;
let toOpenApiPath: (expressPath: string) => string;
let convertBodySchema: typeof import("#src/docs/zod-to-openapi.js").convertBodySchema;

/** Every handler in a chain, flattened to source text. */
function chainSource(chain: RouteChain): string {
  return chain.handlers
    .map((handler) => (typeof handler === "function" ? Function.prototype.toString.call(handler) : ""))
    .join("\n");
}

function routeKey(chain: RouteChain): string {
  return `${chain.method} ${toOpenApiPath(chain.path)}`;
}

function readsBody(chain: RouteChain): boolean {
  return READS_BODY.test(chainSource(chain));
}

function hasRouteLevelJsonParser(chain: RouteChain): boolean {
  return chain.handlers.some(
    (handler) => typeof handler === "function" && /parseJsonBody/.test(Function.prototype.toString.call(handler)),
  );
}

function readsBodyOptionally(chain: RouteChain): boolean {
  return CALLS_OPTIONAL_BODY.test(chainSource(chain));
}

describe("derived OpenAPI request bodies", () => {
  beforeAll(async () => {
    // Dynamic, so the environment stub above is in place before config is evaluated.
    const rnd = await import("#src/docs/openapi-rnd.js");
    const inventory = await import("#src/docs/route-inventory.js");
    const converter = await import("#src/docs/zod-to-openapi.js");
    const map = await import("#src/docs/openapi-rnd-bodies.js");

    chains = rnd.rndRouteChains();
    paths = rnd.buildRndPathItems();
    bodies = map.RND_REQUEST_BODIES;
    toOpenApiPath = inventory.toOpenApiPath;
    convertBodySchema = converter.convertBodySchema;
  });

  it("maps every route that reads a body", () => {
    const unmapped = chains.filter((chain) => readsBody(chain) && !(routeKey(chain) in bodies)).map(routeKey);

    // The red build. The message names the exact key to add.
    expect(unmapped).toEqual([]);
  });

  it("covers every route carrying a route-level JSON parser, as a superset check", () => {
    // Weaker than rule 1 by construction. It exists so that if `optionalBody` is renamed and
    // rule 1 quietly starts matching nothing, this still fails.
    const unmapped = chains
      .filter((chain) => hasRouteLevelJsonParser(chain) && !(routeKey(chain) in bodies))
      .map(routeKey);

    expect(unmapped).toEqual([]);
  });

  it("has no orphaned entries", () => {
    const declared = new Set(chains.map(routeKey));
    // A renamed path leaves an entry documenting nothing. Failing is better than a spec
    // quietly losing a body.
    const orphans = Object.keys(bodies).filter((key) => !declared.has(key));

    expect(orphans).toEqual([]);
  });

  it("detects body reads at all — the guard against a vacuous rule 1", () => {
    // Both detectors matched NOTHING once already, because Vite rewrites an imported call to
    // `(0,_import.optionalBody)(req)` and the first regex looked for `optionalBody(`. Every
    // rule above passes happily when the thing it filters on is never true, so the floors
    // here are what make the rest of this file mean something.
    expect(chains.filter(readsBody).length).toBeGreaterThanOrEqual(70);
    expect(chains.filter(readsBodyOptionally).length).toBeGreaterThanOrEqual(9);
  });

  it("marks a body optional exactly when the handler reads it through optionalBody", () => {
    const disagreements = chains
      .filter((chain) => routeKey(chain) in bodies)
      .filter((chain) => bodies[routeKey(chain)]?.required === readsBodyOptionally(chain))
      .map(routeKey);

    // Both directions. `required: false` on a route that reads `req.body` directly would be
    // a spec that loosens: Express 5 leaves `req.body` undefined with no Content-Type, so a
    // bodyless request there is a 422, not a success.
    expect(disagreements).toEqual([]);
  });

  it("converts every mapped schema", () => {
    const failures = Object.entries(bodies)
      .map(([key, entry]) => ({ key, converted: convertBodySchema(entry.schema) }))
      .filter((result) => result.converted.kind === "failed")
      .map((result) => result.key);

    // The emitter degrades softly so a bad schema cannot take /health down. This is the hard
    // half of that policy: it must never actually happen.
    expect(failures).toEqual([]);
  });

  it("emits a requestBody for every mapped route", () => {
    const missing = Object.keys(bodies).filter((key) => {
      const [method, path] = key.split(" ");
      const operation = paths[path ?? ""]?.[method ?? ""];
      return typeof operation !== "object" || operation === null || !("requestBody" in operation);
    });

    expect(missing).toEqual([]);
  });

  it("discloses every constraint the schema could not express", () => {
    const disclosed = Object.values(paths)
      .flatMap((pathItem) => Object.values(pathItem))
      .filter((operation): operation is Record<string, unknown> => typeof operation === "object" && operation !== null)
      .filter((operation) => "x-unrepresentable-constraints" in operation);

    // A floor rather than an exact count, in the style of the operation-count test beside
    // this one — but a floor above zero, so a detector that silently stopped detecting
    // cannot pass by matching zero to zero.
    expect(disclosed.length).toBeGreaterThanOrEqual(3);

    for (const operation of disclosed) {
      // The machine-readable extension and the human sentence must travel together; a tool
      // reading one and a person reading the other must not disagree.
      expect(String(operation["description"])).toContain("NOT EXPRESSIBLE IN THIS SCHEMA");
    }
  });

  it("emits additionalProperties: false, since every body schema is strict", () => {
    const operation = paths["/research-projects/{projectSlug}/effort-claims"]?.["post"];
    const requestBody =
      typeof operation === "object" && operation !== null ? Reflect.get(operation, "requestBody") : undefined;
    const schema = Reflect.get(
      Reflect.get(Reflect.get(requestBody ?? {}, "content") ?? {}, "application/json") ?? {},
      "schema",
    );

    // The half of the original caveat that turned out to be wrong: `.strict()` DOES survive.
    expect(Reflect.get(schema ?? {}, "additionalProperties")).toBe(false);
  });
});
