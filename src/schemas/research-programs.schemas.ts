/**
 * Request schemas for research-programs, extracted from research-programs.controller.ts.
 *
 * WHY THESE ARE NOT IN THE CONTROLLER. They were the larger half of it — the handlers
 * did not begin until the file was already hundreds of lines deep — and they have a
 * second consumer that a controller cannot serve: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these schemas, and importing a controller to reach one
 * drags in its whole service and db graph.
 *
 * NOTHING ABOUT THE PARSE BOUNDARY MOVED. The controller imports these and every handler
 * still runs `safeParse` before any service call, returning 422 on failure
 * (CLAUDE.md §3.1). Types come from `z.infer` here, so a service takes its input type
 * from the schema rather than importing it back out of a controller.
 */
import { z } from "zod";

/** Offset pagination, bounded. Matches the shape every other R&D list query uses. */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Keyset pagination. `cursor` is decoded in the controller so a bad one is a 422. */
export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().trim().min(1).max(200).optional(),
});

/** `YYYY-MM-DD`, the §1 wire format. Never a `Date`, which a zone would shift. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

/**
 * Client-minted, once per attempt. 8–128 characters mirrors the DB CHECK, and the length
 * floor is what stops a caller from sending `"1"` and colliding with everyone else's `"1"`.
 */
export const IdempotencyKeySchema = z.string().trim().min(8).max(128);

/**
 * `status` is ABSENT, and that absence is the review gate. A user-minted program always
 * lands `pending`; `.strict()` turns an attempt to add the key into a 422 rather than
 * letting one field bypass moderation. Same construction as `CreateCategorySchema`.
 */
export const CreateProgramSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    tagline: z.string().trim().min(3).max(200),
    missionStatement: z.string().trim().min(20).max(4000),
  })
  .strict();

/** No `status`, and no `slug` — a published slug has been linked and cited. */
export const UpdateProgramSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    tagline: z.string().trim().min(3).max(200).optional(),
    missionStatement: z.string().trim().min(20).max(4000).optional(),
  })
  .strict();

/**
 * The reviewer's note is REQUIRED, on both decisions. "No" without a reason is not a
 * review, and the note is the only thing the person who submitted will see.
 */
export const ModerateProgramSchema = z
  .object({
    decision: z.enum(["published", "rejected"]),
    reviewerNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const ListProgramsQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().min(1).max(120).optional(),
}).strict();

/**
 * `status`, `overlappingGroupCount`, `ancestorPath` and `siblingOrder` are all absent.
 * The first two are job-derived (§10 rule 1) and the last two are computed from the tree.
 */
export const CreateBranchSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(10).max(2000),
    parentBranchId: z.string().trim().min(1).max(64).nullable().default(null),
  })
  .strict();

/**
 * `siblingOrder` IS accepted here, unlike on create — reordering is an explicit,
 * deliberate act, whereas on create it would just be a client racing other clients.
 *
 * The two pinned per-mille values are the curator override §10 allows. `.nullable()` so a
 * curator can clear a pin and hand the node back to the client's tidy layout.
 */
export const UpdateBranchSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    summary: z.string().trim().min(10).max(2000).optional(),
    parentBranchId: z.string().trim().min(1).max(64).nullable().optional(),
    siblingOrder: z.coerce.number().int().min(0).max(10_000).optional(),
    pinnedLeftPermille: z.coerce.number().int().min(0).max(1000).nullable().optional(),
    pinnedTopPermille: z.coerce.number().int().min(0).max(1000).nullable().optional(),
  })
  .strict();

/**
 * Every file fact is absent — size, hash and storage key are MEASURED from the bytes, and
 * `moderationStatus` is a reviewer's verdict.
 *
 * `doi` is loosely shaped here and normalized in the service, because the value people
 * paste is `https://doi.org/10.1234/abc` at least as often as the bare form.
 */
export const CreatePaperSchema = z
  .object({
    title: z.string().trim().min(3).max(300),
    categoryId: z.string().trim().min(1).max(64),
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
    doi: z.string().trim().min(3).max(200).nullable().default(null),
    authorAffiliation: z.string().trim().min(1).max(200).nullable().default(null),
    abstractText: z.string().trim().min(1).max(5000).nullable().default(null),
  })
  .strict();

/**
 * The multipart route's body. There is deliberately NOTHING in it beyond the idempotency
 * key: the file is the payload and every fact about it is measured server-side.
 */
export const AttachPaperFileSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();

export const ModeratePaperSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "needs_changes"]),
    reviewerNote: z.string().trim().min(1).max(2000),
    // Moderator-supplied, and capped to match the DB CHECK.
    flagReasons: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  })
  .strict();

export const ListPapersQuerySchema = CursorQuerySchema.extend({
  categoryId: z.string().trim().min(1).max(64).optional(),
  branchId: z.string().trim().min(1).max(64).optional(),
  moderationStatus: z.enum(["queued", "approved", "rejected", "needs_changes"]).optional(),
}).strict();

export const CreatePaperCategorySchema = z
  .object({ label: z.string().trim().min(2).max(80) })
  .strict();

export const ListPaperCategoriesQuerySchema = z
  .object({ status: z.enum(["approved", "pending", "rejected"]).default("approved") })
  .strict();

