/**
 * Request schemas for discovery-vocabulary, extracted from discovery-vocabulary.controller.ts.
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

export const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Must be a lowercase, hyphen-separated slug");

export const DisplayLabelSchema = z.string().trim().min(1).max(80);

export const CreateDiscoverySkillSchema = z
  .object({
    slug: SlugSchema,
    displayLabel: DisplayLabelSchema,
    categoryId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** `isActive: false` is RETIREMENT — the row survives and profiles citing it keep rendering. */
export const UpdateDiscoverySkillSchema = z
  .object({
    displayLabel: DisplayLabelSchema.optional(),
    categoryId: z.string().trim().min(1).max(64).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * `global` IS DELIBERATELY ABSENT from this enum.
 *
 * `discovery_region_root_ck` enforces `kind = 'global' ⇔ parent IS NULL`, but it does NOT
 * make `global` unique — so the schema's own assumption, "exactly one root, and it is the
 * global row", is enforced by nothing. Leaving the branch off the wire makes a second root
 * unrepresentable, which costs no query and no migration.
 *
 * The discriminated union carries both region CHECKs as types: `countryCode` exists only on
 * the `country` branch (so `.strict()` refuses it on a macro region and it is required on a
 * country), and `parentRegionId` is required on both (so neither can be a root).
 */
export const CreateDiscoveryRegionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("country"),
      slug: SlugSchema,
      displayLabel: DisplayLabelSchema,
      countryCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Must be a two-letter ISO country code"),
      parentRegionId: z.string().trim().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("macro_region"),
      slug: SlugSchema,
      displayLabel: DisplayLabelSchema,
      parentRegionId: z.string().trim().min(1).max(64),
    })
    .strict(),
]);

/** A region's identity is not editable; only how it is displayed. */
export const UpdateDiscoveryRegionSchema = z.object({ displayLabel: DisplayLabelSchema }).strict();
