/**
 * Request schemas for §11m.
 *
 * EVERY OBJECT IS `.strict()`. A body is attacker-controlled, and an unknown key that
 * parses is a key somebody can put a server-owned value in — so the rejected-key test
 * beside this file drives `feasibilityScorePoints`, `rank`, `asOf`, `modelName` and
 * `confidenceBps` through every write body and asserts all of them 422.
 *
 * NOTHING HERE ACCEPTS A SCORE, A RANK OR A TRADE FIGURE. Those are computed by
 * `localization-feasibility-score.ts` from Comtrade rows and are never client-supplied
 * (§6: a ranking signal is an attack surface). There is deliberately no write schema for
 * `import_commodity` or `commodity_trade_flow` at all — the ingest is their only author.
 */
import { z } from "zod";

/** Kebab-case, matching every other slug on this surface. */
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/**
 * Six digits, and NOT a slug. An HS code is issued by the World Customs Organization; the
 * kebab-case rule governs identifiers this platform mints.
 */
export const HsCodeSchema = z.string().regex(/^[0-9]{6}$/);

/** ISO-3166 alpha-2, uppercase — the shape `discovery_region.country_code` stores. */
const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const IMPORT_COMMODITY_KINDS = [
  "agricultural_product",
  "food_product",
  "mineral_ceramic",
  "energy_fuel",
  "chemical",
  "pharmaceutical",
  "plastic_rubber",
  "wood_paper",
  "textile_leather",
  "precious_material",
  "metal",
  "machinery",
  "electronic_subassembly",
  "transport_equipment",
  "precision_instrument",
  "other_manufactured",
] as const;

export const TRADE_FLOW_KINDS = ["import", "export"] as const;

export const DOMESTIC_SUBSTITUTE_KINDS = [
  "direct_material_substitute",
  "alternative_material",
  "domestic_component",
  "process_change",
] as const;

export const DOMESTIC_SUBSTITUTE_MATURITIES = [
  "lab_scale",
  "pilot_scale",
  "commercial",
  "mature",
] as const;

/**
 * Page bounds match `ListSuppliersQuerySchema` exactly. A shared ceiling is what stops one
 * surface becoming the cheap way to pull the whole catalogue.
 */
const PageSchema = z.coerce.number().int().min(1).max(500).default(1);
const LimitSchema = z.coerce.number().int().min(1).max(50).default(20);

export const ListImportCommoditiesQuerySchema = z
  .object({
    commodityKind: z.enum(IMPORT_COMMODITY_KINDS).optional(),
    categoryId: z.string().trim().min(1).max(80).optional(),
    reporterCountryCode: CountryCodeSchema.optional(),
    // Matched against the label and the HS code. Bounded because an unbounded LIKE over
    // 5,000 rows is a cheap way to make the database work hard.
    search: z.string().trim().min(1).max(120).optional(),
    page: PageSchema,
    limit: LimitSchema,
  })
  .strict();

export const ListTradeFlowsQuerySchema = z
  .object({
    flowKind: z.enum(TRADE_FLOW_KINDS).optional(),
    reporterCountryCode: CountryCodeSchema.optional(),
    page: PageSchema,
    limit: LimitSchema,
  })
  .strict();

export const ListSubstitutesQuerySchema = z
  .object({
    regionCountryCode: CountryCodeSchema.optional(),
    page: PageSchema,
    limit: LimitSchema,
  })
  .strict();

export const ListLocalizationAssessmentsQuerySchema = z
  .object({
    reporterCountryCode: CountryCodeSchema.optional(),
    commodityKind: z.enum(IMPORT_COMMODITY_KINDS).optional(),
    page: PageSchema,
    limit: LimitSchema,
  })
  .strict();

/**
 * Creating a substitute mapping.
 *
 * `isPublished` rather than `publishedAt`: the CLIENT says whether it should be visible
 * and the SERVER stamps when. A client-supplied timestamp is a client-supplied fact about
 * when a moderator acted.
 *
 * Max lengths match the column CHECKs exactly, so an over-long value is a 422 from the
 * schema rather than a 500 from Postgres.
 */
export const CreateDomesticSubstituteSchema = z
  .object({
    hsCode: HsCodeSchema,
    regionSlug: SlugSchema,
    substituteKind: z.enum(DOMESTIC_SUBSTITUTE_KINDS),
    substituteLabel: z.string().trim().min(1).max(200),
    substituteNotes: z.string().trim().min(1).max(4000).optional(),
    supplierCapabilitySlug: SlugSchema.optional(),
    maturityLevel: z.enum(DOMESTIC_SUBSTITUTE_MATURITIES),
    evidenceSourceName: z.string().trim().min(1).max(200).optional(),
    evidenceSourceUrl: z.url().max(2000).optional(),
    isPublished: z.boolean().default(false),
  })
  .strict();

/**
 * Updating one.
 *
 * `.nullable().optional()` throughout, which is the repo's way of telling "clear this
 * field" (null) apart from "leave it alone" (absent) — two different intentions that a
 * plain `.optional()` collapses into one.
 *
 * `hsCode` and `regionSlug` are ABSENT rather than optional: moving a mapping to a
 * different commodity or country is deleting one and creating another, and allowing it
 * here would silently invalidate every assessment that counted the original.
 */
export const UpdateDomesticSubstituteSchema = z
  .object({
    substituteKind: z.enum(DOMESTIC_SUBSTITUTE_KINDS).optional(),
    substituteLabel: z.string().trim().min(1).max(200).optional(),
    substituteNotes: z.string().trim().min(1).max(4000).nullable().optional(),
    supplierCapabilitySlug: SlugSchema.nullable().optional(),
    maturityLevel: z.enum(DOMESTIC_SUBSTITUTE_MATURITIES).optional(),
    evidenceSourceName: z.string().trim().min(1).max(200).nullable().optional(),
    evidenceSourceUrl: z.url().max(2000).nullable().optional(),
    isPublished: z.boolean().optional(),
  })
  .strict();

/**
 * Accepting or dismissing an AI pathway suggestion.
 *
 * ADVISORY ONLY — the decision moves no score, no rank and no row's arithmetic. It records
 * that a human read a machine opinion and what they thought of it, which is the whole
 * point of the provenance columns beside it.
 */
export const DecidePathwaySuggestionSchema = z
  .object({
    decision: z.enum(["accepted", "dismissed"]),
    decisionNote: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type ListImportCommoditiesQuery = z.infer<typeof ListImportCommoditiesQuerySchema>;
export type ListTradeFlowsQuery = z.infer<typeof ListTradeFlowsQuerySchema>;
export type ListSubstitutesQuery = z.infer<typeof ListSubstitutesQuerySchema>;
export type ListLocalizationAssessmentsQuery = z.infer<
  typeof ListLocalizationAssessmentsQuerySchema
>;
export type CreateDomesticSubstituteInput = z.infer<typeof CreateDomesticSubstituteSchema>;
export type UpdateDomesticSubstituteInput = z.infer<typeof UpdateDomesticSubstituteSchema>;
export type DecidePathwaySuggestionInput = z.infer<typeof DecidePathwaySuggestionSchema>;
