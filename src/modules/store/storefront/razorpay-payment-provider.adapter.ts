import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type {
  CommercePaymentProviderAdapter,
  CommercePaymentProviderError,
  CreateProviderPaymentIntentInput,
  CreateProviderRefundInput,
  NormalizedPaymentIntentState,
  NormalizedRefundState,
  ProviderPaymentIntentResult,
  ProviderRefundResult,
} from "#src/modules/store/storefront/commerce-payment-provider.adapter.js";
import type { Result } from "#src/types/index.js";

/**
 * Razorpay Standard Checkout behind the commerce payment adapter seam (Store Phase 5).
 *
 * TEST MODE ONLY. `resolveCommercePaymentProvider` refuses this adapter in production and
 * refuses an `rzp_live_` key everywhere: §14 still blocks real processors, and without
 * Razorpay Route a captured payment settles into Qatoto's own merchant account — custody,
 * which the store has decided never to take.
 *
 * ## How a Razorpay payment maps onto the intent lifecycle
 *
 * A Razorpay ORDER is the provider reference (`providerPaymentRef = order_…`). Creating it
 * moves no money: the buyer still has to complete the Checkout modal in the browser. So
 * `createPaymentIntent` answers `requires_action`, and the intent only settles once
 * Razorpay reports the order `paid` — observed through `retrievePaymentIntent`, never
 * through a client claim or a webhook body.
 *
 * ## Why `fetch` and not the `razorpay` npm SDK
 *
 * The SDK's responses are loosely typed, so consuming them would need `as` casts that
 * CLAUDE.md §4 forbids. Four endpoints over Basic auth are not worth that; every response
 * here is Zod-parsed instead.
 *
 * ## Idempotency
 *
 * The outbox retries. A retried `POST /v1/orders` would mint a SECOND Razorpay order for the
 * same intent, so the adapter first looks the order up by `receipt`, which is derived from
 * OUR idempotency key. Refunds do the same against the payment's refund list.
 */

/** Razorpay rejects orders below one rupee (100 paise). */
export const RAZORPAY_MINIMUM_AMOUNT_IN_MINOR_UNITS = 100;

/**
 * Razorpay caps `receipt` at 40 characters, and our transfer idempotency keys are longer
 * (`payment_<uuid>` is 44). The receipt is therefore DERIVED: the first 40 hex characters of
 * SHA-256 over the key — deterministic, so an outbox retry finds the same order, and 160 bits,
 * so two keys never share a receipt in practice.
 */
const RAZORPAY_RECEIPT_MAX_LENGTH = 40;

export function deriveRazorpayReceipt(idempotencyKey: string): string {
  return createHash("sha256")
    .update(idempotencyKey, "utf8")
    .digest("hex")
    .slice(0, RAZORPAY_RECEIPT_MAX_LENGTH);
}

const RAZORPAY_ORDER_ID_PATTERN = /^order_[A-Za-z0-9]+$/;
const RAZORPAY_PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/;
const RAZORPAY_REFUND_ID_PATTERN = /^rfnd_[A-Za-z0-9]+$/;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const RazorpayOrderSchema = z.object({
  id: z.string().regex(RAZORPAY_ORDER_ID_PATTERN),
  status: z.enum(["created", "attempted", "paid"]),
  receipt: z.string().nullable().optional(),
});
type RazorpayOrder = z.infer<typeof RazorpayOrderSchema>;

const RazorpayOrderCollectionSchema = z.object({
  items: z.array(RazorpayOrderSchema),
});

const RazorpayPaymentSchema = z.object({
  id: z.string().regex(RAZORPAY_PAYMENT_ID_PATTERN),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  amount: z.number().int(),
  amount_refunded: z.number().int().optional(),
});

const RazorpayPaymentCollectionSchema = z.object({
  items: z.array(RazorpayPaymentSchema),
});

const RazorpayRefundSchema = z.object({
  id: z.string().regex(RAZORPAY_REFUND_ID_PATTERN),
  status: z.enum(["pending", "processed", "failed"]),
  receipt: z.string().nullable().optional(),
});
type RazorpayRefund = z.infer<typeof RazorpayRefundSchema>;

const RazorpayRefundCollectionSchema = z.object({
  items: z.array(RazorpayRefundSchema),
});

