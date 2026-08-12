/**
 * Request schemas for commerce-settlement, extracted from commerce-settlement.controller.ts.
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

export const EmptyObjectSchema = z.object({}).strict();

export const IdentifierSchema = z.string().trim().min(1).max(200);

export const ThreadIdParamsSchema = z.object({ threadId: IdentifierSchema }).strict();

export const AgreementIdParamsSchema = z.object({ agreementId: IdentifierSchema }).strict();

export const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Currency must be an ISO-4217 alpha-3 code");

/**
 * A milestone plan is capped at twenty. An escrow with a hundred tranches is not a payment
 * schedule anyone administers; it is a way to make a release queue unreviewable.
 */
export const MilestoneSchema = z
  .object({
    sequence: z.number().int().positive().max(20),
    milestoneKind: z.enum(["deposit", "shipment", "inspection", "delivery", "final"]),
    amountInCents: z.number().int().positive(),
    releaseConditionNote: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

export const ProposeAgreementBodySchema = z
  .object({
    buyerOrganizationId: IdentifierSchema,
    sellerOrganizationId: IdentifierSchema,
    externalProviderId: IdentifierSchema,
    escrowFeeBearer: z.enum(["buyer", "seller", "split"]),
    currency: CurrencySchema,
    totalInCents: z.number().int().positive(),
    expiresAt: z.coerce.date(),
    milestones: z.array(MilestoneSchema).min(1).max(20),
  })
  .strict();

export const RespondBodySchema = z
  .object({ response: z.enum(["accept", "decline", "withdraw"]) })
  .strict();

export const EligibleProvidersQuerySchema = z
  .object({
    buyerCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/),
    sellerCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/),
    currency: CurrencySchema,
    totalInCents: z.coerce.number().int().positive(),
  })
  .strict();
