/**
 * Request schemas for compensation, extracted from compensation.controller.ts.
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

/**
 * Money in, as a decimal STRING rather than a JS number.
 *
 * `z.number()` would silently lose precision past 2^53 and, worse, would accept `120.5`
 * for a value that must be a whole number of cents.
 */
export const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

/**
 * THE AGREEMENT BODY. Exactly one basis — a flat monthly retainer OR an hourly rate.
 *
 * NO `currencyCode`. §4b: "there is no `currency` field in any request body — it is
 * derived from the round/project". A client-chosen currency would let a $6,000 retainer
 * be re-read as ¥6,000.
 *
 * NO `status`, NO `acceptedAt`, NO `acceptedByUserId`. The lifecycle is server-owned and
 * a founder marking their own proposal accepted is the founder fiat this exists to remove.
 */
export const ProposeCompensationAgreementSchema = z
  .object({
    engagementKind: z.enum(["employee", "independent_contractor", "unpaid_founder"]),
    monthlyAmountInCents: CentsStringSchema.optional(),
    hourlyRateCentsPerHour: CentsStringSchema.optional(),
    effectiveFrom: z.iso.datetime(),
    rationaleNote: z.string().trim().min(1).max(1_000),
  })
  .strict()
  // The CHECK constraint says the same thing, but failing here returns a 422 naming the
  // field rather than surfacing a constraint violation as a 500.
  .refine(
    (body) =>
      (body.monthlyAmountInCents === undefined) !== (body.hourlyRateCentsPerHour === undefined),
    {
      message: "Set exactly one of monthlyAmountInCents or hourlyRateCentsPerHour.",
      path: ["monthlyAmountInCents"],
    },
  );

/**
 * THE FINALIZE BODY. A typed acknowledgement and NOTHING ELSE.
 *
 * §17 step 4 asks what happens when a client edits an amount and posts it back. Here the
 * answer is that there is no amount: the statement is recomputed from the member's own
 * accepted agreement and their own recorded minutes, in the same transaction that freezes
 * it. The acknowledgement exists so an accidental double-click cannot reach the freeze.
 */
/**
 * `POST …/compensation-agreements/:agreementId/decline` (§11j.3) — the member's refusal.
 *
 * The note is OPTIONAL: a member who does not want to explain why they turned down an offer
 * should not be forced to, and the refusal itself is the signal the founder needs. Parsed
 * from `optionalBody(req)`, because body-parser leaves `req.body` undefined on a bodyless
 * POST and Express 5 does not default it to `{}`.
 *
 * There is NO column for this note — it survives only as `project_audit_entry.detailNote`.
 */
export const DeclineAgreementSchema = z
  .object({ note: z.string().trim().min(1).max(1_000).optional() })
  .strict();

/**
 * `POST …/compensation-agreements/:agreementId/withdraw` (§11j.3) — the founder's retraction.
 *
 * `reasonNote` is REQUIRED, mirroring `SupersedePeriodSchema` field for field: retracting an
 * offer somebody is deciding about, with no stated basis, is founder fiat with extra steps.
 */
export const WithdrawAgreementSchema = z
  .object({ reasonNote: z.string().trim().min(1).max(2_000) })
  .strict();

export const FinalizePeriodSchema = z.object({ acknowledgement: z.string() }).strict();

export const CountersignPeriodSchema = z
  .object({ note: z.string().trim().min(1).max(1_000).optional() })
  .strict();

export const SupersedePeriodSchema = z
  .object({ reasonNote: z.string().trim().min(1).max(2_000) })
  .strict();

/**
 * THE PAYMENT BODY. An ATTESTATION about a payment made somewhere else.
 *
 * `paidAmountInCents` is deliberately NOT validated against the line's gross: a partial
 * payment is a fact, and forcing them equal would make the record lie about what happened.
 *
 * `referenceNote` is a human note — a UTR, a payroll run id. Its VALUE is checked in the
 * service for anything shaped like a PAN or an IBAN, because this domain stores no payment
 * instruments and the key list alone would not stop someone pasting one here.
 */
export const RecordPaymentSchema = z
  .object({
    paidAmountInCents: CentsStringSchema,
    paidOnDate: IsoDateSchema,
    methodKey: z.enum([
      "bank_transfer",
      "sepa_transfer",
      "upi",
      "payroll_provider",
      "cash",
      "other",
    ]),
    referenceNote: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const AgreementQuerySchema = z
  .object({ memberId: z.string().trim().min(1).optional() })
  .strict();

export const PeriodListQuerySchema = z
  .object({
    status: z.enum(["open", "finalized", "superseded"]).optional(),
    limit: z.coerce.number().int().min(1).max(120).optional(),
    beforeSequenceNumber: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const ExportQuerySchema = z.object({ format: z.enum(["csv", "json"]).optional() }).strict();

/**
 * `GET /governance/summary` — aggregates, mechanics, and the caller's own lines.
 *
 * `attachOptionalUser`, NOT `requireAuth`, and that is deliberate: this page states the
 * three §7A.6 copy rules publicly, so it has to render for a signed-out visitor. What it
 * renders for them is aggregates and disclosure keys with an empty `callerOpenLines` — not
 * a fabricated example and not somebody else's row.
 *
 * NOTHING HERE NAMES A PERSON. The projection carries no member id, no user id, no name
 * and no per-member amount. The single exception is the caller's own lines, which reach
 * the response only through their own `project_member` rows.
 *
 * READ-ONLY. There is no finalize, countersign, payment or export on this router; each is
 * actor-scoped and stays where the actor's role is already resolved.
 */
export const GovernanceSummaryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
