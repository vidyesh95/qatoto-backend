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

export const EmptyObjectSchema = z.object({}).strict();

export const PrepareCheckoutSchema = z
  .object({
    deliveryAddressId: z.string().trim().min(1).max(200).optional(),
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
