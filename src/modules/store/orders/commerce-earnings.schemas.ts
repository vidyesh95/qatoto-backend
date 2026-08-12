/**
 * Request schema for the seller earnings read, extracted from the controller for the same
 * reason every other `*.schemas.ts` in this module is.
 */
import { z } from "zod";

/**
 * The window, and NOTHING ELSE.
 *
 * NO `organizationId`. The seller is the authenticated actor's organization, resolved by
 * `requireActiveCommerceOrganization`. Accepting an id here would make one seller's takings
 * readable by anyone who could guess an id, and would put a server-owned value in a request —
 * the thing ESCROW_LEDGER_STRUCTURE.md §0 forbids by name.
 *
 * NO `currency` FILTER. Currencies come back split into their own rows and are never summed
 * across, so filtering server-side would save nothing and would let a client ask a question
 * ("my EUR revenue") whose answer it can already read off the response.
 *
 * BOTH BOUNDS OPTIONAL, and omitting them means the lifetime figure rather than a default
 * window. A seller opening this page for the first time should see everything they have ever
 * been paid, not a silently applied last-30-days that makes an established business look new.
 */
export const SellerEarningsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();
