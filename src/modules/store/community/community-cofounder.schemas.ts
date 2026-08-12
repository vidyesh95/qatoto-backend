import { z } from "zod";

/**
 * Boundary contracts for the cofounder directory (STORE_BACKEND_STRUCTURE.md §18).
 *
 * THE CAPITAL FIELDS ARE ABSENT FROM THE WRITE SCHEMA, AND `.strict()` MAKES SENDING ONE A
 * 422. That is deliberate rather than an oversight, and it is the honest of the two
 * options: §14 has not decided whether Qatoto may publish a self-declared capital range
 * beside an equity expectation, so the backend stores no such figure — and silently
 * DISCARDING a number somebody typed about themselves is worse than refusing it, because
 * the author would believe it had been recorded.
 *
 * The READ contract keeps both fields and serves `null`, so the frontend's shipped schemas
 * parse unchanged. Only the composer needs an edit.
 */

export const COFOUNDER_CONTRIBUTION_KINDS = [
  "capital",
  "expertise",
  "influence",
  "operations",
] as const;

export const COFOUNDER_COMMITMENT_LEVELS = ["full_time", "part_time", "advisory"] as const;

export const COFOUNDER_ENGAGEMENT_STATES = [
  "open_to_intros",
  "in_conversation",
  "not_looking",
] as const;

export const CofounderContributionKindSchema = z.enum(COFOUNDER_CONTRIBUTION_KINDS);
export const CofounderCommitmentLevelSchema = z.enum(COFOUNDER_COMMITMENT_LEVELS);

/**
 * NO `sort` KEY AND NO `state` KEY, and both absences are rules.
 *
 * A ranking on this surface could read as a platform recommendation about a person (§18.1
 * rule 2), and `not_looking` profiles stay in the list because a profile is also a record —
 * hiding one makes somebody mid-conversation look as though they had left.
 */
export const ListCofounderProfilesQuerySchema = z
  .object({
    contributionKind: CofounderContributionKindSchema.optional(),
    commitmentLevel: CofounderCommitmentLevelSchema.optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "countryCode must be an uppercase ISO 3166-1 alpha-2 code.")
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const CofounderProfileSlugParamsSchema = z
  .object({
    profileSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be kebab-case."),
  })
  .strict();

export const CofounderProfileIdParamsSchema = z
  .object({
    profileId: z.string().trim().min(1).max(200),
  })
  .strict();

const PriorVentureSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    roleLabel: z.string().trim().min(1).max(120),
    yearsActiveLabel: z.string().trim().min(1).max(40),
    /**
     * NULLABLE AND IT STAYS NULLABLE. Plenty of ventures have no tidy outcome, and a form
     * that requires one invites people to invent one.
     */
    outcomeSummary: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();

/**
 * Your own profile. THE VIEWER POSTS ABOUT THEMSELVES — there is no `userId` here and no
 * route by which one person lists another.
 *
 * `contributionKinds` is non-empty: it is the thing a founder is actually short of, and a
 * profile that claims none of the four answers the directory's only real question with
 * silence.
 */
export const WriteCofounderProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    headline: z.string().trim().min(8).max(200),
    bio: z.string().trim().min(20).max(5000),
    lookingFor: z.string().trim().min(8).max(2000),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "countryCode must be an uppercase ISO 3166-1 alpha-2 code."),
    avatarUrl: z.string().trim().url().max(2048).startsWith("https://").nullable().optional(),
    commitmentLevel: CofounderCommitmentLevelSchema,
    contributionKinds: z.array(CofounderContributionKindSchema).min(1).max(4),
    /** Free text: the long tail is the whole point. Normalized lowercase by the service. */
    sectors: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
    languages: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z]{2}$/, "Use ISO 639-1 codes, lowercase."),
      )
      .max(8)
      .optional(),
    priorVentures: z.array(PriorVentureSchema).max(8).optional(),
  })
  .strict();

export type WriteCofounderProfileInput = z.infer<typeof WriteCofounderProfileSchema>;

/**
 * The one edit a PUBLISHED profile may make without re-entering moderation, which is why it
 * is its own route and its own single-field schema.
 */
export const SetEngagementStateSchema = z
  .object({
    engagementState: z.enum(COFOUNDER_ENGAGEMENT_STATES),
  })
  .strict();

export const ListCofounderQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** Every decision carries a reason, including a publish — the queue's log is read by peers. */
export const ModerateCofounderProfileSchema = z
  .object({
    decision: z.enum(["publish", "reject"]),
    reasonNote: z.string().trim().min(1).max(2000),
  })
  .strict();
