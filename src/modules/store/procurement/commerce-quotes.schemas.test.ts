import { describe, expect, it } from "vitest";

import {
  AcceptQuoteSchema,
  AppendQuoteRevisionSchema,
  EmptyObjectSchema,
  ListProviderQuotesQuerySchema,
  ListSourcingQuoteLinesQuerySchema,
  QuoteIdParamsSchema,
  QuoteRevisionParamsSchema,
  RfqIdParamsSchema,
} from "./commerce-quotes.schemas.js";

describe("commerce-quotes.schemas", () => {
  describe("ID Params & Empty schemas", () => {
    it("validates empty object", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyObjectSchema.safeParse({ extra: 1 }).success).toBe(false);
    });

    it("validates RfqIdParamsSchema and QuoteIdParamsSchema", () => {
      expect(RfqIdParamsSchema.safeParse({ rfqId: "rfq_123" }).success).toBe(true);
      expect(RfqIdParamsSchema.safeParse({ rfqId: "" }).success).toBe(false);

      expect(QuoteIdParamsSchema.safeParse({ quoteId: "q_123" }).success).toBe(true);
      expect(QuoteIdParamsSchema.safeParse({ quoteId: "" }).success).toBe(false);
    });

    it("validates QuoteRevisionParamsSchema", () => {
      const data = QuoteRevisionParamsSchema.parse({
        quoteId: "q_123",
        revision: "2",
      });
      expect(data.revision).toBe(2);

      expect(QuoteRevisionParamsSchema.safeParse({ quoteId: "q_1", revision: "0" }).success).toBe(false);
    });
  });

  describe("List queries", () => {
    it("validates ListProviderQuotesQuerySchema", () => {
      const data = ListProviderQuotesQuerySchema.parse({
        status: "submitted",
        limit: "10",
      });
      expect(data.status).toBe("submitted");
      expect(data.limit).toBe(10);
    });

    it("validates ListSourcingQuoteLinesQuerySchema", () => {
      const parsed = ListSourcingQuoteLinesQuerySchema.safeParse({
        cursor: "cursor_abc",
        limit: "25",
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("AppendQuoteRevisionSchema", () => {
    const validRevision = {
      currency: "USD",
      validityDeadlineAt: "2026-12-31T23:59:59Z",
      taxInCents: 500,
      serviceFeeInCents: 1000,
      shippingInCents: 2000,
      discountInCents: 0,
      paymentTerms: "Net 30",
      incoterm: "FOB" as const,
      productLines: [
        {
          rfqProductLineId: "rfq_prod_1",
          quantity: 100,
          unitPriceInCents: 2500,
          titleSnapshot: "Precision Widget",
          specificationSnapshot: "Anodized aluminum alloy",
          siblingOrder: 0,
        },
      ],
      serviceLines: [],
    };

    it("accepts valid quote revision payload", () => {
      const parsed = AppendQuoteRevisionSchema.safeParse(validRevision);
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid Incoterm", () => {
      const parsed = AppendQuoteRevisionSchema.safeParse({
        ...validRevision,
        incoterm: "INVALID_TERM",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects duplicate rfqProductLineId", () => {
      const parsed = AppendQuoteRevisionSchema.safeParse({
        ...validRevision,
        productLines: [validRevision.productLines[0], { ...validRevision.productLines[0], siblingOrder: 1 }],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe("AcceptQuoteSchema", () => {
    it("accepts valid quote acceptance", () => {
      const parsed = AcceptQuoteSchema.safeParse({
        expectedRevision: 1,
        settlementAgreementId: "agr_settle_1",
      });
      expect(parsed.success).toBe(true);
    });

    it("accepts acceptance without settlement agreement (direct offline default)", () => {
      const parsed = AcceptQuoteSchema.safeParse({
        expectedRevision: 1,
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects non-positive expectedRevision", () => {
      expect(AcceptQuoteSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    });
  });
});
