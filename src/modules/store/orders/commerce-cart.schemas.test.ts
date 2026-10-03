import { describe, expect, it } from "vitest";

import {
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ProductIdParamsSchema,
  RemoveCartItemQuerySchema,
  SetCartItemSchema,
} from "./commerce-cart.schemas.js";

describe("commerce-cart.schemas", () => {
  describe("EmptyObjectSchema & EmptyRequestBodySchema", () => {
    it("handles empty shapes", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ a: 1 }).success).toBe(false);
      expect(EmptyRequestBodySchema.safeParse(undefined).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse({}).success).toBe(true);
    });
  });

  describe("ProductIdParamsSchema", () => {
    it("validates product ID in path params", () => {
      expect(ProductIdParamsSchema.safeParse({ productId: "prod_123" }).success).toBe(true);
      expect(ProductIdParamsSchema.safeParse({ productId: "" }).success).toBe(false);
      expect(ProductIdParamsSchema.safeParse({ productId: "p".repeat(201) }).success).toBe(false);
    });
  });

  describe("SetCartItemSchema", () => {
    it("accepts minimal valid cart item (positive quantity)", () => {
      const data = SetCartItemSchema.parse({ quantity: 2 });
      expect(data.quantity).toBe(2);
      expect(data.variantId).toBeUndefined();
      expect(data.isSample).toBeUndefined();
    });

    it("accepts full item with variant, isSample, and customizations", () => {
      const data = SetCartItemSchema.parse({
        quantity: 5,
        variantId: "var_blue_large",
        isSample: true,
        customizations: [
          {
            slotKey: "engraving_text",
            choiceValue: "Acme Corp",
          },
          {
            slotKey: "logo_upload",
            encryptedDocumentId: "doc_enc_123",
          },
        ],
      });
      expect(data.isSample).toBe(true);
      expect(data.customizations).toHaveLength(2);
    });

    it("rejects non-positive quantity", () => {
      expect(SetCartItemSchema.safeParse({ quantity: 0 }).success).toBe(false);
      expect(SetCartItemSchema.safeParse({ quantity: -1 }).success).toBe(false);
      expect(SetCartItemSchema.safeParse({ quantity: 1.5 }).success).toBe(false);
    });

    it("rejects more than 12 customizations", () => {
      const customizations = Array.from({ length: 13 }, (_, i) => ({
        slotKey: `slot_${i}`,
      }));
      expect(SetCartItemSchema.safeParse({ quantity: 1, customizations }).success).toBe(false);
    });
  });

  describe("RemoveCartItemQuerySchema", () => {
    it("accepts empty query (removes all lines for product)", () => {
      const data = RemoveCartItemQuerySchema.parse({});
      expect(data.variantId).toBeUndefined();
      expect(data.isSample).toBeUndefined();
    });

    it("transforms 'true' and 'false' string enums into booleans", () => {
      const trueData = RemoveCartItemQuerySchema.parse({ isSample: "true" });
      const falseData = RemoveCartItemQuerySchema.parse({ isSample: "false" });

      expect(trueData.isSample).toBe(true);
      expect(falseData.isSample).toBe(false);
    });

    it("rejects non-boolean string values for isSample", () => {
      expect(RemoveCartItemQuerySchema.safeParse({ isSample: "yes" }).success).toBe(false);
      expect(RemoveCartItemQuerySchema.safeParse({ isSample: "1" }).success).toBe(false);
    });

    it("accepts variantId filter", () => {
      const data = RemoveCartItemQuerySchema.parse({ variantId: "var_123" });
      expect(data.variantId).toBe("var_123");
    });
  });
});
