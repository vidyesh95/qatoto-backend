/**
 * HS chapter → what kind of thing it is, and which research category it belongs under.
 *
 * THE ONE GENUINELY EDITORIAL ARTEFACT IN §10A. Everything else on this surface is
 * measured (Comtrade), derived (the score) or moderated (substitutes). This table is a
 * judgement, made once, in one place, so that 5,052 commodities can be filtered by a chip
 * a founder recognises without anyone hand-classifying 5,052 rows.
 *
 * WHY THE CHAPTER AND NOT THE COMMODITY. An HS code's first two digits are its chapter,
 * and the chapter is the level at which the WCO itself groups by kind of good. Classifying
 * per-commodity would be 5,052 decisions that drift; classifying per-chapter is 97 that
 * can be read in one screen and argued with.
 *
 * THE MAP IS TOTAL, AND `assertChapterMapIsComplete` proves it at module load. A commodity
 * whose chapter is missing would otherwise fail its NOT NULL `research_category_id` at
 * INSERT time, mid-ingest, after several thousand rows had already been written.
 *
 * ⚠️ CHAPTER 77 DOES NOT EXIST. It is reserved by the WCO for future use and no goods are
 * ever classified under it — its absence below is correct, not an oversight, and the
 * completeness assertion excludes it explicitly rather than leaving a hole nobody can
 * explain.
 *
 * ⚠️ CHAPTER 99 IS REAL and is easy to miss when working from a textbook list: it is
 * "commodities not specified according to kind", and India files against it. Verified
 * present in the live 2023 data.
 *
 * The eight category slugs are the ones seeded in `src/db/seed-data.ts`. A ninth would
 * need seeding before it can be named here, which the assertion below does not check —
 * the FK does, at ingest time.
 */

/** Matches `import_commodity_kind` in the schema. */
export type ImportCommodityKind =
  | "agricultural_product"
  | "food_product"
  | "mineral_ceramic"
  | "energy_fuel"
  | "chemical"
  | "pharmaceutical"
  | "plastic_rubber"
  | "wood_paper"
  | "textile_leather"
  | "precious_material"
  | "metal"
  | "machinery"
  | "electronic_subassembly"
  | "transport_equipment"
  | "precision_instrument"
  | "other_manufactured";

export interface HsChapterClassification {
  readonly commodityKind: ImportCommodityKind;
  /** A seeded `research_category.slug`. */
  readonly researchCategorySlug: string;
  /** The WCO's own chapter title, so a reader can check the judgement without a lookup. */
  readonly chapterTitle: string;
}

/**
 * Keyed by the two-digit chapter exactly as it appears in an HS6 code — zero-padded, so
 * `"01"` and never `"1"`. A number key would lose the padding and silently miss.
 */
