import { describe, expect, it, vi } from "vitest";

// The controller imports its services, which pull in the db pool at module scope. Stub the
// modules so the schemas can be parsed without a configured environment — nothing here
// calls a handler. Same arrangement as workshop.controller.schemas.test.ts.
vi.mock("#src/services/compensation.service.js", () => ({}));
vi.mock("#src/services/escrow-releases.service.js", () => ({}));
vi.mock("#src/services/escrow-settlement.service.js", () => ({}));
vi.mock("#src/services/escrow.service.js", () => ({}));
vi.mock("#src/services/funding-rounds.service.js", () => ({}));
vi.mock("#src/services/investor-confidence.service.js", () => ({}));
vi.mock("#src/services/milestones.service.js", () => ({}));
vi.mock("#src/services/platform-role.service.js", () => ({}));
vi.mock("#src/services/project-membership.service.js", () => ({}));

const {
  CreateFundingRoundSchema,
  CreatePledgeSchema,
  MilestoneSchema,
  MilestoneVarianceSchema,
  UpdateMilestoneSchema,
} = await import("#src/controllers/funding.controller.js");

/**
 * The §7 boundary (R_AND_D_BACKEND_STRUCTURE.md §7, §13, §17 steps 4 and 8).
 *
 * WHY THIS FILE EXISTS. §7 enumerates 27 keys "so a reviewer can grep for them on the
 * pledge body", and the controller carries a comment asserting all 27 are rejected. A
 * comment claiming a key is rejected and a test proving it are different artifacts, and
 * only one of them fails when somebody adds a field.
 *
 * These schemas are the ONLY thing between a hostile client and the money path. §0: the
 * frontend runs in the user's browser, is untrusted and potentially hostile, and can fire
 * raw HTTP at any endpoint. Every assertion below is a request somebody will eventually
 * send.
 */

/** §7's list, verbatim and in its published order. */
const REJECTED_KEYS = [
  "backerUserId",
  "userId",
  "projectId",
  "currency",
  "platformFeeInCents",
  "netToEscrowInCents",
  "feeInCents",
  "status",
  "verificationStatus",
  "equityBasisPoints",
  "sliceCount",
  "slices",
  "raisedAmountInCents",
  "percentageFunded",
  "percentageFundedBasisPoints",
  "backersCount",
  "escrowAccountId",
  "journalEntryId",
  "ledgerEntryId",
  "providerTransferId",
  "payoutDestinationId",
  "paymentMethodId",
  "occurredAt",
  "createdAt",
  "id",
] as const;

describe("the pledge body", () => {
  it("accepts `{ amountInCents }` and nothing else", () => {
    const parsed = CreatePledgeSchema.safeParse({ amountInCents: "5000" });

    expect(parsed.success).toBe(true);
    // The shape §7 specifies, asserted as a whole rather than key by key: an extra
    // ACCEPTED key would pass a per-key check and still widen the surface.
    expect(parsed.success && Object.keys(parsed.data)).toEqual(["amountInCents"]);
  });

  it.each(REJECTED_KEYS)("rejects `%s` rather than silently ignoring it", (rejectedKey) => {
    const parsed = CreatePledgeSchema.safeParse({
      amountInCents: "5000",
      [rejectedKey]: "attacker-supplied",
    });

    // `.strict()`, not `.strip()`. Stripping would accept the request and quietly discard
    // the field, which reads to the attacker exactly like success and tells the operator
    // nothing.
    expect(parsed.success).toBe(false);
  });

  it("rejects the §17 step 4 tampering payload outright", () => {
    // The literal body from §17's verification script: a different currency's magnitude
    // plus somebody else's user id.
    const parsed = CreatePledgeSchema.safeParse({
      amountInCents: "5000",
      currency: "CNY",
      backerUserId: "someone-else",
    });

    expect(parsed.success).toBe(false);

    // `.strict()`'s `unrecognized_keys` is an OBJECT-level issue, so it lands in
    // `formErrors` and NOT in `fieldErrors` — which is precisely why
    // `respondValidationFailed` merges `formErrors` under the reserved key `form`. A test
    // that looked in `fieldErrors` would find `{}` and pass a schema that rejected nothing.
    const formErrors = parsed.success ? [] : parsed.error.flatten().formErrors;
    // BOTH unknown keys named in one response, not just the first — a 422 that reports one
    // of two problems sends the client back for a second round trip.
    expect(formErrors.join(" ")).toContain("currency");
    expect(formErrors.join(" ")).toContain("backerUserId");
  });

  it("refuses a fractional or negative amount", () => {
    // A decimal STRING, not `z.number()`: a JS number would accept 120.5 for a value that
    // must be whole cents, and would lose precision past 2^53 (§4b).
    expect(CreatePledgeSchema.safeParse({ amountInCents: "120.5" }).success).toBe(false);
    expect(CreatePledgeSchema.safeParse({ amountInCents: "-5000" }).success).toBe(false);
    expect(CreatePledgeSchema.safeParse({ amountInCents: 5000 }).success).toBe(false);
    expect(CreatePledgeSchema.safeParse({ amountInCents: "" }).success).toBe(false);
  });

  it("carries a bigint-safe amount across the wire without precision loss", () => {
    // 15 digits — past 2^53, where a JS number silently rounds.
    const enormous = "999999999999999";
    const parsed = CreatePledgeSchema.safeParse({ amountInCents: enormous });

    expect(parsed.success).toBe(true);
    expect(parsed.success && BigInt(parsed.data.amountInCents).toString()).toBe(enormous);
  });
});

