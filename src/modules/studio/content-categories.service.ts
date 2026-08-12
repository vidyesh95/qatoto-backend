/**
 * The content taxonomy behind the home feed (HOME_BACKEND_STRUCTURE.md §2).
 *
 * WHY THIS IS NOT `feed.service.ts`. A taxonomy read is a catalog concern, not a ranking
 * one — it is the same shape as `listDiscoverySkills`, and it belongs beside it in spirit.
 * `feed.service.ts` stays unwritten until §4's ranker needs it, so that the one file named
 * for ranking contains only ranking.
 *
 * EVERY FUNCTION HERE IS A PURE READ AND NONE RETURNS A `Result`. There is no failure
 * mode: an empty taxonomy is an empty array, not an error, and `findUnavailableCategoryIds`
 * answers a question rather than performing an act. `Result` is for operations that can
 * fail, and inventing an error union for a SELECT would be ceremony.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { contentCategory } from "#src/db/schema.js";

/**
 * Where a video goes when its creator picks no category.
 *
 * WHY A DEFAULT EXISTS AT ALL. The feed's category predicate never relaxes — `EXISTS (SELECT
 * 1 FROM video_category …)` is in the WHERE at every relaxation stage — so an untagged video
 * is unreachable by every category filter for as long as it exists. Category selection stays
 * OPTIONAL at the boundary (`categoryIds` has no `.min(1)`), and the cost of that choice is
 * paid here instead of by the viewer.
 *
 * A SLUG, NOT AN ID, and resolved at call time rather than pinned as a constant. The seed
 * script fixes the row's UUID, but nothing stops an environment from being seeded by hand,
 * and a hardcoded id that is wrong fails as a foreign-key violation on someone's upload.
 * A slug that is wrong fails as a `null` this module already handles.
 */
export const DEFAULT_CONTENT_CATEGORY_SLUG = "people-and-blogs";

/**
 * What a visitor sees for one category.
 *
 * `id` IS IN THIS SHAPE AND §5.1's SKETCH OMITS IT. The studio's category picker reads this
 * same route, and `categoryIds` on create/update are ids — so omitting it would force the
 * studio onto a second, near-identical endpoint, or force it to key a write on a slug that
 * is documented as a display-layer value. One route, one shape.
 *
 * `imageUrl` is `null` for a chip category, and that is not a hole to be papered over — see
 * the `content_category` table comment. A client renders a chip as its label.
 */
export interface ContentCategoryView {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly imageUrl: string | null;
  readonly isTile: boolean;
  readonly sortOrder: number;
}

/**
 * Every active category, ordered, unpaginated. Powers both the filter chip row and the
 * "What's on your mind?" tile grid — the client slices on `isTile`.
 *
 * UNPAGINATED IS A DECISION, not an oversight. The taxonomy is bounded by product judgement
 * at a couple of dozen rows; paginating a list the client always wants in full would make
 * the home page's first paint depend on two round trips.
 *
 * THE SECONDARY SORT IS LOAD-BEARING. `sortOrder` is not unique, so ordering on it alone
 * leaves ties resolved by whatever order the heap hands back — which can differ between two
 * requests for the same data. `slug` makes the order total, and therefore stable.
 */
export async function listActiveContentCategories(): Promise<readonly ContentCategoryView[]> {
  return db
    .select({
      id: contentCategory.id,
      slug: contentCategory.slug,
      label: contentCategory.label,
      imageUrl: contentCategory.imageUrl,
      isTile: contentCategory.isTile,
      sortOrder: contentCategory.sortOrder,
    })
    .from(contentCategory)
    .where(eq(contentCategory.isActive, true))
    .orderBy(asc(contentCategory.sortOrder), asc(contentCategory.slug));
}

/**
 * Of the ids given, which ones cannot be tagged into — because they do not exist, or
 * because they have been retired?
 *
 * THE TWO CASES COLLAPSE DELIBERATELY. A creator fixes both the same way (pick a different
 * category), and distinguishing them would leak which ids exist to anyone who can call the
 * studio — the same reasoning that makes a video the caller does not own a 404 rather than
 * a 403.
 *
 * Returns the WHOLE offending list, not the first. A client sends up to three and must be
 * able to strike all the bad ones in one edit. Copies `findUnownedProductIds`.
 */
export async function findUnavailableCategoryIds(
  categoryIds: readonly string[],
): Promise<readonly string[]> {
  if (categoryIds.length === 0) {
    return [];
  }

  const availableRows = await db
    .select({ id: contentCategory.id })
    .from(contentCategory)
    // `isActive` is half the predicate, not a refinement of it: a retired category must
    // come back in the unavailable list exactly like an unknown one.
    .where(and(inArray(contentCategory.id, [...categoryIds]), eq(contentCategory.isActive, true)));

  const availableIds = new Set(availableRows.map((row) => row.id));
  return categoryIds.filter((categoryId) => !availableIds.has(categoryId));
}

/**
 * The id behind `DEFAULT_CONTENT_CATEGORY_SLUG`, or `null` when that row is missing or has
 * been retired.
 *
 * `null` IS A LEGITIMATE ANSWER AND NOT AN ERROR, which is why this returns an id rather
 * than a `Result`. The caller's contract is to write no categories in that case — the
 * behaviour before the default existed. An upload refused because an operator forgot to run
 * `pnpm db:seed-content-categories` would trade a soft problem (an untagged video) for a
 * hard one (a creator who cannot publish), and the seed row is not something a creator can
 * fix.
 *
 * `isActive` is part of the lookup for the same reason it is half of
 * `findUnavailableCategoryIds`' predicate: retiring the default must stop new videos from
 * being tagged into it, not start writing rows a filter will never surface.
 */
export async function resolveDefaultCategoryId(): Promise<string | null> {
  const [defaultRow] = await db
    .select({ id: contentCategory.id })
    .from(contentCategory)
    .where(
      and(
        eq(contentCategory.slug, DEFAULT_CONTENT_CATEGORY_SLUG),
        eq(contentCategory.isActive, true),
      ),
    )
    .limit(1);

  return defaultRow?.id ?? null;
}