export const HS_CHAPTER_CLASSIFICATIONS: Readonly<Record<string, HsChapterClassification>> = {
  // --- Section I-IV: food and agriculture. Categorised `agriculture` throughout, split
  //     by kind between raw output and processed food, because localizing a crop and
  //     localizing a cannery are different problems.
  "01": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Live animals",
  },
  "02": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Meat and edible meat offal",
  },
  "03": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Fish and crustaceans",
  },
  "04": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Dairy produce, eggs, honey",
  },
  "05": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Products of animal origin, nes",
  },
  "06": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Live trees and plants",
  },
  "07": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Edible vegetables",
  },
  "08": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Edible fruit and nuts",
  },
  "09": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Coffee, tea, maté and spices",
  },
  "10": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Cereals",
  },
  "11": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Products of the milling industry",
  },
  "12": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Oil seeds and oleaginous fruits",
  },
  "13": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Lac, gums, resins",
  },
  "14": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Vegetable plaiting materials",
  },
  "15": {
    commodityKind: "agricultural_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Animal or vegetable fats and oils",
  },
  "16": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Preparations of meat and fish",
  },
  "17": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Sugars and sugar confectionery",
  },
  "18": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Cocoa and cocoa preparations",
  },
  "19": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Preparations of cereals, flour, milk",
  },
  "20": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Preparations of vegetables and fruit",
  },
  "21": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Miscellaneous edible preparations",
  },
  "22": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Beverages, spirits and vinegar",
  },
  "23": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Food industry residues; animal fodder",
  },
  "24": {
    commodityKind: "food_product",
    researchCategorySlug: "agriculture",
    chapterTitle: "Tobacco and manufactured substitutes",
  },

  // --- Section V: minerals. Chapter 27 is the single largest import line in most
  //     developing economies and is categorised `clean-energy` because that is the
  //     research this platform wants pointed at it, not because petroleum is clean.
  "25": {
    commodityKind: "mineral_ceramic",
    researchCategorySlug: "housing",
    chapterTitle: "Salt, sulphur, earths, stone, cement",
  },
  "26": {
    commodityKind: "mineral_ceramic",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Ores, slag and ash",
  },
  "27": {
    commodityKind: "energy_fuel",
    researchCategorySlug: "clean-energy",
    chapterTitle: "Mineral fuels, oils and waxes",
  },

  // --- Section VI: chemicals. 30 splits to healthcare and 31 to agriculture because the
  //     localization problem for a drug and for a fertiliser is a regulatory and an
  //     agronomic one respectively, not a chemical-engineering one.
  "28": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Inorganic chemicals",
  },
  "29": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Organic chemicals",
  },
  "30": {
    commodityKind: "pharmaceutical",
    researchCategorySlug: "healthcare",
    chapterTitle: "Pharmaceutical products",
  },
  "31": {
    commodityKind: "chemical",
    researchCategorySlug: "agriculture",
    chapterTitle: "Fertilisers",
  },
  "32": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Tanning and dyeing extracts",
  },
  "33": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Essential oils, perfumery, cosmetics",
  },
  "34": {
    commodityKind: "chemical",
    researchCategorySlug: "water-sanitation",
    chapterTitle: "Soap, washing and cleaning preparations",
  },
  "35": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Albuminoidal substances; glues; enzymes",
  },
  "36": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Explosives and pyrotechnic products",
  },
  "37": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Photographic or cinematographic goods",
  },
  "38": {
    commodityKind: "chemical",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Miscellaneous chemical products",
  },

  // --- Section VII: plastics and rubber.
  "39": {
    commodityKind: "plastic_rubber",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Plastics and articles thereof",
  },
  "40": {
    commodityKind: "plastic_rubber",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Rubber and articles thereof",
  },

  // --- Sections VIII-X: hides, wood, paper.
  "41": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Raw hides, skins and leather",
  },
  "42": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Articles of leather; saddlery",
  },
  "43": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Furskins and artificial fur",
  },
  "44": {
    commodityKind: "wood_paper",
    researchCategorySlug: "housing",
    chapterTitle: "Wood and articles of wood",
  },
  "45": {
    commodityKind: "wood_paper",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Cork and articles of cork",
  },
  "46": {
    commodityKind: "wood_paper",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Manufactures of straw and plaiting materials",
  },
  // Recovered paper is the feedstock of a recycling industry, which is the research
  // question this chapter actually poses.
  "47": {
    commodityKind: "wood_paper",
    researchCategorySlug: "waste-recycling",
    chapterTitle: "Pulp of wood; recovered paper",
  },
  "48": {
    commodityKind: "wood_paper",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Paper and paperboard",
  },
  "49": {
    commodityKind: "wood_paper",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Printed books and newspapers",
  },

  // --- Section XI-XII: textiles and footwear. Fourteen chapters, one category: the
  //     localization question is the same industrial one across all of them.
  "50": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Silk",
  },
  "51": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Wool and animal hair",
  },
  "52": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Cotton",
  },
  "53": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Other vegetable textile fibres",
  },
  "54": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Man-made filaments",
  },
  "55": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Man-made staple fibres",
  },
  "56": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Wadding, felt and nonwovens",
  },
  "57": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Carpets and textile floor coverings",
  },
  "58": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Special woven fabrics; tapestries",
  },
  "59": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Impregnated or coated textile fabrics",
  },
  "60": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Knitted or crocheted fabrics",
  },
  "61": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Apparel, knitted or crocheted",
  },
  "62": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Apparel, not knitted or crocheted",
  },
  "63": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Other made-up textile articles",
  },
  "64": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Footwear, gaiters and the like",
  },
  "65": {
    commodityKind: "textile_leather",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Headgear and parts thereof",
  },
  "66": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Umbrellas, walking sticks, whips",
  },
  "67": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Prepared feathers; artificial flowers",
  },

  // --- Section XIII: stone, ceramics, glass. Building materials, hence `housing`.
  "68": {
    commodityKind: "mineral_ceramic",
    researchCategorySlug: "housing",
    chapterTitle: "Articles of stone, plaster, cement",
  },
  "69": {
    commodityKind: "mineral_ceramic",
    researchCategorySlug: "housing",
    chapterTitle: "Ceramic products",
  },
  "70": {
    commodityKind: "mineral_ceramic",
    researchCategorySlug: "housing",
    chapterTitle: "Glass and glassware",
  },

  // --- Section XIV: precious materials. Its own kind because gold and diamonds distort
  //     every ranking they enter — $42bn of unwrought gold is India's second-largest
  //     import line and is not a manufacturing opportunity in any useful sense.
  "71": {
    commodityKind: "precious_material",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Pearls, precious stones and metals",
  },

  // --- Section XV: base metals.
  "72": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Iron and steel",
  },
  "73": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Articles of iron or steel",
  },
  "74": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Copper and articles thereof",
  },
  "75": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Nickel and articles thereof",
  },
  "76": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Aluminium and articles thereof",
  },
  // 77 is reserved by the WCO and intentionally absent. See the module header.
  "78": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Lead and articles thereof",
  },
  "79": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Zinc and articles thereof",
  },
  "80": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Tin and articles thereof",
  },
  "81": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Other base metals; cermets",
  },
  "82": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Tools, implements, cutlery of base metal",
  },
  "83": {
    commodityKind: "metal",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Miscellaneous articles of base metal",
  },

  // --- Section XVI: machinery and electricals. The two biggest manufacturing chapters,
  //     kept apart because 84 is mechanical and 85 is electronic, and a country can be
  //     capable of one and not the other.
  "84": {
    commodityKind: "machinery",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Machinery and mechanical appliances",
  },
  "85": {
    commodityKind: "electronic_subassembly",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Electrical machinery and equipment",
  },

  // --- Section XVII: transport. Categorised `logistics`.
  "86": {
    commodityKind: "transport_equipment",
    researchCategorySlug: "logistics",
    chapterTitle: "Railway locomotives and rolling stock",
  },
  "87": {
    commodityKind: "transport_equipment",
    researchCategorySlug: "logistics",
    chapterTitle: "Vehicles other than railway",
  },
  "88": {
    commodityKind: "transport_equipment",
    researchCategorySlug: "logistics",
    chapterTitle: "Aircraft, spacecraft and parts",
  },
  "89": {
    commodityKind: "transport_equipment",
    researchCategorySlug: "logistics",
    chapterTitle: "Ships, boats and floating structures",
  },

  // --- Section XVIII: precision instruments. 90 carries medical devices, hence
  //     `healthcare`; 91 and 92 do not.
  "90": {
    commodityKind: "precision_instrument",
    researchCategorySlug: "healthcare",
    chapterTitle: "Optical, photographic, medical instruments",
  },
  "91": {
    commodityKind: "precision_instrument",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Clocks and watches",
  },
  "92": {
    commodityKind: "precision_instrument",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Musical instruments",
  },

  // --- Sections XIX-XXI: arms, furniture, miscellaneous, art.
  "93": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Arms and ammunition",
  },
  "94": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "housing",
    chapterTitle: "Furniture, bedding, lamps, prefabricated buildings",
  },
  "95": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Toys, games and sports requisites",
  },
  "96": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Miscellaneous manufactured articles",
  },
  "97": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Works of art, collectors' pieces, antiques",
  },

  // --- Chapter 99. Not a kind of good at all: it is what a reporter files when the
  //     commodity is not specified. Kept so the map stays total, and worth remembering
  //     when a surface shows it — it is a bucket, not a market.
  "99": {
    commodityKind: "other_manufactured",
    researchCategorySlug: "manufacturing",
    chapterTitle: "Commodities not specified according to kind",
  },
};

