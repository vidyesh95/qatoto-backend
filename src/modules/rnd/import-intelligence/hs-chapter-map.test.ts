import { describe, expect, it } from "vitest";

import { classifyHsCode, HS_CHAPTER_CLASSIFICATIONS } from "#src/modules/rnd/import-intelligence/hs-chapter-map.js";

/**
 * The eight category slugs seeded in `src/db/seed-data.ts`.
 *
 * RESTATED HERE rather than imported, for the reason `demand-score.test.ts` gives about
 * ladders: importing the seed would make this test pass for any category the seed happens
 * to contain, including one added by mistake. `import_commodity.research_category_id` is
 * NOT NULL with a `restrict` FK, so a slug this list does not contain is an ingest that
 * fails thousands of rows in.
 */
const SEEDED_RESEARCH_CATEGORY_SLUGS = new Set([
  "agriculture",
  "clean-energy",
  "healthcare",
  "housing",
  "logistics",
  "manufacturing",
  "water-sanitation",
  "waste-recycling",
]);

const VALID_COMMODITY_KINDS = new Set([
  "agricultural_product",
  "food_product",
  "mineral_ceramic",
  "energy_fuel",
  "chemical",
  "pharmaceutical",
  "plastic_rubber",
  "wood_paper",
  "textile_leather",
  "precious_material",
  "metal",
  "machinery",
  "electronic_subassembly",
  "transport_equipment",
  "precision_instrument",
  "other_manufactured",
]);

describe("HS_CHAPTER_CLASSIFICATIONS", () => {
  it("covers every chapter the WCO issues, and only those", () => {
    // 01-97 minus 77 (reserved, never issued) is 96, plus chapter 99 ("commodities not
    // specified according to kind"), which India genuinely files against.
    expect(Object.keys(HS_CHAPTER_CLASSIFICATIONS)).toHaveLength(97);
  });

  it("has no entry for chapter 77, which does not exist", () => {
    expect(HS_CHAPTER_CLASSIFICATIONS["77"]).toBeUndefined();
  });

  it("DOES have chapter 99, which a textbook chapter list omits", () => {
    expect(HS_CHAPTER_CLASSIFICATIONS["99"]).toBeDefined();
  });

  it("keys every chapter zero-padded to two digits", () => {
    for (const chapter of Object.keys(HS_CHAPTER_CLASSIFICATIONS)) {
      // A key of "1" would never match the "01" slice of a real HS6 code.
      expect(chapter).toMatch(/^[0-9]{2}$/);
    }
  });

  it("names only seeded research categories", () => {
    for (const [chapter, classification] of Object.entries(HS_CHAPTER_CLASSIFICATIONS)) {
      expect(
        SEEDED_RESEARCH_CATEGORY_SLUGS.has(classification.researchCategorySlug),
        `chapter ${chapter} names unseeded category "${classification.researchCategorySlug}"`,
      ).toBe(true);
    }
  });

  it("names only declared commodity kinds", () => {
    for (const [chapter, classification] of Object.entries(HS_CHAPTER_CLASSIFICATIONS)) {
      expect(
        VALID_COMMODITY_KINDS.has(classification.commodityKind),
        `chapter ${chapter} names unknown kind "${classification.commodityKind}"`,
      ).toBe(true);
    }
  });

  it("carries a chapter title for every entry, so a judgement can be checked", () => {
    for (const classification of Object.values(HS_CHAPTER_CLASSIFICATIONS)) {
      expect(classification.chapterTitle.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyHsCode", () => {
  it.each([
    ["270900", "energy_fuel", "clean-energy"],
    ["854231", "electronic_subassembly", "manufacturing"],
    ["710812", "precious_material", "manufacturing"],
    ["300490", "pharmaceutical", "healthcare"],
    ["870380", "transport_equipment", "logistics"],
    ["310210", "chemical", "agriculture"],
  ])("classifies %s as %s / %s", (hsCode, expectedKind, expectedCategory) => {
    const classification = classifyHsCode(hsCode);
    expect(classification?.commodityKind).toBe(expectedKind);
    expect(classification?.researchCategorySlug).toBe(expectedCategory);
  });

  it("returns null for a chapter the map does not carry, rather than guessing", () => {
    // 98 is reserved for national use. A guess here would file a whole chapter of trade
    // under whatever category happened to be nearest.
    expect(classifyHsCode("980000")).toBeNull();
    expect(classifyHsCode("770000")).toBeNull();
  });

  it("reads only the first two digits", () => {
    expect(classifyHsCode("270900")).toStrictEqual(classifyHsCode("271111"));
  });
});
