import { randomUUID } from "node:crypto";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * Foreign-exchange facilitator adapter seam (STORE_BACKEND_STRUCTURE.md §3, Phase 14c).
 *
 * ## The rule this file exists to enforce
 *
 * §4.7: "rates are fixed-point integers plus an explicit scale or canonical decimal strings
 * parsed by a decimal library on the backend. JavaScript/Postgres floating point is
 * FORBIDDEN for money or exchange rates."
 *
 * There is no `number` rate anywhere below. A rate is `{ units: bigint, scale: number }`,
 * read as `units / 10^scale`, which is exactly the shape `foreign_exchange_deliverable_detail`
 * already stores. The reason is not fastidiousness: 0.1 + 0.2 is not 0.2999999999999999 in a
 * ledger, it is a reconciliation ticket, and an FX rate is multiplied by a notional large
 * enough to turn the last bit into real money.
 *
 * ## What is NOT wired
 *
 * This is a SEAM, not a live integration. No FX facilitator is contracted, so the fake is
 * the only implementation and nothing in the order or engagement state machines calls it
 * yet. It exists so that signing a provider is an adapter plus a registry row rather than a
 * redesign, and so the outbox/inbox substrate has a second shape to prove it is general.
 */

export const FX_PROVIDER_NAMES = ["fake"] as const;

export type ForeignExchangeProviderName = (typeof FX_PROVIDER_NAMES)[number];

export type ForeignExchangeProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "QUOTE_EXPIRED"; providerQuoteRef: string }
  | { type: "PAIR_NOT_SUPPORTED"; currencyPair: string };

/**
 * A rate as `units / 10^scale`. Never a float, never a formatted string.
 *
 * `bigint` rather than `number` because a scale of 8 on a major pair already exceeds what a
 * double represents exactly once multiplied out, and the failure is silent.
 */
export interface FixedPointRate {
  readonly units: bigint;
  readonly scale: number;
}

export type NormalizedFxQuoteState = "quoted" | "locked" | "expired" | "settled" | "cancelled";

export interface RequestFxQuoteInput {
  readonly idempotencyKey: string;
  /** `USD/EUR` — sell the first, buy the second. */
  readonly currencyPair: string;
  readonly sellAmountMinorUnits: bigint;
}

export interface FxQuoteResult {
  readonly providerQuoteRef: string;
  readonly currencyPair: string;
  readonly rate: FixedPointRate;
  readonly sellAmountMinorUnits: bigint;
  readonly buyAmountMinorUnits: bigint;
  readonly state: NormalizedFxQuoteState;
  readonly quoteExpiresAt: Date;
}

export interface LockFxRateInput {
  readonly idempotencyKey: string;
  readonly providerQuoteRef: string;
}

export interface ForeignExchangeProviderAdapter {
  readonly providerName: ForeignExchangeProviderName;
  requestQuote(
    input: RequestFxQuoteInput,
  ): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>>;
  lockRate(input: LockFxRateInput): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>>;
  retrieveQuote(
    providerQuoteRef: string,
  ): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>>;
}

const CURRENCY_PAIR_PATTERN = /^[A-Z]{3}\/[A-Z]{3}$/;

/**
 * Converts a sell amount at a fixed-point rate, in integer arithmetic throughout.
 *
 * ROUNDS DOWN, and says so. Every conversion has a remainder, and the only defensible thing
 * to do with it is round in one stated direction rather than let the platform silently
 * capture or gift a fraction on each trade. Down means the buy side never receives more than
 * the rate strictly entitles it to.
 */
export function convertAtFixedPointRate(
  sellAmountMinorUnits: bigint,
  rate: FixedPointRate,
): bigint {
  if (rate.scale < 0 || rate.scale > 12) {
    throw new Error(`convertAtFixedPointRate: scale ${String(rate.scale)} is out of range`);
  }
  return (sellAmountMinorUnits * rate.units) / 10n ** BigInt(rate.scale);
}

/**
 * Deterministic fake. A flat 1:1 rate at scale 6.
 *
 * A FLAT RATE ON PURPOSE, rather than a plausible-looking invented one. A fake that returned
 * 1.0847 would produce buy amounts that look real in a fixture and are meaningless, and
 * somebody would eventually reconcile against them. 1:1 is obviously synthetic.
 */
export class FakeForeignExchangeProviderAdapter implements ForeignExchangeProviderAdapter {
  readonly providerName = "fake" as const;

  private buildQuote(
    providerQuoteRef: string,
    currencyPair: string,
    sellAmountMinorUnits: bigint,
    state: NormalizedFxQuoteState,
  ): FxQuoteResult {
    const rate: FixedPointRate = { units: 1_000_000n, scale: 6 };
    return {
      providerQuoteRef,
      currencyPair,
      rate,
      sellAmountMinorUnits,
      buyAmountMinorUnits: convertAtFixedPointRate(sellAmountMinorUnits, rate),
      state,
      // Thirty seconds, like a real streaming quote: long enough to accept, short enough
      // that an expiry path is exercised rather than theoretical.
      quoteExpiresAt: new Date(Date.now() + 30_000),
    };
  }

  async requestQuote(
    input: RequestFxQuoteInput,
  ): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>> {
    if (!CURRENCY_PAIR_PATTERN.test(input.currencyPair)) {
      return {
        success: false,
        error: { type: "PAIR_NOT_SUPPORTED", currencyPair: input.currencyPair },
      };
    }
    const [sellCurrency, buyCurrency] = input.currencyPair.split("/");
    if (sellCurrency === buyCurrency) {
      return {
        success: false,
        error: { type: "PAIR_NOT_SUPPORTED", currencyPair: input.currencyPair },
      };
    }
    if (input.sellAmountMinorUnits <= 0n) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "sell_amount_must_be_positive" },
      };
    }
    return {
      success: true,
      value: this.buildQuote(
        `fake_fx_${input.idempotencyKey}`,
        input.currencyPair,
        input.sellAmountMinorUnits,
        "quoted",
      ),
    };
  }

  async lockRate(
    input: LockFxRateInput,
  ): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>> {
    if (!input.providerQuoteRef.startsWith("fake_fx_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_quote_reference" },
      };
    }
    return {
      success: true,
      value: this.buildQuote(input.providerQuoteRef, "USD/USD", 0n, "locked"),
    };
  }

  async retrieveQuote(
    providerQuoteRef: string,
  ): Promise<Result<FxQuoteResult, ForeignExchangeProviderError>> {
    if (!providerQuoteRef.startsWith("fake_fx_")) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "unknown_quote_reference" },
      };
    }
    return {
      success: true,
      value: this.buildQuote(providerQuoteRef, "USD/USD", 0n, "quoted"),
    };
  }
}

export function mintFxIdempotencyKey(purpose: "quote" | "lock"): string {
  return `fx_${purpose}_${randomUUID()}`;
}

/**
 * Refuse-closed in production, like the payment and escrow factories and unlike the document
 * scanner. The asymmetry is deliberate: an absent scanner blocks a feature, whereas a fake FX
 * rate reaching a quote would put an invented exchange rate on a commercial document.
 */
export function resolveForeignExchangeProvider(
  providerSlug: string,
): Result<ForeignExchangeProviderAdapter, ForeignExchangeProviderError> {
  if (providerSlug !== "fake") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Foreign-exchange provider "${providerSlug}" is not implemented yet.`,
      },
    };
  }
  if (config.NODE_ENV === "production") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          'The "fake" foreign-exchange provider is refuse-closed in production; its rates are synthetic and must never reach a commercial document.',
      },
    };
  }
  return { success: true, value: new FakeForeignExchangeProviderAdapter() };
}
