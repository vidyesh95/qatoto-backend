import { z } from "zod";

import { ProductRelationKindSchema } from "#src/schemas/commerce-catalog.schemas.js";

/**
 * Guided pathway authoring (§15.8).
 *
 * NOTE WHAT IS ABSENT from every schema here: `state`, `sourceKind`, `submittedAt`,
 * `reviewedByUserId` and `reviewedAt`. All five are server-owned. A client that could
 * set `state` could publish its own proposal, and one that could set `sourceKind`
 * could pass a graph suggestion off as a curatorial decision — the same posture §0
 * takes on prices and badges. `.strict()` turns an attempt into a loud 422 rather than
 * a silently ignored field.
 */

const PathwaySlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug must be kebab-case.");

const PathwayAccentSchema = z.enum(["amber", "slate", "emerald", "sky", "rose"]);

/**
 * The slot an uploaded pathway image fills. Two named roles rather than a free string,
 * because each one maps to its own column triple on `store_pathway` (`0091`).
 */
export const PathwayImageSlotSchema = z.enum(["hero", "card"]);

export const PathwayImageParamsSchema = z
  .object({
    pathwayId: z.string().trim().min(1).max(200),
    imageSlot: PathwayImageSlotSchema,
  })
  .strict();

export const CreatePathwaySchema = z
  .object({
    slug: PathwaySlugSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500).optional(),
    accent: PathwayAccentSchema.optional(),
    /** Non-null makes this an anchored set (§15.1). */
    anchorProductId: z.string().trim().min(1).max(200).optional(),
    /**
     * `heroImageUrl` / `cardImageUrl` were here and migration `0091` removed them. Art is
     * uploaded to POST /commerce/pathways/:pathwayId/images/:imageSlot so the platform
     * holds the bytes: a seller may propose a set (§15.5) and a moderator publishes it,
     * and a URL let the seller change the picture after it was approved.
     */
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
  })
  .strict();

/**
 * `slug` is absent on purpose: a public slug is a URL identity and is immutable after
 * publication (§4). Changing a display name must not change where a set lives.
 */
export const UpdatePathwaySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    summary: z.string().trim().min(1).max(500).nullable().optional(),
    accent: PathwayAccentSchema.optional(),
    anchorProductId: z.string().trim().min(1).max(200).nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update.");

/**
 * The whole slot plan is replaced in one call, like `PUT /products/:id/variants`:
 * ordering is a property of the plan, not of individual rows, and a PATCH-per-slot
 * surface would let a client leave the plan half-reordered.
 */
export const ReplacePathwaySlotsSchema = z
  .object({
    slots: z
      .array(
        z
          .object({
            roleLabel: z.string().trim().min(1).max(80),
            isRequired: z.boolean().optional(),
            quantity: z.number().int().min(1).max(1_000_000).optional(),
            /** Names the graph edge an anchored slot resolves its candidates from. */
            derivedRelationKind: ProductRelationKindSchema.optional(),
            startsAt: z.coerce.date().optional(),
            endsAt: z.coerce.date().optional(),
          })
          .strict()
          .refine(
            (slot) =>
              slot.startsAt === undefined ||
              slot.endsAt === undefined ||
              slot.endsAt > slot.startsAt,
            "A slot window must end after it starts.",
          ),
      )
      .max(100),
  })
  .strict();

/**
 * `variantId` is required whenever the product has active variants, but that is a
 * database fact the schema cannot see — the service checks it and returns
 * `VARIANT_REQUIRED`. Accepting it as optional here keeps the two rules in one place
 * instead of half-enforcing it at the boundary.
 */
export const ReplacePathwaySlotCandidatesSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            productId: z.string().trim().min(1).max(200),
            variantId: z.string().trim().min(1).max(200).optional(),
            rank: z.number().int().min(0).max(10_000).optional(),
          })
          .strict(),
      )
      .max(12)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => `${entry.productId}:${entry.variantId ?? ""}`)).size ===
          entries.length,
        "A product/variant pair may appear only once in a slot.",
      ),
  })
  .strict();

export const ModeratePathwaySchema = z
  .object({
    decision: z.enum(["publish", "reject"]),
    reviewNote: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (body) => body.decision !== "reject" || body.reviewNote !== undefined,
    "A rejection must say why.",
  );

export const PathwayIdParamsSchema = z
  .object({ pathwayId: z.string().trim().min(1).max(200) })
  .strict();

export const PathwaySlotParamsSchema = z
  .object({
    pathwayId: z.string().trim().min(1).max(200),
    slotId: z.string().trim().min(1).max(200),
  })
  .strict();

export const PathwaySlugParamsSchema = z.object({ pathwaySlug: PathwaySlugSchema }).strict();

/**
 * Cart seeding (§15.4). A selection may only name a candidate the slot already offers;
 * the service verifies that, so a client cannot inject an arbitrary product into a set
 * it did not curate.
 */
export const SeedCartFromPathwaySchema = z
  .object({
    selections: z
      .array(
        z
          .object({
            slotId: z.string().trim().min(1).max(200),
            productId: z.string().trim().min(1).max(200),
            variantId: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(100)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.slotId)).size === entries.length,
        "A slot may be selected only once.",
      )
      .optional(),
  })
  .strict();

export type CreatePathwayInput = z.infer<typeof CreatePathwaySchema>;
export type UpdatePathwayInput = z.infer<typeof UpdatePathwaySchema>;
export type ReplacePathwaySlotsInput = z.infer<typeof ReplacePathwaySlotsSchema>;
export type ReplacePathwaySlotCandidatesInput = z.infer<typeof ReplacePathwaySlotCandidatesSchema>;
export type ModeratePathwayInput = z.infer<typeof ModeratePathwaySchema>;
export type SeedCartFromPathwayInput = z.infer<typeof SeedCartFromPathwaySchema>;

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const PageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
