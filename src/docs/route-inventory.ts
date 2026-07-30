/**
 * The route surface, derived from the mounted routers rather than written down
 * (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 8).
 *
 * WHY DERIVE IT. `src/docs/openapi.ts` is 929 hand-written lines describing 27 paths, and
 * ZERO of them are R&D: the whole `/research-projects` tree, funding, compensation,
 * proof-of-effort, suppliers and every root-mounted read are absent. A hand-written spec
 * for 200 more routes would be wrong within a week — the same drift this document's own
 * §11 has suffered twice, and for the same reason.
 *
 * WHAT THIS IS NOT. A path list is not a full specification: it carries no request bodies
 * and no response schemas, which the hand-written entries do carry for the auth surface.
 * Publishing an honest inventory of every route beats publishing a detailed description of
 * an eighth of them and silence about the rest — a client generator that emits nothing for
 * `/compensation-periods/:id/finalize` tells its author the endpoint does not exist.
 *
 * REQUEST BODIES HAVE SINCE LANDED, and the caveat above turned out to be half right. A
 * `.strict()` object converts cleanly — `z.toJSONSchema` emits `additionalProperties: false`
 * for it. What does NOT survive is the cross-field REFINEMENT: `.refine()` is a check on
 * `_zod.def.checks` and the converter dispatches on `def.type`, so it is dropped in silence,
 * and `unrepresentable: "throw"` does not catch it because that flag guards unrepresentable
 * TYPES. The fix is in `src/docs/zod-to-openapi.ts`: the lost constraints are detected and
 * disclosed on the operation rather than the body being withheld. Loudly loosened, not
 * quietly.
 *
 * RESPONSE SCHEMAS remain the honest gap. Nothing here claims one.
 */

interface RouterInternals {
  readonly stack: readonly {
    readonly route?: {
      readonly path?: unknown;
      readonly methods?: Record<string, boolean>;
      readonly stack?: readonly { readonly handle?: unknown; readonly method?: unknown }[];
    };
  }[];
}

export interface DeclaredRoute {
  readonly method: string;
  /** As declared on the router, with Express's `:param` syntax. */
  readonly path: string;
}

/**
 * A route plus the handler chain Express will actually run for that verb.
 *
 * SEPARATE FROM `DeclaredRoute` ON PURPOSE, and the separation is the point. `DeclaredRoute`
 * is what the EMITTER consumes, and the emitter must stay blind to handler identity: "there
 * is a `compactBody` in this chain" is a claim about intent, not about behaviour —
 * a parser mounted on a prefix in `src/app.ts` silently voids the ones inside it. Deriving
 * published documentation from that would publish the intent and describe the wrong server.
 *
 * The audit tier may be clever about handlers; the spec builder may not. `handlers` is typed
 * `unknown[]` deliberately: reference comparison and `String()` are the only honest
 * operations on it, and both belong in a test.
 */
export interface RouteHandlerChain {
  readonly method: string;
  readonly path: string;
  readonly handlers: readonly unknown[];
}

function isRouterInternals(value: unknown): value is RouterInternals {
  // An Express router is a FUNCTION with a `stack` property, not a plain object.
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  return Array.isArray(Reflect.get(value, "stack"));
}

/** Every verb route a router declares, prefixed with its mount path. */
export function declaredRoutes(mountPath: string, router: unknown): readonly DeclaredRoute[] {
  if (!isRouterInternals(router)) return [];

  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];

    const methods = Object.entries(layer.route?.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => method.toLowerCase())
      // `_all` is Express's marker for `router.all`, not a verb.
      .filter((method) => method !== "_all");

    const fullPath = `${mountPath === "/" ? "" : mountPath}${path}`;
    return methods.map((method) => ({ method, path: fullPath }));
  });
}

/**
 * Every verb route a router declares, with the handlers Express runs for that verb.
 *
 * ONE `route.stack` SERVES ALL OF A ROUTE'S VERBS, so the entries must be filtered by method
 * or a `.post(parser, handler).get(handler)` route reports the parser on its GET. Handlers
 * registered through `router.all` carry no `.method` and belong to every verb.
 */
export function declaredRouteChains(
  mountPath: string,
  router: unknown,
): readonly RouteHandlerChain[] {
  if (!isRouterInternals(router)) return [];

  return router.stack.flatMap((layer) => {
    const path = layer.route?.path;
    if (typeof path !== "string") return [];

    const chainEntries = layer.route?.stack ?? [];
    const methods = Object.entries(layer.route?.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => method.toLowerCase())
      .filter((method) => method !== "_all");

    const fullPath = `${mountPath === "/" ? "" : mountPath}${path}`;
    return methods.map((method) => ({
      method,
      path: fullPath,
      handlers: chainEntries
        .filter((entry) => entry.method === method || entry.method === undefined)
        .map((entry) => entry.handle),
    }));
  });
}

/** `/research-projects/:projectSlug` → `/research-projects/{projectSlug}`. */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The `{name}` parameters in an OpenAPI path, in order. */
export function pathParameterNames(openApiPath: string): readonly string[] {
  return [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "");
}
