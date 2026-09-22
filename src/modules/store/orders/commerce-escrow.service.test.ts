import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));

const enqueueConnectorCommandMock =
  vi.fn<(tx: unknown, args: Record<string, unknown>) => Promise<{ readonly outboxId: string }>>();
const scheduleConnectorDispatchMock = vi.fn<(outboxId: string) => Promise<void>>();

vi.mock("#src/modules/store/fulfillment/commerce-connector.service.js", () => ({
  enqueueConnectorCommand: (tx: unknown, args: Record<string, unknown>) => enqueueConnectorCommandMock(tx, args),
  scheduleConnectorDispatch: (outboxId: string) => scheduleConnectorDispatchMock(outboxId),
}));

const { requestEscrowReleaseForCompletedOrder, scheduleEscrowCommands } =
  await import("#src/modules/store/orders/commerce-escrow.service.js");

type TransactionParam = Parameters<typeof requestEscrowReleaseForCompletedOrder>[0];

type FakeEscrowSession = {
  readonly id: string;
  readonly orderId: string;
  readonly providerId: string;
  readonly fundedAt: Date | null;
};

type FakeMilestone = {
  readonly id: string;
  readonly sessionId: string;
  readonly state: string;
  readonly sequence: number;
  readonly amountInCents: number;
  readonly currency: string;
};

/**
 * A drizzle transaction handle is not constructible by hand, so the seam is cast — the
 * stub models only the two chains the function under test walks.
 *
 * ⚠️ IT DOES NOT INTERPRET THE QUERY. `milestones` comes back whatever the `state` filter
 * says, so the `locked | verification_pending` selection is asserted by construction here,
 * not proven. A test in this file cannot catch that filter widening.
 */
function createFakeTransaction(
  session: FakeEscrowSession | null,
  milestones: readonly FakeMilestone[],
): TransactionParam {
  const transactionStub = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (_mode: string) => Promise.resolve(session ? [session] : []),
          orderBy: () => Promise.resolve(milestones),
        }),
      }),
    }),
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return transactionStub as unknown as TransactionParam;
}

describe("requestEscrowReleaseForCompletedOrder", () => {
  it("returns empty requested list when no escrow session exists for the order", async () => {
    enqueueConnectorCommandMock.mockClear();
    const fakeTx = createFakeTransaction(null, []);

    const result = await requestEscrowReleaseForCompletedOrder(fakeTx, "ord_no_escrow");

    expect(result).toEqual({ requested: [] });
    expect(enqueueConnectorCommandMock).not.toHaveBeenCalled();
  });

  it("returns empty requested list when escrow session is unfunded (fundedAt is null)", async () => {
    enqueueConnectorCommandMock.mockClear();
    const fakeTx = createFakeTransaction(
      {
        id: "escrow_session_unfunded",
        orderId: "ord_unfunded",
        providerId: "escrow_provider_1",
        fundedAt: null,
      },
      [
        {
          id: "milestone_1",
          sessionId: "escrow_session_unfunded",
          state: "locked",
          sequence: 1,
          amountInCents: 50000,
          currency: "USD",
        },
      ],
    );

    const result = await requestEscrowReleaseForCompletedOrder(fakeTx, "ord_unfunded");

    expect(result).toEqual({ requested: [] });
    expect(enqueueConnectorCommandMock).not.toHaveBeenCalled();
  });

  it("enqueues release commands for releasable milestones and returns outbox IDs", async () => {
    enqueueConnectorCommandMock.mockReset();
    enqueueConnectorCommandMock
      .mockResolvedValueOnce({ outboxId: "outbox_rel_1" })
      .mockResolvedValueOnce({ outboxId: "outbox_rel_2" });

    const session: FakeEscrowSession = {
      id: "escrow_session_funded",
      orderId: "ord_funded",
      providerId: "escrow_provider_1",
      fundedAt: new Date("2026-09-01T10:00:00Z"),
    };

    const releasableMilestones: readonly FakeMilestone[] = [
      {
        id: "milestone_locked",
        sessionId: "escrow_session_funded",
        state: "locked",
        sequence: 1,
        amountInCents: 30000,
        currency: "USD",
      },
      {
        id: "milestone_verification_pending",
        sessionId: "escrow_session_funded",
        state: "verification_pending",
        sequence: 2,
        amountInCents: 70000,
        currency: "USD",
      },
    ];

    const fakeTx = createFakeTransaction(session, releasableMilestones);
    const result = await requestEscrowReleaseForCompletedOrder(fakeTx, "ord_funded");

    expect(result.requested).toEqual(["outbox_rel_1", "outbox_rel_2"]);
    expect(enqueueConnectorCommandMock).toHaveBeenCalledTimes(2);

    expect(enqueueConnectorCommandMock).toHaveBeenNthCalledWith(
      1,
      fakeTx,
      expect.objectContaining({
        providerId: "escrow_provider_1",
        connectorKind: "external_escrow",
        kind: "escrow_request_release",
        orderId: "ord_funded",
        escrowSessionId: "escrow_session_funded",
        escrowMilestoneId: "milestone_locked",
        requestPayload: {
          milestoneId: "milestone_locked",
          amountInCents: 30000,
          currency: "USD",
        },
      }),
    );

    expect(enqueueConnectorCommandMock).toHaveBeenNthCalledWith(
      2,
      fakeTx,
      expect.objectContaining({
        providerId: "escrow_provider_1",
        connectorKind: "external_escrow",
        kind: "escrow_request_release",
        orderId: "ord_funded",
        escrowSessionId: "escrow_session_funded",
        escrowMilestoneId: "milestone_verification_pending",
        requestPayload: {
          milestoneId: "milestone_verification_pending",
          amountInCents: 70000,
          currency: "USD",
        },
      }),
    );
  });
});

