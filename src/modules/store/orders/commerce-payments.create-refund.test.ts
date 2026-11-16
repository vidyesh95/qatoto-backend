import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * `createRefund` — every refusal BEFORE money moves, and what a successful refund writes.
 *
 * Salvaged from bot PR #16 and rewritten to this repo's test rules. A refund is the one place a
 * caller asks Qatoto to send money back out, so the security properties are the point:
 *
 *   - an organization that is neither buyer nor counterparty learns nothing (NOT_FOUND, not
 *     FORBIDDEN), on both the fresh path and the idempotent-replay path;
 *   - a party without a refund role is refused before any intent is read;
 *   - the amount can never exceed what is still refundable.
 *
 * WHAT IT DOES NOT. Row locking and the real `sum()` need a database. Here every awaited query
 * chain resolves the next queued row set, in call order, so each case states exactly which reads
 * happen and the test fails if the service starts reading something new.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const { queuedQueryResults, insertedRows, transactionMock, createQueryRoot } = vi.hoisted(() => {
  const queuedRows: unknown[][] = [];
  const recordedInsertRows: unknown[] = [];

  /** One query chain. Every builder method returns the chain; awaiting it takes the next result. */
  class QueuedQueryChain implements PromiseLike<unknown[]> {
    select(): this {
      return this;
    }
    from(): this {
      return this;
    }
    where(): this {
      return this;
    }
    for(): this {
      return this;
    }
    limit(): this {
      return this;
    }
    values(insertRow: unknown): this {
      recordedInsertRows.push(insertRow);
      return this;
    }
    returning(): this {
      return this;
    }
    // oxlint-disable-next-line unicorn/no-thenable -- awaiting the chain is the drizzle contract being faked
    then<FulfilledResult = unknown[], RejectedResult = never>(
      onFulfilled?: ((rows: unknown[]) => FulfilledResult | PromiseLike<FulfilledResult>) | null,
      onRejected?: ((reason: unknown) => RejectedResult | PromiseLike<RejectedResult>) | null,
    ): PromiseLike<FulfilledResult | RejectedResult> {
      return Promise.resolve(queuedRows.shift() ?? []).then(onFulfilled, onRejected);
    }
  }

  /** Stands in for both `db` and the transaction handle: each call starts a fresh chain. */
  function buildQueryRoot() {
    return {
      select: () => new QueuedQueryChain(),
      insert: () => new QueuedQueryChain(),
    };
  }

  return {
    queuedQueryResults: queuedRows,
    insertedRows: recordedInsertRows,
    transactionMock: vi.fn<(callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>>(),
    createQueryRoot: buildQueryRoot,
  };
});

vi.mock("#src/db/index.js", () => ({
  db: { ...createQueryRoot(), transaction: transactionMock },
  pool: {},
}));

const resolveCommercePaymentProvider = vi.hoisted(() => vi.fn<() => unknown>());
vi.mock("#src/modules/store/storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: () => resolveCommercePaymentProvider(),
}));

const appendCommerceOrganizationAuditEntry = vi.hoisted(() =>
  vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
);
vi.mock("#src/modules/store/organizations/commerce-organization-audit.service.js", () => ({
  appendCommerceOrganizationAuditEntry: (...args: readonly unknown[]) => appendCommerceOrganizationAuditEntry(...args),
}));

const sendJob = vi.hoisted(() => vi.fn<(...args: readonly unknown[]) => Promise<unknown>>());
vi.mock("#src/lib/jobs.js", async () => {
  const actual = await vi.importActual<typeof import("#src/lib/jobs.js")>("#src/lib/jobs.js");
  return { ...actual, sendJob: (...args: readonly unknown[]) => sendJob(...args) };
});

const { createRefund } = await import("#src/modules/store/orders/commerce-payments.service.js");

const BUYER_ORGANIZATION_ID = "org_buyer";
const COUNTERPARTY_ORGANIZATION_ID = "org_seller";
const ORDER_ID = "order_1";
const IDEMPOTENCY_KEY = "idem_refund_1";
const NOW = new Date("2026-11-16T10:00:00.000Z");

