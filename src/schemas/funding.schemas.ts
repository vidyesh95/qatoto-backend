/**
 * Request schemas for funding, extracted from funding.controller.ts.
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
 * for a value that must be a whole number of cents. 15 digits caps a single request at
 * ~$10 trillion, which is above any real round and below the point where a typo becomes a
 * denial-of-service on the `bigint` arithmetic downstream.
 */
export const CentsStringSchema = z
  .string()
  .regex(/^\d{1,15}$/, "Must be a whole number of cents, as a string");

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date (YYYY-MM-DD)");

export const PaginationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const CreateFundingRoundSchema = z
  .object({
    type: z.enum(["crowdfunding", "equity", "venture"]),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(2_000).optional(),
    goalAmountInCents: CentsStringSchema,
    minimumPledgeInCents: CentsStringSchema.optional(),
    maximumPledgeInCents: CentsStringSchema.optional(),
    opensAt: z.iso.datetime().optional(),
    closesAt: z.iso.datetime().optional(),
  })
  .strict();

/**
 * THE PLEDGE BODY. `{ amountInCents }` and nothing else — §7's own words.
 *
 * Every other figure a client might send is derived server-side from the round, and every
 * one of §7's 27 rejected keys is absent from this object, so `.strict()` answers 422.
 */
/**
 * `PATCH /funding-rounds/:roundId` (§11j.3) — a draft correction, nothing more.
 *
 * `type` IS ABSENT and stays absent: the enabled-types gate is re-checked at open, and a
 * round that could change type after creation would sidestep it. `currency`,
 * `raisedAmountInCents`, `backersCount`, `status` and `closedAt` are absent because all
 * five are server-owned — `.strict()` turns any of them into a 422.
 *
 * A `"0"` goal parses here and is refused by the SERVICE: `CentsStringSchema` bounds the
 * shape, not the value, and `funding_round_goal_ck` is what the number has to satisfy.
 */
export const UpdateFundingRoundSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(2_000).nullable().optional(),
    goalAmountInCents: CentsStringSchema.optional(),
    minimumPledgeInCents: CentsStringSchema.optional(),
    maximumPledgeInCents: CentsStringSchema.nullable().optional(),
    opensAt: z.iso.datetime().nullable().optional(),
    closesAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const CreatePledgeSchema = z.object({ amountInCents: CentsStringSchema }).strict();

export const MilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5_000).optional(),
    plannedPayoutInCents: CentsStringSchema,
    dueDate: IsoDateSchema.optional(),
  })
  .strict();

/**
 * `status` is deliberately ABSENT. It moves through `/complete`, which writes `completedAt`
 * in the same statement — a PATCH that could set `done` without a completion instant would
 * produce a milestone an escrow release could be approved against with no record of when
 * the work finished.
 */
export const UpdateMilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    plannedPayoutInCents: CentsStringSchema.optional(),
    dueDate: IsoDateSchema.nullable().optional(),
  })
  .strict();

/** Six typed integers (§15). `varianceBasisPoints` is absent — the server computes it. */
export const MilestoneVarianceSchema = z
  .object({
    plannedDurationDays: z.number().int().min(0).max(100_000),
    actualDurationDays: z.number().int().min(0).max(100_000),
    plannedCostInCents: CentsStringSchema,
    actualCostInCents: CentsStringSchema,
    plannedEffortMinutes: z.number().int().min(0).max(100_000_000),
    actualEffortMinutes: z.number().int().min(0).max(100_000_000),
  })
  .strict();

export const DealsQuerySchema = z
  .object({
    roundType: z.enum(["crowdfunding", "equity", "venture"]).optional(),
    stage: z
      .enum([
        "market_research",
        "problem_validation",
        "team_building",
        "building_mvp",
        "raising_funding",
        "go_to_market",
      ])
      .optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
