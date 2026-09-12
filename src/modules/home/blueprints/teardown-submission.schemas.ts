import { z } from "zod";

import { TEARDOWN_ATTESTATION_CLAUSE_IDS } from "#src/db/schema/home.js";
import {
  AssetUrlSchema,
  createAssetUrlSchema,
  createExternalUrlSchema,
} from "#src/modules/home/blueprints/blueprint-url.schemas.js";
import {
  CompositionElementSchema,
  MaterialSchema,
  ProvenanceSchema,
  TEARDOWN_DOCUMENT_KINDS,
  TEARDOWN_MANUFACTURING_FILE_KINDS,
} from "#src/modules/home/blueprints/teardown-import.schemas.js";

/**
 * The gate for `POST /blueprints/teardowns` — what the authoring wizard is allowed to send.
 *
 * ⚠️ A DIFFERENT SHAPE FROM `TeardownImportSchema`, NOT A SUBSET OF IT, and the difference is the
 * point. The import schema is the SEED's gate: a whole published teardown, ids and byte sizes and
 * geometry included, written by someone with a fixture file. This is a PERSON's gate: five wizard
 * steps, no ids, no sizes, no geometry, no slug. Five fields diverge and each one answers something
 * the database would otherwise have refused at 3am inside a transaction.
 *
 * `ProvenanceSchema` and the composition rules are REUSED WHOLE, so the three-arm permission truth
 * table and the instrument-versus-method rule are enforced here for free and cannot drift.
 */

/**
 * The version stamped on every document this file writes.
 *
 * A submission written today is read by a publish weeks later, against whatever this schema has
 * become. The reader's `unparseable` arm handles the failure; this number decides WHICH schema to
 * try. Bump it when a stored shape changes, and keep the old parser beside the new one.
 */
export const TEARDOWN_SUBMISSION_DOCUMENT_SCHEMA_VERSION = 1;

/**
 * ⚠️ 512, NOT 2048, AND HTTPS ONLY — two tightenings the read path does not need.
 *
 * `createExternalUrlSchema` refuses the site-relative branch that `AssetUrlSchema` allows. That
 * branch exists for values this server minted; a link a stranger pasted is external by definition,
 * and accepting `/blueprints/teardowns/x/claim-targets` as a "datasheet" would let an author file
 * this API's own responses as their evidence.
 *
 * The length is the body budget's biggest lever, and the precedent is already in
 * `blueprint-url.schemas.ts`: case-study sources cap at 512 for exactly this reason, and a URL
 * longer than that is a tracking-parameter-laden mess rather than a citation.
 */
const SubmittedFileUrlSchema = createExternalUrlSchema(512);

/**
 * One file a submission points at. NO `id` and NO `byteSize`: the wire carries neither.
 *
 * ⚠️ `kind` ACCEPTS BOTH VOCABULARIES, AND THAT IS A BUG BEING ABSORBED RATHER THAN A DESIGN.
 * The frontend serves `documents[]` and `manufacturingFiles[]` from ONE schema whose `kind` is the
 * manufacturing-file enum, and its composer defaults both lists to `"step"` — so today every
 * `documents[]` row arrives carrying a label `teardown_document.kind` cannot store.
 *
 * The three ways out were: refuse the whole array with a 422 (breaks a step that ships today);
 * translate `step` into `datasheet` (the platform deciding what somebody's file is, unrecoverably,
 * at write time); or accept both vocabularies and let the PUBLISH route by which set the label
 * belongs to. The third keeps the author's word intact, needs no frontend release to start working,
 * and needs no backend release when that release lands.
 */
const SubmittedFileSchema = z
  .object({
    kind: z.enum([...TEARDOWN_DOCUMENT_KINDS, ...TEARDOWN_MANUFACTURING_FILE_KINDS]),
    title: z.string().min(1).max(200),
    url: SubmittedFileUrlSchema,
  })
  .strict();

export type SubmittedTeardownFile = z.infer<typeof SubmittedFileSchema>;

/** True when a file's `kind` belongs to the reader's vocabulary rather than the fab's. */
export function isTeardownDocumentKind(
  kind: SubmittedTeardownFile["kind"],
): kind is (typeof TEARDOWN_DOCUMENT_KINDS)[number] {
  return TEARDOWN_DOCUMENT_KINDS.some((documentKind) => documentKind === kind);
}

