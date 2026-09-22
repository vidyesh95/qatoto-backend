import { z } from "zod";

/**
 * The wire shape for `/blueprints/drafts`.
 *
 * ⚠️ THE ENVELOPE IS PARSED STRICTLY AND THE DOCUMENT IS NOT PARSED AT ALL, which is the one
 * decision in this file worth defending. Everywhere else on this surface, "parse, don't validate"
 * means a Zod schema mirroring the stored shape — but a draft is UNVALIDATED BY DEFINITION. A
 * half-answered wizard step is the state it exists to hold, so a schema that admitted only
 * submittable documents would refuse exactly the drafts worth saving.
 *
 * What makes that safe rather than a hole:
 *
 *   * the document NEVER reaches a public serializer, a publish, or another account. The only
 *     reader is the author who wrote it;
 *   * the SUBMIT gate is unchanged and remains the only gate. A draft that cannot be submitted is
 *     a draft, and the author finds out when they submit — which is when they asked;
 *   * `.strict()` on the envelope refuses an unknown key, so a client cannot smuggle a column;
 *   * the document is bounded twice — by `longFormBody` on the route and by
 *     `blueprint_draft_document_ck` on the column — and proven to be a JSON OBJECT before storage,
 *     which is what stops `"null"`, an array, or a bare scalar being written.
 *
 * The alternative — three hand-built "everything optional" mirrors of the submit schemas — was
 * rejected on maintenance: Zod 4 has no `.deepPartial()`, so each would be written by hand and kept
 * in step with its submit schema forever, and every new wizard field would touch two files. That is
 * a drift machine, and what it buys is field-level feedback the wizard already gives locally.
 */

/**
 * 32,000 characters, which is what `longFormBody` admits once the envelope is paid for.
 *
 * ⚠️ DERIVED, AND THE FIRST NUMBER HERE WAS WRONG IN A WAY WORTH RECORDING. It was 262,144 — the
 * column CHECK's own bound — and `json-body-budget.test.ts` refused it: `estimateBodyBytes` counts
 * FOUR BYTES PER CHARACTER, so that schema could produce 1,049,569 bytes against a 131,072-byte
 * cap. The CHECK was therefore unreachable through the route, which makes it decorative rather than
 * a control: no request could ever get close enough to trip it.
 *
 * 32,768 was the second wrong answer: 32,768 x 4 is exactly the cap, leaving nothing for `label`,
 * `documentSchemaVersion` and `revision` — 993 bytes over. The document does not get the whole
 * budget, because it does not travel alone. So the Zod bound and the column CHECK are both this
 * number, and the gate proves they stay reachable. `MAX_JSON_BODY_BYTES` is untouched — it is the ceiling every route behind it inherits,
 * and raising it to make room for a draft would loosen every one of them.
 */
export const BLUEPRINT_DRAFT_DOCUMENT_MAXIMUM_CHARACTERS = 32_000;

const DraftDocumentSchema = z
  .string()
  .min(2, "A draft document is a JSON object.")
  .max(BLUEPRINT_DRAFT_DOCUMENT_MAXIMUM_CHARACTERS, "That draft is too large to save.");

const DraftLabelSchema = z.string().trim().min(1).max(200).nullable();

/**
 * ⚠️ THE ARM LABELS ARE THE pgEnum's OWN SPELLING, `showcase_launch` included. It differs from the
 * moderation surface's `showcase` because these are different enums about different things — one
 * names an arm a verb can reach, this one names a wizard. Spelling either to match the other would
 * make a future reader assume they are the same set.
 */
export const CreateBlueprintDraftSchema = z
  .object({
    arm: z.enum(["teardown", "showcase_launch", "case_study"]),
    label: DraftLabelSchema.default(null),
    document: DraftDocumentSchema,
    documentSchemaVersion: z.number().int().positive(),
  })
  .strict();
/**
 * ⚠️ `revision` IS REQUIRED ON EVERY WRITE, and that is what makes autosave safe. A client sends
 * back the revision it loaded; the UPDATE guards on it. Without it, two tabs saving one draft means
 * the last writer silently destroys the other's work — the exact failure "resume later across
 * devices" is sold as preventing, and the cheapest possible thing to add now.
 */
export const ReplaceBlueprintDraftSchema = z
  .object({
    label: DraftLabelSchema,
    document: DraftDocumentSchema,
    documentSchemaVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
/** `.strip()` rather than `.strict()`, matching every other query schema: a stray `utm_source`. */
export const BlueprintDraftListQuerySchema = z
  .object({ arm: z.enum(["teardown", "showcase_launch", "case_study"]).optional() })
  .strip();