/**
 * A discriminated union, mirroring §6's `DecideCategorySchema`: a rejection REQUIRES a note and
 * an approval does not, which one flat object with an optional note could not express.
 *
 * No `pinIconKey` arm — that column belongs to the project taxonomy's problem map, and the
 * paper taxonomy has no equivalent.
 */
export const DecidePaperCategorySchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      note: z.string().trim().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      note: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

/**
 * `depth`, `parentPostId`, `reactionCount`, `replyCount` and `isHidden` are all absent.
 * A reply goes through `POST …/replies`, where the parent is a path parameter — so a
 * client cannot mint a reply at an arbitrary depth by choosing its own parent field.
 */
export const CreatePostSchema = z
  .object({
    track: z.enum(["informal_paper", "idea"]),
    title: z.string().trim().min(3).max(200).nullable().default(null),
    bodyText: z.string().trim().min(1).max(10_000),
    /**
     * Which branch this thread is about. NULL for a program-wide one.
     *
     * Accepted on a top-level post only — a REPLY inherits its parent's, which is why
     * `CreateReplySchema` has no such field. Letting a reply re-file itself would move half a
     * conversation to another branch.
     */
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
  })
  .strict()
  // The CHECK enforces the same rule; refusing it here names the field instead of the
  // constraint, and turns a would-be 500 into an actionable 422.
  .refine((body) => (body.track === "informal_paper" ? body.title !== null : body.title === null), {
    message: "An informal paper needs a title; an idea must not have one.",
    path: ["title"],
  });

export const CreateReplySchema = z
  .object({ bodyText: z.string().trim().min(1).max(10_000) })
  .strict();

export const ReportContentSchema = z
  .object({
    reason: z.enum(["spam", "plagiarism", "misinformation", "harassment", "off_topic", "other"]),
    detailText: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

export const ModeratePostSchema = z
  .object({
    decision: z.enum(["hidden", "restored"]),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();

export const DismissReportSchema = z
  .object({ reasonNote: z.string().trim().min(1).max(2000) })
  .strict();

export const ListPostsQuerySchema = CursorQuerySchema.extend({
  track: z.enum(["informal_paper", "idea"]).default("idea"),
}).strict();

export const PARTICIPANT_ROLES = [
  "researcher",
  "founder_director",
  "venture_capitalist",
  "supplier",
  "supporter",
] as const;

/** `snake_case`, because these are Postgres `pgEnum` labels sent verbatim (§ wire casing). */
export const COMPENSATION_PREFERENCES = ["salary", "one_time", "equity"] as const;

export const JoinProgramSchema = z
  .object({
    role: z.enum(PARTICIPANT_ROLES),
    compensationPreference: z.enum(COMPENSATION_PREFERENCES),
    contributionSummary: z.string().trim().min(1).max(500).nullable().default(null),
    fundingTrancheIndex: z.coerce.number().int().min(1).max(100).nullable().default(null),
    fundingTrancheTotal: z.coerce.number().int().min(1).max(100).nullable().default(null),
  })
  .strict();

export const UpdateParticipationSchema = z
  .object({
    role: z.enum(PARTICIPANT_ROLES).optional(),
    compensationPreference: z.enum(COMPENSATION_PREFERENCES).optional(),
    contributionSummary: z.string().trim().min(1).max(500).nullable().optional(),
    fundingTrancheIndex: z.coerce.number().int().min(1).max(100).nullable().optional(),
    fundingTrancheTotal: z.coerce.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();

export const LogEffortSchema = z
  .object({
    // 1440 is one day. The CHECK says the same; this makes it a 422 with a field name.
    minutes: z.coerce.number().int().min(1).max(1440),
    branchId: z.string().trim().min(1).max(64).nullable().default(null),
    loggedForDate: IsoDateSchema,
    note: z.string().trim().min(1).max(2000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export const RecordContributionSchema = z
  .object({
    kind: z.enum(["cash_commitment", "material", "data", "equipment", "expertise"]),
    /**
     * A DECIMAL STRING, not a number — the convention every money body in this codebase
     * follows (`CentsStringSchema`). A JS number cannot carry a bigint cent amount safely,
     * and `estimatedMarketSizeInCents`-scale values are exactly why the column is bigint.
     */
    amountInCents: z
      .string()
      .regex(/^\d{1,15}$/)
      .nullable()
      .default(null),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    description: z.string().trim().min(1).max(1000),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export const CreateOpportunitySchema = z
  .object({
    productName: z.string().trim().min(3).max(200),
    productDescription: z.string().trim().min(10).max(2000),
    derivedFromBranchId: z.string().trim().min(1).max(64),
    /** bigint cents as a decimal string — "$12B" is 1200000000000, 560× the int4 ceiling. */
    estimatedMarketSizeInCents: z.string().regex(/^\d{1,15}$/),
    readinessMinMonths: z.coerce.number().int().min(0).max(600),
    readinessMaxMonths: z.coerce.number().int().min(0).max(600),
  })
  .strict();

export const ListParticipantsQuerySchema = PageQuerySchema.extend({
  role: z.enum(PARTICIPANT_ROLES).optional(),
}).strict();
