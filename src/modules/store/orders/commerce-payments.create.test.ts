import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendJob } from "#src/lib/jobs.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { resolveCommercePaymentProvider } from "#src/modules/store/storefront/commerce-payment-provider.adapter.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/modules/store/organizations/commerce-organization-audit.service.js", () => ({
  appendCommerceOrganizationAuditEntry: vi.fn(),
}));
vi.mock("#src/lib/jobs.js", async (importOriginal) => {
  return {
    ...(await importOriginal<any>()),
    sendJob: vi.fn(),
  };
});

const queuedSelectResults = vi.hoisted((): unknown[][] => []);
const transactionMock = vi.hoisted(() =>
  vi.fn<(callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>>(),
);
const insertMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());

vi.mock("#src/db/index.js", () => {
  const forMock = vi.fn<() => Promise<unknown[]>>(async () => queuedSelectResults.shift() ?? []);
  const limitMock = vi.fn<() => Promise<unknown[]>>(async () => queuedSelectResults.shift() ?? []);
  const whereMock = vi.fn<() => { limit: typeof limitMock; for: typeof forMock }>(() => ({
    limit: limitMock,
    for: forMock,
  }));
  const fromMock = vi.fn<() => { where: typeof whereMock }>(() => ({ where: whereMock }));
  const valuesMock = vi.fn<() => { returning: typeof limitMock }>(() => ({ returning: limitMock }));
  const updateSetMock = vi.fn<() => { where: typeof whereMock }>(() => ({ where: whereMock }));
  const selectMock = vi.fn<() => { from: typeof fromMock }>(() => ({ from: fromMock }));
  insertMock.mockReturnValue({ values: valuesMock });
  updateMock.mockReturnValue({ set: updateSetMock });

  const fakeTransaction = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  };

  transactionMock.mockImplementation(async (cb) => {
    const res = await cb(fakeTransaction);
    if ((res as any)?.status === "not_found") {
      return { status: "not_found" };
    } else if ((res as any)?.status === "invalid_state") {
      return res;
    } else if ((res as any)?.status === "conflict") {
      return res;
    } else if ((res as any)?.intent) {
      return res;
    }
    return res;
  });

  return {
    db: {
      select: selectMock,
      transaction: transactionMock,
    },
    pool: {},
  };
});

vi.mock("#src/modules/store/storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: vi.fn(),
}));

const { createPaymentIntent } = await import("#src/modules/store/orders/commerce-payments.service.js");

const BUYER_ORGANIZATION_ID = "org_buyer";
const ORDER_ID = "order_1";
const IDEMPOTENCY_KEY = "idempotency_1";
const NOW = new Date("2026-09-17T10:00:00.000Z");

const BUYER_ACTOR = {
  organizationId: BUYER_ORGANIZATION_ID,
  memberId: "member_buyer",
  memberRole: "buyer" as const,
  actorUserId: "user_buyer",
};

describe("createPaymentIntent", () => {
  beforeEach(() => {
    queuedSelectResults.length = 0;
    vi.clearAllMocks();
    (resolveCommercePaymentProvider as any).mockReturnValue({
      success: true,
      value: { providerName: "razorpay" },
    });
    (appendCommerceOrganizationAuditEntry as any).mockResolvedValue({ success: true });
    (sendJob as any).mockResolvedValue({ success: true, value: { jobId: "job_1" } });
  });

  it("fails if the actor is not a buyer", async () => {
    const result = await createPaymentIntent({ ...BUYER_ACTOR, memberRole: "guest" } as any, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("FORBIDDEN");
  });

  it("returns existing intent if idempotency key matches", async () => {
    queuedSelectResults.push([
      {
        id: "pi_existing",
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        createdAt: NOW,
        updatedAt: NOW,
        amountInCents: 1000,
      },
    ]);
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(true);
    expect((result as any).value.paymentIntent.id).toBe("pi_existing");
    expect((result as any).value.accepted).toBe(true);
  });

  it("fails if idempotency key matches but belongs to different buyer", async () => {
    queuedSelectResults.push([{ id: "pi_existing", buyerOrganizationId: "org_other" }]);
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("NOT_FOUND");
  });

  it("fails if provider resolution fails", async () => {
    (resolveCommercePaymentProvider as any).mockReturnValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "offline" },
    });
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("PROVIDER_UNAVAILABLE");
  });

  it("fails if the order is not found", async () => {
    queuedSelectResults.push([]); // No existing intent by idempotency key
    queuedSelectResults.push([]); // No order found

    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("NOT_FOUND");
  });

  it("fails if the order belongs to another organization", async () => {
    queuedSelectResults.push([]); // No existing intent by idempotency key
    queuedSelectResults.push([{ buyerOrganizationId: "org_other" }]); // Order found but wrong buyer

    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("NOT_FOUND");
  });

  it("fails if order is not pending payment", async () => {
    queuedSelectResults.push([]);
    queuedSelectResults.push([{ buyerOrganizationId: BUYER_ORGANIZATION_ID, state: "completed" }]);
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("INVALID_STATE");
  });

  it("fails if order total is zero or negative", async () => {
    queuedSelectResults.push([]);
    queuedSelectResults.push([
      {
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        state: "pending_payment",
        settlementRail: "direct_processor",
        totalInCents: 0,
      },
    ]);
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("INVALID_STATE");
  });

  it("fails if settlement rail is refused", async () => {
    queuedSelectResults.push([]);
    queuedSelectResults.push([
      { buyerOrganizationId: BUYER_ORGANIZATION_ID, state: "pending_payment", settlementRail: "direct_offline" },
    ]);
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("INVALID_STATE");
  });

  it("fails if there is an active intent already", async () => {
    queuedSelectResults.push([]);
    queuedSelectResults.push([
      {
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        state: "pending_payment",
        settlementRail: "direct_processor",
        totalInCents: 1000,
      },
    ]);
    queuedSelectResults.push([{ id: "pi_active" }]); // Active intent found
    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(false);
    expect((result as any).error.type).toBe("CONFLICT");
  });

  it("succeeds creating a new payment intent", async () => {
    queuedSelectResults.push([]); // Existing intent check
    queuedSelectResults.push([
      {
        id: ORDER_ID,
        buyerOrganizationId: BUYER_ORGANIZATION_ID,
        counterpartyOrganizationId: "org_seller",
        state: "pending_payment",
        settlementRail: "direct_processor",
        totalInCents: 1000,
        currency: "USD",
      },
    ]); // Order fetch
    queuedSelectResults.push([]); // Active intent check
    queuedSelectResults.push([
      { id: "pi_new", provider: "razorpay", amountInCents: 1000, currency: "USD", createdAt: NOW, updatedAt: NOW },
    ]); // Intent insert
    queuedSelectResults.push([{ id: "transfer_1" }]); // Transfer insert
    queuedSelectResults.push([{ id: "outbox_1" }]); // Outbox insert

    const result = await createPaymentIntent(BUYER_ACTOR, ORDER_ID, IDEMPOTENCY_KEY);
    expect(result.success).toBe(true);
    expect((result as any).value.paymentIntent.id).toBe("pi_new");
    expect((result as any).value.accepted).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(3); // intent, transfer, outbox
    expect(updateMock).toHaveBeenCalledTimes(1); // update order
    expect(appendCommerceOrganizationAuditEntry).toHaveBeenCalledTimes(1); // audit order (or intent)
    expect(sendJob).toHaveBeenCalledTimes(1);
  });
});
