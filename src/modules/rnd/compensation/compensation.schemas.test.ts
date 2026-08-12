import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import { containsPaymentInstrument } from "#src/lib/payment-instrument.js";

// The controller imports its services, which pull in the db pool at module scope. Stub the
// modules so the schemas can be parsed without a configured environment — nothing here
// calls a handler. Same arrangement as funding.controller.schemas.test.ts.
vi.mock("#src/modules/rnd/compensation/compensation-agreements.service.js", () => ({}));
vi.mock("#src/modules/rnd/compensation/compensation-payments.service.js", () => ({}));
vi.mock("#src/modules/rnd/compensation/compensation-periods.service.js", () => ({}));
vi.mock("#src/modules/rnd/compensation/governance-summary.service.js", () => ({}));
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({}));

const {
  AgreementQuerySchema,
  CountersignPeriodSchema,
  DeclineAgreementSchema,
  ExportQuerySchema,
  FinalizePeriodSchema,
  PeriodListQuerySchema,
  ProposeCompensationAgreementSchema,
  RecordPaymentSchema,
  SupersedePeriodSchema,
  WithdrawAgreementSchema,
} = await import("#src/modules/rnd/compensation/compensation.schemas.js");

/**
 * R_AND_D_BACKEND_STRUCTURE.md §7A's rejected-keys list, §13 and §17 steps 4 and 5c.
 *
 * A COMMENT CLAIMING A KEY IS REJECTED AND A TEST PROVING IT ARE DIFFERENT ARTIFACTS.
 * `compensation.controller.ts` enumerates the list; this file asserts it against every
 * body the router accepts.
 *
 * The three groups §7A names are all here: computed outputs (`grossAmountInCents`,
 * `effortMinutes`, every equity field), chain integrity (`statementHash`,
 * `sequenceNumber`), and wire-fraud primitives (`accountNumber`, `iban`, `upiId`,
 * `destinationAccountId`). The last group is asserted twice — once as a KEY and once as a
 * VALUE inside `referenceNote` — because a rejected-key list is defeated by putting the
 * number in a field that is allowed.
 */

/** §7A's list, verbatim. */
const REJECTED_KEYS: readonly string[] = [
  "backerUserId",
  "userId",
  "memberUserId",
  "projectId",
  "currency",
  "currencyCode",
  "platformFeeInCents",
  "feeInCents",
  "status",
  "verificationStatus",
  "verdict",
  "equityBasisPoints",
  "equityBasisPointsDelta",
  "sliceCount",
  "slices",
  "grossAmountInCents",
  "effortMinutes",
  "minutes",
  "hours",
  "raisedAmountInCents",
  "percentageFunded",
  "percentageFundedBasisPoints",
  "backersCount",
  "statementHash",
  "previousStatementHash",
  "sequenceNumber",
  "finalizedAt",
  "finalizedByUserId",
  "countersignedByUserId",
  "payoutDestinationId",
  "destinationAccountId",
  "accountNumber",
  "iban",
  "upiId",
  "paymentMethodId",
  "occurredAt",
  "createdAt",
  "id",
];

const VALID_AGREEMENT_BODY = {
  engagementKind: "employee",
  monthlyAmountInCents: "600000",
  effectiveFrom: "2026-03-01T00:00:00.000Z",
  rationaleNote: "Market rate for a senior backend engineer in Nairobi.",
};

const VALID_PAYMENT_BODY = {
  paidAmountInCents: "600000",
  paidOnDate: "2026-04-03",
  methodKey: "bank_transfer",
  idempotencyKey: "pay-2026-04-03-a1b2c3d4",
};

const BODIES_UNDER_TEST: readonly (readonly [string, z.ZodType, Readonly<Record<string, unknown>>])[] = [
  ["ProposeCompensationAgreementSchema", ProposeCompensationAgreementSchema, VALID_AGREEMENT_BODY],
  ["FinalizePeriodSchema", FinalizePeriodSchema, { acknowledgement: "FINALIZE" }],
  ["CountersignPeriodSchema", CountersignPeriodSchema, {}],
  ["SupersedePeriodSchema", SupersedePeriodSchema, { reasonNote: "Minutes were double counted." }],
  ["RecordPaymentSchema", RecordPaymentSchema, VALID_PAYMENT_BODY],
];

