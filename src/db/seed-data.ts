/**
 * The baseline R&D taxonomy — the SINGLE source of truth for the seeded categories.
 *
 * This is NOT sample data. `research_project.categoryId` is NOT NULL ON DELETE
 * RESTRICT, so a database with zero categories cannot accept a single project: the
 * taxonomy is a schema-level precondition, the same class as the `CREATE EXTENSION
 * citext` in migration 0008. Migration 0010 inserts these rows as a one-time
 * bootstrap; `pnpm db:seed-research-categories` re-applies them idempotently for local
 * resets and for adding rows later.
 *
 * IDs are literal UUIDs rather than generated, so every environment agrees on them and
 * a fixture or a curl example can reference one directly. They MUST stay byte-identical
 * to the INSERT in migration 0010.
 *
 * TAXONOMY RECONCILIATION (R_AND_D_BACKEND_STRUCTURE.md §5 "Seed drift"). The wizard's
 * IDEA_CATEGORIES and the six mock projects' category labels do not overlap at all. The
 * reason is that they sit at DIFFERENT ALTITUDES: "Precision Agriculture" is an
 * instance of "Agriculture", not a peer of it. Keeping the wizard's altitude and
 * re-tagging the mocks is the resolution, which needs exactly two edits to the wizard
 * list: "Water" widens to "Water & Sanitation", and "Waste & Recycling" is added as the
 * one genuine gap (generalized one notch from the mocks' "E-Waste & Recycling").
 *
 * The mock projects then map: Cold Chain → logistics, Precision Agriculture →
 * agriculture, E-Waste & Recycling → waste-recycling, Medical Logistics → healthcare or
 * logistics (genuinely ambiguous, which is exactly what the `pending` mechanism is for).
 */
import type { categoryPinIconKeyEnum, discoveryRegionKindEnum } from "#src/db/schema.js";

/**
 * Derived from the pgEnum rather than hand-written, so adding a pin key is a one-line
 * schema edit and a wrong key here is a compile error (CLAUDE.md §4: input types come
 * from inference, never a parallel duplicate).
 */
export type CategoryPinIconKey = (typeof categoryPinIconKeyEnum.enumValues)[number];
export type DiscoveryRegionKind = (typeof discoveryRegionKindEnum.enumValues)[number];

export interface BaselineResearchCategory {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  /**
   * Which pin asset the §6 problem map renders for this category.
   *
   * Server-owned and moderator-assigned, because the frontend's current
   * PIN_ICON_SRC_BY_CATEGORY map is keyed on the DISPLAY LABEL — so renaming a label
   * silently drops every pin to the default icon with no error anywhere.
   */
  readonly pinIconKey: CategoryPinIconKey;
}

export const BASELINE_RESEARCH_CATEGORIES: readonly BaselineResearchCategory[] = [
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01",
    slug: "agriculture",
    label: "Agriculture",
    pinIconKey: "agriculture",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02",
    slug: "clean-energy",
    label: "Clean Energy",
    pinIconKey: "energy",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03",
    slug: "healthcare",
    label: "Healthcare",
    pinIconKey: "health",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04",
    slug: "housing",
    label: "Housing",
    pinIconKey: "housing",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05",
    slug: "logistics",
    label: "Logistics",
    pinIconKey: "transport",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06",
    slug: "manufacturing",
    label: "Manufacturing",
    pinIconKey: "manufacturing",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07",
    slug: "water-sanitation",
    label: "Water & Sanitation",
    pinIconKey: "water",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a08",
    slug: "waste-recycling",
    label: "Waste & Recycling",
    pinIconKey: "waste",
  },
];

/**
 * The baseline region tree (§6). Also NOT sample data: `market_insight.regionId` and
 * `demand_signal_snapshot.regionId` are both NOT NULL ON DELETE RESTRICT, so a database
 * with no regions cannot accept a single insight or leaderboard row.
 *
 * Three levels. The `global` root exists so `discovery_region_root_ck` has exactly one
 * parentless row; `macro_region` is what the knowledge hub groups by (and what the mocks'
 * "East Africa" / "Southeast Asia" / "Latin America" strings become); `country` is what
 * reverse geocoding lands on via ISO 3166-1 alpha-2.
 *
 * The country list is deliberately partial — it covers the regions the mock data and the
 * launch markets use. Adding a country later is an append here plus
 * `pnpm db:seed-discovery-regions`, never a migration.
 *
 * MUST stay byte-identical to the INSERT in migration 0011.
 */
