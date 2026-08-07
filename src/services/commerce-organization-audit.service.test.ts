import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { appendCommerceOrganizationAuditEntry } = await import("#src/services/commerce-organization-audit.service.js");

type AuditAppendInput = Parameters<typeof appendCommerceOrganizationAuditEntry>[1];
type AuditExecutor = Parameters<typeof appendCommerceOrganizationAuditEntry>[0];

/**
 * The audit append only ever inserts, so a two-call chain is the whole surface this
 * service touches. Building it by hand keeps the test honest about what it exercises:
 * the payload guard, not Drizzle.
 */
function buildInsertingExecutor(): { executor: AuditExecutor; insertedValues: unknown[] } {
  const insertedValues: unknown[] = [];
  const executor = {
    insert: () => ({
      values: (row: unknown) => {
        insertedValues.push(row);
        return { returning: () => Promise.resolve([{ id: "audit_1" }]) };
      },
    }),
  };
  return { executor: executor as unknown as AuditExecutor, insertedValues };
}

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
  /**
   * REGRESSION. `createAddress` used to pass `addressKind` as a payload key. The guard
   * tests keys against a PII-name regex that includes `address`, so the append failed,
   * `appendAuditOrThrow` threw, and the whole address-creation transaction rolled back —
   * every call to `POST /commerce/organizations/:id/addresses` failed at runtime.
   *
   * The route suite mocks this service, so nothing caught it. This test does.
   */
  it("accepts the address-creation payload shape", async () => {
    const { executor, insertedValues } = buildInsertingExecutor();

    const appended = await appendCommerceOrganizationAuditEntry(
      executor,
      buildAppendInput({ action: "created", kind: "delivery", isDefault: true }),
    );

    expect(appended.success).toBe(true);
    expect(insertedValues).toHaveLength(1);
  });

  it("still refuses a payload key that names PII", async () => {
    const { executor, insertedValues } = buildInsertingExecutor();

    const appended = await appendCommerceOrganizationAuditEntry(
      executor,
      buildAppendInput({ action: "created", addressKind: "delivery" }),
    );

    expect(appended.success).toBe(false);
    if (!appended.success) {
      expect(appended.error).toEqual({ type: "UNSAFE_PAYLOAD", fieldPath: "$.addressKind" });
    }
    // Nothing reached the database — the guard runs before any write.
    expect(insertedValues).toHaveLength(0);
  });

  it("refuses a PII key nested inside the payload", async () => {
    const { executor } = buildInsertingExecutor();

    const appended = await appendCommerceOrganizationAuditEntry(
      executor,
      buildAppendInput({ action: "created", contact: { phone: "+91 99999 99999" } }),
    );

    expect(appended.success).toBe(false);
    if (!appended.success) {
      expect(appended.error).toEqual({ type: "UNSAFE_PAYLOAD", fieldPath: "$.contact.phone" });
    }
  });
});
