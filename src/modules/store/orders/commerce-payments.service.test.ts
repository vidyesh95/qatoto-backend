import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const queuedSelectResults = vi.hoisted((): unknown[][] => []);

vi.mock("#src/db/index.js", () => {
  const limitMock = vi.fn<() => Promise<unknown[]>>(async () => queuedSelectResults.shift() ?? []);
  const whereMock = vi.fn<() => { limit: typeof limitMock }>(() => ({ limit: limitMock }));
  const fromMock = vi.fn<() => { where: typeof whereMock }>(() => ({ where: whereMock }));
  return {
    db: {
      select: vi.fn<() => { from: typeof fromMock }>(() => ({ from: fromMock })),
    },
    pool: {},
  };
});

const resolveCommercePaymentProvider = vi.hoisted(() => vi.fn<() => unknown>());
vi.mock("#src/modules/store/storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: () => resolveCommercePaymentProvider(),
}));

const { getPaymentIntent } =
  await import("#src/modules/store/orders/commerce-payments.service.js");

import type { CommercePaymentActorContext } from "#src/modules/store/orders/commerce-payments.service.js";

describe("commerce-payments.service", () => {
  describe("getPaymentIntent", () => {
    beforeEach(() => {
      queuedSelectResults.length = 0;
    });

    const actor: CommercePaymentActorContext = {
      organizationId: "org_actor",
      memberId: "member_1",
      memberRole: "admin",
      actorUserId: "user_1",
    };

    it("returns NOT_FOUND if intent does not exist", async () => {
      queuedSelectResults.push([]);

      const result = await getPaymentIntent(actor, "pi_missing");
      expect(result).toEqual({ success: false, error: { type: "NOT_FOUND" } });
    });

    it("returns NOT_FOUND if actor organization is neither buyer nor counterparty", async () => {
      queuedSelectResults.push([
        {
          id: "pi_1",
          buyerOrganizationId: "org_buyer",
          counterpartyOrganizationId: "org_seller",
        },
      ]);

      const result = await getPaymentIntent(actor, "pi_1");
      expect(result).toEqual({ success: false, error: { type: "NOT_FOUND" } });
    });

    it("returns intent projection if actor is the buyer", async () => {
      const intentMock = {
        id: "pi_2",
        orderId: "order_1",
        state: "created",
        amountInCents: 1000,
        currency: "USD",
        provider: "razorpay",
        providerPaymentRef: null,
        failureReason: null,
        authorizedAt: null,
        settledAt: null,
        createdAt: new Date("2024-01-01T00:00:00Z"),
        updatedAt: new Date("2024-01-01T00:00:00Z"),
        buyerOrganizationId: actor.organizationId,
        counterpartyOrganizationId: "org_seller",
      };
      queuedSelectResults.push([intentMock]);

      const result = await getPaymentIntent(actor, "pi_2");
      expect(result).toEqual({
        success: true,
        value: {
          id: intentMock.id,
          orderId: intentMock.orderId,
          state: intentMock.state,
          amountInCents: intentMock.amountInCents,
          currency: intentMock.currency,
          provider: intentMock.provider,
          providerPaymentRef: intentMock.providerPaymentRef,
          failureReason: intentMock.failureReason,
          authorizedAt: intentMock.authorizedAt,
          settledAt: intentMock.settledAt,
          createdAt: intentMock.createdAt,
          updatedAt: intentMock.updatedAt,
        },
      });
    });

    it("returns intent projection if actor is the counterparty", async () => {
      const intentMock = {
        id: "pi_3",
        orderId: "order_2",
        state: "settled",
        amountInCents: 500,
        currency: "EUR",
        provider: "stripe",
        providerPaymentRef: "ch_123",
        failureReason: null,
        authorizedAt: new Date("2024-01-02T00:00:00Z"),
        settledAt: new Date("2024-01-02T00:01:00Z"),
        createdAt: new Date("2024-01-02T00:00:00Z"),
        updatedAt: new Date("2024-01-02T00:01:00Z"),
        buyerOrganizationId: "org_buyer",
        counterpartyOrganizationId: actor.organizationId,
      };
      queuedSelectResults.push([intentMock]);

      const result = await getPaymentIntent(actor, "pi_3");
      expect(result).toEqual({
        success: true,
        value: {
          id: intentMock.id,
          orderId: intentMock.orderId,
          state: intentMock.state,
          amountInCents: intentMock.amountInCents,
          currency: intentMock.currency,
          provider: intentMock.provider,
          providerPaymentRef: intentMock.providerPaymentRef,
          failureReason: intentMock.failureReason,
          authorizedAt: intentMock.authorizedAt,
          settledAt: intentMock.settledAt,
          createdAt: intentMock.createdAt,
          updatedAt: intentMock.updatedAt,
        },
      });
    });
  });
});