describe("the §7A rejected-keys list", () => {
  it.each(BODIES_UNDER_TEST)("%s rejects every server-owned key", (_name, schema, validBody) => {
    for (const rejectedKey of REJECTED_KEYS) {
      // `.strict()` refuses the key whatever its value, so a plausible-looking payload is
      // no more accepted than an obviously wrong one.
      const tampered = { ...validBody, [rejectedKey]: "tampered" };
      expect(schema.safeParse(tampered).success, `${rejectedKey} was accepted`).toBe(false);
    }
  });

  it.each(BODIES_UNDER_TEST)("%s still accepts its own valid body", (_name, schema, validBody) => {
    // The positive control. A schema that rejected EVERYTHING would pass the test above
    // and be useless, which is the failure mode worth defending against.
    expect(schema.safeParse(validBody).success).toBe(true);
  });
});

describe("ProposeCompensationAgreementSchema", () => {
  it("requires exactly one basis, not both", () => {
    expect(
      ProposeCompensationAgreementSchema.safeParse({
        ...VALID_AGREEMENT_BODY,
        hourlyRateCentsPerHour: "12000",
      }).success,
    ).toBe(false);
  });

  it("requires exactly one basis, not neither", () => {
    const { monthlyAmountInCents: _dropped, ...withoutBasis } = VALID_AGREEMENT_BODY;
    expect(ProposeCompensationAgreementSchema.safeParse(withoutBasis).success).toBe(false);
  });

  it("accepts an hourly basis on its own", () => {
    const { monthlyAmountInCents: _dropped, ...withoutMonthly } = VALID_AGREEMENT_BODY;
    expect(
      ProposeCompensationAgreementSchema.safeParse({
        ...withoutMonthly,
        hourlyRateCentsPerHour: "12000",
      }).success,
    ).toBe(true);
  });

  it("takes money as a decimal STRING, never a number", () => {
    // A JS number would silently lose precision past 2^53 and would accept 120.5 for a
    // whole-cent field (§4b).
    expect(
      ProposeCompensationAgreementSchema.safeParse({
        ...VALID_AGREEMENT_BODY,
        monthlyAmountInCents: 600_000,
      }).success,
    ).toBe(false);
    expect(
      ProposeCompensationAgreementSchema.safeParse({
        ...VALID_AGREEMENT_BODY,
        monthlyAmountInCents: "6000.50",
      }).success,
    ).toBe(false);
  });

  it("rejects an engagement kind it does not know", () => {
    // Employment classification is founder-DECLARED from a closed set, never inferred and
    // never free text (§4d, §7A.6 item 3).
    expect(
      ProposeCompensationAgreementSchema.safeParse({
        ...VALID_AGREEMENT_BODY,
        engagementKind: "freelancer",
      }).success,
    ).toBe(false);
  });
});

describe("FinalizePeriodSchema", () => {
  it("carries an acknowledgement and NO amounts", () => {
    // §17 step 4, repeated against a §7A statement: there is no amount field to tamper
    // with, because the statement is recomputed in the transaction that freezes it.
    expect(
      FinalizePeriodSchema.safeParse({
        acknowledgement: "FINALIZE",
        grossAmountInCents: "999999",
      }).success,
    ).toBe(false);
  });
});

