import { z } from "zod";

/**
 * Query contract for the public review reads (Appendix A8).
 *
 * `hasMedia` is `z.enum(["true","false"]).transform(...)` and NOT `z.coerce.boolean()`.
 * `Boolean("false")` is `true`, so coercion would make `?hasMedia=false` mean the
 * opposite of what it says — the kind of bug that survives review because the happy
 * path works.
 *
 * `limit` maxes at 24 rather than the catalog's 48: a review row carries a body, up to
 * six media rows, three scores and a reply, so a page is far heavier than a card.
 */
export const StoreReviewListQuerySchema = z
  .object({
    sort: z.enum(["recent", "helpful", "rating_high", "rating_low"]).default("recent"),
    rating: z.coerce.number().int().min(1).max(5).optional(),
    hasMedia: z
      .enum(["true", "false"])
      .transform((rawValue) => rawValue === "true")
      .optional(),
    limit: z.coerce.number().int().min(1).max(24).default(12),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type StoreReviewListQuery = z.infer<typeof StoreReviewListQuerySchema>;

export const StoreProductReviewParamsSchema = z
  .object({
    productSlug: z.string().trim().min(1).max(200),
  })
  .strict();

export const StoreOrganizationReviewParamsSchema = z
  .object({
    organizationSlug: z.string().trim().min(1).max(200),
  })
  .strict();
