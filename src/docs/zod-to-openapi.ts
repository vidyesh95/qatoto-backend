import { z } from "zod";

/**
 * Zod → OpenAPI 3.0 for request bodies (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 8).
 *
 * THE CAVEAT IN `route-inventory.ts` WAS HALF RIGHT, and the half that was wrong changes the
 * design. `.strict()` converts cleanly: `z.toJSONSchema` emits `additionalProperties: false`.
 * What is lost is the cross-field REFINEMENT — `.refine()` compiles to a check on
 * `_zod.def.checks` while the converter dispatches on `def.type`, so it vanishes without a
 * word. `unrepresentable: "throw"` does NOT catch it: every throw site in Zod's processor is
 * an unrepresentable TYPE (bigint, date, map, transform), never a dropped check.
 *
 * So the guard is built rather than configured. `convertBodySchema` walks the same tree
 * through Zod's `override` hook, collects every check whose kind is `custom`, and reports
 * what the emitted schema cannot say so the emitter can disclose it on the operation. The schema published is a strict SUPERSET of
 * what the server accepts, and the operation says so at the point of use — which is what
 * "not quietly loosening" actually requires. Withholding the body instead would hide twenty
 * correct field constraints to avoid overstating one.
 */

/** A cross-field rule the emitted JSON Schema cannot express. */
export interface UnrepresentableConstraint {
  /** Where in the schema the rule sits — `[]` for the object root. */
  readonly at: readonly string[];
  /** The field the rule blames, from `.refine(fn, { path })`. */
  readonly field: readonly string[];
  /** The author's own message, when `.refine` was given a static one. */
  readonly message: string | undefined;
}

export type ConvertedBody =
  | {
      readonly kind: "ok";
      readonly schema: Record<string, unknown>;
      readonly unrepresentable: readonly UnrepresentableConstraint[];
    }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Recovers the static message from a refinement.
 *
 * Zod stores `.refine(fn, { message })` as a THUNK at `def.error`, not as a string, so the
 * only way to read it is to call it. A caller may have passed a function that inspects the
 * issue it is given, so an empty one may well throw — that is not an error worth surfacing,
 * it just means this refinement has no message that can be stated statically.
 */
function staticRefinementMessage(errorThunk: unknown): string | undefined {
  if (typeof errorThunk === "string") return errorThunk;
  if (typeof errorThunk !== "function") return undefined;

  try {
    const produced: unknown = Reflect.apply(errorThunk, undefined, [{}]);
    return typeof produced === "string" ? produced : undefined;
  } catch {
    return undefined;
  }
}

/** Reads `_zod.def.checks` off a schema node without asserting a shape onto it. */
function checksOf(node: unknown): readonly unknown[] {
  if (typeof node !== "object" || node === null) return [];
  const internals: unknown = Reflect.get(node, "_zod");
  if (typeof internals !== "object" || internals === null) return [];
  const def: unknown = Reflect.get(internals, "def");
  if (typeof def !== "object" || def === null) return [];
  const checks: unknown = Reflect.get(def, "checks");
  return Array.isArray(checks) ? checks : [];
}

/** The `_zod.def` of one check, or undefined if the shape is not what we expect. */
function checkDefinitionOf(check: unknown): Record<string, unknown> | undefined {
  if (typeof check !== "object" || check === null) return undefined;
  const internals: unknown = Reflect.get(check, "_zod");
  if (typeof internals !== "object" || internals === null) return undefined;
  const def: unknown = Reflect.get(internals, "def");
  if (typeof def !== "object" || def === null) return undefined;
  return { ...def };
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Converts one body schema, and reports what the conversion could not carry.
 *
 * SOFT FAILURE, DELIBERATELY. `openApiSpec` is a module-level constant, so a throw here would
 * take `/health` down with the rest of the app the moment somebody put a `z.date()` in a
 * body. The emitter omits the body and says why; `openapi-rnd-bodies.test.ts` asserts this
 * branch is never reached, so documentation degrades in production and the BUILD goes red.
 */
export function convertBodySchema(schema: z.ZodType): ConvertedBody {
  const unrepresentable: UnrepresentableConstraint[] = [];

  try {
    const converted = z.toJSONSchema(schema, {
      // Emits `nullable: true` rather than a type array, and no `$schema` key.
      target: "openapi-3.0",
      // LOAD-BEARING. With "output" a field carrying `.default()` lands in `required`, which
      // is the opposite of true for a request body — the client is what may omit it.
      io: "input",
      // Catches an unrepresentable TYPE loudly. It does not catch a dropped refinement; that
      // is what the override below is for.
      unrepresentable: "throw",
      // A `$ref` emitted here would point at `#/definitions/…`, where `#` resolves to the
      // whole OpenAPI document rather than this sub-schema — a silently broken pointer.
      // Inlining keeps every body self-contained.
      reused: "inline",
      cycles: "throw",
      override: (context) => {
        const path = asStringArray(context.path);
        for (const check of checksOf(context.zodSchema)) {
          const definition = checkDefinitionOf(check);
          if (definition?.["check"] !== "custom") continue;

          unrepresentable.push({
            at: path,
            field: asStringArray(definition["path"]),
            message: staticRefinementMessage(definition["error"]),
          });
        }
      },
    });

    return { kind: "ok", schema: converted, unrepresentable };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The sentence appended to an operation's description for each lost rule.
 *
 * EVERY WORD IS DERIVED. Hand-writing this prose in the docs module would be exactly the
 * drift deriving the spec exists to prevent — change the message in the controller and this
 * follows on the next boot, with nobody having to remember.
 */
export function describeUnrepresentableConstraints(
  constraints: readonly UnrepresentableConstraint[],
): string | undefined {
  if (constraints.length === 0) return undefined;

  const sentences = constraints.map((constraint) => {
    const location =
      constraint.at.length > 0 ? `\`${constraint.at.join(".")}\`` : "The request body";
    const field =
      constraint.field.length > 0 ? ` (reported against \`${constraint.field.join(".")}\`)` : "";

    return constraint.message === undefined
      ? // A `.superRefine` carries no static message. Saying so is more honest than
        // inventing one, and it still tells a reader that the schema below is incomplete.
        `${location} additionally enforces a cross-field rule this schema cannot express${field}.`
      : `${location} additionally enforces: ${constraint.message}${field}`;
  });

  return `NOT EXPRESSIBLE IN THIS SCHEMA — the server also rejects bodies that violate the following, so the schema above is broader than what is accepted. ${sentences.join(" ")}`;
}
