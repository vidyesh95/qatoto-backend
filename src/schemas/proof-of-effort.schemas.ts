/**
 * Request schemas for proof-of-effort, extracted from proof-of-effort.controller.ts.
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

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * Money in, as a decimal STRING rather than a JS number.
 *
 * A rate is a `bigint` cent value; `z.number()` would silently lose precision past 2^53
 * and, worse, would accept `120.5` for a value that must be an integer number of cents.
 */
export const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

export const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * The ledger and the audit trail take a KEYSET cursor as well as a page (§11l.2 item 4).
 *
 * `page` is retained because the frontend calls both reads today and this tranche is
 * additive by rule; `fromSequence` is the mode a new caller should use. Both are optional
 * and `fromSequence` wins, because a caller sending a cursor has decided which mode it is
 * in.
 */
export const SequencePaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    fromSequence: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const ProposeRateSchema = z
  .object({
    fairMarketRateCentsPerHour: CentsStringSchema,
    // Zero for the unpaid founder case, which is most of them. Required rather than
    // optional: §9.2 calls the missing paid portion the largest correctness gap in the
    // mock, and a defaulted field is one a founder never has to think about.
    paidCashRateCentsPerHour: CentsStringSchema,
    effectiveFrom: z.iso.datetime(),
    rationaleNote: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const LockRateSchema = z.object({ rateId: z.uuid(), acknowledgement: z.string() }).strict();

export const SubmitClaimSchema = z
  .object({
    sourceKind: z.enum(["daily_log", "physical_receipt"]),
    dailyLogId: z.uuid().optional(),
    physicalReceiptIds: z.array(z.uuid()).max(20).default([]),
    claimedForDate: IsoDateSchema,
    narrative: z.string().trim().max(1_000).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();

export const ReverifySchema = z.object({ reason: z.string().trim().min(1).max(1_000) }).strict();

export const OverrideStepSchema = z
  .object({
    // `pending` is absent: an override that un-decides a step would leave the verdict
    // permanently incomplete, and the CHECK constraint rejects it anyway.
    overriddenStatus: z.enum(["passed", "flagged", "failed", "skipped"]),
    overrideReason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const RaiseDisputeSchema = z
  .object({ disputeNote: z.string().trim().min(1).max(2_000) })
  .strict();

export const CastVoteSchema = z
  .object({
    position: z.enum(["uphold", "void", "re_verify"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const ResolveDisputeSchema = z
  .object({
    resolution: z.enum(["upheld", "voided", "re_verified"]),
    resolutionNote: z.string().trim().min(1).max(2_000),
    // A WINDOW, never a quantity (§9.12 option (a)).
    scopedWindowStartsAt: z.iso.datetime().optional(),
    scopedWindowEndsAt: z.iso.datetime().optional(),
  })
  .strict();

export const AuditTrailQuerySchema = z
  .object({
    fromSequence: z.coerce.number().int().min(1).optional(),
    toSequence: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * `cursor` is the keyset form (§11l.2 item 4) and WINS over `page` when both arrive. `page`
 * stays only for back-compat: offset paging drifts under concurrent inserts, so a client that
 * has adopted the cursor must not be silently dropped back onto the old behaviour.
 */
export const ProposalListQuerySchema = z
  .object({
    status: z.enum(["open", "disputed", "locked", "consensus_reached"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * `GET …/disputes` (§11j.2). The three values are `disputeStatusEnum` verbatim.
 *
 * `page`/`limit` carry DEFAULTS here, unlike the schema above, because these two lists
 * answer with a `PaginatedResponse` and the envelope's `pagination` block has to state the
 * page it actually served — which means the controller, not the service, must know it.
 */
export const DisputeListQuerySchema = z
  .object({
    status: z.enum(["open", "withdrawn", "consensus_reached"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** `GET …/effort-claims` (§11j.2). The six values are `effortVerificationStatusEnum`. */
/**
 * No `page`, deliberately. A review queue is worked from the front; a page-2 control on it
 * invites a reviewer to browse a backlog rather than clear it, and every row here is equity
 * that is not being minted while it waits.
 */
export const OverrideQueueQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export const EffortClaimListQuerySchema = z
  .object({
    status: z
      .enum(["not_run", "queued", "running", "verified", "flagged_for_review", "unverified"])
      .optional(),
    // The PUBLIC user id, matching `…/members/:memberUserId/fair-market-rate`. There is no
    // `memberId` key and no `projectId` key: the project comes from the path, and the
    // internal member id is not a thing a client should be holding.
    memberUserId: z.string().trim().min(1).max(64).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // Keyset mode (§11l.2 item 4). Wins over `page`, and swaps the `pagination` block for a
    // `nextCursor` — see `listEffortClaims` for why the two cannot both be honest at once.
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const UploadReceiptSchema = z
  .object({
    receiptKind: z.enum(["photo_of_work", "cad_file", "material_receipt", "other"]),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();

export const CreateSuggestionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    bodyText: z.string().trim().min(1).max(4_000),
    memberId: z.uuid().optional(),
    evidenceLabels: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  })
  .strict();

export const DecideSuggestionSchema = z
  .object({ note: z.string().trim().max(2_000).optional() })
  .strict();

export const AuthorizeIntegrationSchema = z
  .object({
    // The narrowed scope the member consents to. Empty is legal and means "connect the
    // account but read nothing yet" — §9.10's default-to-narrowest rule.
    requestedResourceIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .strict();

/**
 * `valuationCents` IS ACCEPTED, AND IT IS NOT AN EXCEPTION TO §0.
 *
 * §0 forbids a body carrying a value the SERVER owns. A priced round's valuation is agreed
 * with an investor outside this system and is unknowable to it — and, decisively, NO FORMULA
 * READS IT. It is stored, put in the audit payload, and returned; it never enters
 * `computeSlicesAwarded`, never touches a numerator, and cannot move a basis point. It is
 * recorded EVIDENCE about why the pie was baked, in the same category as
 * `triggerEvidenceNote` beside it.
 */
export const BakePieSchema = z
  .object({
    trigger: z.enum(["cash_flow_breakeven", "priced_round"]),
    triggerEvidenceNote: z.string().trim().min(1).max(2_000),
    // Money as a decimal STRING; a valuation in cents is far past 2^53 for any real round.
    valuationCents: z
      .string()
      .regex(/^\d{1,18}$/, "Must be a whole number of cents, as a string")
      .optional(),
    acknowledgement: z.string(),
    expectedSnapshotId: z.uuid(),
  })
  .strict();

export const IntegrationProviderSchema = z.enum(["github", "gitlab", "figma", "jira", "linear"]);

export const IntegrationCallbackQuerySchema = z
  .object({ code: z.string().min(1), state: z.string().min(1) })
  .strict();
