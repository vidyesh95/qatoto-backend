import { describe, expect, it } from "vitest";

import {
  ListProviderFreightRateCardsQuerySchema,
  ProviderCreateFreightRateCardSchema,
  ProviderRateCardIdParamsSchema,
  ProviderReplaceFreightRateBreaksSchema,
  ProviderUpdateFreightRateCardSchema,
} from "./commerce-provider-freight-rates.schemas.js";

describe("commerce-provider-freight-rates.schemas", () => {
  describe("ProviderRateCardIdParamsSchema", () => {
    it("validates rate card ID", () => {
      expect(ProviderRateCardIdParamsSchema.safeParse({ rateCardId: "rc_123" }).success).toBe(true);
      expect(ProviderRateCardIdParamsSchema.safeParse({ rateCardId: "" }).success).toBe(false);
    });
  });

  describe("ProviderCreateFreightRateCardSchema", () => {
    const validProviderCard = {
      originCountryCode: "VN",
      destinationCountryCode: "US",
      mode: "sea" as const,
      currency: "USD",
      validFrom: "2035-06-01T00:00:00.000Z",
      volumetricDivisorCm3PerKg: 1000,
      breaks: [
        {
          minBillableWeightGrams: 0,
          minVolumeCubicCm: 0,
          unitPriceInCents: 400,
          minimumChargeInCents: 500,
          transitDaysMin: 20,
          transitDaysMax: 35,
        },
      ],
    };

    it("accepts valid provider rate card creation", () => {
      const parsed = ProviderCreateFreightRateCardSchema.safeParse(validProviderCard);
      expect(parsed.success).toBe(true);
    });

    it("rejects transitDaysMin > transitDaysMax in breaks", () => {
      const parsed = ProviderCreateFreightRateCardSchema.safeParse({
        ...validProviderCard,
        breaks: [
          {
            minBillableWeightGrams: 0,
            minVolumeCubicCm: 0,
            unitPriceInCents: 400,
            minimumChargeInCents: 500,
            transitDaysMin: 40,
            transitDaysMax: 20,
          },
        ],
      });
      expect(parsed.success).toBe(false);
    });

    it("validates ProviderReplaceFreightRateBreaksSchema", () => {
      const parsed = ProviderReplaceFreightRateBreaksSchema.safeParse({
        breaks: [
          {
            minBillableWeightGrams: 0,
            minVolumeCubicCm: 0,
            unitPriceInCents: 350,
            minimumChargeInCents: 450,
            transitDaysMin: 15,
            transitDaysMax: 25,
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("ProviderUpdateFreightRateCardSchema (Discriminated Union)", () => {
    it("validates 'shorten_window' intent", () => {
      expect(
        ProviderUpdateFreightRateCardSchema.safeParse({
          intent: "shorten_window",
          validUntil: "2035-12-31T00:00:00.000Z",
        }).success,
      ).toBe(true);
    });

    it("validates 'withdraw' intent", () => {
      expect(
        ProviderUpdateFreightRateCardSchema.safeParse({
          intent: "withdraw",
          reasonNote: "Service suspended for peak season.",
        }).success,
      ).toBe(true);
    });

    it("rejects invalid intent", () => {
      expect(ProviderUpdateFreightRateCardSchema.safeParse({ intent: "close" }).success).toBe(false);
    });
  });

  describe("ListProviderFreightRateCardsQuerySchema", () => {
    it("validates query parameters with limit coercion", () => {
      const data = ListProviderFreightRateCardsQuerySchema.parse({
        state: "active",
        limit: "15",
      });
      expect(data.limit).toBe(15);
    });
  });
});
