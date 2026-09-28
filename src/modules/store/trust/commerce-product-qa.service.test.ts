import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ensureCommerceProductStatsRow as EnsureCommerceProductStatsRow } from "#src/modules/store/catalog/commerce-product-engagement.service.js";
import type { appendCommerceOrganizationAuditEntry as AppendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

/**
 * The write path of `retractProductAnswer`, below the permission table in
 * `commerce-product-qa.permissions.test.ts`: that the gate runs BEFORE anything is written, that
 * the withdrawal and its audit entry travel together, and that a failed append aborts. The
 * permission rule itself is tested there; this file only proves it is wired in.
 *
 * `db.transaction` runs its callback against a chain fake: every query-builder method returns the
 * chain, and awaiting it yields the rows queued for that statement kind. `update` records the
 * table and the `.set(...)` values so the test can see what was written.
 */
interface RecordedUpdate {
  readonly table: unknown;
  values: unknown;
}

// A function DECLARATION, not a const arrow: `vi.hoisted` below runs before any statement, and a
// declaration is initialized by then, so the hoisted factory can call it.
function chainResolvingTo(result: unknown, onSet?: (values: unknown) => void): object {
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return (...methodArguments: unknown[]) => {
        if (property === "set" && onSet) onSet(methodArguments[0]);
        return proxy;
      };
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy;
}

const fakeDatabase = vi.hoisted(() => {
  const state: {
    selectRows: unknown[];
    updates: RecordedUpdate[];
  } = { selectRows: [], updates: [] };

  const transaction = {
    select: () => chainResolvingTo(state.selectRows),
    update: (table: unknown) => {
      const recorded: RecordedUpdate = { table, values: null };
      state.updates.push(recorded);
      return chainResolvingTo([], (values) => {
        recorded.values = values;
      });
    },
  };

  return {
    state,
    db: {
      transaction: async (callback: (executor: typeof transaction) => Promise<unknown>) => callback(transaction),
    },
  };
});

vi.mock("#src/db/index.js", () => ({ db: fakeDatabase.db, pool: {} }));

const appendCommerceOrganizationAuditEntry = vi.hoisted(() => vi.fn<typeof AppendCommerceOrganizationAuditEntry>());
vi.mock("#src/modules/store/organizations/commerce-organization-audit.service.js", () => ({
  appendCommerceOrganizationAuditEntry,
}));
vi.mock("#src/modules/store/catalog/commerce-product-engagement.service.js", () => ({
  ensureCommerceProductStatsRow: vi.fn<typeof EnsureCommerceProductStatsRow>(async () => undefined),
}));

const { commerceProductAnswer } = await import("#src/db/schema.js");
const { retractProductAnswer } = await import("#src/modules/store/trust/commerce-product-qa.service.js");
const { buildAnswerWithdrawalAuditEntry } = await import("#src/modules/store/trust/commerce-product-qa.permissions.js");

const SELLER_ANSWER_ROW = {
  id: "answer_seller",
  questionId: "question_1",
  authorUserId: "user_seller_author",
  authorKind: "seller" as const,
  authorOrganizationId: "commerce_org_seller",
  productId: "product_1",
};

const VERIFIED_BUYER_ANSWER_ROW = {
  id: "answer_buyer",
  questionId: "question_1",
  authorUserId: "user_buyer_author",
  authorKind: "verified_buyer" as const,
  authorOrganizationId: "commerce_org_buyer",
  productId: "product_1",
};

function findAnswerUpdate(): RecordedUpdate | undefined {
  return fakeDatabase.state.updates.find((update) => update.table === commerceProductAnswer);
}

beforeEach(() => {
  fakeDatabase.state.selectRows = [];
  fakeDatabase.state.updates = [];
  appendCommerceOrganizationAuditEntry.mockReset();
  appendCommerceOrganizationAuditEntry.mockResolvedValue({
    success: true,
    value: { auditEntryId: "audit_1" },
  });
});

describe("retractProductAnswer write path", () => {
  it("lets a seller teammate withdraw the org's answer, and audits it as organization_member", async () => {
    fakeDatabase.state.selectRows = [SELLER_ANSWER_ROW];
    const teammate = {
      userId: "user_seller_teammate",
      organizationId: "commerce_org_seller",
      memberRole: "support" as const,
    };

    const result = await retractProductAnswer(teammate, SELLER_ANSWER_ROW.id);

    expect(result).toEqual({ success: true, value: { answerId: SELLER_ANSWER_ROW.id } });
    expect(findAnswerUpdate()?.values).toMatchObject({ visibilityState: "removed_by_author" });
    expect(appendCommerceOrganizationAuditEntry).toHaveBeenCalledTimes(1);
    const [, auditInput] = appendCommerceOrganizationAuditEntry.mock.calls[0] ?? [];
    expect(auditInput).toEqual(buildAnswerWithdrawalAuditEntry(SELLER_ANSWER_ROW, teammate, auditInput.occurredAt));
    expect(auditInput).toMatchObject({
      organizationId: "commerce_org_seller",
      eventKind: "product_answer_withdrawn",
      actorMemberRoleSnapshot: "support",
      payload: { questionId: "question_1", withdrawnBy: "organization_member" },
    });
  });

  it("lets a verified-buyer author with no active org withdraw, audited on the BUYER org's chain", async () => {
    fakeDatabase.state.selectRows = [VERIFIED_BUYER_ANSWER_ROW];
    const author = { userId: "user_buyer_author", organizationId: null, memberRole: null };

    const result = await retractProductAnswer(author, VERIFIED_BUYER_ANSWER_ROW.id);

    expect(result.success).toBe(true);
    expect(appendCommerceOrganizationAuditEntry).toHaveBeenCalledTimes(1);
    const [, auditInput] = appendCommerceOrganizationAuditEntry.mock.calls[0] ?? [];
    expect(auditInput).toMatchObject({
      organizationId: "commerce_org_buyer",
      actorUserId: "user_buyer_author",
      actorMemberRoleSnapshot: null,
      payload: { withdrawnBy: "author" },
    });
  });

  it("refuses a stranger as NOT_FOUND and writes nothing", async () => {
    fakeDatabase.state.selectRows = [SELLER_ANSWER_ROW];
    const stranger = {
      userId: "user_stranger",
      organizationId: "commerce_org_stranger",
      memberRole: "owner" as const,
    };

    const result = await retractProductAnswer(stranger, SELLER_ANSWER_ROW.id);

    expect(result).toEqual({ success: false, error: { type: "NOT_FOUND" } });
    expect(fakeDatabase.state.updates).toHaveLength(0);
    expect(appendCommerceOrganizationAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses the seller organization on a verified buyer's answer, writing nothing", async () => {
    fakeDatabase.state.selectRows = [VERIFIED_BUYER_ANSWER_ROW];
    const seller = {
      userId: "user_seller_author",
      organizationId: "commerce_org_seller",
      memberRole: "owner" as const,
    };

    const result = await retractProductAnswer(seller, VERIFIED_BUYER_ANSWER_ROW.id);

    expect(result).toEqual({ success: false, error: { type: "NOT_FOUND" } });
    expect(fakeDatabase.state.updates).toHaveLength(0);
    expect(appendCommerceOrganizationAuditEntry).not.toHaveBeenCalled();
  });

  it("throws when the audit append fails, so the transaction rolls the withdrawal back", async () => {
    fakeDatabase.state.selectRows = [SELLER_ANSWER_ROW];
    appendCommerceOrganizationAuditEntry.mockResolvedValue({
      success: false,
      error: { type: "APPEND_FAILED" },
    });
    const author = {
      userId: "user_seller_author",
      organizationId: "commerce_org_seller",
      memberRole: "owner" as const,
    };

    await expect(retractProductAnswer(author, SELLER_ANSWER_ROW.id)).rejects.toThrow(
      /audit append failed: APPEND_FAILED/,
    );
  });
});