/**
 * A material, minus the two fields a submitter may not decide.
 *
 * `id` is omitted because `teardown_material.id` is a GLOBAL primary key with no default — the
 * wizard sends `"mat-1"`, and the second author ever to submit two materials would collide with the
 * first. The server mints them.
 *
 * `partId` is `z.null()` rather than `.nullable()` because a submission has no assembly, so
 * `teardown_material_part_fk`'s two hops can never resolve. A literal says that in the type; a
 * `.nullable()` would say it in a comment and refuse it in a transaction.
 */
const SubmittedMaterialSchema = MaterialSchema.omit({ id: true }).extend({
  partId: z.null(),
  elements: z.array(CompositionElementSchema).max(8),
});

/** One listed part. Two fields, because that is everything the wizard's parts step collects. */
const SubmittedPartSchema = z
  .object({
    label: z.string().min(1).max(120),
    material: z.string().min(1).max(120),
  })
  .strict();

/**
 * The walkthrough link.
 *
 * ⚠️ `posterUrl` IS ACCEPTED AND THEN DISCARDED. The client derives it from the video id, so
 * storing what it sent would let an author point an `<img>` rendered under this site's chrome at any
 * https host. The service recomputes it from `youtubeVideoId`, which is what the id pattern is
 * there to make safe. CLAUDE.md §1.1: re-derive anything that gates a state transition.
 */
const SubmittedWalkthroughVideoSchema = z
  .object({
    source: z.literal("youtube"),
    youtubeVideoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "That is not a YouTube video id."),
    posterUrl: AssetUrlSchema,
    durationSeconds: z.number().int().positive().nullable(),
  })
  .strict();

/**
 * Every array is capped, and the caps are derived rather than chosen.
 *
 * The frontend's draft schema bounds none of these. An unbounded array converts to an unbounded
 * body estimate, and `json-body-budget.test.ts` then lets the route through on the full 128 KB while
 * the parser 413s a real submission with nothing in the schema to explain why. These numbers are
 * what keeps the worst case under the declared cap; `teardown-submission.schemas.test.ts` is what
 * keeps them honest.
 */
export const TeardownSubmissionSchema = z
  .object({
    /** The enum's other label, `proposed_design`, is refused by `teardown_subject_kind_ck`. */
    subjectKind: z.literal("existing_physical_product"),
    title: z.string().min(8).max(160),
    summary: z.string().min(40).max(2000),
    provenance: ProvenanceSchema,
    materials: z.array(SubmittedMaterialSchema).max(8),
    parts: z.array(SubmittedPartSchema).max(40),
    documents: z.array(SubmittedFileSchema).max(8),
    manufacturingFiles: z.array(SubmittedFileSchema).max(8),
    walkthroughVideo: SubmittedWalkthroughVideoSchema.nullable(),
    /** Twelve, matching `teardown_tags_ck` — the cap the destination column already carries. */
    tags: z.array(z.string().min(1).max(40)).max(12),
    acceptedAttestationClauseIds: z.array(z.enum(TEARDOWN_ATTESTATION_CLAUSE_IDS)),
  })
  .strict()
  /**
   * ⚠️ RE-CHECKED SERVER-SIDE, NOT TRUSTED FROM THE FORM. The wizard refuses to submit without all
   * four ticks, and that refusal is a courtesy to an honest author — it is not a control. Anyone can
   * post this body directly. An attestation nobody verified is an attestation nobody gave.
   */
  .superRefine((submission, context) => {
    const acceptedClauseIds = new Set(submission.acceptedAttestationClauseIds);
    const outstandingClauseIds = TEARDOWN_ATTESTATION_CLAUSE_IDS.filter(
      (clauseId) => !acceptedClauseIds.has(clauseId),
    );

    if (outstandingClauseIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["acceptedAttestationClauseIds"],
        message: `Every statement must be accepted. Still outstanding: ${outstandingClauseIds.join(", ")}.`,
      });
    }
  })
  /**
   * A survey dated in the future is either a typo or a claim about a unit nobody has opened yet.
   * The `showcase_launch` arm refuses a future launch date for the same reason.
   */
  .superRefine((submission, context) => {
    if (Date.parse(submission.provenance.surveyedAt) > Date.now()) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "surveyedAt"],
        message: "A survey cannot be dated in the future.",
      });
    }
  });

