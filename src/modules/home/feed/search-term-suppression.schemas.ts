import { z } from "zod";

/**
 * Blocking a term from "Everyone is searching for". The reason is REQUIRED: public text is being
 * withheld, and the audit chain must say why. The term is normalized server-side with the same
 * function the search log uses, so "Solar  Pump" and "solar pump" are one suppression.
 */
export const SuppressSearchTermSchema = z.strictObject({
  term: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(2_000),
});

/** `DELETE /feed/admin/search-terms/suppressions/:term` — the stored, already-normalized term. */
export const SuppressedSearchTermParamSchema = z.strictObject({
  term: z.string().min(2).max(80),
});

/**
 * `GET /feed/admin/search-terms/suppressions` — keyset-paged, newest first. A stray key is a 422
 * rather than an ignored parameter.
 */
export const ListSearchTermSuppressionsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
});
