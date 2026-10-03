import { describe, expect, it } from "vitest";

import {
  CreateCustomsDwellEstimateSchema,
  CreateFreightRateCardSchema,
  DwellEstimateIdParamsSchema,
  FreightModeSchema,
  FreightRateCardStateSchema,
  ListCustomsDwellEstimatesQuerySchema,
  ListFreightRateCardsQuerySchema,
  RateCardIdParamsSchema,
  ReplaceFreightRateBreaksSchema,
  UpdateCustomsDwellEstimateSchema,
  UpdateFreightRateCardSchema,
} from "./commerce-freight-rates.schemas.js";

describe("commerce-freight-rates.schemas", () => {
  describe("Enums & ID Params", () => {
    it("validates FreightModeSchema", () => {
      expect(FreightModeSchema.safeParse("air").success).toBe(true);
      expect(FreightModeSchema.safeParse("sea").success).toBe(true);
      expect(FreightModeSchema.safeParse("land").success).toBe(true);
      expect(FreightModeSchema.safeParse("rail").success).toBe(true);
      expect(FreightModeSchema.safeParse("road").success).toBe(false);
    });

    it("validates FreightRateCardStateSchema", () => {
      expect(FreightRateCardStateSchema.safeParse("active").success).toBe(true);
      expect(FreightRateCardStateSchema.safeParse("superseded").success).toBe(true);
      expect(FreightRateCardStateSchema.safeParse("withdrawn").success).toBe(true);
      expect(FreightRateCardStateSchema.safeParse("archived").success).toBe(false);
    });

    it("validates ID params", () => {
      expect(RateCardIdParamsSchema.safeParse({ rateCardId: "rc_123" }).success).toBe(true);
      expect(RateCardIdParamsSchema.safeParse({ rateCardId: "" }).success).toBe(false);

      expect(DwellEstimateIdParamsSchema.safeParse({ dwellEstimateId: "dwell_123" }).success).toBe(true);
      expect(DwellEstimateIdParamsSchema.safeParse({ dwellEstimateId: "" }).success).toBe(false);
    });
  });

  describe("CreateFreightRateCardSchema & ReplaceFreightRateBreaksSchema", () => {
    const validRateCard = {
      providerOrganizationId: "org_provider_123",
      originCountryCode: "IN",
      destinationCountryCode: "US",
      mode: "air" as const,
      currency: "USD",
      sourceForwarderName: "DHL Global Forwarding",
      validFrom: "2026-01-01T00:00:00.000Z",
      volumetricDivisorCm3PerKg: 5000,
      breaks: [
        {
          minBillableWeightGrams: 0,
          minVolumeCubicCm: 0,
          unitPriceInCents: 1500,
          minimumChargeInCents: 2000,
          transitDaysMin: 3,
          transitDaysMax: 7,
        },
      ],
    };

    it("accepts valid rate card creation", () => {
      const parsed = CreateFreightRateCardSchema.safeParse(validRateCard);
      expect(parsed.success).toBe(true);
    });

    it("rejects transitDaysMin > transitDaysMax in breaks", () => {
      const parsed = CreateFreightRateCardSchema.safeParse({
        ...validRateCard,
        breaks: [
          {
            minBillableWeightGrams: 0,
            minVolumeCubicCm: 0,
            unitPriceInCents: 1500,
            minimumChargeInCents: 2000,
            transitDaysMin: 10,
            transitDaysMax: 5,
          },
        ],
      });
      expect(parsed.success).toBe(false);
    });

    it("validates ReplaceFreightRateBreaksSchema", () => {
      const parsed = ReplaceFreightRateBreaksSchema.safeParse({
        breaks: [
          {
            minBillableWeightGrams: 0,
            minVolumeCubicCm: 0,
            unitPriceInCents: 2000,
            minimumChargeInCents: 2500,
            transitDaysMin: 2,
            transitDaysMax: 5,
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("UpdateFreightRateCardSchema (Discriminated Union)", () => {
    it("validates 'shorten_window' intent", () => {
      const parsed = UpdateFreightRateCardSchema.safeParse({
        intent: "shorten_window",
        validUntil: "2026-12-31T00:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
    });

    it("validates 'withdraw' intent", () => {
      const parsed = UpdateFreightRateCardSchema.safeParse({
        intent: "withdraw",
        reasonNote: "Lane discontinued by carrier.",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects unknown intent", () => {
      expect(UpdateFreightRateCardSchema.safeParse({ intent: "delete" }).success).toBe(false);
    });
  });

  describe("Customs Dwell Estimates", () => {
    it("validates CreateCustomsDwellEstimateSchema", () => {
      const parsed = CreateCustomsDwellEstimateSchema.safeParse({
        destinationCountryCode: "US",
        originCountryCode: "IN",
        commodityScopeCategoryId: null,
        clearanceDaysMin: 3,
        clearanceDaysMax: 7,
        source: "Port Authority Customs",
        validFrom: "2026-01-01T00:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects clearanceDaysMin > clearanceDaysMax", () => {
      const parsed = CreateCustomsDwellEstimateSchema.safeParse({
        destinationCountryCode: "US",
        originCountryCode: "IN",
        commodityScopeCategoryId: null,
        clearanceDaysMin: 10,
        clearanceDaysMax: 5,
        source: "Port Authority Customs",
      });
      expect(parsed.success).toBe(false);
    });

    it("validates UpdateCustomsDwellEstimateSchema", () => {
      const parsed = UpdateCustomsDwellEstimateSchema.safeParse({
        validUntil: "2026-12-31T23:59:59.000Z",
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("List Queries", () => {
    it("validates ListFreightRateCardsQuerySchema", () => {
      const data = ListFreightRateCardsQuerySchema.parse({
        originCountryCode: "IN",
        state: "active",
        limit: "10",
      });
      expect(data.limit).toBe(10);
    });

    it("validates ListCustomsDwellEstimatesQuerySchema", () => {
      const parsed = ListCustomsDwellEstimatesQuerySchema.safeParse({
        destinationCountryCode: "US",
      });
      expect(parsed.success).toBe(true);
    });
  });
});
