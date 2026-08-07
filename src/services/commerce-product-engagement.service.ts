import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceProductEngagement,
  commerceProductShare,
  commerceProductStats,
} from "#src/db/schema.js";
/**
 * THIS MODULE TAKES PRODUCT IDS, NOT SLUGS, and deliberately does not import
 * `store-catalog.service`.
 *
 * `store-catalog` imports `loadProductEngagements` to put the counters on the product
 * detail projection. If this file also imported the catalog's slug resolver the two
 * would form an import cycle — which ESM tolerates right up until one of them needs a
 * value from the other at module-evaluation time. Slug resolution therefore happens in
 * the controller, which is allowed to depend on both.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DatabaseExecutor = DatabaseTransaction | typeof db;

export type ProductEngagementKind =
  (typeof commerceProductEngagement.$inferSelect)["engagementKind"];

/**
 * The only way a public engagement write fails: the product is not publicly eligible,
 * which is indistinguishable from "does not exist" on purpose (§11 anti-enumeration).
 */
export type CommerceProductEngagementError = { type: "NOT_FOUND" };

export interface ProductViewerEngagement {
  readonly hasSaved: boolean;
  readonly hasBookmarked: boolean;
}

export interface ProductEngagementProjection {
  readonly savedCount: number;
  readonly bookmarkedCount: number;
  readonly shareCount: number;
  readonly questionCount: number;
  readonly answeredQuestionCount: number;
  /**
   * `null` for an anonymous caller, NOT `{hasSaved: false}`.
   *
   * "You have not saved this" and "we do not know who you are" are different facts,
   * and a definite `false` for a signed-out visitor teaches the client to render a
   * negative it has no basis for. Same reasoning as `video_stats.uniqueViewerCount`
   * being nullable rather than defaulting to zero.
   */
  readonly viewer: ProductViewerEngagement | null;
}

export const EMPTY_PRODUCT_ENGAGEMENT: ProductEngagementProjection = {
  savedCount: 0,
  bookmarkedCount: 0,
  shareCount: 0,
  questionCount: 0,
  answeredQuestionCount: 0,
  viewer: null,
};

/**
 * Mints the stats row for a product if it is missing.
 *
 * Called from THREE places — the migration backfill, product creation, and the top of
 * every toggle transaction — and the third is not redundant. Products have creation
 * paths this phase does not own, and a missing stats row makes the counter UPDATE
 * affect zero rows and lose the count with no error at all. `ensureVideoStatsRows`
 * carries the same warning for the same reason.
 */
export async function ensureCommerceProductStatsRow(
  executor: DatabaseExecutor,
  productId: string,
): Promise<void> {
  await executor.insert(commerceProductStats).values({ productId }).onConflictDoNothing();
}

/**
 * Counter deltas as literal `.set()` payloads, one per kind.
 *
 * NOT a dynamic `{ [column.name]: ... }`: drizzle's `.set()` is keyed by the TypeScript
 * property name (`savedCount`), while `column.name` is the DATABASE name
 * (`saved_count`). A computed key widens the object type enough that the compiler
 * accepts the mismatch and the update silently sets nothing.
 */
function buildEngagementCounterDelta(
  engagementKind: ProductEngagementKind,
  direction: "increment" | "decrement",
): { savedCount: SQL } | { bookmarkedCount: SQL } {
  const column =
    engagementKind === "saved"
      ? commerceProductStats.savedCount
      : commerceProductStats.bookmarkedCount;
  // GREATEST floors at zero: a drifted counter must not go negative and trip
  // `commerce_product_stats_counters_non_negative_ck` on an ordinary un-save.
  const delta = direction === "increment" ? sql`${column} + 1` : sql`GREATEST(${column} - 1, 0)`;
  return engagementKind === "saved" ? { savedCount: delta } : { bookmarkedCount: delta };
}

/**
 * Save or bookmark a product for the calling USER (Appendix A11).
 *
 * THE NO-DOUBLE-COUNT SHAPE, taken from `setVideoSave`: insert with
 * `onConflictDoNothing().returning()` and move the counter ONLY when a row actually
 * appeared. Checking "does a row exist?" and then inserting would let two concurrent
 * taps both see nothing and both increment, permanently inflating the count for one
 * save.
 *
 * Idempotent by verb, which is why the route carries no idempotency key: a repeated
 * PUT returns the same state instead of counting twice.
 */
