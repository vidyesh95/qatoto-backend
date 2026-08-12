/**
 * Request schemas for suppliers, extracted from suppliers.controller.ts.
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

export const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be a lowercase, hyphen-separated slug");

export const SUPPLIER_VERIFICATION_STATES = [
  "unverified",
  "documents_pending",
  "verified",
  "suspended",
] as const;

export const SUPPLIER_CONTACT_POLICIES = ["via_platform", "direct_email", "no_contact"] as const;

/**
 * `capability` accepts one value or several, and several means AND.
 *
 * The union-then-transform shape is `ListTalentQuerySchema`'s verbatim: Express hands a
 * repeated query key back as an array, and normalizing here means the service only ever
 * sees a list.
 */
export const ListSuppliersQuerySchema = z
  .object({
    capability: z
      .union([SlugSchema, z.array(SlugSchema).max(10)])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    region: z.string().trim().min(1).max(60).optional(),
    verificationState: z.enum(SUPPLIER_VERIFICATION_STATES).optional(),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const CreateSupplierSchema = z
  .object({
    slug: SlugSchema,
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(2_000).optional(),
    regionSlug: z.string().trim().min(1).max(60).optional(),
    contactPolicy: z.enum(SUPPLIER_CONTACT_POLICIES).optional(),
    // Not `z.url()`: the host allowlist in the service is the check that matters, and a
    // schemeless link the frontend accepts must not 422 here after a green checkmark.
    websiteUrl: z.string().trim().min(1).max(2_048).optional(),
    // Integer days and integer units. Bounded here AND by a CHECK — the schema catches one
    // hostile payload, the constraint catches a value assembled across two requests.
    leadTimeDays: z.coerce.number().int().min(0).max(3_650).optional(),
    minimumOrderQuantity: z.coerce.number().int().min(0).max(100_000_000).optional(),
    capabilitySlugs: z.array(SlugSchema).max(20).default([]),
  })
  .strict();

export const UpdateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    // Explicit null clears the field; absent leaves it alone. The two must stay
    // distinguishable or a name-only PATCH silently drops a summary.
    summary: z.string().trim().max(2_000).nullable().optional(),
    regionSlug: z.string().trim().min(1).max(60).nullable().optional(),
    verificationState: z.enum(SUPPLIER_VERIFICATION_STATES).optional(),
    contactPolicy: z.enum(SUPPLIER_CONTACT_POLICIES).optional(),
    websiteUrl: z.string().trim().min(1).max(2_048).nullable().optional(),
    leadTimeDays: z.coerce.number().int().min(0).max(3_650).nullable().optional(),
    minimumOrderQuantity: z.coerce.number().int().min(0).max(100_000_000).nullable().optional(),
    isActive: z.boolean().optional(),
    capabilitySlugs: z.array(SlugSchema).max(20).optional(),
  })
  .strict();

export const LaunchReadyProjectsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const ENGAGEMENT_STATUSES = ["considering", "contacted", "contracted", "ended"] as const;

/**
 * `verificationState` is ABSENT here and that is the §6 rule, not an oversight: a project
 * declaring itself `contracted` must never move the supplier's public trust level.
 */
export const CreateSupplierEngagementSchema = z
  .object({
    supplierId: z.string().trim().min(1).max(64),
    status: z.enum(ENGAGEMENT_STATUSES).default("considering"),
    // `project_supplier_engagement_note_ck` is `char_length(note) <= 2000`, so the schema
    // and the constraint agree and an over-long note is a 422 rather than a 500.
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

/** `supplierId` is absent: the (projectId, supplierId) pair is the row's identity. */
export const UpdateSupplierEngagementSchema = z
  .object({
    status: z.enum(ENGAGEMENT_STATUSES).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const ListSupplierEngagementsQuerySchema = z
  .object({
    status: z.enum(ENGAGEMENT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
