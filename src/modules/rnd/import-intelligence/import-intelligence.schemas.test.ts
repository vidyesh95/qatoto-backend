import { describe, expect, it, vi } from "vitest";

vi.mock("#src/modules/rnd/import-intelligence/import-intelligence.service.js", () => ({}));

const {
  CreateDomesticSubstituteSchema,
  DecidePathwaySuggestionSchema,
  HsCodeSchema,
  ListImportCommoditiesQuerySchema,
  ListLocalizationAssessmentsQuerySchema,
  ListTradeFlowsQuerySchema,
  UpdateDomesticSubstituteSchema,
} = await import("#src/modules/rnd/import-intelligence/import-intelligence.schemas.js");

/**
 * Keys the SERVER owns. None may be accepted in any body on this surface.
 *
 * The score and its components come from `localization-feasibility-score.ts` over Comtrade
 * rows; the rank comes from the nightly job; the model name, prompt version and confidence
 * come from the provider. A body that could set any of them would let a caller publish a
 * feasibility verdict of their own choosing — §6's rule that a ranking signal is an attack
 * surface, applied to this domain.
 */
const SERVER_OWNED_KEYS = [
  "feasibilityScorePoints",
  "importDependencyPoints",
  "exportCapabilityPoints",
  "substituteAvailabilityPoints",
  "supplierCapacityPoints",
  "leadTimeAdvantagePoints",
  "rank",
  "trendDirection",
  "asOf",
  "scoreAlgorithmVersion",
  "modelName",
  "modelVersion",
  "promptVersion",
  "confidenceBps",
  "tradeValueInCents",
  "observedImportValueInCents",
  "currency",
  "publishedAt",
  "createdByUserId",
  "narrativeStatus",
  "dataOrigin",
] as const;

const VALID_CREATE_BODY = {
  hsCode: "854231",
  regionSlug: "india",
  substituteKind: "domestic_component",
  substituteLabel: "Domestic OSAT packaging",
  maturityLevel: "pilot_scale",
  isPublished: true,
} as const;

