import { describe, expect, it } from "vitest";

import {
  AttributeIdParamsSchema,
  CategoryIdParamsSchema,
  CreateCategoryAttributeSchema,
  ReplaceProductAttributeValuesSchema,
  UpdateCategoryAttributeSchema,
} from "#src/modules/store/catalog/commerce-category-attributes.schemas.js";

describe("commerce-category-attributes.schemas", () => {
  describe("CreateCategoryAttributeSchema", () => {
    it("accepts valid enum attribute creation", () => {
      const parsed = CreateCategoryAttributeSchema.parse({
        attributeKey: "switch_type",
        label: "Switch Type",
        valueKind: "enum",
        choices: [
          { choiceValue: "linear", label: "Linear" },
          { choiceValue: "tactile", label: "Tactile" },
          { choiceValue: "clicky", label: "Clicky" },
        ],
        isFilterable: true,
      });

      expect(parsed.attributeKey).toBe("switch_type");
      expect(parsed.valueKind).toBe("enum");
      expect(parsed.choices).toHaveLength(3);
    });

    it("accepts valid numeric attribute creation", () => {
      const parsed = CreateCategoryAttributeSchema.parse({
        attributeKey: "actuation_force",
        label: "Actuation Force",
        valueKind: "number",
        unitLabel: "gf",
        numericScale: 1,
      });

      expect(parsed.attributeKey).toBe("actuation_force");
      expect(parsed.numericScale).toBe(1);
    });

    it("rejects invalid attributeKey format (kebab-case, spaces, uppercase)", () => {
      expect(
        CreateCategoryAttributeSchema.safeParse({
          attributeKey: "switch-type",
          label: "Switch Type",
          valueKind: "enum",
        }).success,
      ).toBe(false);

      expect(
        CreateCategoryAttributeSchema.safeParse({
          attributeKey: "Switch_Type",
          label: "Switch Type",
          valueKind: "enum",
        }).success,
      ).toBe(false);
    });

    it("rejects duplicate choices", () => {
      const result = CreateCategoryAttributeSchema.safeParse({
        attributeKey: "color",
        label: "Color",
        valueKind: "enum",
        choices: [
          { choiceValue: "red", label: "Red" },
          { choiceValue: "red", label: "Crimson" },
        ],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("UpdateCategoryAttributeSchema", () => {
    it("accepts valid update", () => {
      const parsed = UpdateCategoryAttributeSchema.parse({
        label: "Updated Label",
        isFilterable: false,
      });
      expect(parsed.label).toBe("Updated Label");
      expect(parsed.isFilterable).toBe(false);
    });

    it("rejects attempt to change attributeKey or valueKind", () => {
      expect(
        UpdateCategoryAttributeSchema.safeParse({
          attributeKey: "new_key",
          label: "Updated Label",
        }).success,
      ).toBe(false);

      expect(
        UpdateCategoryAttributeSchema.safeParse({
          valueKind: "number",
        }).success,
      ).toBe(false);
    });

    it("rejects empty patch", () => {
      expect(UpdateCategoryAttributeSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("ReplaceProductAttributeValuesSchema", () => {
    it("accepts valid mixed attribute values", () => {
      const parsed = ReplaceProductAttributeValuesSchema.parse({
        values: [
          {
            attributeKey: "switch_type",
            kind: "enum",
            choiceValue: "tactile",
          },
          {
            attributeKey: "actuation_force",
            kind: "number",
            numericValueScaled: 450,
          },
          {
            attributeKey: "designer_notes",
            kind: "text",
            textValue: "Lubed with Krytox 205g0",
          },
        ],
      });

      expect(parsed.values).toHaveLength(3);
    });

    it("rejects duplicate attributeKey answers", () => {
      const result = ReplaceProductAttributeValuesSchema.safeParse({
        values: [
          {
            attributeKey: "switch_type",
            kind: "enum",
            choiceValue: "tactile",
          },
          {
            attributeKey: "switch_type",
            kind: "enum",
            choiceValue: "linear",
          },
        ],
      });

      expect(result.success).toBe(false);
    });

    it("rejects mismatched kind properties", () => {
      expect(
        ReplaceProductAttributeValuesSchema.safeParse({
          values: [
            {
              attributeKey: "switch_type",
              kind: "enum",
              textValue: "Wrong kind property",
            },
          ],
        }).success,
      ).toBe(false);
    });
  });

  describe("CategoryIdParamsSchema & AttributeIdParamsSchema", () => {
    it("validates CategoryIdParamsSchema", () => {
      expect(CategoryIdParamsSchema.parse({ categoryId: "cat_1" }).categoryId).toBe("cat_1");
      expect(CategoryIdParamsSchema.safeParse({ categoryId: "" }).success).toBe(false);
    });

    it("validates AttributeIdParamsSchema", () => {
      expect(AttributeIdParamsSchema.parse({ attributeId: "attr_1" }).attributeId).toBe("attr_1");
      expect(AttributeIdParamsSchema.safeParse({ attributeId: "" }).success).toBe(false);
    });
  });
});
