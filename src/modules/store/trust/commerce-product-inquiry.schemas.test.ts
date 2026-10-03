import { describe, expect, it } from "vitest";

import {
  CreateProductInquiryParamsSchema,
  EmptyObjectSchema,
  ListProductInquiriesQuerySchema,
} from "./commerce-product-inquiry.schemas.js";

describe("commerce-product-inquiry.schemas", () => {
  describe("CreateProductInquiryParamsSchema", () => {
    it("accepts a valid product ID", () => {
      const data = CreateProductInquiryParamsSchema.parse({
        productId: "prod_12345",
      });
      expect(data.productId).toBe("prod_12345");
    });

    it("trims whitespace from product ID", () => {
      const data = CreateProductInquiryParamsSchema.parse({
        productId: "  prod_trimmed_id  ",
      });
      expect(data.productId).toBe("prod_trimmed_id");
    });

    it("rejects an empty or whitespace-only product ID", () => {
      expect(CreateProductInquiryParamsSchema.safeParse({ productId: "" }).success).toBe(false);
      expect(CreateProductInquiryParamsSchema.safeParse({ productId: "   " }).success).toBe(false);
    });

    it("rejects a product ID exceeding 200 characters", () => {
      expect(
        CreateProductInquiryParamsSchema.safeParse({
          productId: "p".repeat(201),
        }).success,
      ).toBe(false);
    });

    it("rejects unknown properties due to strict mode", () => {
      expect(
        CreateProductInquiryParamsSchema.safeParse({
          productId: "prod_12345",
          unexpected: "value",
        }).success,
      ).toBe(false);
    });
  });

  describe("ListProductInquiriesQuerySchema", () => {
    it("applies default values when given an empty object", () => {
      const data = ListProductInquiriesQuerySchema.parse({});
      expect(data.side).toBe("any");
      expect(data.limit).toBe(20);
      expect(data.cursor).toBeUndefined();
    });

    it("accepts explicit valid query parameters", () => {
      const data = ListProductInquiriesQuerySchema.parse({
        side: "buyer",
        limit: "15",
        cursor: "cursor_token_xyz",
      });
      expect(data.side).toBe("buyer");
      expect(data.limit).toBe(15);
      expect(data.cursor).toBe("cursor_token_xyz");
    });

    it("accepts 'seller' side filter", () => {
      const data = ListProductInquiriesQuerySchema.parse({
        side: "seller",
      });
      expect(data.side).toBe("seller");
    });

    it("rejects an invalid side filter", () => {
      expect(
        ListProductInquiriesQuerySchema.safeParse({
          side: "moderator",
        }).success,
      ).toBe(false);
    });

    it("coerces numeric limit strings and enforces boundaries (1 to 50)", () => {
      expect(ListProductInquiriesQuerySchema.parse({ limit: "1" }).limit).toBe(1);
      expect(ListProductInquiriesQuerySchema.parse({ limit: "50" }).limit).toBe(50);
      expect(ListProductInquiriesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
      expect(ListProductInquiriesQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
      expect(ListProductInquiriesQuerySchema.safeParse({ limit: "10.5" }).success).toBe(false);
    });

    it("rejects an empty cursor string or one exceeding 500 characters", () => {
      expect(ListProductInquiriesQuerySchema.safeParse({ cursor: "   " }).success).toBe(false);
      expect(ListProductInquiriesQuerySchema.safeParse({ cursor: "c".repeat(501) }).success).toBe(false);
    });

    it("rejects unknown query keys due to strict mode", () => {
      expect(
        ListProductInquiriesQuerySchema.safeParse({
          side: "any",
          unknownKey: "rejected",
        }).success,
      ).toBe(false);
    });
  });

  describe("EmptyObjectSchema", () => {
    it("accepts an empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
    });

    it("rejects objects with any unexpected properties", () => {
      expect(EmptyObjectSchema.safeParse({ foo: "bar" }).success).toBe(false);
    });
  });
});
