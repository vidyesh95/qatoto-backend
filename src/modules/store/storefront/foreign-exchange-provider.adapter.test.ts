import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { convertAtFixedPointRate, FakeForeignExchangeProviderAdapter } =
  await import("#src/modules/store/storefront/foreign-exchange-provider.adapter.js");

/**
 * §4.7 forbids floating point for money and exchange rates. These tests exist to pin the
 * arithmetic that rule is about, not to exercise the fake — a rate is multiplied by a
 * notional large enough that the last bit of a double is real money.
 */
describe("fixed-point rate conversion", () => {
  it("converts at a scale-6 rate exactly", () => {
    // 1.084700 EUR per USD, on 1,000,000 minor units.
    const converted = convertAtFixedPointRate(1_000_000n, { units: 1_084_700n, scale: 6 });

    expect(converted).toBe(1_084_700n);
  });

  /**
   * The case that motivates the whole rule. In IEEE-754, 0.1 + 0.2 is 0.30000000000000004 and
   * 4_300_000 * 0.1 lands on 430000.00000000006 — a value that rounds correctly today and
   * wrongly at some other notional. Integers have no such cliff.
   */
  it("has no representation error where a double would", () => {
    const converted = convertAtFixedPointRate(4_300_000n, { units: 100_000n, scale: 6 });

    expect(converted).toBe(430_000n);
    expect(Number(converted)).not.toBe(4_300_000 * 0.1 + 0.00000000006);
  });

  /**
   * Rounds DOWN, stated rather than incidental. Every conversion has a remainder and the
   * only defensible thing to do is round one stated way, so the platform neither captures
   * nor gifts a fraction on each trade.
   */
  it("rounds down rather than to nearest", () => {
    // 999_999 * 1.5 = 1_499_998.5 in exact arithmetic.
    const converted = convertAtFixedPointRate(999_999n, { units: 1_500_000n, scale: 6 });

    expect(converted).toBe(1_499_998n);
  });

  it("handles a notional far beyond a double's exact integer range", () => {
    // Larger than Number.MAX_SAFE_INTEGER, which is where a `number` silently loses precision.
    const hugeNotional = 90_071_992_547_409_930n;

    const converted = convertAtFixedPointRate(hugeNotional, { units: 2_000_000n, scale: 6 });

    expect(converted).toBe(180_143_985_094_819_860n);
  });

  it("refuses a scale outside the stored range", () => {
    expect(() => convertAtFixedPointRate(1n, { units: 1n, scale: 13 })).toThrow(/scale/);
    expect(() => convertAtFixedPointRate(1n, { units: 1n, scale: -1 })).toThrow(/scale/);
  });
});

describe("the fake foreign-exchange adapter", () => {
  const adapter = new FakeForeignExchangeProviderAdapter();

  it("quotes a valid pair at an obviously synthetic 1:1", async () => {
    const quoted = await adapter.requestQuote({
      idempotencyKey: "fx_quote_fixed",
      currencyPair: "USD/EUR",
      sellAmountMinorUnits: 250_000n,
    });

    expect(quoted.success).toBe(true);
    if (!quoted.success) return;
    expect(quoted.value.buyAmountMinorUnits).toBe(250_000n);
    expect(quoted.value.state).toBe("quoted");
  });

  it("refuses a malformed pair", async () => {
    const quoted = await adapter.requestQuote({
      idempotencyKey: "fx_quote_bad",
      currencyPair: "dollars-to-euros",
      sellAmountMinorUnits: 100n,
    });

    expect(quoted.success).toBe(false);
    if (quoted.success) return;
    expect(quoted.error.type).toBe("PAIR_NOT_SUPPORTED");
  });

  it("refuses a pair that does not cross currencies", async () => {
    const quoted = await adapter.requestQuote({
      idempotencyKey: "fx_quote_same",
      currencyPair: "USD/USD",
      sellAmountMinorUnits: 100n,
    });

    expect(quoted.success).toBe(false);
  });

  it("refuses a non-positive notional", async () => {
    const quoted = await adapter.requestQuote({
      idempotencyKey: "fx_quote_zero",
      currencyPair: "USD/EUR",
      sellAmountMinorUnits: 0n,
    });

    expect(quoted.success).toBe(false);
  });
});