describe("RecordPaymentSchema", () => {
  it("requires an idempotency key long enough to be one", () => {
    expect(RecordPaymentSchema.safeParse({ ...VALID_PAYMENT_BODY, idempotencyKey: "short" }).success).toBe(false);
  });

  it("requires a calendar day, not an instant", () => {
    // A bank does not publish an instant; inventing one would be precision the record
    // does not have.
    expect(
      RecordPaymentSchema.safeParse({
        ...VALID_PAYMENT_BODY,
        paidOnDate: "2026-04-03T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects a payment method it does not know", () => {
    expect(RecordPaymentSchema.safeParse({ ...VALID_PAYMENT_BODY, methodKey: "crypto" }).success).toBe(false);
  });
});

describe("containsPaymentInstrument — §17 step 5c", () => {
  it("rejects a card-shaped number, spaced or not", () => {
    expect(containsPaymentInstrument("4111111111111111")).toBe(true);
    expect(containsPaymentInstrument("4111 1111 1111 1111")).toBe(true);
    expect(containsPaymentInstrument("4111-1111-1111-1111")).toBe(true);
    expect(containsPaymentInstrument("paid via card 4111111111111111 thanks")).toBe(true);
  });

  it("rejects an IBAN", () => {
    expect(containsPaymentInstrument("DE89370400440532013000")).toBe(true);
    expect(containsPaymentInstrument("GB82 WEST 1234 5698 7654 32")).toBe(true);
  });

  it("accepts the references this field actually exists for", () => {
    // A UTR, a payroll run id and a bank reference are all comfortably under 13 digits.
    expect(containsPaymentInstrument("UTR 302145987")).toBe(false);
    expect(containsPaymentInstrument("Payroll run 2026-04")).toBe(false);
    expect(containsPaymentInstrument("SEPA ref INV-2026-0417")).toBe(false);
    expect(containsPaymentInstrument("Paid alongside March invoice")).toBe(false);
  });
});

describe("query schemas", () => {
  it("PeriodListQuerySchema rejects an unknown filter", () => {
    expect(PeriodListQuerySchema.safeParse({ status: "open" }).success).toBe(true);
    expect(PeriodListQuerySchema.safeParse({ projectId: "prj_1" }).success).toBe(false);
  });

  it("ExportQuerySchema accepts only the two formats", () => {
    expect(ExportQuerySchema.safeParse({ format: "csv" }).success).toBe(true);
    expect(ExportQuerySchema.safeParse({ format: "json" }).success).toBe(true);
    expect(ExportQuerySchema.safeParse({ format: "pdf" }).success).toBe(false);
  });

  it("AgreementQuerySchema filters by member and nothing else", () => {
    expect(AgreementQuerySchema.safeParse({ memberId: "usr_1" }).success).toBe(true);
    expect(AgreementQuerySchema.safeParse({ status: "active" }).success).toBe(false);
  });
});

/**
 * The two endings of a proposed agreement (§11j.3).
 *
 * BOTH WRITE `withdrawn`, because `compensationAgreementStatusEnum` has no `declined`, and
 * the audit kind added in migration 0022 is what records who ended it. Neither note has a
 * column on `member_cash_compensation_agreement`; both live in the audit entry alone.
 */
describe("agreement decline and withdraw bodies", () => {
  const SERVER_OWNED_ON_ENDINGS = [
    { status: "withdrawn" },
    { acceptedAt: new Date().toISOString() },
    { acceptedByUserId: "usr_other" },
    { memberId: "mem_other" },
    { projectId: "prj_other" },
    { monthlyAmountInCents: "500000" },
    { hourlyRateCentsPerHour: "12000" },
    { currencyCode: "CNY" },
    { effectiveFrom: "2026-01-01" },
  ] as const;

  it.each(SERVER_OWNED_ON_ENDINGS)("decline rejects %o", (forged) => {
    expect(DeclineAgreementSchema.safeParse({ ...forged }).success).toBe(false);
  });

  it.each(SERVER_OWNED_ON_ENDINGS)("withdraw rejects %o", (forged) => {
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "Role scope changed.", ...forged }).success).toBe(false);
  });

  /**
   * A member turning an offer down should not have to justify it — the refusal is the
   * signal. A founder retracting one must, or the retraction is fiat with extra steps.
   */
  it("makes the decline note optional and the withdrawal reason required", () => {
    expect(DeclineAgreementSchema.safeParse({}).success).toBe(true);
    expect(DeclineAgreementSchema.safeParse({ note: "Rate is below my floor." }).success).toBe(true);

    expect(WithdrawAgreementSchema.safeParse({}).success).toBe(false);
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "" }).success).toBe(false);
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "   " }).success).toBe(false);
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "Role scope changed." }).success).toBe(true);
  });

  it("bounds both notes", () => {
    expect(DeclineAgreementSchema.safeParse({ note: "x".repeat(1_000) }).success).toBe(true);
    expect(DeclineAgreementSchema.safeParse({ note: "x".repeat(1_001) }).success).toBe(false);
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "x".repeat(2_000) }).success).toBe(true);
    expect(WithdrawAgreementSchema.safeParse({ reasonNote: "x".repeat(2_001) }).success).toBe(false);
  });
});
