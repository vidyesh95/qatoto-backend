import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveRazorpayReceipt,
  RazorpayCommercePaymentProviderAdapter,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  type RazorpayFetchImplementation,
} from "#src/modules/store/storefront/razorpay-payment-provider.adapter.js";

/**
 * The Razorpay adapter with no network (Store Phase 5, test mode).
 *
 * THE SIGNATURE VECTORS ARE COMPUTED HERE WITH `node:crypto`, NOT WITH THE ADAPTER'S OWN SIGNING
 * HELPER. A test that signs with the code under test agrees with it by construction, including
 * when both are wrong — e.g. hashing `payment_id|order_id`. The order below is the one Razorpay
 * documents: `order_id + "|" + payment_id`.
 */

const KEY_SECRET = "razorpay_test_key_secret_for_unit_tests";
const ORDER_ID = "order_TestOrder123";
const PAYMENT_ID = "pay_TestPayment456";
const IDEMPOTENCY_KEY = "payment_0b7d8f5e-6a0e-4f2b-9d0c-2f5a6c9e1b3d";

function documentedCheckoutSignature(orderId: string, paymentId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchImplementation = vi.fn<RazorpayFetchImplementation>();

function buildAdapter(): RazorpayCommercePaymentProviderAdapter {
  return new RazorpayCommercePaymentProviderAdapter({
    keyId: "rzp_test_UnitTestKey",
    keySecret: KEY_SECRET,
    apiBaseUrl: "https://api.razorpay.test",
    timeoutMs: 1_000,
    fetchImplementation,
  });
}

function requestedUrl(callIndex: number): string {
  const requestTarget = fetchImplementation.mock.calls[callIndex]?.[0];
  if (requestTarget === undefined) return "";
  if (typeof requestTarget === "string") return requestTarget;
  return requestTarget instanceof URL ? requestTarget.toString() : requestTarget.url;
}

/** The JSON body the adapter sent, parsed; `null` when there was no string body. */
function requestedJsonBody(callIndex: number): unknown {
  const requestBody = fetchImplementation.mock.calls[callIndex]?.[1]?.body;
  return typeof requestBody === "string" ? JSON.parse(requestBody) : null;
}

function requestedInit(callIndex: number): RequestInit | undefined {
  return fetchImplementation.mock.calls[callIndex]?.[1];
}

const CREATE_INPUT = {
  idempotencyKey: IDEMPOTENCY_KEY,
  amountInCents: 50_000,
  currency: "inr",
  orderId: "qatoto_order_1",
  paymentIntentId: "qatoto_pi_1",
};

describe("verifyRazorpayCheckoutSignature", () => {
  it("accepts the documented order_id|payment_id HMAC", () => {
    const result = verifyRazorpayCheckoutSignature({
      razorpayOrderId: ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: documentedCheckoutSignature(ORDER_ID, PAYMENT_ID, KEY_SECRET),
      keySecret: KEY_SECRET,
    });

    expect(result).toEqual({ success: true, value: true });
  });

  it.each([
    {
      name: "the operands swapped",
      signature: documentedCheckoutSignature(PAYMENT_ID, ORDER_ID, KEY_SECRET),
      expectedError: "SIGNATURE_MISMATCH",
    },
    {
      name: "another order's signature",
      signature: documentedCheckoutSignature("order_SomeoneElse", PAYMENT_ID, KEY_SECRET),
      expectedError: "SIGNATURE_MISMATCH",
    },
    {
      name: "the wrong secret",
      signature: documentedCheckoutSignature(ORDER_ID, PAYMENT_ID, "not_the_secret"),
      expectedError: "SIGNATURE_MISMATCH",
    },
    { name: "a truncated signature", signature: "abc123", expectedError: "SIGNATURE_MALFORMED" },
    { name: "uppercase hex", signature: "A".repeat(64), expectedError: "SIGNATURE_MALFORMED" },
    { name: "an empty signature", signature: "", expectedError: "SIGNATURE_MALFORMED" },
  ])("rejects $name", ({ signature, expectedError }) => {
    const result = verifyRazorpayCheckoutSignature({
      razorpayOrderId: ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: signature,
      keySecret: KEY_SECRET,
    });

    expect(result.success ? null : result.error.type).toBe(expectedError);
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  const rawBody = Buffer.from('{"event":"order.paid","payload":{}}', "utf8");
  const webhookSecret = "razorpay_webhook_secret";

  it("accepts an HMAC over the raw bytes", () => {
    const signatureHeader = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

    expect(verifyRazorpayWebhookSignature({ rawBody, signatureHeader, webhookSecret })).toEqual({
      success: true,
      value: true,
    });
  });

  it.each([
    { name: "a missing header", signatureHeader: undefined, expectedError: "SIGNATURE_MALFORMED" },
    {
      name: "a signature over re-serialized JSON",
      signatureHeader: createHmac("sha256", webhookSecret)
        .update(JSON.stringify(JSON.parse(rawBody.toString("utf8")), null, 2))
        .digest("hex"),
      expectedError: "SIGNATURE_MISMATCH",
    },
  ])("rejects $name", ({ signatureHeader, expectedError }) => {
    const result = verifyRazorpayWebhookSignature({ rawBody, signatureHeader, webhookSecret });

    expect(result.success ? null : result.error.type).toBe(expectedError);
  });
});

describe("deriveRazorpayReceipt", () => {
  it("fits Razorpay's 40-character receipt cap for a real transfer key and is deterministic", () => {
    const receipt = deriveRazorpayReceipt(IDEMPOTENCY_KEY);

    expect(IDEMPOTENCY_KEY.length).toBeGreaterThan(40);
    expect(receipt).toHaveLength(40);
    expect(receipt).toBe(createHash("sha256").update(IDEMPOTENCY_KEY).digest("hex").slice(0, 40));
    expect(deriveRazorpayReceipt(IDEMPOTENCY_KEY)).toBe(receipt);
  });
});

describe("RazorpayCommercePaymentProviderAdapter", () => {
  beforeEach(() => {
    fetchImplementation.mockReset();
  });

  describe("createPaymentIntent", () => {
    it("refuses an amount below Razorpay's 100-paise minimum without calling Razorpay", async () => {
      const result = await buildAdapter().createPaymentIntent({ ...CREATE_INPUT, amountInCents: 99 });

      expect(result).toEqual({
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "amount_below_razorpay_minimum" },
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("creates an order with Basic auth and answers requires_action — the buyer has not paid yet", async () => {
      fetchImplementation
        .mockResolvedValueOnce(jsonResponse(200, { entity: "collection", count: 0, items: [] }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            id: ORDER_ID,
            status: "created",
            receipt: deriveRazorpayReceipt(IDEMPOTENCY_KEY),
          }),
        );

      const result = await buildAdapter().createPaymentIntent(CREATE_INPUT);

      expect(result).toEqual({
        success: true,
        value: { providerPaymentRef: ORDER_ID, state: "requires_action", failureReason: null },
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(requestedUrl(0)).toBe(
        `https://api.razorpay.test/v1/orders?receipt=${deriveRazorpayReceipt(IDEMPOTENCY_KEY)}`,
      );
      expect(requestedUrl(1)).toBe("https://api.razorpay.test/v1/orders");
      expect(requestedInit(1)?.method).toBe("POST");
      expect(requestedInit(1)?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from(`rzp_test_UnitTestKey:${KEY_SECRET}`).toString("base64")}`,
      });
      expect(requestedJsonBody(1)).toEqual({
        amount: 50_000,
        currency: "INR",
        receipt: deriveRazorpayReceipt(IDEMPOTENCY_KEY),
        notes: { qatotoOrderId: "qatoto_order_1", qatotoPaymentIntentId: "qatoto_pi_1" },
      });
    });

    it("returns the existing order when the receipt lookup already sees it (best effort; see the adapter docblock)", async () => {
      fetchImplementation.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [{ id: ORDER_ID, status: "paid", receipt: deriveRazorpayReceipt(IDEMPOTENCY_KEY) }],
        }),
      );

      const result = await buildAdapter().createPaymentIntent(CREATE_INPUT);

      expect(result).toEqual({
        success: true,
        value: { providerPaymentRef: ORDER_ID, state: "settled", failureReason: null },
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    it.each([
      {
        name: "401 as an authentication rejection",
        response: () => jsonResponse(401, { error: { description: "Authentication failed" } }),
        expectedError: { type: "PROVIDER_REJECTED", reason: "razorpay_authentication_failed" },
      },
      {
        name: "400 with Razorpay's own description",
        response: () => jsonResponse(400, { error: { description: "Currency is not supported" } }),
        expectedError: { type: "PROVIDER_REJECTED", reason: "Currency is not supported" },
      },
      {
        name: "503 as retryable",
        response: () => jsonResponse(503, {}),
        expectedError: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_http_503" },
      },
      {
        name: "429 as retryable",
        response: () => jsonResponse(429, {}),
        expectedError: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_http_429" },
      },
      {
        name: "an unparsable 200 as retryable",
        response: () => jsonResponse(200, { unexpected: true }),
        expectedError: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_response_unparsable" },
      },
    ])("maps $name", async ({ response, expectedError }) => {
      fetchImplementation.mockResolvedValueOnce(response());

      const result = await buildAdapter().createPaymentIntent(CREATE_INPUT);

      expect(result).toEqual({ success: false, error: expectedError });
    });

    it("maps a thrown fetch (timeout, socket reset) to a retryable failure", async () => {
      fetchImplementation.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

      const result = await buildAdapter().createPaymentIntent(CREATE_INPUT);

      expect(result).toEqual({
        success: false,
        error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_request_failed" },
      });
    });
  });

  describe("retrievePaymentIntent", () => {
    it.each([
      { orderStatus: "created", expectedState: "requires_action" },
      // A declined card leaves the order `attempted`; the buyer may retry in the same modal.
      { orderStatus: "attempted", expectedState: "requires_action" },
      { orderStatus: "paid", expectedState: "settled" },
    ])("maps order status $orderStatus to $expectedState", async ({ orderStatus, expectedState }) => {
      fetchImplementation.mockResolvedValueOnce(jsonResponse(200, { id: ORDER_ID, status: orderStatus }));

      const result = await buildAdapter().retrievePaymentIntent(ORDER_ID);

      expect(result).toEqual({
        success: true,
        value: { providerPaymentRef: ORDER_ID, state: expectedState, failureReason: null },
      });
      expect(requestedUrl(0)).toBe(`https://api.razorpay.test/v1/orders/${ORDER_ID}`);
    });

    it("refuses a reference that is not an order id before it reaches a URL path", async () => {
      const result = await buildAdapter().retrievePaymentIntent("../payments/pay_x");

      expect(result).toEqual({
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: "../payments/pay_x" },
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    });

    it("maps 404 to PROVIDER_NOT_FOUND", async () => {
      fetchImplementation.mockResolvedValueOnce(jsonResponse(404, { error: { description: "not found" } }));

      const result = await buildAdapter().retrievePaymentIntent(ORDER_ID);

      expect(result).toEqual({
        success: false,
        error: { type: "PROVIDER_NOT_FOUND", providerRef: ORDER_ID },
      });
    });
  });

  describe("createRefund", () => {
    const REFUND_INPUT = {
      idempotencyKey: "refund_5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      amountInCents: 20_000,
      currency: "INR",
      providerPaymentRef: ORDER_ID,
      refundId: "qatoto_refund_1",
      paymentIntentId: "qatoto_pi_1",
    };

    it("refunds the order's captured payment", async () => {
      fetchImplementation
        .mockResolvedValueOnce(
          jsonResponse(200, {
            items: [
              { id: "pay_Failed1", status: "failed", amount: 50_000 },
              { id: PAYMENT_ID, status: "captured", amount: 50_000 },
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { items: [] }))
        .mockResolvedValueOnce(jsonResponse(200, { id: "rfnd_Refund1", status: "pending" }));

      const result = await buildAdapter().createRefund(REFUND_INPUT);

      expect(result).toEqual({
        success: true,
        value: { providerRefundRef: "rfnd_Refund1", state: "processing", failureReason: null },
      });
      expect(requestedUrl(2)).toBe(`https://api.razorpay.test/v1/payments/${PAYMENT_ID}/refund`);
      expect(requestedJsonBody(2)).toMatchObject({
        amount: 20_000,
        receipt: deriveRazorpayReceipt(REFUND_INPUT.idempotencyKey),
      });
    });

    it("returns the existing refund for a retried call instead of refunding twice", async () => {
      fetchImplementation
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: PAYMENT_ID, status: "captured", amount: 50_000 }] }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            items: [
              {
                id: "rfnd_Refund1",
                status: "processed",
                receipt: deriveRazorpayReceipt(REFUND_INPUT.idempotencyKey),
              },
            ],
          }),
        );

      const result = await buildAdapter().createRefund(REFUND_INPUT);

      expect(result).toEqual({
        success: true,
        value: { providerRefundRef: "rfnd_Refund1", state: "settled", failureReason: null },
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    });

    it("refuses when the order has no captured payment", async () => {
      fetchImplementation.mockResolvedValueOnce(
        jsonResponse(200, { items: [{ id: "pay_Failed1", status: "failed", amount: 50_000 }] }),
      );

      const result = await buildAdapter().createRefund(REFUND_INPUT);

      expect(result).toEqual({
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: "razorpay_order_has_no_captured_payment" },
      });
    });
  });
});
