import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * What a payment may post, on the rail the order actually settles on (Appendix A41).
 *
 * WHY THIS FILE EXISTS. Phase 5 wrote `buyer_clearing → order_held`, Phase 14 froze that pair onto
 * `internal_custody` — the rail it retired — and nothing revisited the payment service. Every
 * settlement on every live rail therefore threw inside `appendCommerceJournalEntry`, the outbox
 * caught it, retried eight times and dead-lettered, and no order could leave `payment_processing`.
 * It went unnoticed for two phases because THIS SERVICE HAD NO TESTS AT ALL, and the journal's own
 * suite asserts the rail MAP against the database trigger without ever asking what a producer posts.
 *
 * THE FIRST ASSERTION IS THE ONE THAT WOULD HAVE CAUGHT IT, and it is deliberately not a list of
 * expected account names: it holds every planned line against
 * `COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL` imported from the real module. A test that restated the
 * accounts would have been written from the same wrong assumption as the code.
 *
 * NO DATABASE IS STUBBED, because the decision under test is pure. `planSettlementPostings` and
 * `planRefundPostings` take a rail and answer with entries; writing them is the trivial half.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const { COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL } = await import("#src/services/commerce-journal.service.js");
const { planSettlementPostings, planRefundPostings } = await import("#src/services/commerce-payments.service.js");

const ORDER_ID = "order-1";
const AMOUNT = 9_600_000n;

/** The two rails a payment intent may exist on. The other two are refused at creation. */
const PAYABLE_RAILS = ["direct_processor", "internal_custody"] as const;
const UNPAYABLE_RAILS = ["direct_offline", "external_escrow"] as const;

describe("A41 · a payment posts only what its rail permits", () => {
  for (const rail of PAYABLE_RAILS) {
    it(`plans a settlement on ${rail} naming only permitted accounts`, () => {
      const permitted = COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL[rail];
      const posted = planSettlementPostings(rail, ORDER_ID, AMOUNT).flatMap((posting) =>
        posting.lines.map((line) => line.accountKind),
      );

      expect(posted.length).toBeGreaterThan(0);
      for (const accountKind of posted) {
        expect(permitted).toContain(accountKind);
      }
    });

    it(`plans a refund on ${rail} naming only permitted accounts`, () => {
      const permitted = COMMERCE_JOURNAL_ACCOUNT_KINDS_BY_RAIL[rail];
      const posted = planRefundPostings(rail, ORDER_ID, AMOUNT).flatMap((posting) =>
        posting.lines.map((line) => line.accountKind),
      );

      expect(posted.length).toBeGreaterThan(0);
      for (const accountKind of posted) {
        expect(permitted).toContain(accountKind);
      }
    });

    it(`balances every planned entry on ${rail} to zero`, () => {
      const planned = [
        ...planSettlementPostings(rail, ORDER_ID, AMOUNT),
        ...planRefundPostings(rail, ORDER_ID, AMOUNT),
      ];

      for (const posting of planned) {
        const total = posting.lines.reduce((sum, line) => sum + line.signedAmountInCents, 0n);
        expect(total).toBe(0n);
        // `appendCommerceJournalEntry` throws on a zero-amount line before it throws on anything else.
        expect(posting.lines.every((line) => line.signedAmountInCents !== 0n)).toBe(true);
      }
    });
  }

  for (const rail of UNPAYABLE_RAILS) {
    it(`refuses to plan anything on ${rail}, which takes no payment intent`, () => {
      expect(() => planSettlementPostings(rail, ORDER_ID, AMOUNT)).toThrow(/takes no payment intent/);
      expect(() => planRefundPostings(rail, ORDER_ID, AMOUNT)).toThrow(/takes no payment intent/);
    });
  }
});

describe("A41 · the direct_processor rail settles buyer to seller", () => {
  it("posts funding into released, with NO custody hop", () => {
    const [posting, ...rest] = planSettlementPostings("direct_processor", ORDER_ID, AMOUNT);

    expect(rest).toHaveLength(0);
    // `direct_settled` was minted for this in Phase 14 and had no writer until A41.
    expect(posting?.kind).toBe("direct_settled");
    expect(posting?.lines).toEqual([
      { accountKind: "settlement_funding_memo", signedAmountInCents: -AMOUNT },
      { accountKind: "settlement_released_memo", signedAmountInCents: AMOUNT },
    ]);
  });

  it("never names custody, because nobody is holding the money", () => {
    const planned = [
      ...planSettlementPostings("direct_processor", ORDER_ID, AMOUNT),
      ...planRefundPostings("direct_processor", ORDER_ID, AMOUNT),
    ].flatMap((posting) => posting.lines.map((line) => line.accountKind));

    expect(planned).not.toContain("settlement_custody_memo");
  });

  it("returns a refund out of released, in ONE entry", () => {
    const [posting, ...rest] = planRefundPostings("direct_processor", ORDER_ID, AMOUNT);

    expect(rest).toHaveLength(0);
    expect(posting?.lines).toEqual([
      { accountKind: "settlement_released_memo", signedAmountInCents: -AMOUNT },
      { accountKind: "settlement_refunded_memo", signedAmountInCents: AMOUNT },
    ]);
  });

  it("keeps the memo identity across a settlement and a full refund", () => {
    /**
     * `funding + custody + released + refunded = 0`, per order, always — the identity
     * `verify-store-phase-14-constraints` asserts against live data. Checked here across the two
     * events together, because each is balanced on its own and the identity is about the pair.
     */
    const everyLine = [
      ...planSettlementPostings("direct_processor", ORDER_ID, AMOUNT),
      ...planRefundPostings("direct_processor", ORDER_ID, AMOUNT),
    ].flatMap((posting) => posting.lines);

    const memoTotal = everyLine
      .filter((line) => line.accountKind.startsWith("settlement_"))
      .reduce((sum, line) => sum + line.signedAmountInCents, 0n);

    expect(memoTotal).toBe(0n);
  });
});

describe("A41 · the frozen rail still posts what it always did", () => {
  it("keeps buyer_clearing → order_held for a historical order", () => {
    // Backing Phase 14 out has to stay a data edit rather than a deploy, and a replayed webhook
    // for a pre-Phase-14 order must post what THAT order's rail permits.
    const [posting] = planSettlementPostings("internal_custody", ORDER_ID, AMOUNT);

    expect(posting?.kind).toBe("payment_settled");
    expect(posting?.lines).toEqual([
      { accountKind: "buyer_clearing", signedAmountInCents: -AMOUNT },
      { accountKind: "order_held", signedAmountInCents: AMOUNT },
    ]);
  });

  it("keeps the two-entry refund, because the money really did stop here", () => {
    expect(planRefundPostings("internal_custody", ORDER_ID, AMOUNT)).toHaveLength(2);
  });

  it("never posts seller_payable, which Phase 14 asserts stays unposted", () => {
    const planned = [
      ...planSettlementPostings("internal_custody", ORDER_ID, AMOUNT),
      ...planRefundPostings("internal_custody", ORDER_ID, AMOUNT),
    ].flatMap((posting) => posting.lines.map((line) => line.accountKind));

    expect(planned).not.toContain("seller_payable");
  });
});
