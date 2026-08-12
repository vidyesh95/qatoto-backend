/**
 * Request schemas for commerce-seller-profile, extracted from commerce-seller-profile.controller.ts.
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

export const OrganizationIdSchema = z
  .object({ organizationId: z.string().trim().min(1).max(200) })
  .strict();

export const MediaParamsSchema = OrganizationIdSchema.extend({
  mediaId: z.string().uuid(),
}).strict();

export const StakeholderParamsSchema = OrganizationIdSchema.extend({
  stakeholderId: z.string().uuid(),
}).strict();

export const CertificationParamsSchema = z.object({ certificationId: z.string().uuid() }).strict();

/**
 * Hand-written mirrors of the pgEnums, and they must be widened WITH the enum. A value
 * added to the database and forgotten here is rejected at the boundary and nobody can ever
 * create one — the failure mode the address-kind schema documents from Phase 11.
 */
export const BusinessTypeSchema = z.enum([
  "manufacturer",
  "trading_company",
  "manufacturer_trading",
  "agent",
  "distributor",
]);

export const VisitPolicySchema = z.enum(["welcome", "by_appointment", "not_available"]);

export const MediaKindSchema = z.enum([
  "factory",
  "office",
  "warehouse",
  "production_line",
  "showcase",
]);

export const SiteAccessModeSchema = z.enum(["road", "sea", "air", "rail"]);

export const CapabilityKindSchema = z.enum([
  "oem",
  "odm",
  "customization",
  "in_house_inspection",
  "in_house_rnd",
  "sample_production",
]);

/**
 * `year_founded BETWEEN 1800 AND 2100` in the database stops a typo; THIS stops a claim
 * about the future. The CHECK cannot express it, because `now()` is not IMMUTABLE and
 * Postgres refuses it in a constraint — so the real rule lives here, where a clock is
 * readable.
 */
export const YearFoundedSchema = z
  .number()
  .int()
  .min(1800)
  .refine(
    (year) => year <= new Date().getUTCFullYear(),
    "A founding year cannot be in the future.",
  );

export const nonNegativeCount = z.number().int().min(0).max(10_000_000);

export const UpsertSellerProfileSchema = z
  .object({
    yearFounded: YearFoundedSchema.nullable().optional(),
    factoryCount: nonNegativeCount.nullable().optional(),
    totalStaffCount: nonNegativeCount.nullable().optional(),
    productionLineCount: nonNegativeCount.nullable().optional(),
    factoryAreaSquareMetres: nonNegativeCount.nullable().optional(),
    businessType: BusinessTypeSchema.nullable().optional(),
    visitPolicy: VisitPolicySchema.nullable().optional(),
    acceptingCustomOrders: z.boolean().optional(),
    publicSummary: z.string().trim().max(4000).nullable().optional(),
    declaredResponseTimeHours: z.number().int().min(0).max(8760).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const ReplaceSiteAccessSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            accessMode: SiteAccessModeSchema,
            facilityName: z.string().trim().min(1).max(200),
            distanceKm: z.number().int().min(0).max(40_000).nullable().optional(),
            notes: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const ReplaceStakeholdersSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            /**
             * Echo back the id of a stakeholder you are keeping so their uploaded
             * portrait survives an edit. A HINT, NOT A GRANT — honoured only when the id
             * already belongs to this organization.
             */
            id: z.string().trim().min(1).max(200).optional(),
            fullName: z.string().trim().min(1).max(200),
            roleTitle: z.string().trim().min(1).max(200),
            /**
             * `photoUrl` was here and migration `0091` removed it. Upload to
             * POST /commerce/organizations/:organizationId/stakeholders/:stakeholderId/photo
             * so the platform holds the bytes — a portrait's EXIF carries the named
             * person's coordinates, and a hotlink can never have them stripped.
             */
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const ReplaceCapabilitiesSchema = z
  .object({
    rows: z
      .array(
        z
          .object({
            capabilityKind: CapabilityKindSchema,
            detail: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

export const ReorderOrganizationMediaSchema = z
  .object({ mediaIdsInOrder: z.array(z.string().uuid()).min(1).max(12) })
  .strict();

/** Multipart text fields arrive as strings, so this schema coerces rather than expects. */
export const AddOrganizationMediaSchema = z
  .object({
    mediaKind: MediaKindSchema,
    altText: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD).");

export const SubmitCertificationSchema = z
  .object({
    standardName: z.string().trim().min(1).max(200),
    issuerName: z.string().trim().min(1).max(200),
    certificateNumber: z.string().trim().min(1).max(120),
    scopeSummary: z.string().trim().min(1).max(2000).optional(),
    validFrom: IsoDateSchema,
    validUntil: IsoDateSchema,
  })
  .strict()
  .refine(
    (certification) => certification.validUntil > certification.validFrom,
    "validUntil must be after validFrom.",
  );

export const DecideCertificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }).strict(),
  z
    .object({
      kind: z.literal("reject"),
      decisionReason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
