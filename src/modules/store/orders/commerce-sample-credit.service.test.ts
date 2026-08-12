import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { selectConsumableCredits } = await import("#src/modules/store/orders/commerce-sample-credit.service.js");

type SampleCredit = Parameters<typeof selectConsumableCredits>[0][number];

function buildCredit(id: string, amountInCents: number): SampleCredit {
  return {
    id,
    sellerOrganizationId: "commerce_org_seller",
    productId: "prd_1",
    amountInCents,
    currency: "USD",
    sourceOrderId: `order_${id}`,
  };
}

describe("sample credit selection (A17)", () => {
  it("applies every credit the order can absorb", () => {
    const selected = selectConsumableCredits([buildCredit("credit_1", 1_000), buildCredit("credit_2", 2_500)], 10_000);

    expect(selected.discountInCents).toBe(3_500);
    expect(selected.consumedCredits.map((credit) => credit.id)).toEqual(["credit_1", "credit_2"]);
  });

  /**
   * A credit is spent whole or not at all. Splitting one would need a residual-balance
   * column and a partial-consumption state, and neither earns its keep for a value that
   * exists to refund a single sample.
   */
  it("skips a credit larger than the order rather than part-spending it", () => {
    const selected = selectConsumableCredits([buildCredit("credit_big", 50_000)], 10_000);

    expect(selected.discountInCents).toBe(0);
    expect(selected.consumedCredits).toEqual([]);
  });

  it("keeps taking smaller credits after skipping one that does not fit", () => {
    const selected = selectConsumableCredits(
      [buildCredit("credit_big", 50_000), buildCredit("credit_small", 4_000)],
      10_000,
    );

    expect(selected.discountInCents).toBe(4_000);
    expect(selected.consumedCredits.map((credit) => credit.id)).toEqual(["credit_small"]);
  });

  /**
   * The discount can never exceed the subtotal, because the totals CHECK requires
   * `total = subtotal + tax + serviceFee + shipping - discount` and a negative total
   * would be rejected by the database — after the buyer had already been told a number.
   */
  it("never discounts more than the order is worth", () => {
    const selected = selectConsumableCredits([buildCredit("credit_1", 6_000), buildCredit("credit_2", 6_000)], 10_000);

    expect(selected.discountInCents).toBeLessThanOrEqual(10_000);
    expect(selected.consumedCredits).toHaveLength(1);
  });

  it("applies nothing when the buyer has no credits with this seller", () => {
    expect(selectConsumableCredits([], 10_000)).toEqual({
      consumedCredits: [],
      discountInCents: 0,
    });
  });
});
