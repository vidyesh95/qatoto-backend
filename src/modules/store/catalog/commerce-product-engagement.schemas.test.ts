import { describe, expect, it } from "vitest";

import {
  EmptyObjectSchema,
  ListBookmarkedProductsQuerySchema,
  ProductSlugParamsSchema,
  ProductViewBeaconBodySchema,
} from "#src/modules/store/catalog/commerce-product-engagement.schemas.js";
import { MAXIMUM_VIEW_DWELL_SECONDS } from "#src/modules/store/commerce-view-clamp.js";

describe("commerce-product-engagement.schemas", () => {
  describe("EmptyObjectSchema", () => {
    it("accepts empty object", () => {
      expect(EmptyObjectSchema.parse({})).toEqual({});
    });

    it("rejects object with keys", () => {
      expect(EmptyObjectSchema.safeParse({ unexpected: "value" }).success).toBe(false);
    });
  });

  describe("ProductViewBeaconBodySchema", () => {
    it("accepts valid dwellSeconds and applies default viewSource", () => {
      const parsed = ProductViewBeaconBodySchema.parse({
        dwellSeconds: 45,
      });
      expect(parsed.dwellSeconds).toBe(45);
      expect(parsed.viewSource).toBe("unknown");
    });

    it("accepts explicit viewSource enum values", () => {
      const sources = ["product_detail", "search", "rail", "pathway", "companion", "unknown"] as const;

      for (const viewSource of sources) {
        const parsed = ProductViewBeaconBodySchema.parse({
          dwellSeconds: 10,
          viewSource,
        });
        expect(parsed.viewSource).toBe(viewSource);
      }
    });

    it("rejects negative dwellSeconds", () => {
      expect(ProductViewBeaconBodySchema.safeParse({ dwellSeconds: -1 }).success).toBe(false);
    });

    it("rejects dwellSeconds exceeding MAXIMUM_VIEW_DWELL_SECONDS", () => {
      expect(
        ProductViewBeaconBodySchema.safeParse({
          dwellSeconds: MAXIMUM_VIEW_DWELL_SECONDS + 1,
        }).success,
      ).toBe(false);
    });

    it("rejects invalid viewSource", () => {
      expect(
        ProductViewBeaconBodySchema.safeParse({
          dwellSeconds: 10,
          viewSource: "invalid_source",
        }).success,
      ).toBe(false);
    });

    it("rejects extra properties due to strict mode", () => {
      expect(
        ProductViewBeaconBodySchema.safeParse({
          dwellSeconds: 10,
          extraField: true,
        }).success,
      ).toBe(false);
    });
  });

  describe("ProductSlugParamsSchema", () => {
    it("accepts valid product slug", () => {
      const parsed = ProductSlugParamsSchema.parse({ productSlug: "artisan-keyboard-switch" });
      expect(parsed.productSlug).toBe("artisan-keyboard-switch");
    });

    it("rejects empty or whitespace productSlug", () => {
      expect(ProductSlugParamsSchema.safeParse({ productSlug: "" }).success).toBe(false);
      expect(ProductSlugParamsSchema.safeParse({ productSlug: "   " }).success).toBe(false);
    });

    it("rejects productSlug exceeding 200 characters", () => {
      expect(ProductSlugParamsSchema.safeParse({ productSlug: "a".repeat(201) }).success).toBe(false);
    });
  });

  describe("ListBookmarkedProductsQuerySchema", () => {
    it("applies default limit of 24 when omitted", () => {
      const parsed = ListBookmarkedProductsQuerySchema.parse({});
      expect(parsed.limit).toBe(24);
      expect(parsed.cursor).toBeUndefined();
    });

    it("accepts custom limit and coerces string", () => {
      const parsed = ListBookmarkedProductsQuerySchema.parse({ limit: "40", cursor: "curs_123" });
      expect(parsed.limit).toBe(40);
      expect(parsed.cursor).toBe("curs_123");
    });

    it("rejects limit below 1 or above 48", () => {
      expect(ListBookmarkedProductsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
      expect(ListBookmarkedProductsQuerySchema.safeParse({ limit: 49 }).success).toBe(false);
    });

    it("rejects unknown keys like kind (which was deprecated)", () => {
      const result = ListBookmarkedProductsQuerySchema.safeParse({
        kind: "liked",
      });
      expect(result.success).toBe(false);
    });
  });
});
