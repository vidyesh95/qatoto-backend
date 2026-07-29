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
 * The bodies remain the Zod schemas the controllers export. Wiring those in is the next
 * step and is worth doing schema by schema, not in one sweep: `z.toJSONSchema` is available
 * (zod 4.4), but a `.strict()` object with a cross-field refinement does not always survive
 * the translation, and a spec that quietly loosens a constraint is worse than one that
 * omits it.
 */

interface RouterInternals {
  readonly stack: readonly {
    readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
  }[];
}

export interface DeclaredRoute {
  readonly method: string;
  /** As declared on the router, with Express's `:param` syntax. */
  readonly path: string;
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

/** `/research-projects/:projectSlug` → `/research-projects/{projectSlug}`. */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The `{name}` parameters in an OpenAPI path, in order. */
export function pathParameterNames(openApiPath: string): readonly string[] {
  return [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "");
}
