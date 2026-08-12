import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildValidationFailureBody, fieldRefusal } from "#src/modules/rnd/projects/project-error-response.js";

/**
 * The 422 envelope, pinned.
 *
 * WHY THIS FILE EXISTS. Every controller's Zod failure routes through one responder, and both
 * halves of what it emits are load-bearing in ways a green suite would not otherwise notice:
 *
 *   - `message` is USER-FACING COPY. 48 client components render it and only 2 also render
 *     `errors`, so on ~46 surfaces it is the entire error a person sees.
 *   - `errors.form` is where `.strict()`'s `unrecognized_keys` lands — the way every rejected
 *     server-owned field arrives. Twenty-five controllers once dropped it and answered 422 with an
 *     empty object.
 *
 * Neither was pinned before, and the message changed once without anything failing.
 * `users.controller.photo.test.ts` sets the precedent: "If the extracted mapper drifts, one of
 * these fails."
 *
 * Asserts the PURE mapper, like every sibling `*-error-response.test.ts` — no Express fake, and so
 * no type assertions (CLAUDE.md §2).
 */

const StrictBodySchema = z.object({ title: z.string().min(1) }).strict();

function failureFor(input: unknown): ReturnType<typeof buildValidationFailureBody> {
  const parsed = StrictBodySchema.safeParse(input);
  if (parsed.success) {
    throw new Error("failureFor: the input parsed successfully, so there is no error to inspect");
  }
  return buildValidationFailureBody(parsed.error);
}

describe("buildValidationFailureBody", () => {
  it("carries the canonical user-facing message", () => {
    const body = failureFor({ title: "" });

    expect(body.status).toBe("error");
    expect(body.statusCode).toBe(422);
    // Sentence case, second person, trailing period — the style the other 656 error messages keep.
    // This is the string ~46 client surfaces render on its own.
    expect(body.message).toBe("Please check the highlighted fields.");
  });

  it("names the offending field", () => {
    expect(failureFor({ title: "" }).errors.title).toBeDefined();
  });

  /**
   * THE ONE THAT MATTERS MOST. `.strict()`'s rejection is an OBJECT-level issue, so it lands in
   * `formErrors` and is invisible to anything reading `fieldErrors` alone.
   */
  it("surfaces a rejected unknown key under the reserved `form` key", () => {
    const body = failureFor({ title: "Fine", sellerOrganizationId: "smuggled" });

    expect(body.errors.form).toBeDefined();
    expect(JSON.stringify(body.errors.form)).toContain("sellerOrganizationId");
  });

  it("keeps field-level and object-level issues side by side", () => {
    const body = failureFor({ title: "", sellerOrganizationId: "smuggled" });

    // Surfacing one must not cost the other.
    expect(body.errors.title).toBeDefined();
    expect(body.errors.form).toBeDefined();
  });

  it("omits `form` entirely when nothing object-level failed", () => {
    // An empty `form: []` would render as a bullet with no text on the clients that list entries.
    expect(failureFor({ title: "" }).errors.form).toBeUndefined();
  });

  it("never uses `data` — that is the success payload, which clients do not read on a failure", () => {
    expect(failureFor({ title: "" })).not.toHaveProperty("data");
  });
});

/**
 * The DOMAIN half of the 422 surface. Not a parse failure — "that handle is taken" has no ZodError
 * behind it — so it gets its own builder, and the same rule: one sentence, both places.
 */
describe("fieldRefusal", () => {
  const REASON = "Handle is already taken.";

  it("puts the identical sentence in `message` and in the field entry", () => {
    const body = fieldRefusal("handle", REASON);

    // The point of the helper. `message` reaches ~46 client surfaces; `errors.handle` reaches the 2
    // that can highlight an input. Neither may be the only one that knows why.
    expect(body.message).toBe(REASON);
    expect(body.errors.handle).toEqual([REASON]);
  });

  it("answers 422", () => {
    expect(fieldRefusal("handle", REASON).statusCode).toBe(422);
  });

  it("names exactly one field", () => {
    expect(Object.keys(fieldRefusal("handle", REASON).errors)).toEqual(["handle"]);
  });

  /**
   * `form` is reserved for object-level PARSE issues — `.strict()`'s rejected keys. A domain
   * refusal always knows which field it is about, so emitting `form` here would tell a client the
   * problem was unattributable when it is not.
   */
  it("never emits the reserved `form` key", () => {
    expect(fieldRefusal("handle", REASON).errors.form).toBeUndefined();
  });
});
