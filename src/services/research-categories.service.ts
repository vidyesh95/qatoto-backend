import { asc, eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { researchCategory } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { Result } from "#src/types/index.js";

/**
 * The project taxonomy. A client-writable taxonomy is a spam surface, so anything a
 * user mints lands `pending` and is excluded from public filter facets until a platform
 * moderator approves it (§4a Layer 3, §5).
 */

export type ResearchCategoryError = { type: "CATEGORY_LABEL_TAKEN"; slug: string };

export interface ResearchCategoryView {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly status: (typeof researchCategory.$inferSelect)["status"];
}

const CATEGORY_VIEW_COLUMNS = {
  id: researchCategory.id,
  slug: researchCategory.slug,
  label: researchCategory.label,
  status: researchCategory.status,
} as const;

/**
 * Slugifies a category label.
 *
 * This slug IS the de-duplication mechanism, because `research_category_slug_unq` is
 * declared on it: "Cold Chain", "cold chain" and "Cold-Chain" all fold to `cold-chain`,
 * so the second minter loses the race and gets a 409 rather than creating a near
 * duplicate. That is the opposite of `research_project.slug`, which auto-suffixes —
 * two projects may legitimately share a name, two categories may not.
 */
export function slugifyCategoryLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/**
 * Lists categories. Defaults to `approved` only, which is what every public filter
 * facet must show — a pending, user-minted category appearing in the public taxonomy
 * would make the spam gate pointless.
 */
export async function listResearchCategories(
  status: (typeof researchCategory.$inferSelect)["status"] = "approved",
): Promise<readonly ResearchCategoryView[]> {
  return db
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchCategory)
    .where(eq(researchCategory.status, status))
    .orderBy(asc(researchCategory.label), asc(researchCategory.id));
}

/**
 * Mints a category from the wizard's step 1.
 *
 * `status` is server-owned and always `pending` here — it is absent from the request
 * schema, so `.strict()` rejects a client trying to self-approve. Uniqueness is
 * resolved by letting the INSERT race and translating 23505, never by a
 * check-then-insert (a TOCTOU race under concurrency).
 */
export async function createResearchCategory(
  label: string,
  createdByUserId: string,
): Promise<Result<ResearchCategoryView, ResearchCategoryError>> {
  const slug = slugifyCategoryLabel(label);

  if (slug.length === 0) {
    // A label of pure punctuation or emoji cannot produce a usable filter key.
    return { success: false, error: { type: "CATEGORY_LABEL_TAKEN", slug } };
  }

  try {
    const [created] = await db
      .insert(researchCategory)
      .values({ slug, label, status: "pending", createdByUserId })
      .returning(CATEGORY_VIEW_COLUMNS);

    if (!created) {
      throw new Error("createResearchCategory: insert returned no row");
    }
    return { success: true, value: created };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return { success: false, error: { type: "CATEGORY_LABEL_TAKEN", slug } };
    }
    throw error;
  }
}

/** Resolves a category id, used by the project create/update gate. */
export async function findCategoryById(categoryId: string): Promise<ResearchCategoryView | null> {
  const [row] = await db
    .select(CATEGORY_VIEW_COLUMNS)
    .from(researchCategory)
    .where(eq(researchCategory.id, categoryId));
  return row ?? null;
}
