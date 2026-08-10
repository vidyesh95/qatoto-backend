import { z } from "zod";

/**
 * Boundary contracts for the manufacturer directory (STORE_BACKEND_STRUCTURE.md §16).
 *
 * EVERY FILTER KEY SHIPS WITH THE ENDPOINT. §16.4 is explicit that a subset is not a
 * degradation but a defect: `.strict()` answers **422** for an unrecognized key rather
 * than ignoring it, so a frontend sending a documented filter the backend never built does
 * not lose one facet — it loses the whole read. `providers.schemas.ts` documents at length
 * what that cost, after seven filters were specified there and one was built.
 *
 * Enum values are snake_case on the wire in both directions; query KEYS are camelCase.
 */

export const FACTORY_CAPABILITY_KINDS = [
  "oem",
  "odm",
  "customization",
  "in_house_inspection",
  "in_house_rnd",
  "sample_production",
  "contract_manufacturing",
  "private_label",
  "tooling_and_moulds",
  "assembly",
] as const;

export const FACTORY_CERTIFICATION_CODES = [
  "iso_9001",
  "iso_14001",
  "bsci",
  "sedex_smeta",
  "gots",
  "fsc",
  "ce_marking",
  "fda_registered",
] as const;

export const FactoryCapabilityKindSchema = z.enum(FACTORY_CAPABILITY_KINDS);
export const FactoryCertificationCodeSchema = z.enum(FACTORY_CERTIFICATION_CODES);

export const ListFactoriesQuerySchema = z
  .object({
    capabilityKind: FactoryCapabilityKindSchema.optional(),
    /** Uppercase ISO 3166-1 alpha-2, matching how the column stores it. */
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, "countryCode must be an uppercase ISO 3166-1 alpha-2 code.")
      .optional(),
    certification: FactoryCertificationCodeSchema.optional(),
    /**
     * An UPPER BOUND on the factory's own MOQ — "show me factories that will take an order
     * this small". A factory that declared no minimum SATISFIES it, which is the A25 NULL
     * rule applied here: excluding them would hide the shops most likely to say yes.
     */
    maxMinimumOrderQuantity: z.coerce.number().int().min(1).max(100_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ListFactoriesQuery = z.infer<typeof ListFactoriesQuerySchema>;

export const FactorySlugParamsSchema = z
  .object({
    factorySlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be kebab-case."),
  })
  .strict();

/**
 * What a buyer sends to open a conversation with a factory (§16.5).
 *
 * OPTIONAL FIELDS ARE OMITTED, NEVER SENT AS `0`, `""` OR `null`. `0` for a blank target
 * unit price asks the factory to work for free, and an empty unit label makes a quantity
 * unreadable. The pairs below are refused half-filled at this boundary, which is where
 * `pg-errors.ts` says cross-field invariants belong — the DB CHECK is defense-in-depth.
 *
 * `capabilityKind` IS REQUIRED. It is the one field that decides whether this inquiry is
 * answerable at all: a buyer who needs tooling and writes to an assembly-only shop should
 * find that out from the form, not from silence three weeks later.
 */
export const CreateManufacturingInquirySchema = z
  .object({
    capabilityKind: FactoryCapabilityKindSchema,
    productDescription: z.string().trim().min(1).max(5000),
    estimatedAnnualQuantity: z.number().int().positive().max(1_000_000_000).optional(),
    unitLabel: z.string().trim().min(1).max(40).optional(),
    targetUnitPriceInCents: z.number().int().positive().max(1_000_000_000_000).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "currency must be an uppercase ISO 4217 code.")
      .optional(),
    requiredCertifications: z.array(FactoryCertificationCodeSchema).max(8).optional(),
    /** A calendar date. A buyer wants delivery "by 30 June", not at an instant. */
    desiredFirstDeliveryAt: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "desiredFirstDeliveryAt must be a YYYY-MM-DD date.")
      .optional(),
    notes: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.estimatedAnnualQuantity === undefined) !== (value.unitLabel === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["unitLabel"],
        message:
          "estimatedAnnualQuantity and unitLabel are both-or-neither: a quantity with no unit cannot be compared against a line.",
      });
    }
    if ((value.targetUnitPriceInCents === undefined) !== (value.currency === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message:
          "targetUnitPriceInCents and currency are both-or-neither: a price with no currency is not a price.",
      });
    }
  });

export type CreateManufacturingInquiryInput = z.infer<typeof CreateManufacturingInquirySchema>;

