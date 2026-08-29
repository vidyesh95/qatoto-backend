/**
 * Request schemas for the category-attribute surface (STORE §20).
 *
 * Extracted from the controller for the same reason `commerce-categories.schemas.ts` was: the
 * parse boundary stays in the controller (`safeParse` → 422 before any service call), and the
 * service takes its input types from `z.infer` here rather than importing them back out.
 */
import { z } from "zod";

/**
 * ⚠️ SNAKE_CASE, AND NOT KEBAB. This is a wire identity a stored value points at and a saved
 * filter link names — the same class as a `pgEnum` label, not a URL segment. The regex matches
 * the database's own `commerce_category_attribute_key_ck`; kebab-case here would be a 422 from
 * the CHECK after passing Zod, which is the worst place to disagree.
 */
export const AttributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, "Use lowercase words separated by single underscores.");

export const AttributeLabelSchema = z.string().trim().min(1).max(120);
export const AttributeValueKindSchema = z.enum(["enum", "number", "text"]);

/**
 * The allowed answers for an `enum` attribute.
 *
 * Bounded at 60: a chip row longer than that is not a filter a person uses, and an unbounded
 * array is an unbounded body — the same argument `ReorderCommerceCategoriesSchema` makes.
 */
export const AttributeChoicesSchema = z
  .array(
    z
      .object({
        choiceValue: AttributeKeySchema,
        label: AttributeLabelSchema,
      })
      .strict(),
  )
  .max(60)
  .refine(
    (choices) => new Set(choices.map((choice) => choice.choiceValue)).size === choices.length,
    "Choice values must be unique within an attribute.",
  );

export const CreateCategoryAttributeSchema = z
  .object({
    attributeKey: AttributeKeySchema,
    label: AttributeLabelSchema,
    groupLabel: z.string().trim().min(1).max(80).nullable().optional(),
    valueKind: AttributeValueKindSchema,
    /** `number` only, and the service refuses it on the other kinds. "V", "mm", "kg". */
    unitLabel: z.string().trim().min(1).max(24).nullable().optional(),
    /**
     * `number` only, and REQUIRED there. Fixed point: a scale of 2 means the stored integer is
     * hundredths. 0–6 matches the CHECK.
     */
    numericScale: z.number().int().min(0).max(6).nullable().optional(),
    isFilterable: z.boolean().optional(),
    isRequiredForPublish: z.boolean().optional(),
    choices: AttributeChoicesSchema.optional(),
  })
  .strict();

/**
 * ⚠️ `attributeKey`, `valueKind` AND `numericScale` ARE ABSENT, and `.strict()` makes sending one
 * a 422 naming the key rather than a silent no-op. All three are identity: the key is what a
 * value points at, and the kind and scale decide which column every stored answer lives in and
 * what its integer means. Changing them in place would reinterpret every answer already given.
 */
export const UpdateCategoryAttributeSchema = z
  .object({
    label: AttributeLabelSchema.optional(),
    groupLabel: z.string().trim().min(1).max(80).nullable().optional(),
    unitLabel: z.string().trim().min(1).max(24).nullable().optional(),
    isFilterable: z.boolean().optional(),
    isRequiredForPublish: z.boolean().optional(),
    choices: AttributeChoicesSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Send at least one field to change.",
  });

/**
 * One listing's structured answers, as a replace-set.
 *
 * A DISCRIMINATED UNION on `kind`, so an answer cannot arrive as two types at once — the shape
 * `commerce_product_attribute_value`'s `num_nonnulls(...) = 1` CHECK enforces one layer down.
 * The service additionally proves `kind` matches the DEFINITION's `valueKind`, which no schema
 * can know.
 */
export const ReplaceProductAttributeValuesSchema = z
  .object({
    values: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              attributeKey: AttributeKeySchema,
              kind: z.literal("enum"),
              choiceValue: AttributeKeySchema,
            })
            .strict(),
          z
            .object({
              attributeKey: AttributeKeySchema,
              kind: z.literal("number"),
              /**
               * ALREADY SCALED by the definition's `numericScale`. No decimal crosses the wire —
               * the same rule integer cents follow, and the reason the scale lives on the
               * definition rather than on the value.
               */
              numericValueScaled: z.number().int().min(-1e15).max(1e15),
            })
            .strict(),
          z
            .object({
              attributeKey: AttributeKeySchema,
              kind: z.literal("text"),
              textValue: z.string().trim().min(1).max(500),
            })
            .strict(),
        ]),
      )
      .max(60)
      .refine(
        (values) => new Set(values.map((value) => value.attributeKey)).size === values.length,
        "Each attribute may be answered once.",
      ),
  })
  .strict();

export const CategoryIdParamsSchema = z
  .object({ categoryId: z.string().trim().min(1).max(200) })
  .strict();

export const AttributeIdParamsSchema = z
  .object({ attributeId: z.string().trim().min(1).max(200) })
  .strict();
