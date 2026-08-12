/**
 * Request schemas for commerce-organizations, extracted from commerce-organizations.controller.ts.
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

export const CommerceOrganizationIdSchema = z.string().trim().min(1).max(200);

export const OrganizationIdSchema = z
  .object({ organizationId: CommerceOrganizationIdSchema })
  .strict();

export const MemberParamsSchema = OrganizationIdSchema.extend({
  memberId: z.string().uuid(),
}).strict();

export const AddressParamsSchema = OrganizationIdSchema.extend({
  addressId: z.string().uuid(),
}).strict();

export const VerificationParamsSchema = OrganizationIdSchema.extend({
  verificationId: z.string().uuid(),
}).strict();

export const DocumentParamsSchema = OrganizationIdSchema.extend({
  documentId: z.string().uuid(),
}).strict();

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const OrganizationTypeSchema = z.enum([
  "company",
  "sole_proprietor",
  "cooperative",
  "government",
  "nonprofit",
]);

export const MemberRoleSchema = z.enum([
  "administrator",
  "buyer",
  "seller",
  "provider_operator",
  "finance",
  "support",
  "viewer",
]);

/**
 * A hand-written mirror of `commerceOrganizationAddressKindEnum`. It must be widened
 * with the pgEnum or a newly added kind is rejected at the boundary and nobody can
 * create one — which is exactly how `delivery` would have gone unusable in Phase 11.
 */
export const AddressKindSchema = z.enum([
  "billing",
  "registered",
  "warehouse",
  "pickup",
  "return",
  "delivery",
]);

export const nullableHttpsUrl = z
  .url()
  .refine((url) => url.startsWith("https://"))
  .nullable();

export const CreateCommerceOrganizationSchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    legalName: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000).optional(),
    organizationType: OrganizationTypeSchema,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    registrationNumber: z.string().trim().min(1).max(200).optional(),
    taxIdentifier: z.string().trim().min(1).max(200).optional(),
    websiteUrl: z
      .url()
      .refine((url) => url.startsWith("https://"))
      .optional(),
  })
  .strict();

export const UpdateCommerceOrganizationSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).nullable().optional(),
    websiteUrl: nullableHttpsUrl.optional(),
    /**
     * `logoUrl` was here and migration `0091` removed it. The logo is now uploaded to
     * POST /commerce/organizations/:organizationId/logo so the platform holds the bytes
     * it renders; a seller-supplied URL meant EXIF was never stripped and the image
     * behind an approved storefront could be swapped at will. `.strict()` turns a client
     * still sending it into a loud 422 rather than a silently ignored field.
     */
    visibility: z.enum(["private", "public"]).optional(),
    /**
     * A37. Added in Phase 21, and without it an auto-provisioned buyer shell is a dead end:
     * it is minted with no country (§14), `commerce_organization_country_pending_ck` will
     * not let it reach `active` without one, and no other route could set it.
     *
     * NOT NULLABLE, unlike `summary`. A shell may never have declared a country; an
     * organization that has declared one may not un-declare it, because the row may already
     * be trading and the CHECK would refuse the write anyway.
     */
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const CreateCommerceOrganizationMemberSchema = z
  .object({ userId: z.string().min(1).max(200), role: MemberRoleSchema })
  .strict();

export const UpdateCommerceOrganizationMemberSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    state: z.enum(["active", "suspended", "left"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.")
  .refine(
    (patch) => !(patch.role !== undefined && patch.state !== undefined),
    "Change a member role and state in separate requests so each transition is audited.",
  );

export const AddressFieldsSchema = z.object({
  addressKind: AddressKindSchema,
  label: z.string().trim().min(1).max(100).nullable().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  regionCode: z.string().trim().min(1).max(100).nullable().optional(),
  locality: z.string().trim().min(1).max(150),
  postalCode: z.string().trim().min(1).max(32).nullable().optional(),
  recipientName: z.string().trim().min(1).max(200).nullable().optional(),
  addressLineOne: z.string().trim().min(1).max(500),
  addressLineTwo: z.string().trim().min(1).max(500).nullable().optional(),
  phone: z.string().trim().min(1).max(50).nullable().optional(),
  isDefault: z.boolean(),
});

export const CreateCommerceOrganizationAddressSchema = AddressFieldsSchema.strict();

export const UpdateCommerceOrganizationAddressSchema = AddressFieldsSchema.partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "At least one field is required.");

export const SubmitCommerceVerificationSchema = z
  .object({
    verificationKind: z.enum([
      "business_registration",
      "tax_registration",
      "identity",
      "address",
      "bank_account",
    ]),
    documentKind: z.enum([
      "business_registration",
      "tax_registration",
      "identity",
      "address_proof",
      "bank_evidence",
      "other",
    ]),
  })
  .strict();

export const DecideCommerceVerificationSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved") }).strict(),
  z
    .object({
      decision: z.literal("rejected"),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export const RecordCommerceDocumentScannerVerdictSchema = z
  .object({ verdict: z.enum(["available", "quarantined"]) })
  .strict();

export const TransitionCommerceTradeStateSchema = z
  .object({
    tradeState: z.enum(["active", "suspended", "closed"]),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
