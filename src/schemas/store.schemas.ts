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
