import { describe, expect, it } from "vitest";

import { SellerEarningsQuerySchema } from "./commerce-earnings.schemas.js";

describe("commerce-earnings.schemas", () => {
  describe("SellerEarningsQuerySchema", () => {
    it("accepts empty query (lifetime earnings)", () => {
      const data = SellerEarningsQuerySchema.parse({});
      expect(data.from).toBeUndefined();
      expect(data.to).toBeUndefined();
    });

    it("accepts valid ISO date bounds", () => {
      const data = SellerEarningsQuerySchema.parse({
        from: "2026-01-01T00:00:00Z",
        to: "2026-03-31T23:59:59Z",
      });
      expect(data.from).toBeInstanceOf(Date);
      expect(data.to).toBeInstanceOf(Date);
    });

    it("rejects invalid date strings", () => {
      expect(SellerEarningsQuerySchema.safeParse({ from: "invalid_date" }).success).toBe(false);
      expect(SellerEarningsQuerySchema.safeParse({ to: "not-a-valid-date" }).success).toBe(false);
    });

    it("rejects unexpected query keys (strict mode)", () => {
      expect(SellerEarningsQuerySchema.safeParse({ organizationId: "org_1" }).success).toBe(false);
      expect(SellerEarningsQuerySchema.safeParse({ currency: "USD" }).success).toBe(false);
    });
  });
});
