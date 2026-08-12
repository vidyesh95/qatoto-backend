/**
 * Request schemas for settlement attestations, extracted from the controller for the same
 * reason every other `*.schemas.ts` in this module is: `src/docs/openapi-rnd-bodies.ts`
 * generates request bodies from these, and importing a controller to reach one drags in its
 * whole service and db graph.
 */
import { z } from "zod";

export const EmptyObjectSchema = z.object({}).strict();

export const OrderIdParamsSchema = z
  .object({ orderId: z.string().trim().min(1).max(200) })
  .strict();

/**
 * WHAT A PARTY MAY STATE, AND NOTHING ELSE.
 *
 * Three fields, and the omissions are the design:
 *
 *   - **No `attestationKind`.** Derived from which side of the order the caller is on. Accepting
 *     it would let a buyer attest that the SELLER received money — see `resolveAttestationKind`.
 *   - **No `currency`.** Read off the order. One order settles in one currency, and a second
 *     spelling of it is a second thing that can disagree.
 *   - **No `orderId` in the body.** It is the path.
 *
 * `occurredAt` IS accepted, and is the one genuinely external fact here: the party knows when
 * their bank moved the money and this server has no way to find out. It is bounded to the past
 * in the service rather than here, because "not in the future" is a fact about the clock at the
 * moment of the request rather than a property of the string.
 */
export const RecordSettlementAttestationBodySchema = z
  .object({
    amountInCents: z.number().int().positive(),
    occurredAt: z.coerce.date(),
    referenceNote: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
