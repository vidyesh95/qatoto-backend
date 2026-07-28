import { describe, expect, it, vi } from "vitest";

// The controller imports its service, which pulls in the db pool at module scope. Stub it
// so the schemas parse without a configured environment — nothing here calls a handler.
vi.mock("#src/services/market-insights.service.js", () => ({}));

const { CreateMarketInsightSchema, ListMarketInsightsAdminQuerySchema, UpdateMarketInsightSchema } =
  await import("#src/controllers/market-insights.controller.js");

/**
 * §11j.4's authoring bodies (§0, §13).
 *
 * TWO PROPERTIES CARRY THE WEIGHT HERE, and each has its own block:
 *
 *   `publishedAt` is rejected on BOTH bodies. It is the visibility switch the public read
 *   filters on, and it is reachable only through /publish and /unpublish. If it were a
 *   PATCH key, an insight would go live as a side effect of a typo fix.
 *
 *   The stat quad is ALL FOUR OR NONE, by type. `market_insight_trend_agreement_ck` is
 *   cross-field, so a flat partial patch is a guaranteed 23514 — a 500 with nothing to tell
 *   the caller, since pg-errors.ts exposes no isCheckViolation. Nesting makes the illegal
 *   partial unrepresentable rather than merely refused.
 */

const validStat = {
  statKind: "percent_change",
  statValueMilli: 34_000,
  statUnitKey: "percent",
  trendDirection: "up",
} as const;

const validCreate = {
  headline: "Rural water access improved across the region",
  stat: validStat,
  regionId: "reg_1",
  categoryId: "cat_1",
  sourceName: "WHO regional water survey",
  sourcePublishedDate: "2025-11-01",
} as const;

describe("market insight bodies refuse every server-owned field", () => {
  const SERVER_OWNED = [
    { publishedAt: new Date().toISOString() },
    { createdByUserId: "usr_other" },
    { createdAt: new Date().toISOString() },
    { updatedAt: new Date().toISOString() },
    { id: "mki_other" },
  ] as const;

  it.each(SERVER_OWNED)("CREATE rejects %o", (forged) => {
    expect(CreateMarketInsightSchema.safeParse({ ...validCreate, ...forged }).success).toBe(false);
  });

  it.each(SERVER_OWNED)("UPDATE rejects %o", (forged) => {
    expect(UpdateMarketInsightSchema.safeParse({ ...forged }).success).toBe(false);
  });

  /**
   * The single most important assertion in this file. Publication is an editorial act with
   * its own route; if it could ride along on an edit, "fix a typo" and "put this on the
   * landing page" would be the same request.
   */
  it("rejects publishedAt specifically, on both bodies", () => {
    const publishedAt = new Date().toISOString();
    expect(CreateMarketInsightSchema.safeParse({ ...validCreate, publishedAt }).success).toBe(false);
    expect(UpdateMarketInsightSchema.safeParse({ headline: "Revised headline", publishedAt }).success).toBe(false);
  });
});

describe("the stat quad", () => {
  it("accepts a well-formed create", () => {
    expect(CreateMarketInsightSchema.safeParse(validCreate).success).toBe(true);
  });

  it("refuses a FLAT stat field — the quad moves together or not at all", () => {
    // This is the shape that would otherwise reach market_insight_trend_agreement_ck.
    expect(UpdateMarketInsightSchema.safeParse({ trendDirection: "up" }).success).toBe(false);
    expect(UpdateMarketInsightSchema.safeParse({ statValueMilli: -22_000 }).success).toBe(false);
    expect(UpdateMarketInsightSchema.safeParse({ statKind: "multiplier" }).success).toBe(false);
    expect(UpdateMarketInsightSchema.safeParse({ statUnitKey: "people" }).success).toBe(false);
  });

  it("requires all four members of the nested quad", () => {
    for (const key of ["statKind", "statValueMilli", "statUnitKey", "trendDirection"] as const) {
      const partial: Record<string, unknown> = { ...validStat };
      delete partial[key];
      expect(UpdateMarketInsightSchema.safeParse({ stat: partial }).success).toBe(false);
    }
  });

  it("carries the unit pairing CHECK as a type", () => {
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: { ...validStat, statKind: "multiplier", statUnitKey: "people" },
      }).success,
    ).toBe(false);
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: {
          statKind: "absolute_count",
          statValueMilli: 4_000_000,
          statUnitKey: "percent",
          trendDirection: "up",
        },
      }).success,
    ).toBe(false);
  });

  it("carries the value range CHECK as a type", () => {
    // Only percent_change may be negative.
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: {
          statKind: "absolute_count",
          statValueMilli: -1,
          statUnitKey: "people",
          trendDirection: "down",
        },
      }).success,
    ).toBe(false);
    // percent_level is bounded to 0..100%.
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: {
          statKind: "percent_level",
          statValueMilli: 100_001,
          statUnitKey: "percent",
          trendDirection: "flat",
        },
      }).success,
    ).toBe(false);
  });

  /** The one rule no type can express, so the superRefine has to carry it. */
  it("refuses an arrow that contradicts the sign", () => {
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: { ...validStat, statValueMilli: -22_000, trendDirection: "up" },
      }).success,
    ).toBe(false);
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: { ...validStat, statValueMilli: 34_000, trendDirection: "down" },
      }).success,
    ).toBe(false);
    // And accepts the honest pairing.
    expect(
      UpdateMarketInsightSchema.safeParse({
        stat: { ...validStat, statValueMilli: -22_000, trendDirection: "down" },
      }).success,
    ).toBe(true);
  });

  it("refuses a fractional milli-unit, which the bigint column could not store", () => {
    expect(
      CreateMarketInsightSchema.safeParse({
        ...validCreate,
        stat: { ...validStat, statValueMilli: 34_000.5 },
      }).success,
    ).toBe(false);
  });
});

describe("required fields and bounds", () => {
  it("requires regionId and categoryId, both NOT NULL on the table", () => {
    for (const key of ["regionId", "categoryId", "headline", "sourceName", "sourcePublishedDate"]) {
      const partial: Record<string, unknown> = { ...validCreate };
      delete partial[key];
      expect(CreateMarketInsightSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("bounds the headline at the 240-char CHECK", () => {
    expect(CreateMarketInsightSchema.safeParse({ ...validCreate, headline: "x".repeat(240) }).success).toBe(true);
    expect(CreateMarketInsightSchema.safeParse({ ...validCreate, headline: "x".repeat(241) }).success).toBe(false);
  });

  it("takes a date-only sourcePublishedDate, never a timestamp", () => {
    expect(
      CreateMarketInsightSchema.safeParse({
        ...validCreate,
        sourcePublishedDate: "2025-11-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts an empty PATCH", () => {
    expect(UpdateMarketInsightSchema.safeParse({}).success).toBe(true);
  });
});

describe("ListMarketInsightsAdminQuerySchema", () => {
  it("defaults to showing everything, drafts included", () => {
    const parsed = ListMarketInsightsAdminQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe("all");
  });

  it("accepts the three states and refuses anything else", () => {
    for (const status of ["draft", "published", "all"]) {
      expect(ListMarketInsightsAdminQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(ListMarketInsightsAdminQuerySchema.safeParse({ status: "pending" }).success).toBe(false);
  });
});
