import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

/**
 * The audit append only ever inserts, so a two-call chain is the whole surface it
 * touches. Stubbing it on the db module rather than hand-rolling an executor keeps the
 * call site honestly typed — `db` carries its real declared type here, so the test
 * exercises the same signature production does.
 */
const insertedRowsRef = vi.hoisted(() => ({ rows: [] as unknown[] }));

const transactionStub = vi.hoisted(() => ({
  insert: () => ({
    values: (row: unknown) => {
      insertedRowsRef.rows.push(row);
      return { returning: () => Promise.resolve([{ id: "audit_1" }]) };
    },
  }),
}));

vi.mock("#src/db/index.js", () => ({
  db: {
    // Handing the stub to the callback is what lets the test call the service with a
    // correctly typed transaction and no type assertion anywhere.
    transaction: (run: (transaction: unknown) => Promise<unknown>) => run(transactionStub),
  },
  pool: {},
}));

const { db } = await import("#src/db/index.js");
const { appendCommerceOrganizationAuditEntry } = await import("#src/services/commerce-organization-audit.service.js");

type AuditAppendInput = Parameters<typeof appendCommerceOrganizationAuditEntry>[1];

function buildAppendInput(payload: AuditAppendInput["payload"]): AuditAppendInput {
  return {
    organizationId: "commerce_org_1",
    eventKind: "address_changed",
    actorUserId: "user_1",
    actorMemberRoleSnapshot: "owner",
    targetEntityType: "commerce_organization_address",
    targetEntityId: "address_1",
    payload,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("commerce organization audit payload guard", () => {
  beforeEach(() => {
    insertedRowsRef.rows.length = 0;
  });

  /**
   * REGRESSION. `createAddress` used to pass `addressKind` as a payload key. The guard
   * tests keys against a PII-name regex that includes `address`, so the append failed,
   * `appendAuditOrThrow` threw, and the whole address-creation transaction rolled back —
   * every call to `POST /commerce/organizations/:id/addresses` failed at runtime.
   *
   * The route suite mocks this service, so nothing caught it. This test does.
   */
  it("accepts the address-creation payload shape", async () => {
    const appended = await db.transaction(async (transaction) =>
      appendCommerceOrganizationAuditEntry(
        transaction,
        buildAppendInput({ action: "created", kind: "delivery", isDefault: true }),
      ),
    );

    expect(appended).toEqual({ success: true, value: { auditEntryId: "audit_1" } });
    expect(insertedRowsRef.rows).toHaveLength(1);
  });

  it("still refuses a payload key that names PII", async () => {
    const appended = await db.transaction(async (transaction) =>
      appendCommerceOrganizationAuditEntry(
        transaction,
        buildAppendInput({ action: "created", addressKind: "delivery" }),
      ),
    );

    expect(appended).toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.addressKind" },
    });
    // Nothing reached the database — the guard runs before any write.
    expect(insertedRowsRef.rows).toHaveLength(0);
  });

  it("refuses a PII key nested inside the payload", async () => {
    const appended = await db.transaction(async (transaction) =>
      appendCommerceOrganizationAuditEntry(
        transaction,
        buildAppendInput({ action: "created", contact: { phone: "+91 99999 99999" } }),
      ),
    );

    expect(appended).toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.contact.phone" },
    });
  });
});
