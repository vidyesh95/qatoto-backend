import { describe, expect, it } from "vitest";

import {
  CreateRefundBodySchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ListRefundsQuerySchema,
  OrderIdParamsSchema,
  PaymentIntentIdParamsSchema,
  RazorpayCheckoutVerificationBodySchema,
} from "./commerce-payments.schemas.js";

describe("commerce-payments.schemas", () => {
  describe("Empty schemas and ID params", () => {
    it("validates empty shapes", () => {
      expect(EmptyObjectSchema.safeParse({}).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse(undefined).success).toBe(true);
      expect(EmptyRequestBodySchema.safeParse({}).success).toBe(true);
    });

    it("validates OrderIdParamsSchema and PaymentIntentIdParamsSchema", () => {
      expect(OrderIdParamsSchema.safeParse({ orderId: "ord_123" }).success).toBe(true);
      expect(OrderIdParamsSchema.safeParse({ orderId: "" }).success).toBe(false);

      expect(PaymentIntentIdParamsSchema.safeParse({ paymentIntentId: "pi_123" }).success).toBe(true);
      expect(PaymentIntentIdParamsSchema.safeParse({ paymentIntentId: "" }).success).toBe(false);
    });
  });

  describe("ListRefundsQuerySchema", () => {
    it("accepts empty query", () => {
      expect(ListRefundsQuerySchema.safeParse({}).success).toBe(true);
    });

    it("accepts valid query parameters and coerces limit (up to 100)", () => {
      const data = ListRefundsQuerySchema.parse({
        orderId: "ord_1",
        cursor: "cursor_abc",
        limit: "50",
      });
      expect(data.limit).toBe(50);
    });

    it("rejects limit > 100", () => {
      expect(ListRefundsQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });
  });

  describe("CreateRefundBodySchema", () => {
    it("accepts empty refund body (full refund)", () => {
      expect(CreateRefundBodySchema.safeParse({}).success).toBe(true);
    });

    it("accepts partial refund amount and reason", () => {
      const parsed = CreateRefundBodySchema.safeParse({
        amountInCents: 5000,
        reason: "Customer requested partial refund due to minor scratch.",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects non-positive amountInCents", () => {
      expect(CreateRefundBodySchema.safeParse({ amountInCents: 0 }).success).toBe(false);
      expect(CreateRefundBodySchema.safeParse({ amountInCents: -100 }).success).toBe(false);
    });

    it("rejects reason exceeding 1000 characters", () => {
      expect(CreateRefundBodySchema.safeParse({ reason: "r".repeat(1001) }).success).toBe(false);
    });
  });

  describe("RazorpayCheckoutVerificationBodySchema", () => {
    it("accepts valid Razorpay verification payload", () => {
      const parsed = RazorpayCheckoutVerificationBodySchema.safeParse({
        razorpayOrderId: "order_DBJOWzybf0sJbb",
        razorpayPaymentId: "pay_29BgBifbpwwjig",
        razorpaySignature: "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d840193e13ced",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid Razorpay order ID prefix", () => {
      expect(
        RazorpayCheckoutVerificationBodySchema.safeParse({
          razorpayOrderId: "ord_invalid_prefix",
          razorpayPaymentId: "pay_29BgBifbpwwjig",
          razorpaySignature: "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d840193e13ced",
        }).success,
      ).toBe(false);
    });

    it("rejects invalid Razorpay payment ID prefix", () => {
      expect(
        RazorpayCheckoutVerificationBodySchema.safeParse({
          razorpayOrderId: "order_DBJOWzybf0sJbb",
          razorpayPaymentId: "payment_invalid",
          razorpaySignature: "9ef4dffbfd84f1318f6739a3ce19f9d85851857ae648f114332d840193e13ced",
        }).success,
      ).toBe(false);
    });

    it("rejects non-hex or non-64-char signature", () => {
      expect(
        RazorpayCheckoutVerificationBodySchema.safeParse({
          razorpayOrderId: "order_DBJOWzybf0sJbb",
          razorpayPaymentId: "pay_29BgBifbpwwjig",
          razorpaySignature: "not_a_valid_hex_signature",
        }).success,
      ).toBe(false);
    });
  });
});