export interface BaselineDiscoveryRegion {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly kind: DiscoveryRegionKind;
  readonly parentRegionId: string | null;
  readonly countryCode: string | null;
}

const GLOBAL_REGION_ID = "b3d2f8a1-0000-4000-8000-000000000001";
const EAST_AFRICA_ID = "b3d2f8a1-0000-4000-8000-000000000010";
const WEST_AFRICA_ID = "b3d2f8a1-0000-4000-8000-000000000011";
const SOUTH_ASIA_ID = "b3d2f8a1-0000-4000-8000-000000000012";
const SOUTHEAST_ASIA_ID = "b3d2f8a1-0000-4000-8000-000000000013";
const LATIN_AMERICA_ID = "b3d2f8a1-0000-4000-8000-000000000014";

export const BASELINE_DISCOVERY_REGIONS: readonly BaselineDiscoveryRegion[] = [
  {
    id: GLOBAL_REGION_ID,
    slug: "global",
    label: "Global",
    kind: "global",
    parentRegionId: null,
    countryCode: null,
  },
  {
    id: EAST_AFRICA_ID,
    slug: "east-africa",
    label: "East Africa",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: WEST_AFRICA_ID,
    slug: "west-africa",
    label: "West Africa",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: SOUTH_ASIA_ID,
    slug: "south-asia",
    label: "South Asia",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: SOUTHEAST_ASIA_ID,
    slug: "southeast-asia",
    label: "Southeast Asia",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: LATIN_AMERICA_ID,
    slug: "latin-america",
    label: "Latin America",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000015",
    slug: "middle-east",
    label: "Middle East",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000016",
    slug: "europe",
    label: "Europe",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000017",
    slug: "north-america",
    label: "North America",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000018",
    slug: "oceania",
    label: "Oceania",
    kind: "macro_region",
    parentRegionId: GLOBAL_REGION_ID,
    countryCode: null,
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000020",
    slug: "kenya",
    label: "Kenya",
    kind: "country",
    parentRegionId: EAST_AFRICA_ID,
    countryCode: "KE",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000021",
    slug: "tanzania",
    label: "Tanzania",
    kind: "country",
    parentRegionId: EAST_AFRICA_ID,
    countryCode: "TZ",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000022",
    slug: "uganda",
    label: "Uganda",
    kind: "country",
    parentRegionId: EAST_AFRICA_ID,
    countryCode: "UG",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000023",
    slug: "ethiopia",
    label: "Ethiopia",
    kind: "country",
    parentRegionId: EAST_AFRICA_ID,
    countryCode: "ET",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000024",
    slug: "nigeria",
    label: "Nigeria",
    kind: "country",
    parentRegionId: WEST_AFRICA_ID,
    countryCode: "NG",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000025",
    slug: "ghana",
    label: "Ghana",
    kind: "country",
    parentRegionId: WEST_AFRICA_ID,
    countryCode: "GH",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000026",
    slug: "senegal",
    label: "Senegal",
    kind: "country",
    parentRegionId: WEST_AFRICA_ID,
    countryCode: "SN",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000027",
    slug: "india",
    label: "India",
    kind: "country",
    parentRegionId: SOUTH_ASIA_ID,
    countryCode: "IN",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000028",
    slug: "bangladesh",
    label: "Bangladesh",
    kind: "country",
    parentRegionId: SOUTH_ASIA_ID,
    countryCode: "BD",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000029",
    slug: "pakistan",
    label: "Pakistan",
    kind: "country",
    parentRegionId: SOUTH_ASIA_ID,
    countryCode: "PK",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000030",
    slug: "nepal",
    label: "Nepal",
    kind: "country",
    parentRegionId: SOUTH_ASIA_ID,
    countryCode: "NP",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000031",
    slug: "indonesia",
    label: "Indonesia",
    kind: "country",
    parentRegionId: SOUTHEAST_ASIA_ID,
    countryCode: "ID",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000032",
    slug: "philippines",
    label: "Philippines",
    kind: "country",
    parentRegionId: SOUTHEAST_ASIA_ID,
    countryCode: "PH",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000033",
    slug: "vietnam",
    label: "Vietnam",
    kind: "country",
    parentRegionId: SOUTHEAST_ASIA_ID,
    countryCode: "VN",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000034",
    slug: "peru",
    label: "Peru",
    kind: "country",
    parentRegionId: LATIN_AMERICA_ID,
    countryCode: "PE",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000035",
    slug: "brazil",
    label: "Brazil",
    kind: "country",
    parentRegionId: LATIN_AMERICA_ID,
    countryCode: "BR",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000036",
    slug: "colombia",
    label: "Colombia",
    kind: "country",
    parentRegionId: LATIN_AMERICA_ID,
    countryCode: "CO",
  },
  {
    id: "b3d2f8a1-0000-4000-8000-000000000037",
    slug: "mexico",
    label: "Mexico",
    kind: "country",
    parentRegionId: LATIN_AMERICA_ID,
    countryCode: "MX",
  },
];

