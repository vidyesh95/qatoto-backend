/**
 * Request schemas for commerce-checkout, extracted from commerce-checkout.controller.ts.
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

import { FreightModeSchema } from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";

export const EmptyObjectSchema = z.object({}).strict();

export const PrepareCheckoutSchema = z
  .object({
    deliveryAddressId: z.string().trim().min(1).max(200).optional(),
    /**
     * How the buyer is asking for the goods to travel.
     *
     * ⚠️ **A REQUEST, NOT A BOOKING.** Nothing prices it, nothing reserves capacity, and no
     * shipment leg is filled in from it. It reaches the arrival-window projection, which until now
     * answered `mode_not_selected` for every prepare ever made because there was no field to put a
     * mode in, and it reaches the seller on the order so somebody can act on it.
     *
     * `FreightModeSchema` — the four-member tuple mirroring `commerce_shipment_leg_mode`, NOT
     * `freight_transport_mode`'s five. A buyer picks a way of travelling; `multimodal` is what a
     * sequence of legs IS, not something to ask for.
     *
     * OPTIONAL, AND NOTHING IS AUTO-SELECTED WHEN IT IS ABSENT — the rule
     * `commerce-arrival-window.service.ts` states at length: sea is nearly always cheapest and
     * roughly four times slower, so guessing publishes the slowest window as though the buyer had
     * chosen it.
     */
    requestedFreightMode: FreightModeSchema.optional(),
    /**
     * WHICH CART LINES THIS CHECKOUT COVERS. Absent means the WHOLE CART, which is what every
     * caller before this field did, so nothing that omits it changes behaviour.
     *
     * It exists for "Buy now": a button that says it is buying one chair must not reserve stock
     * against every other seller's lines and confirm into three orders. That was the reason the
     * PDP's Buy-now control sat inert — there was no way to say "just this one".
     *
     * ⚠️ A LINE IS NAMED BY ITS NATURAL KEY, NOT BY AN ID, and that is deliberate rather than a
     * convenience. `commerce_cart_product_line` is UNIQUE on
     * `(cartId, productId, coalesce(variantId,''), isSample)`, so this tuple names at most one
     * line — it is exact, not a heuristic. It is also the only vocabulary the client HAS: the cart
     * projection exposes no line id, and `PUT`/`DELETE /commerce/cart/items/:productId` already
     * address a line exactly this way.
     *
     * ⚠️ EVERY ENTRY MUST MATCH A LINE OR THE PREPARE IS REFUSED. Quietly dropping a selector that
     * matched nothing would charge the buyer for a different set of lines than the one they named,
     * which is §0's "never trust a client-supplied identifier" applied to a tuple.
     *
     * Capped at 50 for the reason `settlementAgreements` is capped at 20: a selection larger than
     * a cart anyone assembled is a script, not a checkout.
     */
    items: z
      .array(
        z
          .object({
            productId: z.string().trim().min(1).max(200),
            variantId: z.string().trim().min(1).max(200).optional(),
            isSample: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .strict();

export const ConfirmCheckoutSchema = z
  .object({
    prepareId: z.string().trim().min(1).max(200),
    deliveryAddressId: z.string().trim().min(1).max(200).optional(),
    /**
     * STORE Phase 14. Which agreed escrow terms apply to which seller.
     *
     * OMITTING IT IS THE DEFAULT AND NOT AN ERROR — the order settles without escrow, and
     * the buyer carries the counterparty risk. Naming an agreement here does not establish
     * one: the service revalidates it against the accepted, unconsumed set under a row lock
     * and refuses the confirm outright if it has lapsed (§0).
     *
     * Capped at twenty because a checkout produces one order per counterparty and a cart
     * spanning more sellers than that is not a negotiation anyone conducted.
     */
    settlementAgreements: z
      .array(
        z
          .object({
            sellerOrganizationId: z.string().trim().min(1).max(200),
            agreementId: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