const RazorpayErrorBodySchema = z.object({
  error: z.object({
    description: z.string().optional(),
  }),
});

export type RazorpayFetchImplementation = typeof globalThis.fetch;

export interface RazorpayAdapterOptions {
  readonly keyId: string;
  readonly keySecret: string;
  readonly apiBaseUrl: string;
  readonly timeoutMs: number;
  /** Injectable so the suite exercises every outcome with no network. */
  readonly fetchImplementation?: RazorpayFetchImplementation;
}

function mapOrderStatus(orderStatus: RazorpayOrder["status"]): NormalizedPaymentIntentState {
  switch (orderStatus) {
    case "created":
    case "attempted":
      // `attempted` includes a failed card: Checkout lets the buyer retry against the same
      // order, so a failed attempt is NOT a failed intent.
      return "requires_action";
    case "paid":
      return "settled";
    default: {
      const exhaustiveCheck: never = orderStatus;
      throw new Error(`Unhandled Razorpay order status: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function mapRefundStatus(refundStatus: RazorpayRefund["status"]): NormalizedRefundState {
  switch (refundStatus) {
    case "pending":
      return "processing";
    case "processed":
      return "settled";
    case "failed":
      return "failed";
    default: {
      const exhaustiveCheck: never = refundStatus;
      throw new Error(`Unhandled Razorpay refund status: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function toPaymentIntentResult(order: RazorpayOrder): ProviderPaymentIntentResult {
  return { providerPaymentRef: order.id, state: mapOrderStatus(order.status), failureReason: null };
}

function toRefundResult(refund: RazorpayRefund): ProviderRefundResult {
  const state = mapRefundStatus(refund.status);
  return {
    providerRefundRef: refund.id,
    state,
    failureReason: state === "failed" ? "razorpay_refund_failed" : null,
  };
}

type RazorpayRequest =
  | {
      readonly method: "GET";
      readonly path: string;
      readonly query?: Readonly<Record<string, string>>;
    }
  | {
      readonly method: "POST";
      readonly path: string;
      readonly body: Readonly<Record<string, unknown>>;
    };

export class RazorpayCommercePaymentProviderAdapter implements CommercePaymentProviderAdapter {
  readonly providerName = "razorpay" as const;

  private readonly options: RazorpayAdapterOptions;

  constructor(options: RazorpayAdapterOptions) {
    this.options = options;
  }

  async createPaymentIntent(
    input: CreateProviderPaymentIntentInput,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>> {
    if (input.amountInCents < RAZORPAY_MINIMUM_AMOUNT_IN_MINOR_UNITS) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_below_razorpay_minimum" },
      };
    }
    const razorpayReceipt = deriveRazorpayReceipt(input.idempotencyKey);

    const existingOrders = await this.send(
      { method: "GET", path: "/v1/orders", query: { receipt: razorpayReceipt } },
      RazorpayOrderCollectionSchema,
      input.idempotencyKey,
    );
    if (!existingOrders.success) return existingOrders;

    const existingOrder = existingOrders.value.items.find(
      (order) => order.receipt === razorpayReceipt,
    );
    if (existingOrder) {
      return { success: true, value: toPaymentIntentResult(existingOrder) };
    }

    const createdOrder = await this.send(
      {
        method: "POST",
        path: "/v1/orders",
        body: {
          amount: input.amountInCents,
          currency: input.currency.toUpperCase(),
          receipt: razorpayReceipt,
          notes: {
            qatotoOrderId: input.orderId,
            qatotoPaymentIntentId: input.paymentIntentId,
          },
        },
      },
      RazorpayOrderSchema,
      input.idempotencyKey,
    );
    if (!createdOrder.success) return createdOrder;

    return { success: true, value: toPaymentIntentResult(createdOrder.value) };
  }

  async retrievePaymentIntent(
    providerPaymentRef: string,
  ): Promise<Result<ProviderPaymentIntentResult, CommercePaymentProviderError>> {
    // The reference is interpolated into a URL path, so it is re-proven at the point of use.
    if (!RAZORPAY_ORDER_ID_PATTERN.test(providerPaymentRef)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: providerPaymentRef },
      };
    }

    const order = await this.send(
      { method: "GET", path: `/v1/orders/${providerPaymentRef}` },
      RazorpayOrderSchema,
      providerPaymentRef,
    );
    if (!order.success) return order;

    return { success: true, value: toPaymentIntentResult(order.value) };
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
    const razorpayReceipt = deriveRazorpayReceipt(input.idempotencyKey);
    if (!RAZORPAY_ORDER_ID_PATTERN.test(input.providerPaymentRef)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: input.providerPaymentRef },
      };
    }

    const orderPayments = await this.send(
      { method: "GET", path: `/v1/orders/${input.providerPaymentRef}/payments` },
      RazorpayPaymentCollectionSchema,
      input.providerPaymentRef,
    );
    if (!orderPayments.success) return orderPayments;

    // A refunded payment keeps status `refunded` once fully refunded; a partial refund keeps
    // it `captured`. Either one is the payment the money came from.
    const capturedPayment = orderPayments.value.items.find(
      (payment) => payment.status === "captured" || payment.status === "refunded",
    );
    if (!capturedPayment) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "razorpay_order_has_no_captured_payment" },
      };
    }

    const existingRefunds = await this.send(
      { method: "GET", path: `/v1/payments/${capturedPayment.id}/refunds` },
      RazorpayRefundCollectionSchema,
      capturedPayment.id,
    );
    if (!existingRefunds.success) return existingRefunds;

    const existingRefund = existingRefunds.value.items.find(
      (refund) => refund.receipt === razorpayReceipt,
    );
    if (existingRefund) {
      return { success: true, value: toRefundResult(existingRefund) };
    }

    const createdRefund = await this.send(
      {
        method: "POST",
        path: `/v1/payments/${capturedPayment.id}/refund`,
        body: {
          amount: input.amountInCents,
          receipt: razorpayReceipt,
          notes: { qatotoRefundId: input.refundId, qatotoPaymentIntentId: input.paymentIntentId },
        },
      },
      RazorpayRefundSchema,
      capturedPayment.id,
    );
    if (!createdRefund.success) return createdRefund;

    return { success: true, value: toRefundResult(createdRefund.value) };
  }

  async retrieveRefund(
    providerRefundRef: string,
  ): Promise<Result<ProviderRefundResult, CommercePaymentProviderError>> {
    if (!RAZORPAY_REFUND_ID_PATTERN.test(providerRefundRef)) {
      return {
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: providerRefundRef },
      };
    }

    const refund = await this.send(
      { method: "GET", path: `/v1/refunds/${providerRefundRef}` },
      RazorpayRefundSchema,
      providerRefundRef,
    );
    if (!refund.success) return refund;

    return { success: true, value: toRefundResult(refund.value) };
  }

  /**
   * One Razorpay call, classified.
   *
   *   2xx + parsable        → value
   *   401                   → REJECTED (bad keys — retrying cannot help)
   *   404                   → NOT_FOUND
   *   other 4xx             → REJECTED with Razorpay's description
   *   429 / 5xx / throw     → UNAVAILABLE (retryable)
   *   2xx + unparsable      → UNAVAILABLE: a body we cannot read proves nothing
   *
   * The catches are explicit and narrow: a timeout or socket reset must become a retryable
   * Result, not an unhandled rejection that the outbox would log as a crash.
   */
  private async send<ResponseSchema extends z.ZodType>(
    razorpayRequest: RazorpayRequest,
    responseSchema: ResponseSchema,
    providerRefForNotFound: string,
  ): Promise<Result<z.infer<ResponseSchema>, CommercePaymentProviderError>> {
    const requestUrl = new URL(razorpayRequest.path, this.options.apiBaseUrl);
    if (razorpayRequest.method === "GET" && razorpayRequest.query) {
      for (const [queryName, queryValue] of Object.entries(razorpayRequest.query)) {
        requestUrl.searchParams.set(queryName, queryValue);
      }
    }

    const basicCredentials = Buffer.from(
      `${this.options.keyId}:${this.options.keySecret}`,
      "utf8",
    ).toString("base64");
    const fetchImplementation = this.options.fetchImplementation ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchImplementation(requestUrl, {
        method: razorpayRequest.method,
        headers: {
          Authorization: `Basic ${basicCredentials}`,
          Accept: "application/json",
          ...(razorpayRequest.method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(razorpayRequest.method === "POST"
          ? { body: JSON.stringify(razorpayRequest.body) }
          : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_request_failed" },
      };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      if (response.status === 401) {
        return {
          success: false,
          error: { type: "PROVIDER_REJECTED", reason: "razorpay_authentication_failed" },
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: { type: "PROVIDER_NOT_FOUND", providerRef: providerRefForNotFound },
        };
      }
      if (response.status === 429 || response.status >= 500) {
        return {
          success: false,
          error: { type: "PROVIDER_UNAVAILABLE", reason: `razorpay_http_${response.status}` },
        };
      }
      const parsedErrorBody = RazorpayErrorBodySchema.safeParse(responseBody);
      const errorDescription = parsedErrorBody.success
        ? parsedErrorBody.data.error.description
        : undefined;
      return {
        success: false,
        error: {
          type: "PROVIDER_REJECTED",
          reason: errorDescription ?? `razorpay_http_${response.status}`,
        },
      };
    }

    const parsedResponse = responseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      return {
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_response_unparsable" },
      };
    }
    return { success: true, value: parsedResponse.data };
  }
}

export type RazorpaySignatureError =
  | { type: "SIGNATURE_MALFORMED" }
  | { type: "SIGNATURE_MISMATCH" };

/**
 * `timingSafeEqual` THROWS on a length mismatch, so the format is pinned first — a
 * truncated signature must be a rejection, not a 500.
 */
function compareHexDigests(
  expectedDigest: string,
  presentedSignature: string,
): Result<true, RazorpaySignatureError> {
  if (!HEX_SHA256_PATTERN.test(presentedSignature)) {
    return { success: false, error: { type: "SIGNATURE_MALFORMED" } };
  }
  const expectedBuffer = Buffer.from(expectedDigest, "utf8");
  const presentedBuffer = Buffer.from(presentedSignature, "utf8");
  if (expectedBuffer.length !== presentedBuffer.length) {
    return { success: false, error: { type: "SIGNATURE_MISMATCH" } };
  }
  if (!timingSafeEqual(expectedBuffer, presentedBuffer)) {
    return { success: false, error: { type: "SIGNATURE_MISMATCH" } };
  }
  return { success: true, value: true };
}

export interface RazorpayCheckoutSignatureInput {
  readonly razorpayOrderId: string;
  readonly razorpayPaymentId: string;
  readonly razorpaySignature: string;
  readonly keySecret: string;
}

/**
 * The Checkout handler's signature: HMAC-SHA256(`order_id|payment_id`, key secret).
 *
 * A VALID SIGNATURE IS NECESSARY, NOT SUFFICIENT. It proves Razorpay issued this payment id
 * for this order; it does not prove the order is paid, and it does not prove the order
 * belongs to the intent in the URL. The caller checks ownership and re-fetches the order.
 */
export function verifyRazorpayCheckoutSignature(
  input: RazorpayCheckoutSignatureInput,
): Result<true, RazorpaySignatureError> {
  const expectedDigest = createHmac("sha256", input.keySecret)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest("hex");
  return compareHexDigests(expectedDigest, input.razorpaySignature);
}

export interface RazorpayWebhookSignatureInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly webhookSecret: string;
}

/**
 * Webhook signature: HMAC-SHA256(raw body, webhook secret) in `X-Razorpay-Signature`.
 *
 * NOT `verifyWebhookSignature` from `webhook-signature.ts`: Razorpay signs no timestamp, so
 * there is no tolerance window to apply. Replay is bounded instead by the
 * `(provider, provider_event_id)` unique index keyed on `X-Razorpay-Event-Id`, and by the
 * fact that the handler only ever re-fetches state from Razorpay — replaying `order.paid`
 * cannot settle an order Razorpay does not report paid.
 */
export function verifyRazorpayWebhookSignature(
  input: RazorpayWebhookSignatureInput,
): Result<true, RazorpaySignatureError> {
  if (input.signatureHeader === undefined) {
    return { success: false, error: { type: "SIGNATURE_MALFORMED" } };
  }
  const expectedDigest = createHmac("sha256", input.webhookSecret)
    .update(input.rawBody)
    .digest("hex");
  return compareHexDigests(expectedDigest, input.signatureHeader);
}

/** Exposed for tests and the smoke page; Razorpay signs on its own side in real traffic. */
export function signRazorpayCheckoutPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  keySecret: string,
): string {
  return createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
}
