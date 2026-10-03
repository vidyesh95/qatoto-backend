import { describe, expect, it } from "vitest";

import {
  EmptyObjectSchema,
  OrderIdParamsSchema,
  RecordSettlementAttestationBodySchema,
} from "./commerce-settlement-attestation.schemas.js";

describe("commerce-settlement-attestation.schemas", () => {
  describe("EmptyObjectSchema & OrderIdParamsSchema", () => {
    it("validates empty object and order ID", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(OrderIdParamsSchema.safeParse({ orderId: "ord_123" }).success).toBe(true);
      expect(OrderIdParamsSchema.safeParse({ orderId: "" }).success).toBe(false);
    });
  });

  describe("RecordSettlementAttestationBodySchema", () => {
    it("accepts valid attestation payload", () => {
      const data = RecordSettlementAttestationBodySchema.parse({
        amountInCents: 50000,
        occurredAt: "2026-05-01T12:00:00Z",
        referenceNote: "Wire transfer ref #TRX-998877",
      });
      expect(data.amountInCents).toBe(50000);
      expect(data.occurredAt).toBeInstanceOf(Date);
      expect(data.referenceNote).toBe("Wire transfer ref #TRX-998877");
    });

    it("rejects non-positive amountInCents", () => {
      expect(
        RecordSettlementAttestationBodySchema.safeParse({
          amountInCents: 0,
          occurredAt: "2026-05-01T12:00:00Z",
        }).success,
      ).toBe(false);
    });

    it("rejects invalid date format", () => {
      expect(
        RecordSettlementAttestationBodySchema.safeParse({
          amountInCents: 1000,
          occurredAt: "not_a_date",
        }).success,
      ).toBe(false);
    });

    it("rejects referenceNote longer than 500 characters", () => {
      expect(
        RecordSettlementAttestationBodySchema.safeParse({
          amountInCents: 1000,
          occurredAt: "2026-05-01T12:00:00Z",
          referenceNote: "n".repeat(501),
        }).success,
      ).toBe(false);
    });

    it("rejects server-owned or disallowed fields (e.g. attestationKind, currency)", () => {
      expect(
        RecordSettlementAttestationBodySchema.safeParse({
          amountInCents: 1000,
          occurredAt: "2026-05-01T12:00:00Z",
          attestationKind: "payment_received",
        }).success,
      ).toBe(false);
    });
  });
});
