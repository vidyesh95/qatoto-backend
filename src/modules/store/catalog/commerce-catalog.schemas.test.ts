import { describe, expect, it } from "vitest";

import {
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ListProductRelationsForModerationQuerySchema,
  ProductIdParamsSchema,
  ProductRelationKindSchema,
  RelationIdParamsSchema,
  ReplaceProductRelationsSchema,
} from "#src/modules/store/catalog/commerce-catalog.schemas.js";

describe("commerce-catalog.schemas", () => {
  describe("ProductRelationKindSchema", () => {
    it("accepts all valid relation kinds", () => {
      const validKinds = [
        "accessory_of",
        "spare_part_of",
        "consumable_for",
        "compatible_with",
        "complements",
        "replaces",
      ] as const;

      for (const kind of validKinds) {
        expect(ProductRelationKindSchema.parse(kind)).toBe(kind);
      }
    });

    it("rejects unknown relation kinds", () => {
      expect(ProductRelationKindSchema.safeParse("unknown_kind").success).toBe(false);
      expect(ProductRelationKindSchema.safeParse("").success).toBe(false);
      expect(ProductRelationKindSchema.safeParse(123).success).toBe(false);
    });
  });

  describe("ReplaceProductRelationsSchema", () => {
    it("accepts empty relations list", () => {
      const parsed = ReplaceProductRelationsSchema.parse({ relations: [] });
      expect(parsed.relations).toHaveLength(0);
    });

    it("accepts valid relation list with rank", () => {
      const parsed = ReplaceProductRelationsSchema.parse({
        relations: [
          {
            toProductId: "prd_12345",
            relationKind: "accessory_of",
            rank: 10,
          },
          {
            toProductId: "prd_67890",
            relationKind: "compatible_with",
          },
        ],
      });
      expect(parsed.relations).toHaveLength(2);
      expect(parsed.relations[0]?.toProductId).toBe("prd_12345");
      expect(parsed.relations[0]?.rank).toBe(10);
    });

    it("rejects duplicate toProductId + relationKind pairs", () => {
      const result = ReplaceProductRelationsSchema.safeParse({
        relations: [
          {
            toProductId: "prd_duplicate",
            relationKind: "compatible_with",
          },
          {
            toProductId: "prd_duplicate",
            relationKind: "compatible_with",
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("allows same toProductId with different relationKind", () => {
      const result = ReplaceProductRelationsSchema.safeParse({
        relations: [
          {
            toProductId: "prd_dual",
            relationKind: "compatible_with",
          },
          {
            toProductId: "prd_dual",
            relationKind: "accessory_of",
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects unknown keys at root due to .strict()", () => {
      const result = ReplaceProductRelationsSchema.safeParse({
        relations: [],
        sourceKind: "moderator_curated",
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys in relation item due to .strict()", () => {
      const result = ReplaceProductRelationsSchema.safeParse({
        relations: [
          {
            toProductId: "prd_1",
            relationKind: "complements",
            extraField: "disallowed",
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects rank out of bounds", () => {
      expect(
        ReplaceProductRelationsSchema.safeParse({
          relations: [
            {
              toProductId: "prd_1",
              relationKind: "complements",
              rank: -1,
            },
          ],
        }).success,
      ).toBe(false);

      expect(
        ReplaceProductRelationsSchema.safeParse({
          relations: [
            {
              toProductId: "prd_1",
              relationKind: "complements",
              rank: 10_001,
            },
          ],
        }).success,
      ).toBe(false);
    });

    it("rejects empty toProductId", () => {
      expect(
        ReplaceProductRelationsSchema.safeParse({
          relations: [
            {
              toProductId: "   ",
              relationKind: "complements",
            },
          ],
        }).success,
      ).toBe(false);
    });

    it("rejects lists exceeding 100 entries", () => {
      const entries = Array.from({ length: 101 }, (_, i) => ({
        toProductId: `prd_${i}`,
        relationKind: "compatible_with" as const,
      }));
      expect(ReplaceProductRelationsSchema.safeParse({ relations: entries }).success).toBe(false);
    });
  });

  describe("ProductIdParamsSchema & RelationIdParamsSchema", () => {
    it("validates ProductIdParamsSchema", () => {
      expect(ProductIdParamsSchema.parse({ productId: "prd_abc123" }).productId).toBe("prd_abc123");
      expect(ProductIdParamsSchema.safeParse({ productId: "   " }).success).toBe(false);
      expect(ProductIdParamsSchema.safeParse({ productId: "a".repeat(201) }).success).toBe(false);
      expect(ProductIdParamsSchema.safeParse({ productId: "prd_1", unexpected: true }).success).toBe(false);
    });

    it("validates RelationIdParamsSchema", () => {
      expect(RelationIdParamsSchema.parse({ relationId: "rel_abc123" }).relationId).toBe("rel_abc123");
      expect(RelationIdParamsSchema.safeParse({ relationId: "   " }).success).toBe(false);
      expect(RelationIdParamsSchema.safeParse({ relationId: "a".repeat(201) }).success).toBe(false);
      expect(RelationIdParamsSchema.safeParse({ relationId: "rel_1", unexpected: true }).success).toBe(false);
    });
  });

  describe("EmptyObjectSchema & EmptyRequestBodySchema", () => {
    it("validates EmptyObjectSchema", () => {
      expect(EmptyObjectSchema.parse({})).toEqual({});
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates EmptyRequestBodySchema", () => {
      expect(EmptyRequestBodySchema.parse(undefined)).toBeUndefined();
      expect(EmptyRequestBodySchema.parse({})).toEqual({});
      expect(EmptyRequestBodySchema.safeParse({ notEmpty: true }).success).toBe(false);
    });
  });

  describe("ListProductRelationsForModerationQuerySchema", () => {
    it("applies default limit of 25 when omitted", () => {
      const parsed = ListProductRelationsForModerationQuerySchema.parse({});
      expect(parsed.limit).toBe(25);
      expect(parsed.sourceKind).toBeUndefined();
      expect(parsed.cursor).toBeUndefined();
    });

    it("accepts valid query parameters and coerces limit", () => {
      const parsed = ListProductRelationsForModerationQuerySchema.parse({
        sourceKind: "moderator_curated",
        cursor: "cursor_token_123",
        limit: "10",
      });
      expect(parsed.sourceKind).toBe("moderator_curated");
      expect(parsed.cursor).toBe("cursor_token_123");
      expect(parsed.limit).toBe(10);
    });

    it("rejects limit below 1 or above 50", () => {
      expect(ListProductRelationsForModerationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(ListProductRelationsForModerationQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    });

    it("rejects invalid sourceKind", () => {
      expect(ListProductRelationsForModerationQuerySchema.safeParse({ sourceKind: "invalid" }).success).toBe(false);
    });

    it("rejects unknown query properties", () => {
      expect(ListProductRelationsForModerationQuerySchema.safeParse({ unknownKey: "bad" }).success).toBe(false);
    });
  });
});
