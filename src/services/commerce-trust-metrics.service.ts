import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceOrder,
  commerceReview,
  commerceReviewScore,
} from "#src/db/schema.js";

export interface ProductReviewMetrics {
  readonly averageRating: number | null;
  readonly reviewCount: number;
}

/** The five bars of the rating breakdown, in integer counts (Appendix A8). */
export interface ReviewRatingHistogram {
  readonly rating1: number;
  readonly rating2: number;
  readonly rating3: number;
  readonly rating4: number;
  readonly rating5: number;
}

export interface ReviewScoreAverage {
  readonly average: number | null;
  readonly count: number;
}

export interface ReviewScoreAverages {
  readonly service: ReviewScoreAverage;
  readonly shipping: ReviewScoreAverage;
  readonly quality: ReviewScoreAverage;
}

/**
 * The full summary the ratings section needs (Appendix A8).
 *
 * Deliberately NOT folded into `ProductReviewMetrics`: that one runs for up to 48
 * cards on a category page, and a five-bucket histogram plus sub-score joins per card
 * is payload nobody renders. This is loaded only by the reviews route, which the
 * client fetches when the section is opened.
 */
export interface ReviewSummaryAggregate {
  readonly averageRating: number | null;
  readonly reviewCount: number;
  readonly ratingHistogram: ReviewRatingHistogram;
  readonly reviewsWithMediaCount: number;
  readonly mediaCount: number;
}

const EMPTY_RATING_HISTOGRAM: ReviewRatingHistogram = {
  rating1: 0,
  rating2: 0,
  rating3: 0,
  rating4: 0,
  rating5: 0,
};

export const EMPTY_REVIEW_SUMMARY: ReviewSummaryAggregate = {
  averageRating: null,
  reviewCount: 0,
  ratingHistogram: EMPTY_RATING_HISTOGRAM,
  reviewsWithMediaCount: 0,
  mediaCount: 0,
};

const EMPTY_SCORE_AVERAGE: ReviewScoreAverage = { average: null, count: 0 };

export const EMPTY_REVIEW_SCORE_AVERAGES: ReviewScoreAverages = {
  service: EMPTY_SCORE_AVERAGE,
  shipping: EMPTY_SCORE_AVERAGE,
  quality: EMPTY_SCORE_AVERAGE,
};

/** `avg(rating)::text` comes back as a numeric string; two decimal places is enough. */
function parseAverage(rawAverage: string | null): number | null {
  return rawAverage === null ? null : Number.parseFloat(Number(rawAverage).toFixed(2));
}

export interface OrganizationFulfillmentMetrics {
  readonly onTimeShipmentRate: number | null;
  readonly completedOrderCount: number;
}

export interface OrganizationReviewMetrics {
  readonly averageRating: number | null;
  readonly reviewCount: number;
}

/**
 * Loads privacy-safe review aggregates for products. Only visible reviews are counted.
 */
