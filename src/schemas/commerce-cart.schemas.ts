/**
 * Request schemas for commerce-cart, extracted from commerce-cart.controller.ts.
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

export const EmptyObjectSchema = z.object({}).strict();

export const EmptyRequestBodySchema = z.union([z.undefined(), EmptyObjectSchema]);

export const ProductIdParamsSchema = z
  .object({ productId: z.string().trim().min(1).max(200) })
  .strict();

export const SetCartItemSchema = z
  .object({
    quantity: z.number().int().positive(),
    /**
     * A1. Required by the server whenever the product has active variants — the
     * absence of a value here is exactly what produces `VARIANT_REQUIRED`, so it
     * stays optional in the schema and mandatory in the domain.
     */
    variantId: z.string().trim().min(1).max(200).optional(),
    /**
     * A17. Opt-in per line. A sample sits beside the bulk line rather than replacing
     * it, because ordering a sample and then a bulk quantity is the point.
     */
    isSample: z.boolean().optional(),
    /**
     * A18. Slot keys, not option ids: the key is the seller's stable machine name for
     * the slot, so a client that cached one still means the same thing after a rename.
     */
    customizations: z
      .array(
        z
          .object({
            slotKey: z.string().trim().min(1).max(60),
            encryptedDocumentId: z.string().trim().min(1).max(200).optional(),
            choiceValue: z.string().trim().min(1).max(120).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();

/**
 * Naming a variant removes that line; omitting one removes every line for the
 * product, which is what "remove this product from my cart" means.
 */
export const RemoveCartItemQuerySchema = z
  .object({ variantId: z.string().trim().min(1).max(200).optional() })
  .strict();