describe("CreateDomesticSubstituteSchema", () => {
  it("accepts a well-formed body", () => {
    expect(CreateDomesticSubstituteSchema.safeParse(VALID_CREATE_BODY).success).toBe(true);
  });

  it.each(SERVER_OWNED_KEYS)("rejects the server-owned key %s", (rejectedKey) => {
    const parsed = CreateDomesticSubstituteSchema.safeParse({
      ...VALID_CREATE_BODY,
      [rejectedKey]: "anything",
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults isPublished to false — visibility is never a side effect", () => {
    const parsed = CreateDomesticSubstituteSchema.safeParse({
      hsCode: "854231",
      regionSlug: "india",
      substituteKind: "domestic_component",
      substituteLabel: "Domestic OSAT packaging",
      maturityLevel: "pilot_scale",
    });
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data.isPublished).toBe(false);
  });

  it.each([
    ["85423", "five digits"],
    ["8542310", "seven digits"],
    ["85423a", "a letter"],
    ["854-231", "kebab-cased, which an HS code never is"],
  ])("rejects the HS code %s (%s)", (hsCode) => {
    expect(CreateDomesticSubstituteSchema.safeParse({ ...VALID_CREATE_BODY, hsCode }).success).toBe(false);
  });

  it("rejects an unknown maturity level", () => {
    expect(
      CreateDomesticSubstituteSchema.safeParse({
        ...VALID_CREATE_BODY,
        maturityLevel: "production",
      }).success,
    ).toBe(false);
  });

  it("rejects a kebab-cased enum value, which the backend never uses", () => {
    // Enum values are pgEnum labels and are snake_case in both directions.
    expect(
      CreateDomesticSubstituteSchema.safeParse({
        ...VALID_CREATE_BODY,
        substituteKind: "domestic-component",
      }).success,
    ).toBe(false);
  });

  it("rejects a label longer than the column CHECK allows", () => {
    // Matched exactly, so an over-long value is a 422 rather than a 500 from Postgres.
    expect(
      CreateDomesticSubstituteSchema.safeParse({
        ...VALID_CREATE_BODY,
        substituteLabel: "x".repeat(201),
      }).success,
    ).toBe(false);
  });
});

describe("UpdateDomesticSubstituteSchema", () => {
  it("accepts an empty patch", () => {
    expect(UpdateDomesticSubstituteSchema.safeParse({}).success).toBe(true);
  });

  it.each(["hsCode", "regionSlug"])("refuses to move a mapping by changing %s", (immovableKey) => {
    // Moving a mapping is deleting one and creating another; allowing it here would
    // silently invalidate every assessment that counted the original.
    expect(UpdateDomesticSubstituteSchema.safeParse({ [immovableKey]: "something" }).success).toBe(false);
  });

  it("distinguishes clearing a field from leaving it alone", () => {
    const cleared = UpdateDomesticSubstituteSchema.safeParse({ substituteNotes: null });
    if (!cleared.success) throw new Error("expected success");
    expect(cleared.data.substituteNotes).toBeNull();

    const untouched = UpdateDomesticSubstituteSchema.safeParse({});
    if (!untouched.success) throw new Error("expected success");
    expect("substituteNotes" in untouched.data).toBe(false);
  });

  it.each(SERVER_OWNED_KEYS)("rejects the server-owned key %s", (rejectedKey) => {
    expect(UpdateDomesticSubstituteSchema.safeParse({ [rejectedKey]: "anything" }).success).toBe(false);
  });
});

describe("DecidePathwaySuggestionSchema", () => {
  it("accepts the two decisions", () => {
    expect(DecidePathwaySuggestionSchema.safeParse({ decision: "accepted" }).success).toBe(true);
    expect(DecidePathwaySuggestionSchema.safeParse({ decision: "dismissed" }).success).toBe(true);
  });

  it("refuses to reopen a decided suggestion through the body", () => {
    // Reopening is not a decision a moderator makes here; `open` is the initial state only.
    expect(DecidePathwaySuggestionSchema.safeParse({ decision: "open" }).success).toBe(false);
  });

  it.each(SERVER_OWNED_KEYS)("rejects the server-owned key %s", (rejectedKey) => {
    expect(DecidePathwaySuggestionSchema.safeParse({ decision: "accepted", [rejectedKey]: "anything" }).success).toBe(
      false,
    );
  });

  it("rejects a decidedByUserId — the actor comes from the session", () => {
    expect(
      DecidePathwaySuggestionSchema.safeParse({
        decision: "accepted",
        decidedByUserId: "someone-else",
      }).success,
    ).toBe(false);
  });
});

describe("query schemas", () => {
  it("defaults page and limit", () => {
    const parsed = ListImportCommoditiesQuerySchema.safeParse({});
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data.page).toBe(1);
    expect(parsed.data.limit).toBe(20);
  });

  it("caps the page size, so one surface is not the cheap way to pull the catalogue", () => {
    expect(ListImportCommoditiesQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(ListImportCommoditiesQuerySchema.safeParse({ limit: "50" }).success).toBe(true);
  });

  it("requires an uppercase ISO-2 country code", () => {
    expect(ListTradeFlowsQuerySchema.safeParse({ reporterCountryCode: "IN" }).success).toBe(true);
    expect(ListTradeFlowsQuerySchema.safeParse({ reporterCountryCode: "in" }).success).toBe(false);
    expect(ListTradeFlowsQuerySchema.safeParse({ reporterCountryCode: "IND" }).success).toBe(false);
  });

  it("rejects an unknown query key rather than ignoring it", () => {
    // `.strict()`: a silently-ignored filter is a filter the user believes is applied.
    expect(ListLocalizationAssessmentsQuerySchema.safeParse({ sortBy: "score" }).success).toBe(false);
  });

  it("rejects an unknown flow kind", () => {
    expect(ListTradeFlowsQuerySchema.safeParse({ flowKind: "reexport" }).success).toBe(false);
  });
});

describe("HsCodeSchema", () => {
  it("accepts exactly six digits", () => {
    expect(HsCodeSchema.safeParse("270900").success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(HsCodeSchema.safeParse("27090").success).toBe(false);
    expect(HsCodeSchema.safeParse("petroleum-oils").success).toBe(false);
  });
});
