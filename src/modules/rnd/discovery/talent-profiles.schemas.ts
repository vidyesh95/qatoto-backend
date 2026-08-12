/**
 * Request schemas for talent-profiles, extracted from talent-profiles.controller.ts.
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

export const TALENT_AVAILABILITIES = ["open_to_work", "open_to_offers", "unavailable"] as const;

export const ROLE_COMMITMENTS = ["full_time", "part_time", "hobby"] as const;

export const TALENT_SORTS = ["recent", "effort"] as const;

/** Bounds every money field well inside int4 while still allowing a large ask. */
export const MAXIMUM_MONEY_IN_CENTS = 2_000_000_000;

/**
 * The applicant-side mirror of §5's CompensationStrandSchema — a DISCRIMINATED UNION on
 * `kind`, so an equity ask carrying a salary range is a parse error rather than a row a
 * CHECK constraint has to reject (CLAUDE.md §3.2).
 *
 * `currency` is ABSENT from every branch (§4b: no currency field in any request body — it
 * is server-owned on talent_profile, the same shape as product.currency). `earnedAsPolicy`
 * is absent too: an ASK does not get to name a payout mechanism. That belongs to the OFFER
 * side, because the escrow engine honours offers, not wishes.
 */
export const TalentCompensationAskSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("salary"),
      salaryMinInCentsPerMonth: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS),
      salaryMaxInCentsPerMonth: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("one_time"),
      oneTimeMinInCents: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS),
      oneTimeMaxInCents: z.number().int().min(0).max(MAXIMUM_MONEY_IN_CENTS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("equity"),
      // An ASK, never a grant. Grants come solely from §9's ledger, and there is no
      // writable equity column anywhere in this schema.
      equityBasisPointsMin: z.number().int().min(0).max(10_000),
      equityBasisPointsMax: z.number().int().min(0).max(10_000).optional(),
    })
    .strict(),
]);

/**
 * PUT, not PATCH: the profile is a value object the owner replaces wholesale, which is the
 * only way "remove my equity ask" and "clear my location" are expressible.
 *
 * ABSENT BY CONSTRUCTION: `userId` (§13 — the row is keyed on req.user.id), `name`,
 * `avatarImageUrl`, `handle` (a PROJECTION of `user`; a copy drifts the moment someone
 * changes their photo), `isPublished` (a separate explicit action, so a listing can never
 * appear as a side effect of an edit), `currency` (server-owned), `verifiedEffortMinutes`
 * (§9's job owns it — §13: no body carries an hour count), and `isVerified` on a skill.
 */
export const TalentProfileSchema = z
  .object({
    headlineRole: z.string().trim().min(2).max(120),
    availability: z.enum(TALENT_AVAILABILITIES),
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    locationLabel: z.string().trim().max(120).nullable().optional(),
    regionId: z.uuid().nullable().optional(),
    bio: z.string().trim().max(2_000).nullable().optional(),
    // Canonical `discovery_skill` slugs, validated as a SUBSET server-side so an unknown
    // slug is a typed 422 naming the offenders and never silently creates taxonomy.
    skillSlugs: z.array(z.string().trim().min(1).max(60)).max(25).default([]),
    compensationAsks: z.array(TalentCompensationAskSchema).max(3).default([]),
  })
  .strict();

export type TalentProfileInput = z.infer<typeof TalentProfileSchema>;

export const ListTalentQuerySchema = z
  .object({
    commitment: z.enum(ROLE_COMMITMENTS).optional(),
    /**
     * Repeatable: `?skill=water-quality&skill=firmware`. Multiple values are ANDed, which
     * is what a row of filter chips means.
     */
    skill: z
      .union([z.string().trim().min(1).max(60), z.array(z.string().trim().min(1).max(60)).max(10)])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    availability: z.enum(TALENT_AVAILABILITIES).optional(),
    region: z.string().trim().min(1).max(60).optional(),
    sort: z.enum(TALENT_SORTS).default("recent"),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