export async function setProductEngagement(
  viewerUserId: string,
  productId: string,
  engagementKind: ProductEngagementKind,
): Promise<ProductEngagementProjection> {
  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);

    const inserted = await transaction
      .insert(commerceProductEngagement)
      .values({ productId: productId, userId: viewerUserId, engagementKind })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) return;

    await transaction
      .update(commerceProductStats)
      .set({
        ...buildEngagementCounterDelta(engagementKind, "increment"),
        lastEngagementAt: new Date(),
      })
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

/** Undo a save or bookmark (Appendix A11). Idempotent: clearing twice is not an error. */
export async function clearProductEngagement(
  viewerUserId: string,
  productId: string,
  engagementKind: ProductEngagementKind,
): Promise<ProductEngagementProjection> {
  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);

    const removed = await transaction
      .delete(commerceProductEngagement)
      .where(
        and(
          eq(commerceProductEngagement.productId, productId),
          eq(commerceProductEngagement.userId, viewerUserId),
          eq(commerceProductEngagement.engagementKind, engagementKind),
        ),
      )
      .returning();

    if (removed.length === 0) return;

    await transaction
      .update(commerceProductStats)
      .set(buildEngagementCounterDelta(engagementKind, "decrement"))
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

/**
 * Record a share (Appendix A11).
 *
 * Accepts an anonymous sharer, because most shares are. Every call is a new row: this
 * table has no channel and no day bucket, so unlike `video_share` there is nothing
 * honest to deduplicate on, and inventing a fingerprint would just make the count
 * wrong in a different direction.
 */
export async function recordProductShare(
  viewerUserId: string | null,
  productId: string,
): Promise<ProductEngagementProjection> {
  await db.transaction(async (transaction) => {
    await ensureCommerceProductStatsRow(transaction, productId);
    await transaction.insert(commerceProductShare).values({ productId, userId: viewerUserId });
    await transaction
      .update(commerceProductStats)
      .set({
        shareCount: sql`${commerceProductStats.shareCount} + 1`,
        lastEngagementAt: new Date(),
      })
      .where(eq(commerceProductStats.productId, productId));
  });

  return loadSingleProductEngagement(productId, viewerUserId);
}

async function loadSingleProductEngagement(
  productId: string,
  viewerUserId: string | null,
): Promise<ProductEngagementProjection> {
  const engagements = await loadProductEngagements([productId], viewerUserId);
  return engagements.get(productId) ?? EMPTY_PRODUCT_ENGAGEMENT;
}

/**
 * Loads counters and per-viewer state for a set of products (Appendix A11).
 *
 * Two queries regardless of how many ids are passed — one for the stats rows, one for
 * the viewer's own engagement rows — so this is safe to call from a list projection
 * as well as the detail page.
 */
export async function loadProductEngagements(
  productIds: readonly string[],
  viewerUserId: string | null,
): Promise<ReadonlyMap<string, ProductEngagementProjection>> {
  const engagements = new Map<string, ProductEngagementProjection>();
  if (productIds.length === 0) return engagements;

  const [statsRows, viewerRows] = await Promise.all([
    db
      .select()
      .from(commerceProductStats)
      .where(inArray(commerceProductStats.productId, [...productIds])),
    viewerUserId === null
      ? Promise.resolve([])
      : db
          .select({
            productId: commerceProductEngagement.productId,
            engagementKind: commerceProductEngagement.engagementKind,
          })
          .from(commerceProductEngagement)
          .where(
            and(
              inArray(commerceProductEngagement.productId, [...productIds]),
              eq(commerceProductEngagement.userId, viewerUserId),
            ),
          ),
  ]);

  const viewerStateByProduct = new Map<string, { hasSaved: boolean; hasBookmarked: boolean }>();
  for (const row of viewerRows) {
    const current = viewerStateByProduct.get(row.productId) ?? {
      hasSaved: false,
      hasBookmarked: false,
    };
    if (row.engagementKind === "saved") current.hasSaved = true;
    if (row.engagementKind === "bookmarked") current.hasBookmarked = true;
    viewerStateByProduct.set(row.productId, current);
  }

  const statsByProduct = new Map(statsRows.map((row) => [row.productId, row]));

  for (const productId of productIds) {
    const stats = statsByProduct.get(productId);
    engagements.set(productId, {
      savedCount: stats?.savedCount ?? 0,
      bookmarkedCount: stats?.bookmarkedCount ?? 0,
      shareCount: stats?.shareCount ?? 0,
      questionCount: stats?.questionCount ?? 0,
      answeredQuestionCount: stats?.answeredQuestionCount ?? 0,
      viewer:
        viewerUserId === null
          ? null
          : (viewerStateByProduct.get(productId) ?? { hasSaved: false, hasBookmarked: false }),
    });
  }
  return engagements;
}
