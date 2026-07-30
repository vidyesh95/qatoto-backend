/**
 * The largest JSON body a Zod schema can legitimately produce, in bytes (§11l.4).
 *
 * WHY IT MATTERS THAT THIS IS DERIVED. Making the per-route caps real means TIGHTENING
 * routes that had silently been on 128 kb, and a cap picked by eye is how you reintroduce
 * the bug the whole exercise is fixing — a 413 for non-English users only.
 *
 * Deriving it removes that risk by construction. A route whose cap is at least its own
 * schema's worst case can only reject a body Zod was going to reject anyway: the caller sees
 * a 413 where they would have seen a 422, and the request fails either way. Nothing that
 * works today stops working.
 *
 * THE ESTIMATE IS AN UPPER BOUND, deliberately loose:
 *
 *   * a string counts `maxLength × 4`, the worst case for UTF-8 including astral-plane
 *     characters. `z.string().max(n)` counts UTF-16 code units while a cap counts BYTES, and
 *     that gap IS the original bug — a 5,000-character Devanagari description is ~15 kb.
 *   * an array counts its item bound × `maxItems`.
 *   * every property adds its own name plus JSON punctuation.
 *   * anything with no derivable bound reports `unbounded`, and the caller keeps the larger
 *     cap rather than inventing a number.
 *
 * Loose is the correct direction: over-estimating leaves a route on a larger cap, which is
 * where it already is. Under-estimating is the change that breaks something.
 */

/** Worst-case UTF-8 bytes per UTF-16 code unit permitted by `z.string().max()`. */
const BYTES_PER_CHARACTER = 4;

/** `{`, `}`, quotes around a key, the colon and the comma. */
const PROPERTY_OVERHEAD_BYTES = 8;

/** A number, boolean or enum member serialized at its most verbose. */
const SCALAR_BYTES = 32;

/**
 * Formats whose longest legal value is fixed by their own specification.
 *
 * These are DERIVED bounds, not guesses: a uuid is 36 characters, an RFC 5321 address 254.
 * Reading them matters because `z.uuid()` and `z.iso.datetime()` emit no `maxLength`, and
 * treating them as unmeasurable would leave most of this surface on the larger cap — 21 of
 * the 71 mapped bodies hinge on exactly these two.
 */
const FORMAT_MAX_LENGTH: Readonly<Record<string, number>> = {
  uuid: 36,
  date: 10,
  "date-time": 64,
  time: 32,
  duration: 64,
  email: 254,
  ipv4: 15,
  ipv6: 45,
};

/**
 * The longest string an ANCHORED, fully-bounded regex can match, or undefined if the pattern
 * admits unbounded input or uses anything this does not understand.
 *
 * WHY BOTHER. Fifteen bodies bound a decimal-string amount with `^\d{1,15}$` and seven bound
 * a date with `^\d{4}-\d{2}-\d{2}$` — real bounds, declared, just not as `maxLength`.
 *
 * DELIBERATELY NOT A REGEX ENGINE. Anything it does not recognise — `*`, `+`, `{n,}`,
 * alternation, groups — returns undefined and the caller treats the field as unbounded.
 * Erring toward "cannot measure" keeps a route on the cap it already has; erring the other
 * way shrinks a cap below what the server accepts, which is the one outcome to avoid.
 */
export function maxLengthFromPattern(pattern: string): number | undefined {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return undefined;

  const body = pattern.slice(1, -1);
  // Alternation and groups need a real parser to bound; `format` covers the cases that matter.
  if (/[|()*+]/.test(body)) return undefined;
  // An open-ended repetition is unbounded by definition.
  if (/\{\d+,\}/.test(body)) return undefined;

  let total = 0;
  let index = 0;

  while (index < body.length) {
    // One atom: an escape, a character class, or a literal character.
    if (body[index] === "\\") {
      index += 2;
    } else if (body[index] === "[") {
      const close = body.indexOf("]", index + 1);
      if (close === -1) return undefined;
      index = close + 1;
    } else {
      index += 1;
    }

    // Its quantifier, if any.
    const quantifier = /^\{(\d+)(?:,(\d+))?\}|^\?/.exec(body.slice(index));
    if (!quantifier) {
      total += 1;
      continue;
    }

    if (quantifier[0] === "?") {
      total += 1;
      index += 1;
      continue;
    }

    // `{n,m}` costs m; `{n}` costs n.
    total += Number(quantifier[2] ?? quantifier[1]);
    index += quantifier[0].length;
  }

  return total;
}

