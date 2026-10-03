import { describe, expect, it } from "vitest";

import {
  CategoriesQuerySchema,
  CategoryParamsSchema,
  CursorPageQuerySchema,
  OfferingParamsSchema,
  OrganizationParamsSchema,
  PathwayParamsSchema,
  ProductDocumentFileParamsSchema,
  ProductParamsSchema,
  RailParamsSchema,
  SearchQuerySchema,
} from "./store.schemas.js";

describe("store.schemas", () => {
  describe("Paging & Public Slugs", () => {
    it("validates CursorPageQuerySchema default limit and max 48", () => {
      const data = CursorPageQuerySchema.parse({});
      expect(data.limit).toBe(24);

      expect(CursorPageQuerySchema.safeParse({ limit: 48 }).success).toBe(true);
      expect(CursorPageQuerySchema.safeParse({ limit: 49 }).success).toBe(false);
    });

    it("validates CategoriesQuerySchema", () => {
      const data = CategoriesQuerySchema.parse({
        parentCategoryId: "cat_electronics",
        limit: "8",
      });
      expect(data.limit).toBe(8);
    });

    it("validates Category, Product, Organization, Pathway, Rail, Offering params", () => {
      expect(CategoryParamsSchema.safeParse({ slug: "industrial-automation" }).success).toBe(true);
      expect(ProductParamsSchema.safeParse({ productSlug: "smart-sensor-x1" }).success).toBe(true);
      expect(
        ProductDocumentFileParamsSchema.safeParse({
          productSlug: "smart-sensor-x1",
          documentId: "doc_123",
        }).success,
      ).toBe(true);
      expect(OrganizationParamsSchema.safeParse({ organizationSlug: "acme-corp" }).success).toBe(true);
      expect(PathwayParamsSchema.safeParse({ pathwaySlug: "iot-foundry" }).success).toBe(true);
      expect(RailParamsSchema.safeParse({ railSlug: "featured-electronics" }).success).toBe(true);
      expect(OfferingParamsSchema.safeParse({ offeringSlug: "ocean-freight-us" }).success).toBe(true);
    });
  });

  describe("SearchQuerySchema", () => {
    it("accepts valid store search query", () => {
      const data = SearchQuerySchema.parse({
        query: "precision enclosure",
        category: "electronics",
        sellerCountryCode: "DE",
        providerKind: "freight_forwarder",
        documentKind: "product",
        stockState: "in_stock",
        condition: "new",
        priceMinInCents: "1000",
        priceMaxInCents: "50000",
      });
      expect(data.priceMinInCents).toBe(1000);
      expect(data.priceMaxInCents).toBe(50000);
    });

    it("rejects lowercase sellerCountryCode", () => {
      expect(SearchQuerySchema.safeParse({ sellerCountryCode: "de" }).success).toBe(false);
    });

    it("rejects invalid documentKind", () => {
      expect(SearchQuerySchema.safeParse({ documentKind: "order" }).success).toBe(false);
    });
  });
});
