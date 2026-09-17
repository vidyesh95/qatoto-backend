import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * `verifyRazorpayCheckout` and `confirmProviderPaymentIntent` — the decisions BEFORE any write
 * (Store Phase 5, Razorpay test mode).
 *
 * WHAT THIS PINS. The order of refusals is the security property: a valid signature for the
 * caller's own cheap order must not settle someone else's expensive intent, a counterparty must
 * not confirm the buyer's payment, and a client's report must never settle anything Razorpay
 * itself does not report paid. Each case asserts not only the refusal but that NOTHING
 * downstream ran — no provider call, no transaction.
 *
 * WHAT IT DOES NOT. The settlement transaction body (journal postings, webhook dedupe) needs a
 * real database; it is the same `applyPaymentSettlement` the outbox path already uses, and the
 * live smoke exercises it end to end.
 */

const KEY_SECRET = "razorpay_service_suite_secret";
stubServerEnvironment({ RAZORPAY_KEY_SECRET: KEY_SECRET });
vi.mock("dotenv/config", () => ({}));

/** Each `db.select()…limit()` resolves the next queued row set, in call order. */
const queuedSelectResults = vi.hoisted((): unknown[][] => []);
const transactionMock = vi.hoisted(() => vi.fn<(callback: (transaction: unknown) => Promise<void>) => Promise<void>>());

vi.mock("#src/db/index.js", () => {
  const limitMock = vi.fn<() => Promise<unknown[]>>(async () => queuedSelectResults.shift() ?? []);
  const whereMock = vi.fn<() => { limit: typeof limitMock }>(() => ({ limit: limitMock }));
  const fromMock = vi.fn<() => { where: typeof whereMock }>(() => ({ where: whereMock }));
  return {
    db: {
      select: vi.fn<() => { from: typeof fromMock }>(() => ({ from: fromMock })),
      transaction: transactionMock,
    },
    pool: {},
  };
});

const retrievePaymentIntent = vi.hoisted(() => vi.fn<(providerPaymentRef: string) => Promise<unknown>>());
const resolveCommercePaymentProvider = vi.hoisted(() => vi.fn<() => unknown>());
vi.mock("#src/modules/store/storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: () => resolveCommercePaymentProvider(),
}));

const { verifyRazorpayCheckout, confirmProviderPaymentIntent } =
  await import("#src/modules/store/orders/commerce-payments.service.js");

const BUYER_ORGANIZATION_ID = "org_buyer";
const RAZORPAY_ORDER_ID = "order_ServiceSuite1";
const RAZORPAY_PAYMENT_ID = "pay_ServiceSuite1";
const NOW = new Date("2026-09-17T10:00:00.000Z");

const BUYER_ACTOR = {
  organizationId: BUYER_ORGANIZATION_ID,
  memberId: "member_buyer",
  memberRole: "buyer" as const,
  actorUserId: "user_buyer",
};

function intentRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "pi_1",
    orderId: "order_1",
    buyerOrganizationId: BUYER_ORGANIZATION_ID,
    counterpartyOrganizationId: "org_seller",
    provider: "razorpay",
    state: "requires_action",
    amountInCents: 50_000,
    currency: "INR",
    providerPaymentRef: RAZORPAY_ORDER_ID,
    failureReason: null,
    authorizedAt: null,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function genuineSignature(orderId: string = RAZORPAY_ORDER_ID): string {
  return createHmac("sha256", KEY_SECRET).update(`${orderId}|${RAZORPAY_PAYMENT_ID}`).digest("hex");
}

function checkoutReport(overrides: Readonly<Record<string, string>> = {}) {
  return {
    razorpayOrderId: RAZORPAY_ORDER_ID,
    razorpayPaymentId: RAZORPAY_PAYMENT_ID,
    razorpaySignature: genuineSignature(),
    ...overrides,
  };
}

function providerReports(state: string) {
  retrievePaymentIntent.mockResolvedValue({
    success: true,
    value: { providerPaymentRef: RAZORPAY_ORDER_ID, state, failureReason: null },
  });
}