function actorFrom(organizationId: string, memberRole: Parameters<typeof createRefund>[0]["memberRole"]) {
  return { organizationId, memberId: "member_1", memberRole, actorUserId: "user_1" };
}

const BUYER_ACTOR = actorFrom(BUYER_ORGANIZATION_ID, "buyer");

function orderRow() {
  return {
    id: ORDER_ID,
    buyerOrganizationId: BUYER_ORGANIZATION_ID,
    counterpartyOrganizationId: COUNTERPARTY_ORGANIZATION_ID,
  };
}

function settledIntentRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "pi_1",
    orderId: ORDER_ID,
    amountInCents: 1_000,
    currency: "INR",
    providerPaymentRef: "order_Razorpay1",
    ...overrides,
  };
}

function refundRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "refund_1",
    paymentIntentId: "pi_1",
    orderId: ORDER_ID,
    buyerOrganizationId: BUYER_ORGANIZATION_ID,
    state: "created",
    amountInCents: 1_000,
    currency: "INR",
    providerRefundRef: null,
    reason: null,
    failureReason: null,
    settledAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** The total `sumActiveRefundsInCents` reads; Postgres hands `sum()` back as a string. */
function activeRefundTotal(totalInCents: number) {
  return [{ total: String(totalInCents) }];
}

beforeEach(() => {
  queuedQueryResults.length = 0;
  insertedRows.length = 0;
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (callback) => callback(createQueryRoot()));
  resolveCommercePaymentProvider.mockReturnValue({ success: true, value: { providerName: "razorpay" } });
  appendCommerceOrganizationAuditEntry.mockResolvedValue({ success: true, value: undefined });
  sendJob.mockResolvedValue({ success: true, value: { jobId: "job_1" } });
});

