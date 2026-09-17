import { config } from "#src/config/index.js";
import { RazorpayCommercePaymentProviderAdapter } from "#src/modules/store/storefront/razorpay-payment-provider.adapter.js";
import type { Result } from "#src/types/index.js";

/**
 * Commerce payment provider adapter seam (STORE_BACKEND_STRUCTURE.md §3 / §9).
 *
 * Controllers and payment services talk only to this interface. The fake adapter is the
 * sole implementation today; a real processor plugs in here without changing journal or
 * order transition code.
 *
 * NO MONEY MOVES through the fake. It mints deterministic provider references and
 * normalized states so the outbox → settle → journal path can be exercised end-to-end.
 * Do not ship client copy that claims a card was charged or funds are escrowed.
 */

export type CommercePaymentProviderName = "fake" | "stripe" | "razorpay";

export type CommercePaymentProviderError =
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "PROVIDER_NOT_FOUND"; providerRef: string };

export type NormalizedPaymentIntentState =
  | "requires_action"
  | "processing"
  | "authorized"
  | "settled"
  | "failed"
  | "cancelled";

export type NormalizedRefundState = "processing" | "settled" | "failed" | "cancelled";

export interface CreateProviderPaymentIntentInput {
  readonly idempotencyKey: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly orderId: string;
  readonly paymentIntentId: string;
}

export interface ProviderPaymentIntentResult {
  readonly providerPaymentRef: string;
  readonly state: NormalizedPaymentIntentState;
  readonly failureReason: string | null;
}

export interface CreateProviderRefundInput {
  readonly idempotencyKey: string;
  readonly amountInCents: number;
  readonly currency: string;
  readonly providerPaymentRef: string;
  readonly refundId: string;
  readonly paymentIntentId: string;
}

export interface ProviderRefundResult {
  readonly providerRefundRef: string;
  readonly state: NormalizedRefundState;
  readonly failureReason: string | null;
}

export interface CommercePaymentProviderAdapter {
  readonly providerName: CommercePaymentProviderName;
  createPaymentIntent(
    input: CreateProviderPaymentIntentInput,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>>;
  retrievePaymentIntent(
    providerPaymentRef: string,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>>;
  createRefund(
    input: CreateProviderRefundInput,
  ): Promise<Result<ProviderRefundResult, CommercePaymentProviderError>>;
  retrieveRefund(
    providerRefundRef: string,
  ): Promise<Result<ProviderRefundResult, CommercePaymentProviderError>>;
}

/**
 * Deterministic fake adapter. Provider refs are derived from OUR idempotency keys so a
 * retried worker call returns the same reference and never looks like a second charge.
 */
export class FakeCommercePaymentProviderAdapter implements CommercePaymentProviderAdapter {
  readonly providerName = "fake" as const;

  async createPaymentIntent(
    input: CreateProviderPaymentIntentInput,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>> {
    if (input.amountInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_must_be_positive" },
      };
    }
    return {
      success: true,
      value: {
        providerPaymentRef: `fake_pi_${input.idempotencyKey}`,
        state: "settled",
        failureReason: null,
      },
    };
  }

  async retrievePaymentIntent(
    providerPaymentRef: string,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>> {
    if (!providerPaymentRef.startsWith("fake_pi_")) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: providerPaymentRef },
      };
    }
    return {
      success: true,
      value: {
        providerPaymentRef,
        state: "settled",
        failureReason: null,
      },
    };
  }

  async createRefund(
    input: CreateProviderRefundInput,
  ): Promise<Result<ProviderRefundResult, CommercePaymentProviderError>> {
    if (input.amountInCents <= 0) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_must_be_positive" },
      };
    }
    if (!input.providerPaymentRef.startsWith("fake_pi_")) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerPaymentRef },
      };
    }
    return {
      success: true,
      value: {
        providerRefundRef: `fake_re_${input.idempotencyKey}`,
        state: "settled",
        failureReason: null,
      },
    };
  }

  async retrieveRefund(
    providerRefundRef: string,
  ): Promise<Result<ProviderRefundResult, CommercePaymentProviderError>> {
    if (!providerRefundRef.startsWith("fake_re_")) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: providerRefundRef },
      };
    }
    return {
      success: true,
      value: {
        providerRefundRef,
        state: "settled",
        failureReason: null,
      },
    };
  }
}

/**
 * Resolves the configured commerce payment adapter.
 *
 * The fake adapter is fail-closed in production: shipping a ledger-only fake as if it
 * were a real processor would imply custody and settlement that did not happen.
 */
export function resolveCommercePaymentProvider(): Result<
  CommercePaymentProviderAdapter,
  CommercePaymentProviderError
> {
  const configuredProvider = config.COMMERCE_PAYMENT_PROVIDER;

  if (configuredProvider === "fake") {
    if (config.NODE_ENV === "production") {
      return {
        success: false,
        error: {
          type: "PROVIDER_UNAVAILABLE",
          reason:
            "COMMERCE_PAYMENT_PROVIDER=fake is refuse-closed in production; configure a real processor before accepting payments.",
        },
      };
    }
    return { success: true, value: new FakeCommercePaymentProviderAdapter() };
  }

  if (configuredProvider === "razorpay") {
    return resolveRazorpayProvider();
  }

  return {
    success: false,
    error: {
      type: "PROVIDER_UNAVAILABLE",
      reason: `Commerce payment provider "${configuredProvider}" is not implemented yet.`,
    },
  };
}

/**
 * Razorpay is TEST MODE ONLY, and each refusal below is deliberate.
 *
 * PRODUCTION: §14 still blocks real processors. Without Razorpay Route a captured payment
 * lands in Qatoto's own merchant account, which is custody — the thing the store decided
 * never to take. Lifting this is a policy change, not a config change.
 *
 * `rzp_live_` KEYS: refused everywhere, so a live key pasted into a staging `.env` cannot
 * move real money through a code path that was never approved to.
 */
function resolveRazorpayProvider(): Result<
  CommercePaymentProviderAdapter,
  CommercePaymentProviderError
> {
  if (config.NODE_ENV === "production") {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          "COMMERCE_PAYMENT_PROVIDER=razorpay is refuse-closed in production until §14 is lifted; without Razorpay Route the platform would hold buyer funds.",
      },
    };
  }

  const razorpayKeyId = config.RAZORPAY_KEY_ID;
  const razorpayKeySecret = config.RAZORPAY_KEY_SECRET;
  if (razorpayKeyId === undefined || razorpayKeySecret === undefined) {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when COMMERCE_PAYMENT_PROVIDER=razorpay.",
      },
    };
  }

  if (!razorpayKeyId.startsWith("rzp_test_")) {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason:
          "Only Razorpay test keys (rzp_test_…) are accepted; live keys are refused until §14 is lifted.",
      },
    };
  }

  return {
    success: true,
    value: new RazorpayCommercePaymentProviderAdapter({
      keyId: razorpayKeyId,
      keySecret: razorpayKeySecret,
      apiBaseUrl: config.RAZORPAY_API_BASE_URL,
      timeoutMs: config.RAZORPAY_TIMEOUT_MS,
    }),
  };
}
