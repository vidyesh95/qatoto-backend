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
    transaction: (run: (transaction: unknown) => Promise<unknown>) =>
      run(transactionStub),
  },
  pool: {},
}));

const { db } = await import("#src/db/index.js");
const { appendCommerceOrganizationAuditEntry } =
  await import("#src/services/commerce-organization-audit.service.js");

type AuditAppendInput = Parameters<
  typeof appendCommerceOrganizationAuditEntry
>[1];

function buildAppendInput(
  payload: AuditAppendInput["payload"],
): AuditAppendInput {
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
        buildAppendInput({
          action: "created",
          kind: "delivery",
          isDefault: true,
        }),
      ),
    );

    expect(appended).toEqual({
      success: true,
      value: { auditEntryId: "audit_1" },
    });
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
        buildAppendInput({
          action: "created",
          contact: { phone: "+91 99999 99999" },
        }),
      ),
    );

    expect(appended).toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.contact.phone" },
    });
  });
});

/**
 * Appendix A13 (Phase 12) payload shapes, asserted DIRECTLY against the guard.
 *
 * These duplicate the literals in commerce-seller-profile.service.ts on purpose, and the
 * duplication is the whole value: the route suite mocks that service, so a payload key the
 * guard rejects produces a runtime throw no type and no route test can see. That is exactly
 * how `addressKind` took address creation down for every caller in Phase 11.
 *
 * The pairs below are deliberate — each "accepts" case sits next to the tempting key that
 * would have failed, so anyone editing a payload can see which spelling is the trap.
 */
describe("A13 seller profile audit payload shapes", () => {
  beforeEach(() => {
    insertedRowsRef.rows.length = 0;
  });

  async function append(payload: AuditAppendInput["payload"]) {
    return db.transaction(async (transaction) =>
      appendCommerceOrganizationAuditEntry(
        transaction,
        buildAppendInput(payload),
      ),
    );
  }

  it("accepts the seller-profile update payload", async () => {
    const appended = await append({
      changedFields: ["businessType", "factoryCount", "yearFounded"],
    });
    expect(appended).toEqual({
      success: true,
      value: { auditEntryId: "audit_1" },
    });
  });

  it("accepts the company-media payload", async () => {
    const appended = await append({
      mediaId: "8f1c6f2e-0000-4000-8000-000000000001",
      mediaKind: "factory",
      position: "0",
    });
    expect(appended).toEqual({
      success: true,
      value: { auditEntryId: "audit_1" },
    });
  });

  /**
   * THE TRAP the media payload is shaped to avoid. `filename` is matched outright; an
   * object storage key is matched by `object.*key`. A Cloudinary upload's most natural
   * payload keys are exactly these two.
   */
  it("refuses the media payload keys a Cloudinary upload invites", async () => {
    await expect(append({ filename: "factory-floor.jpg" })).resolves.toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.filename" },
    });
    await expect(
      append({ objectStorageKey: "qatoto/commerce-organizations/x" }),
    ).resolves.toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.objectStorageKey" },
    });
    expect(insertedRowsRef.rows).toHaveLength(0);
  });

  it("accepts the site-access, stakeholder and capability payloads", async () => {
    await expect(append({ rowCount: "4" })).resolves.toEqual({
      success: true,
      value: { auditEntryId: "audit_1" },
    });
    await expect(
      append({ capabilityKinds: ["oem", "sample_production"] }),
    ).resolves.toEqual({ success: true, value: { auditEntryId: "audit_1" } });
  });

  /**
   * The stakeholder payload carries `rowCount` and NOT the names, which the guard would
   * have allowed — `fullName` matches nothing in the regex. Recording a named individual in
   * immutable history to note that a list was edited is a judgement this test pins down, so
   * that "the guard allows it" is not mistaken for "it belongs there".
   */
  it("documents that the guard would have allowed stakeholder names", async () => {
    await expect(append({ fullName: "A. Patel" })).resolves.toEqual({
      success: true,
      value: { auditEntryId: "audit_1" },
    });
  });

  it("accepts the certification payloads", async () => {
    await expect(
      append({
        certificationId: "8f1c6f2e-0000-4000-8000-000000000002",
        standardName: "ISO 9001:2015",
        evidenceDocumentId: "8f1c6f2e-0000-4000-8000-000000000003",
      }),
    ).resolves.toEqual({ success: true, value: { auditEntryId: "audit_1" } });

    await expect(
      append({
        certificationId: "8f1c6f2e-0000-4000-8000-000000000002",
        standardName: "ISO 9001:2015",
        decision: "rejected",
        reason: "The certificate scan is illegible.",
      }),
    ).resolves.toEqual({ success: true, value: { auditEntryId: "audit_1" } });
  });

  /**
   * `issuerName` is safe, but a certificate's REGISTRATION number is not — and
   * `certificateNumber` passes while `registrationNumber` does not. The submitted payload
   * carries neither, so this pins the boundary rather than the choice.
   */
  it("refuses a certification payload naming a registration number", async () => {
    await expect(
      append({ registrationNumber: "U74999MH2009PTC000000" }),
    ).resolves.toEqual({
      success: false,
      error: { type: "UNSAFE_PAYLOAD", fieldPath: "$.registrationNumber" },
    });
  });
});
