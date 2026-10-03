import { describe, expect, it } from "vitest";

import {
  AgreementIdParamsSchema,
  EligibleProvidersQuerySchema,
  EmptyObjectSchema,
  ProposeAgreementBodySchema,
  RespondBodySchema,
  ThreadIdParamsSchema,
} from "./commerce-settlement.schemas.js";

describe("commerce-settlement.schemas", () => {
  describe("EmptyObjectSchema & Parameter Schemas", () => {
    it("validates EmptyObjectSchema", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates ThreadIdParamsSchema", () => {
      expect(ThreadIdParamsSchema.safeParse({ threadId: "thr_123" }).success).toBe(true);
      expect(ThreadIdParamsSchema.safeParse({ threadId: "" }).success).toBe(false);
      expect(ThreadIdParamsSchema.safeParse({ threadId: "t".repeat(201) }).success).toBe(false);
    });

    it("validates AgreementIdParamsSchema", () => {
      expect(AgreementIdParamsSchema.safeParse({ agreementId: "agr_123" }).success).toBe(true);
      expect(AgreementIdParamsSchema.safeParse({ agreementId: "" }).success).toBe(false);
      expect(AgreementIdParamsSchema.safeParse({ agreementId: "a".repeat(201) }).success).toBe(false);
    });
  });

  describe("ProposeAgreementBodySchema", () => {
    const validPropose = {
      buyerOrganizationId: "org_buyer_1",
      sellerOrganizationId: "org_seller_1",
      externalProviderId: "provider_tazapay",
      escrowFeeBearer: "split" as const,
      currency: "USD",
      totalInCents: 100000,
      expiresAt: "2026-12-31T23:59:59Z",
      milestones: [
        {
          sequence: 1,
          milestoneKind: "deposit" as const,
          amountInCents: 30000,
          releaseConditionNote: "30% upfront on order confirmation.",
        },
        {
          sequence: 2,
          milestoneKind: "delivery" as const,
          amountInCents: 70000,
          releaseConditionNote: null,
        },
      ],
    };

    it("accepts valid agreement proposal", () => {
      const data = ProposeAgreementBodySchema.parse(validPropose);
      expect(data.currency).toBe("USD");
      expect(data.milestones).toHaveLength(2);
      expect(data.expiresAt).toBeInstanceOf(Date);
    });

    it("rejects lowercase currency code", () => {
      const parsed = ProposeAgreementBodySchema.safeParse({
        ...validPropose,
        currency: "usd",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects non-positive totalInCents", () => {
      expect(ProposeAgreementBodySchema.safeParse({ ...validPropose, totalInCents: 0 }).success).toBe(false);
      expect(ProposeAgreementBodySchema.safeParse({ ...validPropose, totalInCents: -500 }).success).toBe(false);
    });

    it("rejects empty milestones array", () => {
      const parsed = ProposeAgreementBodySchema.safeParse({
        ...validPropose,
        milestones: [],
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects more than 20 milestones", () => {
      const milestones = Array.from({ length: 21 }, (_, i) => ({
        sequence: i + 1,
        milestoneKind: "delivery" as const,
        amountInCents: 1000,
        releaseConditionNote: null,
      }));
      const parsed = ProposeAgreementBodySchema.safeParse({
        ...validPropose,
        milestones,
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects invalid escrowFeeBearer", () => {
      const parsed = ProposeAgreementBodySchema.safeParse({
        ...validPropose,
        escrowFeeBearer: "platform",
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("RespondBodySchema", () => {
    it("accepts valid responses (accept, decline, withdraw)", () => {
      for (const response of ["accept", "decline", "withdraw"] as const) {
        const data = RespondBodySchema.parse({ response });
        expect(data.response).toBe(response);
      }
    });

    it("rejects invalid response", () => {
      expect(RespondBodySchema.safeParse({ response: "counter" }).success).toBe(false);
    });
  });

  describe("EligibleProvidersQuerySchema", () => {
    it("accepts valid query with ISO alpha-2 country codes, ISO-4217 currency, positive totalInCents", () => {
      const data = EligibleProvidersQuerySchema.parse({
        buyerCountryCode: "US",
        sellerCountryCode: "IN",
        currency: "USD",
        totalInCents: "50000",
      });
      expect(data.buyerCountryCode).toBe("US");
      expect(data.sellerCountryCode).toBe("IN");
      expect(data.currency).toBe("USD");
      expect(data.totalInCents).toBe(50000);
    });

    it("rejects lowercase country codes", () => {
      expect(
        EligibleProvidersQuerySchema.safeParse({
          buyerCountryCode: "us",
          sellerCountryCode: "IN",
          currency: "USD",
          totalInCents: 5000,
        }).success,
      ).toBe(false);
    });

    it("rejects non-positive or missing totalInCents", () => {
      expect(
        EligibleProvidersQuerySchema.safeParse({
          buyerCountryCode: "US",
          sellerCountryCode: "IN",
          currency: "USD",
          totalInCents: "0",
        }).success,
      ).toBe(false);
    });
  });
});