/**
 * The canonical skill vocabulary (§6).
 *
 * THIS LIST IS A BUG FIX, not a convenience. `talent-filter-grid.tsx` currently filters
 * with `skills.some((skill) => skill.includes(chipText))` — a substring match, so a
 * "Water" chip matches "Water Polo". Filtering on these slugs by equality makes that
 * class of bug unrepresentable.
 *
 * `categoryId` is nullable on purpose: "Computer Vision" and "Data Analysis" are
 * genuinely cross-cutting, and forcing every skill under one category would assert a
 * taxonomy that does not exist.
 *
 * MUST stay byte-identical to the INSERT in migration 0011.
 */
export interface BaselineDiscoverySkill {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly categoryId: string | null;
}

const AGRICULTURE_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01";
const CLEAN_ENERGY_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02";
const HEALTHCARE_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03";
const HOUSING_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04";
const LOGISTICS_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05";
const MANUFACTURING_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06";
const WATER_SANITATION_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07";
const WASTE_RECYCLING_CATEGORY_ID = "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a08";

export const BASELINE_DISCOVERY_SKILLS: readonly BaselineDiscoverySkill[] = [
  {
    id: "c4e3a9b2-0000-4000-8000-000000000001",
    slug: "firmware",
    label: "Firmware",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000002",
    slug: "sensor-networks",
    label: "Sensor Networks",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000003",
    slug: "power-electronics",
    label: "Power Electronics",
    categoryId: CLEAN_ENERGY_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000004",
    slug: "membrane-filtration",
    label: "Membrane Filtration",
    categoryId: WATER_SANITATION_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000005",
    slug: "water-quality",
    label: "Water Quality",
    categoryId: WATER_SANITATION_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000006",
    slug: "lab-validation",
    label: "Lab Validation",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000007",
    slug: "flight-control",
    label: "Flight Control",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000008",
    slug: "computer-vision",
    label: "Computer Vision",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000009",
    slug: "precision-farming",
    label: "Precision Farming",
    categoryId: AGRICULTURE_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000010",
    slug: "refrigeration",
    label: "Refrigeration",
    categoryId: LOGISTICS_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000011",
    slug: "cold-chain-logistics",
    label: "Cold Chain Logistics",
    categoryId: LOGISTICS_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000012",
    slug: "solar-pv",
    label: "Solar PV",
    categoryId: CLEAN_ENERGY_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000013",
    slug: "battery-systems",
    label: "Battery Systems",
    categoryId: CLEAN_ENERGY_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000014",
    slug: "structural-design",
    label: "Structural Design",
    categoryId: HOUSING_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000015",
    slug: "prefab-construction",
    label: "Prefab Construction",
    categoryId: HOUSING_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000016",
    slug: "medical-devices",
    label: "Medical Devices",
    categoryId: HEALTHCARE_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000017",
    slug: "diagnostics",
    label: "Diagnostics",
    categoryId: HEALTHCARE_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000018",
    slug: "supply-chain",
    label: "Supply Chain",
    categoryId: LOGISTICS_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000019",
    slug: "materials-recovery",
    label: "Materials Recovery",
    categoryId: WASTE_RECYCLING_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000020",
    slug: "industrial-design",
    label: "Industrial Design",
    categoryId: MANUFACTURING_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000021",
    slug: "embedded-linux",
    label: "Embedded Linux",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000022",
    slug: "mechanical-design",
    label: "Mechanical Design",
    categoryId: MANUFACTURING_CATEGORY_ID,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000023",
    slug: "field-operations",
    label: "Field Operations",
    categoryId: null,
  },
  {
    id: "c4e3a9b2-0000-4000-8000-000000000024",
    slug: "data-analysis",
    label: "Data Analysis",
    categoryId: null,
  },
];