/** The chapter numbers the WCO does not issue. Only 77 today. */
const RESERVED_HS_CHAPTERS: ReadonlySet<string> = new Set(["77"]);

/** The highest chapter in use. 99 is real — see the module header. */
const HIGHEST_HS_CHAPTER = 99;

/**
 * Classifies an HS6 code by its chapter.
 *
 * Returns `null` rather than throwing, and returns null rather than guessing: an ingest
 * that meets a chapter this map has never seen must skip the row and say so, not file it
 * under whatever category happened to be nearest.
 */
export function classifyHsCode(hsCode: string): HsChapterClassification | null {
  return HS_CHAPTER_CLASSIFICATIONS[hsCode.slice(0, 2)] ?? null;
}

/**
 * Proves the map covers every chapter the WCO issues, at module load.
 *
 * A missing chapter would otherwise surface as a NOT NULL violation on
 * `import_commodity.research_category_id`, thousands of rows into an ingest, with an error
 * naming a column rather than the chapter that is actually missing.
 */
function assertChapterMapIsComplete(): void {
  const missingChapters: string[] = [];
  for (let chapterNumber = 1; chapterNumber <= HIGHEST_HS_CHAPTER; chapterNumber += 1) {
    const chapter = String(chapterNumber).padStart(2, "0");
    if (RESERVED_HS_CHAPTERS.has(chapter)) {
      continue;
    }
    // 98 is reserved for national use and is not issued as an international chapter; it is
    // skipped for the same reason as 77 but is listed separately because, unlike 77, some
    // reporters do file against it nationally. If one ever appears in the feed, the row is
    // skipped and counted rather than silently classified.
    if (chapter === "98") {
      continue;
    }
    if (HS_CHAPTER_CLASSIFICATIONS[chapter] === undefined) {
      missingChapters.push(chapter);
    }
  }

  if (missingChapters.length > 0) {
    throw new Error(
      `HS_CHAPTER_CLASSIFICATIONS is missing chapter(s): ${missingChapters.join(", ")}`,
    );
  }
}

assertChapterMapIsComplete();
