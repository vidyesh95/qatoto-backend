import { z } from "zod";

/**
 * ⚠️ snake_case, SENT VERBATIM — the `blueprint_rights_claim_kind` and
 * `blueprint_rights_claim_target_kind` pgEnum labels, which the frontend's `rights-claim.schemas.ts`
 * spells identically. A kebab or camel spelling on the wire is a different, absent label.
 */
const BLUEPRINT_RIGHTS_CLAIM_KINDS = [
  "patent",
  "trade_secret",
  "copyright_cad",
  "trademark",
] as const;

/**
 * The three statements a claimant swears. The ids are the frontend's `RIGHTS_CLAIM_SWORN_CLAUSES`
 * ids; the wording lives there, and what the server needs is that all three were accepted.
 */
export const BLUEPRINT_RIGHTS_CLAIM_SWORN_CLAUSE_IDS = [
  "good_faith",
  "accurate",
  "authorised",
] as const;

/**
 * ⚠️ NOT `z.uuid()`. The three claimable tables key on text ids, and the seeded corpus uses ids like
 * `doc-001`. What makes an id honest is the service checking it against this teardown's own
 * `claim-targets`, not its shape.
 */
const ClaimTargetIdSchema = z.string().trim().min(1, "Pick what the claim is about.").max(200);

const RightsClaimTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whole_teardown") }).strict(),
  z.object({ kind: z.literal("document"), documentId: ClaimTargetIdSchema }).strict(),
  z
    .object({ kind: z.literal("manufacturing_file"), manufacturingFileId: ClaimTargetIdSchema })
    .strict(),
  z.object({ kind: z.literal("part"), partId: ClaimTargetIdSchema }).strict(),
]);

export type BlueprintRightsClaimTarget = z.infer<typeof RightsClaimTargetSchema>;

/**
 * The body of `POST /blueprints/teardowns/:teardownSlug/claims`.
 *
 * ⚠️ NO TEARDOWN ID, NO CLAIMANT ID AND NO TIMESTAMP. The teardown comes from the path, the claimant
 * from the session, and `sworn_at` from the server's clock — `.strict()` refuses a body that tries
 * to carry any of them.
 *
 * ⚠️ ALL THREE CLAUSES OR NOTHING. A notice sworn to two of three is a complaint, and the third
 * clause (standing) is the one that decides whether a moderator can act on it at all.
 */
export const CreateBlueprintRightsClaimSchema = z
  .object({
    claimKind: z.enum(BLUEPRINT_RIGHTS_CLAIM_KINDS),
    target: RightsClaimTargetSchema,
    claimantFullName: z
      .string()
      .trim()
      .min(2, "A claim has to say who is making it.")
      .max(200, "Keep the name under 200 characters."),
    claimantOrganizationName: z
      .string()
      .trim()
      .min(1)
      .max(200, "Keep the organisation under 200 characters.")
      .nullable(),
    claimantEmail: z.email("An address a moderator can reply to.").max(320),
    relationshipToRightsHolder: z
      .string()
      .trim()
      .min(3, "Say whether you own this right or are acting for whoever does.")
      .max(500, "Keep this under 500 characters."),
    claimSubstance: z
      .string()
      .trim()
      .min(60, "Say what you own and what here you say copies it.")
      .max(5000, "Keep the claim under 5,000 characters."),
    acceptedSwornClauseIds: z
      .array(z.enum(BLUEPRINT_RIGHTS_CLAIM_SWORN_CLAUSE_IDS))
      .max(BLUEPRINT_RIGHTS_CLAIM_SWORN_CLAUSE_IDS.length),
  })
  .strict()
  .superRefine((body, context) => {
    const accepted = new Set(body.acceptedSwornClauseIds);
    const missing = BLUEPRINT_RIGHTS_CLAIM_SWORN_CLAUSE_IDS.filter(
      (clauseId) => !accepted.has(clauseId),
    );
    if (missing.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["acceptedSwornClauseIds"],
        message: `All three statements have to be sworn. Still missing: ${missing.join(", ")}.`,
      });
    }
  });

export type CreateBlueprintRightsClaimBody = z.infer<typeof CreateBlueprintRightsClaimSchema>;

/**
 * The claim queue's paging controls. `.strip()`, like every read's query schema on this surface.
 */
export const BlueprintRightsClaimQueueQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).default("open"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strip();

/**
 * ⚠️ THE NOTE IS REQUIRED. A dismissal answers a person who swore a statement, and a decision with
 * no recorded reason cannot be reviewed by the next moderator.
 */
export const DismissBlueprintRightsClaimSchema = z
  .object({
    resolutionNote: z
      .string()
      .trim()
      .min(1, "Say why this claim is being dismissed.")
      .max(2000, "Keep the note under 2,000 characters."),
  })
  .strict();
