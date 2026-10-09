import { describe, expect, it } from "vitest";
import { planRefundPostings } from "./commerce-payments.service.js";

describe("planRefundPostings", () => {
  const orderId = "test-order-123";
  const amount = 5000n; // 50.00 in cents

  it("should return correct postings for direct_processor rail", () => {
    const result = planRefundPostings("direct_processor", orderId, amount);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "payment_refunded",
      description: `Refund returned to buyer for order ${orderId}`,
      lines: [
        { accountKind: "settlement_released_memo", signedAmountInCents: -amount },
        { accountKind: "settlement_refunded_memo", signedAmountInCents: amount },
      ],
    });
  });

  it("should return correct postings for internal_custody rail", () => {
    const result = planRefundPostings("internal_custody", orderId, amount);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      kind: "payment_refunded",
      description: `Refund settled for order ${orderId}`,
      lines: [
        { accountKind: "order_held", signedAmountInCents: -amount },
        { accountKind: "refunds_payable", signedAmountInCents: amount },
      ],
    });
    expect(result[1]).toEqual({
      kind: "payment_refunded",
      description: `Refund returned to buyer for order ${orderId}`,
      lines: [
        { accountKind: "refunds_payable", signedAmountInCents: -amount },
        { accountKind: "buyer_clearing", signedAmountInCents: amount },
      ],
    });
  });

  it("should throw an error for direct_offline rail", () => {
    expect(() => planRefundPostings("direct_offline", orderId, amount)).toThrowError(
      `planRefundPostings: order ${orderId} settles on direct_offline, which takes no payment intent`,
    );
  });

  it("should throw an error for external_escrow rail", () => {
    expect(() => planRefundPostings("external_escrow", orderId, amount)).toThrowError(
      `planRefundPostings: order ${orderId} settles on external_escrow, which takes no payment intent`,
    );
  });

  it("should throw an error for unhandled rails", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
    expect(() => planRefundPostings("unhandled_rail" as any, orderId, amount)).toThrowError(
      'Unhandled settlement rail: "unhandled_rail"',
    );
  });
});