export async function loadProductReviewMetrics(
  productIds: readonly string[],
): Promise<ReadonlyMap<string, ProductReviewMetrics>> {
  const metrics = new Map<string, ProductReviewMetrics>();
  if (productIds.length === 0) return metrics;

  const rows = await db
    .select({
      productId: commerceReview.productId,
      reviewCount: sql<number>`count(*)::int`,
      averageRating: sql<string | null>`avg(${commerceReview.rating})::text`,
    })
    .from(commerceReview)
    .where(
      and(
        inArray(commerceReview.productId, [...productIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.productId);

  for (const productId of productIds) {
    metrics.set(productId, { averageRating: null, reviewCount: 0 });
  }
  for (const row of rows) {
    if (row.productId === null) continue;
    metrics.set(row.productId, {
      averageRating:
        row.averageRating === null ? null : Number.parseFloat(Number(row.averageRating).toFixed(2)),
      reviewCount: row.reviewCount,
    });
  }
  return metrics;
}

/**
 * Loads seller/provider review aggregates over all visible reviews of the organization.
 */
export async function loadOrganizationReviewMetrics(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, OrganizationReviewMetrics>> {
  const metrics = new Map<string, OrganizationReviewMetrics>();
  if (organizationIds.length === 0) return metrics;

  const rows = await db
    .select({
      subjectOrganizationId: commerceReview.subjectOrganizationId,
      reviewCount: sql<number>`count(*)::int`,
      averageRating: sql<string | null>`avg(${commerceReview.rating})::text`,
    })
    .from(commerceReview)
    .where(
      and(
        inArray(commerceReview.subjectOrganizationId, [...organizationIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.subjectOrganizationId);

  for (const organizationId of organizationIds) {
    metrics.set(organizationId, { averageRating: null, reviewCount: 0 });
  }
  for (const row of rows) {
    metrics.set(row.subjectOrganizationId, {
      averageRating:
        row.averageRating === null ? null : Number.parseFloat(Number(row.averageRating).toFixed(2)),
      reviewCount: row.reviewCount,
    });
  }
  return metrics;
}

/**
 * Completed product-line completions count toward seller fulfillment volume.
 * onTimeShipmentRate stays null until promised-delivery timestamps exist.
 */
export async function loadOrganizationFulfillmentMetrics(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, OrganizationFulfillmentMetrics>> {
  const metrics = new Map<string, OrganizationFulfillmentMetrics>();
  if (organizationIds.length === 0) return metrics;

  const rows = await db
    .select({
      counterpartyOrganizationId: commerceCompletion.counterpartyOrganizationId,
      completedOrderCount: sql<number>`count(distinct ${commerceCompletion.orderId})::int`,
    })
    .from(commerceCompletion)
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceCompletion.orderId))
    .where(
      and(
        inArray(commerceCompletion.counterpartyOrganizationId, [...organizationIds]),
        eq(commerceCompletion.targetKind, "product_order_line"),
        eq(commerceOrder.state, "completed"),
      ),
    )
    .groupBy(commerceCompletion.counterpartyOrganizationId);

  for (const organizationId of organizationIds) {
    metrics.set(organizationId, { onTimeShipmentRate: null, completedOrderCount: 0 });
  }
  for (const row of rows) {
    metrics.set(row.counterpartyOrganizationId, {
      onTimeShipmentRate: null,
      completedOrderCount: row.completedOrderCount,
    });
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Appendix A8 — the summary aggregates behind the ratings section.
//
// Every one of these is a single `= any($1)` + GROUP BY, so they are N+1-free by
// construction no matter how many ids the caller passes. The histogram is computed
// with `count(*) FILTER (WHERE rating = n)` over the SAME partial index the plain
// aggregate already uses, so five buckets cost no extra scan.
//
// The two pre-existing loaders above are UNCHANGED on purpose. They run on the card
// path for up to 48 products at a time and only need stars plus a count.
// ---------------------------------------------------------------------------

/**
 * Rating breakdown, media counts and the average for a set of products.
 *
 * Counted over VISIBLE reviews only, which is also what makes moderation work: hiding
 * a review corrects the rating with no separate recomputation step.
 */
export async function loadProductReviewSummaries(
  productIds: readonly string[],
): Promise<ReadonlyMap<string, ReviewSummaryAggregate>> {
  const summaries = new Map<string, ReviewSummaryAggregate>();
  if (productIds.length === 0) return summaries;

  const rows = await db
    .select({
      productId: commerceReview.productId,
      reviewCount: sql<number>`count(*)::int`,
      averageRating: sql<string | null>`avg(${commerceReview.rating})::text`,
      rating1: sql<number>`count(*) filter (where ${commerceReview.rating} = 1)::int`,
      rating2: sql<number>`count(*) filter (where ${commerceReview.rating} = 2)::int`,
      rating3: sql<number>`count(*) filter (where ${commerceReview.rating} = 3)::int`,
      rating4: sql<number>`count(*) filter (where ${commerceReview.rating} = 4)::int`,
      rating5: sql<number>`count(*) filter (where ${commerceReview.rating} = 5)::int`,
      reviewsWithMediaCount: sql<number>`count(*) filter (where ${commerceReview.mediaCount} > 0)::int`,
      mediaCount: sql<number>`coalesce(sum(${commerceReview.mediaCount}), 0)::int`,
    })
    .from(commerceReview)
    .where(
      and(
        inArray(commerceReview.productId, [...productIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.productId);

  for (const productId of productIds) {
    summaries.set(productId, EMPTY_REVIEW_SUMMARY);
  }
  for (const row of rows) {
    if (row.productId === null) continue;
    summaries.set(row.productId, {
      averageRating: parseAverage(row.averageRating),
      reviewCount: row.reviewCount,
      ratingHistogram: {
        rating1: row.rating1,
        rating2: row.rating2,
        rating3: row.rating3,
        rating4: row.rating4,
        rating5: row.rating5,
      },
      reviewsWithMediaCount: row.reviewsWithMediaCount,
      mediaCount: row.mediaCount,
    });
  }
  return summaries;
}

/** The organization mirror — reviews of a seller or provider, product-scoped or not. */
export async function loadOrganizationReviewSummaries(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, ReviewSummaryAggregate>> {
  const summaries = new Map<string, ReviewSummaryAggregate>();
  if (organizationIds.length === 0) return summaries;

  const rows = await db
    .select({
      subjectOrganizationId: commerceReview.subjectOrganizationId,
      reviewCount: sql<number>`count(*)::int`,
      averageRating: sql<string | null>`avg(${commerceReview.rating})::text`,
      rating1: sql<number>`count(*) filter (where ${commerceReview.rating} = 1)::int`,
      rating2: sql<number>`count(*) filter (where ${commerceReview.rating} = 2)::int`,
      rating3: sql<number>`count(*) filter (where ${commerceReview.rating} = 3)::int`,
      rating4: sql<number>`count(*) filter (where ${commerceReview.rating} = 4)::int`,
      rating5: sql<number>`count(*) filter (where ${commerceReview.rating} = 5)::int`,
      reviewsWithMediaCount: sql<number>`count(*) filter (where ${commerceReview.mediaCount} > 0)::int`,
      mediaCount: sql<number>`coalesce(sum(${commerceReview.mediaCount}), 0)::int`,
    })
    .from(commerceReview)
    .where(
      and(
        inArray(commerceReview.subjectOrganizationId, [...organizationIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.subjectOrganizationId);

  for (const organizationId of organizationIds) {
    summaries.set(organizationId, EMPTY_REVIEW_SUMMARY);
  }
  for (const row of rows) {
    summaries.set(row.subjectOrganizationId, {
      averageRating: parseAverage(row.averageRating),
      reviewCount: row.reviewCount,
      ratingHistogram: {
        rating1: row.rating1,
        rating2: row.rating2,
        rating3: row.rating3,
        rating4: row.rating4,
        rating5: row.rating5,
      },
      reviewsWithMediaCount: row.reviewsWithMediaCount,
      mediaCount: row.mediaCount,
    });
  }
  return summaries;
}

function foldScoreRows(
  rows: readonly {
    readonly groupId: string | null;
    readonly axis: "service" | "shipping" | "quality";
    readonly average: string | null;
    readonly scoreCount: number;
  }[],
  groupIds: readonly string[],
): ReadonlyMap<string, ReviewScoreAverages> {
  const averages = new Map<string, ReviewScoreAverages>();
  for (const groupId of groupIds) {
    averages.set(groupId, EMPTY_REVIEW_SCORE_AVERAGES);
  }
  for (const row of rows) {
    if (row.groupId === null) continue;
    const current = averages.get(row.groupId) ?? EMPTY_REVIEW_SCORE_AVERAGES;
    averages.set(row.groupId, {
      ...current,
      [row.axis]: { average: parseAverage(row.average), count: row.scoreCount },
    });
  }
  return averages;
}

/** Service / Shipping / Quality averages per product (Appendix A8's three bars). */
export async function loadProductReviewScoreAverages(
  productIds: readonly string[],
): Promise<ReadonlyMap<string, ReviewScoreAverages>> {
  if (productIds.length === 0) return new Map<string, ReviewScoreAverages>();

  const rows = await db
    .select({
      groupId: commerceReview.productId,
      axis: commerceReviewScore.axis,
      average: sql<string | null>`avg(${commerceReviewScore.score})::text`,
      scoreCount: sql<number>`count(*)::int`,
    })
    .from(commerceReviewScore)
    .innerJoin(commerceReview, eq(commerceReview.id, commerceReviewScore.reviewId))
    .where(
      and(
        inArray(commerceReview.productId, [...productIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.productId, commerceReviewScore.axis);

  return foldScoreRows(rows, productIds);
}

/** The organization mirror of the sub-score averages. */
export async function loadOrganizationReviewScoreAverages(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, ReviewScoreAverages>> {
  if (organizationIds.length === 0) return new Map<string, ReviewScoreAverages>();

  const rows = await db
    .select({
      groupId: commerceReview.subjectOrganizationId,
      axis: commerceReviewScore.axis,
      average: sql<string | null>`avg(${commerceReviewScore.score})::text`,
      scoreCount: sql<number>`count(*)::int`,
    })
    .from(commerceReviewScore)
    .innerJoin(commerceReview, eq(commerceReview.id, commerceReviewScore.reviewId))
    .where(
      and(
        inArray(commerceReview.subjectOrganizationId, [...organizationIds]),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .groupBy(commerceReview.subjectOrganizationId, commerceReviewScore.axis);

  return foldScoreRows(rows, organizationIds);
}