export type BodyBudget =
  | { readonly kind: "bounded"; readonly bytes: number }
  | { readonly kind: "unbounded"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walks a JSON Schema — the output of `convertBodySchema` — and sums an upper bound.
 *
 * Takes JSON Schema rather than the Zod schema so there is one interpretation of what a
 * constraint means, and so the thing measured is the thing published in the OpenAPI document.
 */
export function estimateBodyBytes(schema: unknown, path = "body"): BodyBudget {
  if (!isRecord(schema)) return { kind: "bounded", bytes: SCALAR_BYTES };

  // A union costs as much as its widest arm.
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const arms = schema[key];
    if (!Array.isArray(arms)) continue;

    let widest = 0;
    for (const [index, arm] of arms.entries()) {
      const armBudget = estimateBodyBytes(arm, `${path}[${key}/${String(index)}]`);
      if (armBudget.kind === "unbounded") return armBudget;
      widest = Math.max(widest, armBudget.bytes);
    }
    return { kind: "bounded", bytes: widest + PROPERTY_OVERHEAD_BYTES };
  }

  const type = schema["type"];

  if (type === "string") {
    // An enum is bounded by its longest member even without a maxLength.
    const enumeration = schema["enum"];
    if (Array.isArray(enumeration)) {
      const longest = Math.max(0, ...enumeration.map((member) => String(member).length));
      return { kind: "bounded", bytes: longest * BYTES_PER_CHARACTER + PROPERTY_OVERHEAD_BYTES };
    }

    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number") {
      return { kind: "bounded", bytes: maxLength * BYTES_PER_CHARACTER + PROPERTY_OVERHEAD_BYTES };
    }

    // No `.max()`, but the value may still be bounded by what it IS. Both branches below are
    // derivations from the schema's own declarations, not assumptions about typical input.
    const format = schema["format"];
    const formatBound = typeof format === "string" ? FORMAT_MAX_LENGTH[format] : undefined;
    if (formatBound !== undefined) {
      return {
        kind: "bounded",
        bytes: formatBound * BYTES_PER_CHARACTER + PROPERTY_OVERHEAD_BYTES,
      };
    }

    const pattern = schema["pattern"];
    const patternBound = typeof pattern === "string" ? maxLengthFromPattern(pattern) : undefined;
    if (patternBound !== undefined) {
      return {
        kind: "bounded",
        bytes: patternBound * BYTES_PER_CHARACTER + PROPERTY_OVERHEAD_BYTES,
      };
    }

    // The honest answer. A field with no bound cannot be sized, and guessing one here is how
    // a cap ends up rejecting real input.
    return { kind: "unbounded", reason: `${path} is a string with no derivable maximum` };
  }

  if (type === "array") {
    const maxItems = schema["maxItems"];
    if (typeof maxItems !== "number") {
      return { kind: "unbounded", reason: `${path} is an array with no .max()` };
    }
    const items = estimateBodyBytes(schema["items"], `${path}[]`);
    if (items.kind === "unbounded") return items;
    return { kind: "bounded", bytes: maxItems * (items.bytes + 2) + PROPERTY_OVERHEAD_BYTES };
  }

  if (type === "object" || isRecord(schema["properties"])) {
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    let total = PROPERTY_OVERHEAD_BYTES;

    for (const [name, propertySchema] of Object.entries(properties)) {
      const property = estimateBodyBytes(propertySchema, `${path}.${name}`);
      if (property.kind === "unbounded") return property;
      total += name.length + PROPERTY_OVERHEAD_BYTES + property.bytes;
    }

    // A record with open keys is unbounded in the same way an unbounded string is.
    const additional = schema["additionalProperties"];
    if (additional !== false && isRecord(additional)) {
      return { kind: "unbounded", reason: `${path} allows additional properties` };
    }

    return { kind: "bounded", bytes: total };
  }

  return { kind: "bounded", bytes: SCALAR_BYTES };
}
