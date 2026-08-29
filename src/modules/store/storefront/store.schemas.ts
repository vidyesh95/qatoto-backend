/**
 * Request schemas for store, extracted from store.controller.ts.
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

export const CursorPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const CategoriesQuerySchema = z
  .object({
    parentCategoryId: z.string().trim().min(1).max(200).optional(),
    /**
     * The store home rail's eight. Bounded so a client cannot turn a public read into a
     * full-table scan, and applied in SQL so the admin's `siblingOrder` decides which
     * eight rather than whichever eight the browser kept.
     */
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const CategoryParamsSchema = z.object({ slug: z.string().trim().min(1).max(100) }).strict();

export const ProductParamsSchema = z
  .object({ productSlug: z.string().trim().min(1).max(120) })
  .strict();

/** §21.3. `GET /store/products/:productSlug/documents/:documentId/file`. */
export const ProductDocumentFileParamsSchema = ProductParamsSchema.extend({
  documentId: z.string().trim().min(1).max(200),
}).strict();

export const OrganizationParamsSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();

export const PathwayParamsSchema = z
  .object({ pathwaySlug: z.string().trim().min(1).max(100) })
  .strict();

export const RailParamsSchema = z.object({ railSlug: z.string().trim().min(1).max(100) }).strict();

export const OfferingParamsSchema = z
  .object({ offeringSlug: z.string().trim().min(1).max(120) })
  .strict();

export const SearchQuerySchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sellerCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    providerKind: z
      .enum([
        "freight_forwarder",
        "logistics_operator",
        "customs_broker",
        "insurance_provider",
        "inspection_agency",
        "testing_certification_lab",
        "marketing_agency",
        "warehouse_provider",
        "foreign_exchange_facilitator",
      ])
      .optional(),
    // A25. `organization` is the supplier directory — the same public-eligibility rule
    // products answer to, so a buyer can browse sellers the way they already can
    // service providers.
    documentKind: z.enum(["product", "provider_offering", "organization"]).optional(),
    minOrderQuantityMax: z.coerce.number().int().min(0).max(1_000_000).optional(),
    /**
     * A25. The filters matching the facets `getCategoryFacets` already computes, plus
     * lead time, condition and verification state.
     *
     * A facet the backend publishes and the search cannot filter on is an invitation to
     * filter the fetched page, which is what §2.4 forbids. The counts were already the
     * honest denominator; only the WHERE clause was missing.
     */
    priceMinInCents: z.coerce.number().int().min(0).optional(),
    priceMaxInCents: z.coerce.number().int().min(0).optional(),
    stockState: z.enum(["in_stock", "low_stock", "made_to_order", "unavailable"]).optional(),
    samplePolicy: z.enum(["unavailable", "paid", "refundable"]).optional(),
    condition: z.enum(["new", "refurbished", "used"]).optional(),
    /**
     * §21.2. OMITTING THIS IS NOT THE SAME AS NOT FILTERING. An absent `sellingState`
     * excludes `discontinued`; naming one narrows to exactly that state. A buyer looking for
     * a dead part asks for it explicitly, and everyone else is spared listings that cannot
     * be bought.
     */
    sellingState: z.enum(["selling", "paused", "discontinued"]).optional(),
    /**
     * §20.5. ATTRIBUTE FILTERS, as two bounded repeatable keys rather than one key per attribute.
     *
     * ⚠️ THIS SCHEMA IS `.strict()`, so `?voltage=5v` is a 422 that kills the WHOLE read — not an
     * ignored parameter. That is the trap A25 recorded for the seven undeclared facet filters,
     * and it is why an open-ended attribute vocabulary cannot travel as its own query keys.
     *
     * `attribute=<key>:<choice>` — repeatable. OR within one key, AND across keys.
     * `attributeRange=<key>:<minScaled>:<maxScaled>` — repeatable, integers already multiplied by
     * the definition's `numericScale`, so no decimal is ever parsed off a query string.
     *
     * The caps are the point rather than decoration: an unbounded array of `EXISTS` subqueries is
     * a query-cost hole a crawler finds on its first pass.
     */
    attribute: z
      .union([z.string(), z.array(z.string())])
      .transform((raw) => (Array.isArray(raw) ? raw : [raw]))
      .pipe(z.array(z.string().regex(/^[a-z0-9_]{1,64}:[a-z0-9_]{1,64}$/)).max(6))
      .optional(),
    attributeRange: z
      .union([z.string(), z.array(z.string())])
      .transform((raw) => (Array.isArray(raw) ? raw : [raw]))
      .pipe(z.array(z.string().regex(/^[a-z0-9_]{1,64}:-?\d{1,15}:-?\d{1,15}$/)).max(4))
      .optional(),
    verificationState: z
      .enum(["unverified", "documents_pending", "verified", "rejected", "suspended"])
      .optional(),
    leadTimeMaxDays: z.coerce.number().int().min(0).max(3650).optional(),
    // `discovery` is Phase 13's ranked sort. Deliberately a SEPARATE value rather than a
    // blend: relevance never reads the ranking score and discovery never reads ts_rank_cd.
    sort: z.enum(["relevance", "discovery"]).optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * `GET /store/providers` — the directory's whole filter surface.
 *
 * IT ACCEPTED THREE KEYS AND THE FRONTEND DOCUMENTED EIGHT, which under `.strict()` meant sending
 * one of the missing seven was a **422 that killed the entire read**, not an ignored parameter.
 * `providers.schemas.ts` called them "a backend ask, not a frontend build"; this is that ask.
 *
 * EVERY ONE FILTERS OVER A COLUMN THAT ALREADY EXISTED — no migration. The per-kind detail tables
 * are keyed by OFFERING, not by organization, so each of these is an EXISTS over the organization's
 * `active` offerings rather than a join that would multiply rows per card.
 *
 * ⚠️ `verificationState` HERE IS THE PROFILE'S, not a kind's. A13 keeps those apart deliberately —
 * profile-level means "we checked this company exists", per-kind means "we approved them for this
 * service" — and a query key that blurred them would let the UI present one as the other.
 */
export const ProvidersQuerySchema = z
  .object({
    providerKind: z
      .enum([
        "freight_forwarder",
        "logistics_operator",
        "customs_broker",
        "insurance_provider",
        "inspection_agency",
        "testing_certification_lab",
        "marketing_agency",
        "warehouse_provider",
        "foreign_exchange_facilitator",
      ])
      .optional(),
    /** ISO 3166-1 alpha-2, matching `commerce_service_coverage`'s own spelling. */
    originCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    destinationCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    transportMode: z.enum(["air", "sea", "land", "rail", "multimodal"]).optional(),
    /** Free text on the wire because `jurisdictions` is a free-text array, not an enum. */
    jurisdiction: z.string().trim().min(1).max(80).optional(),
    standard: z.string().trim().min(1).max(120).optional(),
    storageType: z.string().trim().min(1).max(80).optional(),
    /** `USD/INR` — matched against `currency_pairs`, which stores the pair as one string. */
    currencyPair: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}\/[A-Z]{3}$/)
      .optional(),
    acceptingRequests: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * GET /store/products/:productSlug/companions (§15.7).
 *
 * Grouped by `relationKind`, each companion carrying `sourceKind` so a client can
 * never render a seller's compatibility claim as a verified one (§15.3).
 */
export const DeliveryEstimateQuerySchema = z
  .object({
    destinationCountryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 country code."),
    quantity: z.coerce.number().int().min(1).max(1_000_000).default(1),
  })
  .strict();