/**
 * The baseline supplier capability vocabulary (§11i, Appendix B4).
 *
 * SEEDED, WITH NO WRITE ENDPOINT — `discovery_skill`'s reasoning verbatim. There is no
 * `POST /supplier-capabilities` in §11i, so there is no spam surface here and therefore no
 * moderation status. Retirement is `isActive = false`, never a DELETE, because
 * `supplier_capability_link` references this table with `restrict`.
 *
 * These slugs are what `?capability=` matches BY EQUALITY. That is the whole reason the
 * table exists rather than a `text[]` on `supplier`: a substring match would make a
 * "tooling" chip select "retooling", the exact bug class §6 removes.
 *
 * Adding one later means appending here and re-running `pnpm db:seed-supplier-capabilities`
 * — not hand-writing another migration.
 */
export interface BaselineSupplierCapability {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly kind:
    | "manufacturing"
    | "assembly"
    | "tooling"
    | "packaging"
    | "logistics"
    | "certification"
    | "design"
    | "sourcing";
}

export const BASELINE_SUPPLIER_CAPABILITIES: readonly BaselineSupplierCapability[] = [
  {
    id: "d5f4b0c3-0000-4000-8000-000000000001",
    slug: "injection-moulding",
    label: "Injection Moulding",
    kind: "manufacturing",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000002",
    slug: "cnc-machining",
    label: "CNC Machining",
    kind: "manufacturing",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000003",
    slug: "sheet-metal-fabrication",
    label: "Sheet Metal Fabrication",
    kind: "manufacturing",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000004",
    slug: "pcb-assembly",
    label: "PCB Assembly",
    kind: "assembly",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000005",
    slug: "final-assembly",
    label: "Final Assembly",
    kind: "assembly",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000006",
    slug: "cable-harnessing",
    label: "Cable Harnessing",
    kind: "assembly",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000007",
    slug: "tool-and-die",
    label: "Tool and Die",
    kind: "tooling",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000008",
    slug: "rapid-prototyping",
    label: "Rapid Prototyping",
    kind: "tooling",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000009",
    slug: "retail-packaging",
    label: "Retail Packaging",
    kind: "packaging",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000010",
    slug: "protective-packaging",
    label: "Protective Packaging",
    kind: "packaging",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000011",
    slug: "freight-forwarding",
    label: "Freight Forwarding",
    kind: "logistics",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000012",
    slug: "customs-brokerage",
    label: "Customs Brokerage",
    kind: "logistics",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000013",
    slug: "warehousing",
    label: "Warehousing",
    kind: "logistics",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000014",
    slug: "ce-marking",
    label: "CE Marking",
    kind: "certification",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000015",
    slug: "fcc-testing",
    label: "FCC Testing",
    kind: "certification",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000016",
    slug: "rohs-reach-compliance",
    label: "RoHS / REACH Compliance",
    kind: "certification",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000017",
    slug: "industrial-design",
    label: "Industrial Design",
    kind: "design",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000018",
    slug: "design-for-manufacture",
    label: "Design for Manufacture",
    kind: "design",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000019",
    slug: "component-sourcing",
    label: "Component Sourcing",
    kind: "sourcing",
  },
  {
    id: "d5f4b0c3-0000-4000-8000-000000000020",
    slug: "raw-material-sourcing",
    label: "Raw Material Sourcing",
    kind: "sourcing",
  },
];
