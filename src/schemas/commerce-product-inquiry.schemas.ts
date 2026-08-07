import { z } from "zod";

/**
 * Boundary contracts for pre-sales product inquiries (STORE Appendix A14).
 *
 * The create route takes NO body. Everything it needs — the product from the path, the
 * buyer organization from the session context, the seller organization from the
 * product row — is server-derived, and the first message is posted through the
 * existing thread route rather than smuggled in here.
 */
export const CreateProductInquiryParamsSchema = z
  .object({
    productId: z.string().trim().min(1).max(200),
  })
  .strict();

export const ListProductInquiriesQuerySchema = z
  .object({
    /**
     * A FILTER over rows the caller may already see, never a permission. One
     * organization can be the buyer on one listing and the seller on another, so a
     * single route with a side filter is the honest shape.
     */
    side: z.enum(["buyer", "seller", "any"]).default("any"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type ListProductInquiriesQuery = z.infer<typeof ListProductInquiriesQuerySchema>;
