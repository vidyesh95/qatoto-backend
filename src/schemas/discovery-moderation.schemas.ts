/**
 * Request schemas for discovery-moderation, extracted from discovery-moderation.controller.ts.
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

export const CATEGORY_PIN_ICON_KEYS = [
  "water",
  "energy",
  "health",
  "agriculture",
  "housing",
  "transport",
  "waste",
  "connectivity",
  "manufacturing",
  "education",
  "other",
] as const;

/**
 * A DISCRIMINATED UNION on `decision`, not `{ decision, note? }`.
 *
 * `note` is genuinely REQUIRED on a reject — a rejection with no reason is unactionable
 * for the minter and unauditable for the next moderator — and genuinely optional on an
 * approve. A shared optional `note` cannot express that difference; the union makes the
 * illegal state unrepresentable (CLAUDE.md §3.2).
 *
 * `pinIconKey` extends §11b's `{ decision, note? }` by one key, deliberately: the icon is
 * moderator-owned metadata and approval is the exact moment it is assigned. It is absent
 * from the reject branch, and absent from the public CreateCategorySchema, so a minter can
 * never choose their own map iconography.
 */
export const DecideCategorySchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("approve"),
      pinIconKey: z.enum(CATEGORY_PIN_ICON_KEYS).optional(),
      note: z.string().trim().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      decision: z.literal("reject"),
      note: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export const DecideMergeProposalSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const ListMergeProposalsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
