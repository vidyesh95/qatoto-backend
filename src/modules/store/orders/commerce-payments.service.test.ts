import { describe, expect, it, vi, beforeEach } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();

const mockResolveCommercePaymentProvider = vi.fn();
vi.mock("#src/modules/store/storefront/commerce-payment-provider.adapter.js", () => ({
  resolveCommercePaymentProvider: () => mockResolveCommercePaymentProvider(),
}));

vi.mock("#src/lib/jobs.js", () => ({
  sendJob: vi.fn().mockResolvedValue({ success: true }),
  JOB_NAMES: { dispatchCommerceWebhookEvent: "dispatchCommerceWebhookEvent" },
  idempotencyKeyFor: { dispatchCommerceWebhookEvent: vi.fn() },
}));

vi.mock("#src/modules/store/organizations/commerce-organization-audit.service.js", () => ({
  appendCommerceOrganizationAuditEntry: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock Database
const mockDb = {
  select: vi.fn(),
  transaction: vi.fn(),
};

vi.mock("#src/db/index.js", () => ({
  db: mockDb,
  pool: {},
}));

const { createRefund } = await import("#src/modules/store/orders/commerce-payments.service.js");

const defaultActor = {
  organizationId: "org_buyer",
  memberId: "mem_1",
  memberRole: "owner" as const,
  actorUserId: "user_1",
};

describe("createRefund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: true,
      value: { providerName: "mock_provider" },
    });
  });

  it("returns error if payment provider fails to resolve", async () => {
    mockResolveCommercePaymentProvider.mockReturnValue({
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "config_missing" },
    });

    const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("PROVIDER_UNAVAILABLE");
    }
  });

  it("returns existing refund if idempotency key matches (success path)", async () => {
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: "refund_1",
            buyerOrganizationId: "org_buyer", // matches actor
            orderId: "order_1",
            paymentIntentId: "intent_1",
            state: "created",
            amountInCents: 1000,
            currency: "usd",
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      }),
    }));

    const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.id).toBe("refund_1");
    }
  });

  it("returns NOT_FOUND if idempotency key matches but actor lacks order access", async () => {
    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: "refund_1",
            buyerOrganizationId: "org_other", // Doesn't match actor
            orderId: "order_1",
            paymentIntentId: "intent_1",
            state: "created",
            amountInCents: 1000,
            currency: "usd",
            createdAt: new Date(),
            updatedAt: new Date(),
          }]),
        }),
      }),
    }));

    mockDb.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            buyerOrganizationId: "org_another",
            counterpartyOrganizationId: "org_yet_another",
          }]),
        }),
      }),
    }));

    const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("NOT_FOUND");
    }
  });

  describe("transactional checks", () => {
    const mockTx = {
      select: vi.fn(),
      insert: vi.fn(),
    };

    beforeEach(() => {
      // Return empty array for idempotency check (no existing refund)
      mockDb.select.mockImplementation(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }));

      // Stub the db transaction to just run the callback
      mockDb.transaction.mockImplementation(async (cb: any) => {
        return await cb(mockTx);
      });
    });

    it("returns NOT_FOUND if order does not exist", async () => {
      mockTx.select.mockImplementation(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([]), // no order found
          }),
        }),
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NOT_FOUND");
      }
    });

    it("returns NOT_FOUND if actor is not buyer or counterparty", async () => {
      mockTx.select.mockImplementation(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([{
              id: "order_1",
              buyerOrganizationId: "org_another",
              counterpartyOrganizationId: "org_yet_another",
            }]),
          }),
        }),
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("NOT_FOUND");
      }
    });

    it("returns FORBIDDEN if actor is buyer but lacks role", async () => {
      mockTx.select.mockImplementation(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([{
              id: "order_1",
              buyerOrganizationId: "org_buyer",
              counterpartyOrganizationId: "org_seller",
            }]),
          }),
        }),
      }));

      const result = await createRefund({ ...defaultActor, memberRole: "member" }, "order_1", "idemp_1", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("FORBIDDEN");
      }
    });

    it("returns INVALID_STATE if no settled payment intent is found", async () => {
      // Mock order query
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([{
              id: "order_1",
              buyerOrganizationId: "org_buyer",
              counterpartyOrganizationId: "org_seller",
            }]),
          }),
        }),
      }));

      // Mock intent query (empty)
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("INVALID_STATE");
      }
    });

    it("returns INVALID_STATE if intent has no provider payment ref", async () => {
      // Mock order query
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve([{
              id: "order_1",
              buyerOrganizationId: "org_buyer",
              counterpartyOrganizationId: "org_seller",
            }]),
          }),
        }),
      }));

      // Mock intent query
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: () => Promise.resolve([{
                id: "intent_1",
                state: "settled",
                providerPaymentRef: null,
              }]),
            }),
          }),
        }),
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("INVALID_STATE");
      }
    });

    it("returns OVER_REFUND if already refunded equals intent amount", async () => {
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([{ id: "order_1", buyerOrganizationId: "org_buyer" }]) }) }),
      }));
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ id: "intent_1", amountInCents: 1000, providerPaymentRef: "ref_1" }]) }) }) }),
      }));
      // mock sumActiveRefundsInCents (total)
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ total: 1000 }]) })
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("OVER_REFUND");
      }
    });

    it("returns OVER_REFUND if requested amount is greater than refundable", async () => {
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([{ id: "order_1", buyerOrganizationId: "org_buyer" }]) }) }),
      }));
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ id: "intent_1", amountInCents: 1000, providerPaymentRef: "ref_1" }]) }) }) }),
      }));
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ total: 200 }]) }) // 800 refundable
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", { amountInCents: 900 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("OVER_REFUND");
      }
    });

    it("successfully creates refund and returns projection", async () => {
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([{ id: "order_1", buyerOrganizationId: "org_buyer" }]) }) }),
      }));
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ for: () => ({ limit: () => Promise.resolve([{ id: "intent_1", amountInCents: 1000, currency: "usd", providerPaymentRef: "ref_1" }]) }) }) }),
      }));
      mockTx.select.mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ total: 200 }]) })
      }));

      mockTx.insert.mockImplementationOnce(() => ({
        values: () => ({ returning: () => Promise.resolve([{ id: "refund_new", amountInCents: 800, currency: "usd", state: "created", createdAt: new Date(), updatedAt: new Date() }]) })
      }));
      mockTx.insert.mockImplementationOnce(() => ({
        values: () => ({ returning: () => Promise.resolve([{ id: "transfer_new" }]) })
      }));
      mockTx.insert.mockImplementationOnce(() => ({
        values: () => ({ returning: () => Promise.resolve([{ id: "outbox_new" }]) })
      }));

      const result = await createRefund(defaultActor, "order_1", "idemp_1", {});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.id).toBe("refund_new");
        expect(result.value.amountInCents).toBe(800);
      }
    });
  });
});