describe("createRefund — before the transaction", () => {
  it("surfaces an unavailable provider without reading anything", async () => {
    resolveCommercePaymentProvider.mockReturnValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_not_configured" },
    });

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "razorpay_not_configured" },
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("replays the existing refund for the same idempotency key without a new transaction", async () => {
    queuedQueryResults.push([refundRow()]);

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result.success ? result.value.id : result.error.type).toBe("refund_1");
    expect(transactionMock).not.toHaveBeenCalled();
    expect(queuedQueryResults).toHaveLength(0);
  });

  it("lets the counterparty replay a refund it created on the buyer's order", async () => {
    queuedQueryResults.push([refundRow()], [orderRow()]);

    const result = await createRefund(actorFrom(COUNTERPARTY_ORGANIZATION_ID, "seller"), ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result.success ? result.value.id : result.error.type).toBe("refund_1");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND when an outsider replays someone else's idempotency key", async () => {
    queuedQueryResults.push([refundRow()], [orderRow()]);

    const result = await createRefund(actorFrom("org_outsider", "owner"), ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({ success: false, error: { type: "NOT_FOUND" } });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("createRefund — inside the transaction", () => {
  it("answers NOT_FOUND for a missing order", async () => {
    queuedQueryResults.push([], []);

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({ success: false, error: { type: "NOT_FOUND" } });
    expect(insertedRows).toHaveLength(0);
  });

  it("answers NOT_FOUND, not FORBIDDEN, to an organization that is not a party to the order", async () => {
    queuedQueryResults.push([], [orderRow()]);

    const result = await createRefund(actorFrom("org_outsider", "owner"), ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({ success: false, error: { type: "NOT_FOUND" } });
    expect(queuedQueryResults).toHaveLength(0);
    expect(insertedRows).toHaveLength(0);
  });

  it.each([
    { memberRole: "seller" },
    { memberRole: "provider_operator" },
    { memberRole: "support" },
    { memberRole: "viewer" },
  ] as const)("refuses a buyer-side $memberRole before reading the intent", async ({ memberRole }) => {
    queuedQueryResults.push([], [orderRow()], [settledIntentRow()]);

    const result = await createRefund(actorFrom(BUYER_ORGANIZATION_ID, memberRole), ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({ success: false, error: { type: "FORBIDDEN" } });
    // The intent row is still queued: the role check ran first.
    expect(queuedQueryResults).toHaveLength(1);
    expect(insertedRows).toHaveLength(0);
  });

  it.each([{ memberRole: "buyer" }, { memberRole: "support" }, { memberRole: "viewer" }] as const)(
    "refuses a counterparty-side $memberRole before reading the intent",
    async ({ memberRole }) => {
      queuedQueryResults.push([], [orderRow()], [settledIntentRow()]);

      const result = await createRefund(
        actorFrom(COUNTERPARTY_ORGANIZATION_ID, memberRole),
        ORDER_ID,
        IDEMPOTENCY_KEY,
        {},
      );

      expect(result).toStrictEqual({ success: false, error: { type: "FORBIDDEN" } });
      expect(queuedQueryResults).toHaveLength(1);
    },
  );

  it("refuses when no settled payment intent exists", async () => {
    queuedQueryResults.push([], [orderRow()], []);

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result.success ? null : result.error.type).toBe("INVALID_STATE");
    expect(insertedRows).toHaveLength(0);
  });

  it("refuses an intent with no provider reference", async () => {
    queuedQueryResults.push([], [orderRow()], [settledIntentRow({ providerPaymentRef: null })]);

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result.success ? null : result.error.type).toBe("INVALID_STATE");
    expect(insertedRows).toHaveLength(0);
  });

  it("refuses OVER_REFUND with nothing left once the intent is fully refunded", async () => {
    queuedQueryResults.push([], [orderRow()], [settledIntentRow()], activeRefundTotal(1_000));

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, {});

    expect(result).toStrictEqual({ success: false, error: { type: "OVER_REFUND", refundableInCents: 0 } });
    expect(insertedRows).toHaveLength(0);
  });

  it.each([{ amountInCents: 801 }, { amountInCents: 0 }, { amountInCents: -5 }])(
    "refuses a requested $amountInCents against 800 refundable",
    async ({ amountInCents }) => {
      queuedQueryResults.push([], [orderRow()], [settledIntentRow()], activeRefundTotal(200));

      const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, { amountInCents });

      expect(result).toStrictEqual({ success: false, error: { type: "OVER_REFUND", refundableInCents: 800 } });
      expect(insertedRows).toHaveLength(0);
    },
  );

  it("refunds the remaining balance when no amount is given, writing refund, transfer, outbox and audit", async () => {
    queuedQueryResults.push(
      [],
      [orderRow()],
      [settledIntentRow()],
      activeRefundTotal(200),
      [refundRow({ id: "refund_new", amountInCents: 800 })],
      [{ id: "transfer_new" }],
      [{ id: "outbox_new" }],
    );

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, { reason: "damaged" });

    expect(result.success ? result.value : result.error).toMatchObject({ id: "refund_new", amountInCents: 800 });
    expect(insertedRows[0]).toMatchObject({
      paymentIntentId: "pi_1",
      orderId: ORDER_ID,
      buyerOrganizationId: BUYER_ORGANIZATION_ID,
      provider: "razorpay",
      state: "created",
      amountInCents: 800,
      currency: "INR",
      idempotencyKey: IDEMPOTENCY_KEY,
      reason: "damaged",
    });
    expect(insertedRows[1]).toMatchObject({ refundId: "refund_new", direction: "outbound", amountInCents: 800 });
    expect(insertedRows[2]).toMatchObject({
      kind: "submit_refund",
      refundId: "refund_new",
      transferId: "transfer_new",
    });
    expect(appendCommerceOrganizationAuditEntry).toHaveBeenCalledTimes(1);
    expect(sendJob).toHaveBeenCalledTimes(1);
  });

  it("refunds a partial amount exactly at the refundable limit", async () => {
    queuedQueryResults.push(
      [],
      [orderRow()],
      [settledIntentRow()],
      activeRefundTotal(200),
      [refundRow({ id: "refund_new", amountInCents: 800 })],
      [{ id: "transfer_new" }],
      [{ id: "outbox_new" }],
    );

    const result = await createRefund(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY, { amountInCents: 800 });

    expect(result.success ? result.value.amountInCents : result.error.type).toBe(800);
    expect(insertedRows[0]).toMatchObject({ amountInCents: 800 });
  });
});