describe("scheduleEscrowCommands & post-commit dispatch order", () => {
  it("dispatches all enqueued outbox IDs sequentially", async () => {
    scheduleConnectorDispatchMock.mockReset();
    scheduleConnectorDispatchMock.mockResolvedValue(undefined);

    await scheduleEscrowCommands(["outbox_1", "outbox_2", "outbox_3"]);

    expect(scheduleConnectorDispatchMock).toHaveBeenCalledTimes(3);
    expect(scheduleConnectorDispatchMock).toHaveBeenNthCalledWith(1, "outbox_1");
    expect(scheduleConnectorDispatchMock).toHaveBeenNthCalledWith(2, "outbox_2");
    expect(scheduleConnectorDispatchMock).toHaveBeenNthCalledWith(3, "outbox_3");
  });

  /**
   * THE INVARIANT THIS FILE EXISTS TO PIN: only a function that owns the `db.transaction`
   * may dispatch. `requestEscrowReleaseForCompletedOrder` runs INSIDE somebody else's
   * transaction, so a dispatch from here would hand a worker an outbox row that is not
   * visible yet — and, if the transaction later rolls back, one that never exists at all.
   * It enqueues and returns ids; `scheduleEscrowCommands` is the caller's job after commit.
   */
  it("never dispatches from inside the transaction; it only enqueues and returns ids", async () => {
    enqueueConnectorCommandMock.mockReset();
    enqueueConnectorCommandMock.mockResolvedValue({ outboxId: "outbox_committed" });
    scheduleConnectorDispatchMock.mockReset();
    scheduleConnectorDispatchMock.mockResolvedValue(undefined);

    const fakeTx = createFakeTransaction(
      {
        id: "escrow_session_1",
        orderId: "ord_order_dispatch",
        providerId: "provider_1",
        fundedAt: new Date("2026-09-01T10:00:00Z"),
      },
      [
        {
          id: "milestone_1",
          sessionId: "escrow_session_1",
          state: "locked",
          sequence: 1,
          amountInCents: 10000,
          currency: "USD",
        },
      ],
    );

    const outcome = await requestEscrowReleaseForCompletedOrder(fakeTx, "ord_order_dispatch");

    expect(enqueueConnectorCommandMock).toHaveBeenCalledTimes(1);
    expect(outcome.requested).toEqual(["outbox_committed"]);
    expect(scheduleConnectorDispatchMock).not.toHaveBeenCalled();

    await scheduleEscrowCommands(outcome.requested);

    expect(scheduleConnectorDispatchMock).toHaveBeenCalledWith("outbox_committed");
  });
});