describe("the funding round body", () => {
  it("accepts a founder's own goal — a negotiated input, like a seller setting a price", () => {
    const parsed = CreateFundingRoundSchema.safeParse({
      type: "crowdfunding",
      title: "Seed round",
      goalAmountInCents: "500000",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects every server-owned figure", () => {
    const base = { type: "crowdfunding", title: "Seed round", goalAmountInCents: "500000" };

    for (const rejectedKey of [
      "raisedAmountInCents",
      "backersCount",
      "percentageFunded",
      "percentageFundedBasisPoints",
      "currency",
      "status",
      "projectId",
      "id",
    ]) {
      expect(
        CreateFundingRoundSchema.safeParse({ ...base, [rejectedKey]: "1" }).success,
        `${rejectedKey} must be rejected`,
      ).toBe(false);
    }
  });

  it("rejects a round type outside the enum", () => {
    // The REGULATORY gate is `ENABLED_FUNDING_ROUND_TYPES` at the service; this is only
    // the shape check. Both exist, and the service one is the load-bearing half.
    expect(
      CreateFundingRoundSchema.safeParse({
        type: "ico",
        title: "Seed round",
        goalAmountInCents: "500000",
      }).success,
    ).toBe(false);
  });
});

describe("the milestone bodies", () => {
  it("accepts a founder's own release amount", () => {
    expect(
      MilestoneSchema.safeParse({
        title: "400-vendor demand survey",
        plannedPayoutInCents: "250000",
      }).success,
    ).toBe(true);
  });

  it("has no `status` field on the update body", () => {
    // `status` moves through `/complete`, which writes `completedAt` in the same statement.
    // A PATCH that could set `done` without a completion instant would produce a milestone
    // an escrow release could be approved against with no record of when the work finished.
    expect(UpdateMilestoneSchema.safeParse({ status: "done" }).success).toBe(false);
    expect(UpdateMilestoneSchema.safeParse({ completedAt: new Date().toISOString() }).success).toBe(false);
  });

  it("has no `varianceBasisPoints` field — the server computes it (§15)", () => {
    const validVariance = {
      plannedDurationDays: 30,
      actualDurationDays: 38,
      plannedCostInCents: "100000",
      actualCostInCents: "126000",
      plannedEffortMinutes: 9_600,
      actualEffortMinutes: 12_100,
    };

    expect(MilestoneVarianceSchema.safeParse(validVariance).success).toBe(true);
    expect(MilestoneVarianceSchema.safeParse({ ...validVariance, varianceBasisPoints: -2600 }).success).toBe(false);
    // The mock's pre-rendered string, which §15 deletes outright.
    expect(MilestoneVarianceSchema.safeParse({ ...validVariance, varianceLabel: "26% behind" }).success).toBe(false);
  });

  it("refuses negative variance integers", () => {
    expect(
      MilestoneVarianceSchema.safeParse({
        plannedDurationDays: -1,
        actualDurationDays: 38,
        plannedCostInCents: "100000",
        actualCostInCents: "126000",
        plannedEffortMinutes: 9_600,
        actualEffortMinutes: 12_100,
      }).success,
    ).toBe(false);
  });
});

describe("the §17 step 8 zero-trust sweep", () => {
  it("has no schema through which a client can name a formula-produced number", () => {
    // §17 step 8: grep every Zod schema for `userId|equity|slice|Cents|score|verdict|status`
    // and confirm each hit is a documented negotiated-input exception.
    //
    // The `…Cents` hits in this file are all NEGOTIATED INPUTS a founder owns — a goal, a
    // milestone payout, a planned/actual cost — the same class as a seller setting
    // `priceInCents` in STORE §4, plus the ONE pledge amount, which the server re-bounds
    // against the round before it is believed.
    //
    // What matters is the absence, so it is asserted rather than described:
    const derivedFigures = [
      "equityBasisPoints",
      "sliceCount",
      "slices",
      "verificationStatus",
      "verdict",
      "score",
      "confidenceBasisPoints",
      "varianceBasisPoints",
      "raisedAmountInCents",
      "platformFeeInCents",
      "netToEscrowInCents",
    ];

    const everySchema = [
      ["CreatePledgeSchema", CreatePledgeSchema, { amountInCents: "5000" }],
      [
        "CreateFundingRoundSchema",
        CreateFundingRoundSchema,
        { type: "crowdfunding", title: "R", goalAmountInCents: "1" },
      ],
      ["MilestoneSchema", MilestoneSchema, { title: "M", plannedPayoutInCents: "1" }],
      ["UpdateMilestoneSchema", UpdateMilestoneSchema, {}],
    ] as const;

    for (const [schemaName, schema, validBody] of everySchema) {
      for (const derivedFigure of derivedFigures) {
        expect(
          schema.safeParse({ ...validBody, [derivedFigure]: "1" }).success,
          `${schemaName} must reject ${derivedFigure}`,
        ).toBe(false);
      }
    }
  });
});