export type TeardownSubmissionInput = z.infer<typeof TeardownSubmissionSchema>;

/**
 * What `teardown_submission.document_json` holds: the WHOLE parsed submission, `title` and
 * `subjectProductName` included.
 *
 * ⚠️ SO TWO COLUMNS RESTATE TWO DOCUMENT FIELDS, and that is a deliberate cost rather than an
 * oversight. The alternative — storing the document with those keys removed — means the stored bytes
 * are no longer what the author sent, so the row stops being evidence of the submission and a
 * `documents[]` dispute has nothing to appeal to. The duplication is safe here for one reason that
 * must stay true: **a submission is immutable after submit.** Nothing updates `title` or
 * `subject_product_name`, so the column and the document cannot drift apart. The moment an edit
 * route exists, it writes both from one parse or this comment becomes a bug.
 *
 * The reader is the authority in any case: the publish path parses this document and copies the
 * teardown's title from it, never from the promoted column.
 */
export const TeardownSubmissionDocumentSchema = TeardownSubmissionSchema;
export type TeardownSubmissionDocument = TeardownSubmissionInput;

export const TEARDOWN_MODERATOR_NOTE_MAXIMUM_CHARACTERS = 2000;

/** The review queue pages; it offers no filter. Mirrors `CaseStudyCursorPageQuerySchema`. */
export const TeardownReviewQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strip();

/** The author's own list takes no parameters at all — it is one server-capped array. */
export const MyTeardownsQuerySchema = z.object({}).strip();

/**
 * A moderator's decision on one submission.
 *
 * ⚠️ PUBLISHING CARRIES TWO FIELDS THE AUTHOR NEVER SENT, and the line between what a moderator may
 * supply and what they may not is the whole reason this shape is not symmetric. `thumbnailUrl` and
 * `difficulty` are EDITORIAL JUDGEMENTS ABOUT THE WRITE-UP, formed by reading it — the same kind of
 * decision as the public slug every other blueprint arm already asks a moderator to mint. A part's
 * `manufacturingMethod`, a node name or a `.glb` are FACTS ABOUT THE PHYSICAL UNIT, and a moderator
 * who never held it would be fabricating them. So this asks for the first two and will never ask for
 * the others.
 *
 * ⚠️ A SEND-BACK MUST SAY WHY. There is no edit-and-resubmit flow, so the note is the author's
 * entire remedy: they read it, survey again, and submit afresh. A rejection nobody can act on is a
 * dead end wearing a refusal's clothes.
 */
export const TeardownModerationDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("published"),
      moderatorNote: z.string().max(TEARDOWN_MODERATOR_NOTE_MAXIMUM_CHARACTERS).nullable(),
      /**
       * 512, NOT 2048, AND THE NUMBER IS DERIVED. This body also carries a 2,000-character note, and
       * `json-body-budget.test.ts` counts four bytes per character: at 2,048 the worst case is
       * 16,906 bytes against `compactBody`'s 16,384, so the route would 413 a decision its own
       * schema accepts. The alternative was moving a five-field decision to the 128 KB tier.
       */
      thumbnailUrl: createAssetUrlSchema(512),
      difficulty: z.enum(["beginner", "intermediate", "advanced"]),
      /**
       * The address, if the moderator wants to choose it. `null` derives one from the title.
       *
       * Shape-checked here and reserved-word-checked at mint time, where the fallback lives — a
       * refusal at this layer would be a 422 on a field the moderator can simply leave blank.
       */
      desiredSlug: z
        .string()
        .min(3)
        .max(120)
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "An address is lowercase, digits and single hyphens.")
        .nullable(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("rejected"),
      moderatorNote: z
        .string()
        .min(1, "Sending back needs a note. It is the only thing the author sees.")
        .max(TEARDOWN_MODERATOR_NOTE_MAXIMUM_CHARACTERS),
    })
    .strict(),
]);

export type TeardownModerationDecisionInput = z.infer<typeof TeardownModerationDecisionSchema>;
