import { describe, expect, it, vi, beforeEach } from "vitest";

const mockResolveCommercePaymentProvider = vi.hoisted(() => vi.fn());

const mockDbUpdate = vi.hoisted(() => vi.fn());
const mockDbSet = vi.hoisted(() => vi.fn());
const mockDbWhere = vi.hoisted(() => vi.fn());
const mockDbTransaction = vi.hoisted(() =>
  vi.fn(async (cb) =>
    cb({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      for: vi.fn().mockResolvedValue([]),
      update: mockDbUpdate,
    }),
  ),
);

mockDbUpdate.mockReturnValue({ set: mockDbSet });
mockDbSet.mockReturnValue({ where: mockDbWhere });
mockDbWhere.mockResolvedValue({});

vi.mock("#src/db/index.js", () => ({
  db: {
    update: mockDbUpdate,
    transaction: mockDbTransaction,
  },
}));

vi.mock("#src/db/schema.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/db/schema.js")>();
  return {
    ...actual,
    commercePaymentOutbox: {
      id: "outbox.id",
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn(),
  };
});

vi.mock("../storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: mockResolveCommercePaymentProvider,
}));

import { processCommercePaymentOutboxRow } from "./commerce-payments.service.js";

describe("processCommercePaymentOutboxRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return false if provider resolution fails", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "testing" },
    });

    const result = await processCommercePaymentOutboxRow("outbox-1");
    expect(result).toEqual({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "testing" },
    });
  });

  it("should return true and processed: false if claim status is not claimed", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: "dummy-adapter",
    });
    // claimPaymentOutboxRow uses db.transaction to return its result.
    mockDbTransaction.mockResolvedValueOnce({ status: "missing" });

    const result = await processCommercePaymentOutboxRow("outbox-1");
    expect(result).toEqual({ success: true, value: { processed: false } });
  });

  it("should return true and processed: false for non-terminal error (unknown kind)", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: "dummy-adapter",
    });

    const mockClaim = {
      status: "claimed",
      outbox: { id: "outbox-1", kind: "unknown_kind", attemptCount: 1 }, // non-terminal
    };
    mockDbTransaction.mockResolvedValueOnce(mockClaim);

    const result = await processCommercePaymentOutboxRow("outbox-1");

    expect(result).toEqual({ success: true, value: { processed: false } });

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        lastError: 'Unhandled outbox kind: "unknown_kind"',
      }),
    );
  });

  it("should return false for terminal error (unknown kind, attempts >= MAX_OUTBOX_ATTEMPTS)", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: "dummy-adapter",
    });

    const mockClaim = {
      status: "claimed",
      outbox: { id: "outbox-1", kind: "unknown_kind", attemptCount: 8 }, // terminal
    };
    mockDbTransaction.mockResolvedValueOnce(mockClaim);

    const result = await processCommercePaymentOutboxRow("outbox-1");

    expect(result).toEqual({
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: 'Unhandled outbox kind: "unknown_kind"' },
    });

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        lastError: 'Unhandled outbox kind: "unknown_kind"',
      }),
    );
  });

  it("should catch errors thrown by internal provider functions and update the outbox row", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: {
        createPaymentIntent: vi.fn().mockRejectedValue(new Error("Provider failed intent")),
        createRefund: vi.fn(),
      },
    });

    const mockClaim = {
      status: "claimed",
      outbox: { id: "outbox-1", kind: "submit_payment_intent", attemptCount: 1 },
      intent: { state: "processing", reference: "ref1", id: "intent1" },
      transfer: { id: "tx1", paymentIntentId: "intent1" },
      order: { id: "order1", cartId: "cart1", totalFormatted: "1.00", deliveryAddressId: "addr1" },
    };
    mockDbTransaction.mockResolvedValueOnce(mockClaim);

    // we will hit the error path from createPaymentIntent which bubbles up to processCommercePaymentOutboxRow's catch block
    const result = await processCommercePaymentOutboxRow("outbox-1");

    expect(result).toEqual({ success: true, value: { processed: false } });

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        lastError: expect.stringContaining("Provider failed intent"),
      }),
    );
  });

  it("should catch missing payment ref error for refund", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: {
        createRefund: vi.fn().mockRejectedValue(new Error("Provider failed refund")),
      },
    });

    const mockClaim = {
      status: "claimed",
      outbox: { id: "outbox-1", kind: "submit_refund", attemptCount: 1 },
      refund: { id: "ref1", amount: 100 },
      transfer: { id: "tx1", paymentIntentId: "intent1" },
      intent: { providerPaymentRef: undefined, id: "intent1" },
      order: { id: "order1" },
    };
    mockDbTransaction.mockResolvedValueOnce(mockClaim);

    const result = await processCommercePaymentOutboxRow("outbox-1");

    expect(result).toEqual({ success: true, value: { processed: false } });

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        lastError: expect.stringContaining("refund requires provider payment ref"),
      }),
    );
  });
});