export const InquiryIdParamsSchema = z
  .object({
    inquiryId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListManufacturingInquiriesQuerySchema = z
  .object({
    state: z.enum(["draft", "sent", "answered", "closed"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ListManufacturingInquiriesQuery = z.infer<
  typeof ListManufacturingInquiriesQuerySchema
>;

// ---------------------------------------------------------------------------
// Seller-owned writes (§16.3)
// ---------------------------------------------------------------------------

export const ReplaceProductionLinesSchema = z
  .object({
    productionLines: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            processSummary: z.string().trim().min(1).max(2000),
            monthlyCapacityUnits: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
            /** Required even when the capacity is withheld — see the schema comment. */
            unitLabel: z.string().trim().min(1).max(40),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const ReplaceOrganizationSitesSchema = z
  .object({
    sites: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            countryCode: z
              .string()
              .trim()
              .regex(/^[A-Z]{2}$/, "countryCode must be an uppercase ISO 3166-1 alpha-2 code."),
            locality: z.string().trim().min(1).max(200).nullable().optional(),
            floorAreaSquareMetres: z.number().int().min(0).max(100_000_000).nullable().optional(),
            productionStaffCount: z.number().int().min(0).max(10_000_000).nullable().optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

/**
 * The factory's commercial terms, as a WHOLE OBJECT.
 *
 * Not part of the seller-profile PATCH, because both invariants here are cross-field and a
 * partial patch could not validate either without first reading the stored row.
 *
 * `sampleFeeInCents: null` MEANS UNSTATED AND `0` MEANS FREE. The schema accepts both and
 * the projection keeps them apart; the one thing this surface must never do is render the
 * first as the second.
 */
export const ReplaceFactoryTermsSchema = z
  .object({
    offersSamples: z.boolean(),
    sampleLeadTimeDays: z.number().int().min(0).max(3650).nullable(),
    sampleFeeInCents: z.number().int().min(0).max(1_000_000_000_000).nullable(),
    sampleCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "sampleCurrency must be an uppercase ISO 4217 code."),
    minimumOrderQuantity: z.number().int().positive().max(1_000_000_000).nullable(),
    minimumOrderQuantityUnitLabel: z.string().trim().min(1).max(40).nullable(),
    minimumLeadTimeDays: z.number().int().min(0).max(3650).nullable(),
    maximumLeadTimeDays: z.number().int().min(0).max(3650).nullable(),
    acceptingInquiries: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.minimumOrderQuantity === null) !== (value.minimumOrderQuantityUnitLabel === null)) {
      context.addIssue({
        code: "custom",
        path: ["minimumOrderQuantityUnitLabel"],
        message:
          "minimumOrderQuantity and its unit label are both-or-neither: 500 pieces and 500 cartons are different businesses.",
      });
    }
    if (
      value.minimumLeadTimeDays !== null &&
      value.maximumLeadTimeDays !== null &&
      value.minimumLeadTimeDays > value.maximumLeadTimeDays
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumLeadTimeDays"],
        message: "maximumLeadTimeDays must not be shorter than minimumLeadTimeDays.",
      });
    }
    if (
      !value.offersSamples &&
      (value.sampleLeadTimeDays !== null || value.sampleFeeInCents !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["offersSamples"],
        message:
          "A sample lead time or fee cannot be declared by a profile that does not offer samples.",
      });
    }
  });

export type ReplaceFactoryTermsInput = z.infer<typeof ReplaceFactoryTermsSchema>;

// ---------------------------------------------------------------------------
// Staff site audits (§16.2, conflict 3)
// ---------------------------------------------------------------------------

export const RecordSiteAuditSchema = z
  .object({
    auditedAt: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "auditedAt must be a YYYY-MM-DD date."),
    auditorName: z.string().trim().min(1).max(200),
    auditorOrganizationName: z.string().trim().min(1).max(200).nullable().optional(),
    scopeSummary: z.string().trim().min(1).max(2000),
    /** Ids are verified against the organization, never trusted — see the service. */
    siteIds: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  })
  .strict();

/**
 * A withdrawal MUST carry its reason. This is the platform retracting a claim it
 * published, and "why" is the entire content of that act.
 */
export const WithdrawSiteAuditSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export const AuditIdParamsSchema = z
  .object({
    auditId: z.string().trim().min(1).max(200),
  })
  .strict();

export const OrganizationIdParamsSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(200),
  })
  .strict();
