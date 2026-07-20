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
export interface BaselineResearchCategory {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
}

export const BASELINE_RESEARCH_CATEGORIES: readonly BaselineResearchCategory[] = [
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a01", slug: "agriculture", label: "Agriculture" },
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a02", slug: "clean-energy", label: "Clean Energy" },
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a03", slug: "healthcare", label: "Healthcare" },
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a04", slug: "housing", label: "Housing" },
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a05", slug: "logistics", label: "Logistics" },
  { id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a06", slug: "manufacturing", label: "Manufacturing" },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a07",
    slug: "water-sanitation",
    label: "Water & Sanitation",
  },
  {
    id: "a7e1c6b2-0f3d-4a58-9c21-1b0e6d4f8a08",
    slug: "waste-recycling",
    label: "Waste & Recycling",
  },
];