describe("verifyRazorpayCheckout", () => {
  beforeEach(() => {
    queuedSelectResults.length = 0;
    vi.clearAllMocks();
    transactionMock.mockResolvedValue(undefined);
    resolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: { providerName: "razorpay", retrievePaymentIntent },
    });
  });

  it.each([
    { name: "an unknown intent", rows: [], actor: BUYER_ACTOR, expectedError: "NOT_FOUND" },
    {
      name: "another organization's intent",
      rows: [intentRow({ buyerOrganizationId: "org_someone_else" })],
      actor: BUYER_ACTOR,
      expectedError: "NOT_FOUND",
    },
    {
      // The counterparty may READ the intent (getPaymentIntent) but never confirm its payment.
      name: "the seller side of the order",
      rows: [intentRow()],
      actor: { ...BUYER_ACTOR, organizationId: "org_seller" },
      expectedError: "NOT_FOUND",
    },
    {
      name: "a buyer-organization member without a paying role",
      rows: [intentRow()],
      actor: { ...BUYER_ACTOR, memberRole: "seller" as const },
      expectedError: "FORBIDDEN",
    },
    {
      name: "a non-Razorpay intent",
      rows: [intentRow({ provider: "fake" })],
      actor: BUYER_ACTOR,
      expectedError: "INVALID_STATE",
    },
    {
      name: "a genuine signature for a DIFFERENT Razorpay order",
      rows: [intentRow()],
      actor: BUYER_ACTOR,
      report: checkoutReport({
        razorpayOrderId: "order_CallersCheapOrder",
        razorpaySignature: genuineSignature("order_CallersCheapOrder"),
      }),
      expectedError: "CONFLICT",
    },
    {
      name: "a forged signature",
      rows: [intentRow()],
      actor: BUYER_ACTOR,
      report: checkoutReport({ razorpaySignature: "f".repeat(64) }),
      expectedError: "SIGNATURE_MISMATCH",
    },
  ])("refuses $name and asks Razorpay nothing", async ({ rows, actor, report, expectedError }) => {
    queuedSelectResults.push(rows);

    const result = await verifyRazorpayCheckout(actor, "pi_1", report ?? checkoutReport(), NOW);

    expect(result.success ? null : result.error.type).toBe(expectedError);
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("writes nothing when the signature is genuine but Razorpay has not marked the order paid", async () => {
    queuedSelectResults.push([intentRow()], [intentRow()]);
    providerReports("requires_action");

    const result = await verifyRazorpayCheckout(BUYER_ACTOR, "pi_1", checkoutReport(), NOW);

    expect(result.success ? result.value.state : result.error.type).toBe("requires_action");
    expect(retrievePaymentIntent).toHaveBeenCalledWith(RAZORPAY_ORDER_ID);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("settles through one transaction once Razorpay itself reports the order paid", async () => {
    queuedSelectResults.push([intentRow()], [intentRow()], [intentRow({ state: "settled", settledAt: NOW })]);
    providerReports("settled");

    const result = await verifyRazorpayCheckout(BUYER_ACTOR, "pi_1", checkoutReport(), NOW);

    expect(result.success ? result.value.state : result.error.type).toBe("settled");
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("confirmProviderPaymentIntent", () => {
  beforeEach(() => {
    queuedSelectResults.length = 0;
    vi.clearAllMocks();
    transactionMock.mockResolvedValue(undefined);
    resolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: { providerName: "razorpay", retrievePaymentIntent },
    });
  });

  it.each([{ terminalState: "settled" }, { terminalState: "refunded" }, { terminalState: "failed" }])(
    "leaves a $terminalState intent alone without asking the provider",
    async ({ terminalState }) => {
      queuedSelectResults.push([intentRow({ state: terminalState })]);

      const result = await confirmProviderPaymentIntent("pi_1", NOW);

      expect(result.success ? result.value.state : result.error.type).toBe(terminalState);
      expect(retrievePaymentIntent).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it("refuses an intent created under a different provider than the one configured", async () => {
    queuedSelectResults.push([intentRow({ provider: "fake" })]);

    const result = await confirmProviderPaymentIntent("pi_1", NOW);

    expect(result.success ? null : result.error.type).toBe("INVALID_STATE");
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("surfaces an unavailable provider without writing", async () => {
    queuedSelectResults.push([intentRow()]);
    retrievePaymentIntent.mockResolvedValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_http_503" },
    });

    const result = await confirmProviderPaymentIntent("pi_1", NOW);

    expect(result.success ? null : result.error.type).toBe("PROVIDER_UNAVAILABLE");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("surfaces a refused provider configuration (e.g. production) without reading the intent", async () => {
    resolveCommercePaymentProvider.mockReturnValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "refuse-closed in production" },
    });

    queuedSelectResults.push([intentRow()]);

    const result = await confirmProviderPaymentIntent("pi_1", NOW);

    expect(result.success ? null : result.error.type).toBe("PROVIDER_UNAVAILABLE");
    // The queued intent row was never consumed: the refusal came before any read.
    expect(queuedSelectResults).toHaveLength(1);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
