import { z } from "zod";

/**
 * §15.3 relation kinds. Directional on purpose — "this bolt is a spare part of that
 * bicycle" does not invert. Symmetric meanings (`complements`, `compatible_with`)
 * are stored as two rows so one query direction serves every read.
 */
/**
 * Who asserted a relation. Read-only on the seller's write — a client cannot set it — but a
 * moderator's LIST may filter by it, which is the only reason it is expressible at all.
 */
export const ProductRelationSourceKindSchema = z.enum([
  "seller_declared",
  "moderator_curated",
  "derived_cooccurrence",
]);

export const ProductRelationKindSchema = z.enum([
  "accessory_of",
  "spare_part_of",
  "consumable_for",
  "compatible_with",
  "complements",
  "replaces",
]);

/**
 * NOTE WHAT IS ABSENT: `sourceKind`. A seller write is always `seller_declared`,
 * decided by the server (§15.3). Accepting it here — even to validate it — would
 * invite a client to try, and `.strict()` makes the attempt a loud 422 instead of a
 * silently ignored field.
 */
export const ReplaceProductRelationsSchema = z
  .object({
    relations: z
      .array(
        z
          .object({
            toProductId: z.string().trim().min(1).max(200),
            relationKind: ProductRelationKindSchema,
            rank: z.number().int().min(0).max(10_000).optional(),
          })
          .strict(),
      )
      .max(100)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => `${entry.toProductId}:${entry.relationKind}`)).size ===
          entries.length,
        "A product/kind pair may appear only once.",
      ),
  })
  .strict();

export const ProductIdParamsSchema = z
  .object({ productId: z.string().trim().min(1).max(200) })
  .strict();

export const RelationIdParamsSchema = z
  .object({ relationId: z.string().trim().min(1).max(200) })
  .strict();

export const ProductSlugParamsSchema = z
  .object({ productSlug: z.string().trim().min(1).max(200) })
  .strict();

export type ReplaceProductRelationsInput = z.infer<typeof ReplaceProductRelationsSchema>;

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

/**
 * `GET /commerce/admin/product-relations`.
 *
 * ⚠️ **`sourceKind` HAS NO DEFAULT HERE, ON PURPOSE.** The controller applies
 * `seller_declared`, which keeps an explicit `?sourceKind=derived_cooccurrence` expressible for a
 * moderator who wants to audit the machine's own edges. Putting the default in the schema would
 * make the common case convenient and the deliberate one impossible — the same split
 * `ListCertificationsForModerationQuerySchema` uses for its state filter.
 */
export const ListProductRelationsForModerationQuerySchema = z
  .object({
    sourceKind: ProductRelationSourceKindSchema.optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
