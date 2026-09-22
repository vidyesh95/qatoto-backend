import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const requestEscrowReleaseMock = vi
  .fn<(transaction: unknown, orderId: string) => Promise<{ readonly requested: readonly string[] }>>()
  .mockResolvedValue({ requested: ["escrow_outbox_1", "escrow_outbox_2"] });
vi.mock("#src/modules/store/orders/commerce-escrow.service.js", () => ({
  requestEscrowReleaseForCompletedOrder: (transaction: unknown, orderId: string) =>
    requestEscrowReleaseMock(transaction, orderId),
}));
vi.mock("#src/modules/store/orders/commerce-sample-credit.service.js", () => ({
  mintSampleCreditsForOrder: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const {
  isOrderEligibleForCompletion,
  isProductLineEligibleForCompletion,
  isServiceEngagementEligibleForCompletion,
  issueCompletionsForOrder,
} = await import("#src/modules/store/orders/commerce-completion.service.js");

type TransactionParam = Parameters<typeof issueCompletionsForOrder>[0];

type MockOrder = {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly state: string;
};

/**
 * The transaction seam is cast because a drizzle handle cannot be built by hand; the stub
 * answers only the chains `issueCompletionsForOrder` walks, and every candidate query
 * resolves empty so the test isolates the escrow branch from the insert paths.
 */
function createMockTransaction(order: MockOrder): TransactionParam {
  const transactionStub = {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_condition?: unknown) =>
          Object.assign(Promise.resolve([]), {
            limit: (_n: number) => Promise.resolve([order]),
          }),
      }),
    }),
    insert: (_table?: unknown) => ({
      values: (_data?: unknown) => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return transactionStub as unknown as TransactionParam;
}

describe("commerce completion eligibility", () => {
  it("requires delivered product quantity and a terminal line balance", () => {
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 3,
        quantityCancelled: 0,
      }),
    ).toBe(true);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 1,
        quantityCancelled: 2,
      }),
    ).toBe(true);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 0,
        quantityCancelled: 3,
      }),
    ).toBe(false);
    expect(
      isProductLineEligibleForCompletion({
        quantityOrdered: 3,
        quantityFulfilled: 1,
        quantityCancelled: 0,
      }),
    ).toBe(false);
  });

  it("requires payment-confirmed, non-disputed orders", () => {
    expect(isOrderEligibleForCompletion("pending_payment")).toBe(false);
    expect(isOrderEligibleForCompletion("payment_processing")).toBe(false);
    expect(isOrderEligibleForCompletion("confirmed")).toBe(true);
    expect(isOrderEligibleForCompletion("in_fulfillment")).toBe(true);
    expect(isOrderEligibleForCompletion("partially_completed")).toBe(true);
    expect(isOrderEligibleForCompletion("completed")).toBe(true);
    expect(isOrderEligibleForCompletion("disputed")).toBe(false);
  });

  it("requires completed service work between different organizations", () => {
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(true);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "in_progress",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_same",
        providerOrganizationId: "commerce_org_same",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "legacy_missing_snapshot",
        requiresDeliverableNormalization: false,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
    expect(
      isServiceEngagementEligibleForCompletion({
        state: "completed",
        executionContractState: "ready",
        requiresDeliverableNormalization: true,
        buyerOrganizationId: "commerce_org_buyer",
        providerOrganizationId: "commerce_org_provider",
      }),
    ).toBe(false);
  });
});

describe("issueCompletionsForOrder escrow release integration", () => {
  it("returns empty escrow outbox ids if buyer and seller are same org", async () => {
    const mockTx = createMockTransaction({
      id: "ord_same_org",
      buyerOrganizationId: "org_alpha",
      counterpartyOrganizationId: "org_alpha",
      state: "completed",
    });

    const result = await issueCompletionsForOrder(mockTx, "ord_same_org", new Date(), null);

    expect(result).toEqual({ escrowReleaseOutboxIds: [] });
    expect(requestEscrowReleaseMock).not.toHaveBeenCalled();
  });

  it("returns empty escrow outbox ids if order state is not eligible for completion", async () => {
    const mockTx = createMockTransaction({
      id: "ord_pending",
      buyerOrganizationId: "org_buyer",
      counterpartyOrganizationId: "org_seller",
      state: "pending_payment",
    });

    const result = await issueCompletionsForOrder(mockTx, "ord_pending", new Date(), null);

    expect(result).toEqual({ escrowReleaseOutboxIds: [] });
    expect(requestEscrowReleaseMock).not.toHaveBeenCalled();
  });

  it("requests escrow release and returns outbox ids when order state is completed", async () => {
    requestEscrowReleaseMock.mockClear();
    const mockTx = createMockTransaction({
      id: "ord_completed",
      buyerOrganizationId: "org_buyer",
      counterpartyOrganizationId: "org_seller",
      state: "completed",
    });

    const result = await issueCompletionsForOrder(mockTx, "ord_completed", new Date(), "user_actor_1");

    expect(requestEscrowReleaseMock).toHaveBeenCalledWith(mockTx, "ord_completed");
    expect(result).toEqual({
      escrowReleaseOutboxIds: ["escrow_outbox_1", "escrow_outbox_2"],
    });
  });

  it("does not request escrow release when order state is in_fulfillment", async () => {
    requestEscrowReleaseMock.mockClear();
    const mockTx = createMockTransaction({
      id: "ord_in_fulfillment",
      buyerOrganizationId: "org_buyer",
      counterpartyOrganizationId: "org_seller",
      state: "in_fulfillment",
    });

    const result = await issueCompletionsForOrder(mockTx, "ord_in_fulfillment", new Date(), "user_actor_1");

    expect(requestEscrowReleaseMock).not.toHaveBeenCalled();
    expect(result).toEqual({ escrowReleaseOutboxIds: [] });
  });
});
