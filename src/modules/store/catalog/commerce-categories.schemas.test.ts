import { describe, expect, it } from "vitest";

import {
  CreateCommerceCategorySchema,
  DecideCommerceCategoryRequestSchema,
  ListCommerceCategoryRequestsQuerySchema,
  ReorderCommerceCategoriesSchema,
  SubmitCommerceCategoryRequestSchema,
  UpdateCommerceCategorySchema,
} from "#src/modules/store/catalog/commerce-categories.schemas.js";

describe("commerce-categories.schemas", () => {
  describe("CreateCommerceCategorySchema", () => {
    it("accepts valid category creation payload", () => {
      const parsed = CreateCommerceCategorySchema.parse({
        name: "Mechanical Keyboards",
        slug: "mechanical-keyboards",
        parentCategoryId: "cat_electronics",
        searchSynonyms: "keyboards, typing, switches",
        state: "active",
      });

      expect(parsed.name).toBe("Mechanical Keyboards");
      expect(parsed.slug).toBe("mechanical-keyboards");
      expect(parsed.state).toBe("active");
    });

    it("rejects invalid slug format (uppercase, underscores, spaces)", () => {
      expect(
        CreateCommerceCategorySchema.safeParse({
          name: "Invalid",
          slug: "Mechanical_Keyboards",
        }).success,
      ).toBe(false);

      expect(
        CreateCommerceCategorySchema.safeParse({
          name: "Invalid",
          slug: "keyboards switch",
        }).success,
      ).toBe(false);

      expect(
        CreateCommerceCategorySchema.safeParse({
          name: "Invalid",
          slug: "-keyboards-",
        }).success,
      ).toBe(false);
    });

    it("rejects unexpected properties due to strict mode", () => {
      const result = CreateCommerceCategorySchema.safeParse({
        name: "Test",
        slug: "test-cat",
        siblingOrder: 1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateCommerceCategorySchema", () => {
    it("accepts partial updates", () => {
      const parsed = UpdateCommerceCategorySchema.parse({
        name: "Updated Keyboards",
        state: "retired",
      });
      expect(parsed.name).toBe("Updated Keyboards");
      expect(parsed.state).toBe("retired");
    });

    it("accepts parentCategoryId as null to make it a root category", () => {
      const parsed = UpdateCommerceCategorySchema.parse({
        parentCategoryId: null,
      });
      expect(parsed.parentCategoryId).toBeNull();
    });

    it("rejects empty patch", () => {
      const result = UpdateCommerceCategorySchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects slug updates (slug is immutable)", () => {
      const result = UpdateCommerceCategorySchema.safeParse({
        name: "Updated",
        slug: "new-slug",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ReorderCommerceCategoriesSchema", () => {
    it("accepts valid categoryIds order under root", () => {
      const parsed = ReorderCommerceCategoriesSchema.parse({
        parentCategoryId: null,
        categoryIds: ["cat_1", "cat_2", "cat_3"],
      });
      expect(parsed.parentCategoryId).toBeNull();
      expect(parsed.categoryIds).toHaveLength(3);
    });

    it("rejects empty categoryIds array", () => {
      const result = ReorderCommerceCategoriesSchema.safeParse({
        parentCategoryId: "cat_parent",
        categoryIds: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects categoryIds array exceeding 200 entries", () => {
      const ids = Array.from({ length: 201 }, (_, i) => `cat_${i}`);
      const result = ReorderCommerceCategoriesSchema.safeParse({
        parentCategoryId: null,
        categoryIds: ids,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SubmitCommerceCategoryRequestSchema", () => {
    it("accepts valid category proposal", () => {
      const parsed = SubmitCommerceCategoryRequestSchema.parse({
        proposedName: "Custom Keycaps",
        proposedParentCategoryId: "cat_keyboards",
        justification: "High demand from boutique keyboard makers",
      });
      expect(parsed.proposedName).toBe("Custom Keycaps");
    });

    it("rejects missing proposedName", () => {
      expect(SubmitCommerceCategoryRequestSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("DecideCommerceCategoryRequestSchema", () => {
    it("accepts approval with slug", () => {
      const parsed = DecideCommerceCategoryRequestSchema.parse({
        decision: "approve",
        slug: "custom-keycaps",
        productAssignments: [{ productId: "prd_1", categoryId: "cat_keycaps" }],
      });
      expect(parsed).toMatchObject({
        decision: "approve",
        slug: "custom-keycaps",
      });
    });

    it("rejects approval without slug", () => {
      const result = DecideCommerceCategoryRequestSchema.safeParse({
        decision: "approve",
      });
      expect(result.success).toBe(false);
    });

    it("accepts rejection with required note", () => {
      const parsed = DecideCommerceCategoryRequestSchema.parse({
        decision: "reject",
        note: "Duplicate of existing category",
      });
      expect(parsed).toMatchObject({
        decision: "reject",
        note: "Duplicate of existing category",
      });
    });

    it("rejects rejection without note", () => {
      const result = DecideCommerceCategoryRequestSchema.safeParse({
        decision: "reject",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ListCommerceCategoryRequestsQuerySchema", () => {
    it("accepts valid states", () => {
      expect(ListCommerceCategoryRequestsQuerySchema.parse({ state: "pending" }).state).toBe("pending");
      expect(ListCommerceCategoryRequestsQuerySchema.parse({ state: "approved" }).state).toBe("approved");
      expect(ListCommerceCategoryRequestsQuerySchema.parse({ state: "rejected" }).state).toBe("rejected");
      expect(ListCommerceCategoryRequestsQuerySchema.parse({}).state).toBeUndefined();
    });

    it("rejects unknown state", () => {
      expect(ListCommerceCategoryRequestsQuerySchema.safeParse({ state: "archived" }).success).toBe(false);
    });
  });
});
