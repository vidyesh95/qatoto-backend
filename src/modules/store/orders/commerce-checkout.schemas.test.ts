import { describe, expect, it } from "vitest";

import { ConfirmCheckoutSchema, EmptyObjectSchema, PrepareCheckoutSchema } from "./commerce-checkout.schemas.js";

describe("commerce-checkout.schemas", () => {
  describe("EmptyObjectSchema", () => {
    it("accepts empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ unexpected: 1 }).success).toBe(false);
    });
  });

  describe("PrepareCheckoutSchema", () => {
    it("accepts completely empty body (prepares whole cart without specific mode)", () => {
      const data = PrepareCheckoutSchema.parse({});
      expect(data.deliveryAddressId).toBeUndefined();
      expect(data.requestedFreightMode).toBeUndefined();
      expect(data.items).toBeUndefined();
    });

    it("accepts explicit requestedFreightMode and deliveryAddressId", () => {
      const data = PrepareCheckoutSchema.parse({
        deliveryAddressId: "addr_123",
        requestedFreightMode: "air",
      });
      expect(data.requestedFreightMode).toBe("air");
    });

    it("accepts specific line item selectors for 'Buy now'", () => {
      const data = PrepareCheckoutSchema.parse({
        items: [
          {
            productId: "prod_chair_1",
            variantId: "var_walnut",
            isSample: false,
          },
        ],
      });
      expect(data.items).toHaveLength(1);
    });

    it("rejects empty items array", () => {
      expect(PrepareCheckoutSchema.safeParse({ items: [] }).success).toBe(false);
    });

    it("rejects more than 50 items", () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        productId: `prod_${i}`,
      }));
      expect(PrepareCheckoutSchema.safeParse({ items }).success).toBe(false);
    });
  });

  describe("ConfirmCheckoutSchema", () => {
    it("accepts minimal confirm payload with prepareId", () => {
      const parsed = ConfirmCheckoutSchema.safeParse({
        prepareId: "prep_12345",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts settlement agreements mapped to sellers", () => {
      const data = ConfirmCheckoutSchema.parse({
        prepareId: "prep_12345",
        deliveryAddressId: "addr_1",
        settlementAgreements: [
          {
            sellerOrganizationId: "org_seller_1",
            agreementId: "agr_1",
          },
        ],
      });
      expect(data.settlementAgreements).toHaveLength(1);
    });

    it("rejects missing prepareId", () => {
      expect(ConfirmCheckoutSchema.safeParse({}).success).toBe(false);
      expect(ConfirmCheckoutSchema.safeParse({ prepareId: "" }).success).toBe(false);
    });

    it("rejects more than 20 settlement agreements", () => {
      const agreements = Array.from({ length: 21 }, (_, i) => ({
        sellerOrganizationId: `org_${i}`,
        agreementId: `agr_${i}`,
      }));
      expect(
        ConfirmCheckoutSchema.safeParse({
          prepareId: "prep_1",
          settlementAgreements: agreements,
        }).success,
      ).toBe(false);
    });
  });
});
