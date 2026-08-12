import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceMessage,
  commerceOrder,
  commerceOrganizationMember,
  commerceReview,
  commerceReviewScore,
  commerceShipment,
  commerceShipmentEvent,
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

/**
 * PLATFORM-MEASURED fulfillment facts about a counterparty organization (Appendix A13).
 *
 * Every rate here is `null` below its sample threshold, and its sample size ALWAYS rides
 * alongside. "We measured 100% across three orders" is not a performance claim, and a bare
 * `1.0` is indistinguishable from a well-earned one — so the wire carries the evidence and
 * the client decides whether to render "not enough data yet".
 *
 * Nothing on this interface is seller-supplied. The seller's own assertions live on
 * `SellerDeclaredProfileProjection`, and A13's closing rule is that the two must not be
 * renderable through one code path.
 */
export interface OrganizationFulfillmentMetrics {
  /**
   * Share of promised, delivered, non-cancelled orders that arrived by their promise.
   *
   * Was hardcoded `null` from Phase 7 until Phase 12 because no promised-delivery
   * timestamp existed. It is now real — but still `null` for a seller below
   * {@link ON_TIME_MINIMUM_SAMPLE}, and still `null` for a seller who never declared a
   * lead time, because such orders carry no promise and are absent from the denominator.
   */
  readonly onTimeShipmentRate: number | null;
  /** Orders that had BOTH a promise and a delivery, so could be scored either way. */
  readonly onTimeSampleSize: number;
  readonly completedOrderCount: number;
}

/**
 * The fulfillment metrics PLUS the two that only a company page renders (A13 item 7).
 *
 * SEPARATE FROM THE CARD SHAPE ON PURPOSE, for exactly the reason the review summaries
 * below are separate from `loadProductReviewMetrics`: reorder rate and measured response
 * time cost a per-buyer aggregate over a year of orders and a window function over ninety
 * days of messages. A category page asks for 48 organizations at once and renders neither.
 * Folding all six into the card loader would put that scan on every browse request to buy a
 * number nobody displays there.
 */
export interface OrganizationMeasuredMetrics extends OrganizationFulfillmentMetrics {
  /** Share of this seller's buyers who bought again. Null below the buyer threshold. */
  readonly reorderRate: number | null;
  /** Distinct buyer organizations with at least one completed order in the window. */
  readonly reorderSampleSize: number;
  /**
   * MEASURED median hours to reply in a thread, not the integer a provider typed about
   * itself. That one is `commerce_provider_profile.averageResponseTimeHours` and is
   * projected as a DECLARED field; conflating them is the specific mistake A13 names.
   */
  readonly measuredResponseTimeHours: number | null;
  readonly responseSampleSize: number;
}

/**
 * Below these, the rate is `null` and only the sample size ships.
 *
 * The thresholds themselves stay OFF the wire. A client that knew them could render "3 of
 * 10 orders needed", which reads as a countdown to a good score rather than an absence of
 * evidence — and would need a coordinated release every time one is retuned.
 */
const ON_TIME_MINIMUM_SAMPLE = 10;
const REORDER_MINIMUM_BUYERS = 10;
const RESPONSE_MINIMUM_SAMPLE = 5;

/** Trailing windows. Reorder needs a year to see a repeat; responsiveness is current. */
const REORDER_WINDOW_DAYS = 365;
const RESPONSE_WINDOW_DAYS = 90;

const MILLISECONDS_PER_DAY = 86_400_000;

export const EMPTY_FULFILLMENT_METRICS: OrganizationFulfillmentMetrics = {
  onTimeShipmentRate: null,
  onTimeSampleSize: 0,
  completedOrderCount: 0,
};

export const EMPTY_MEASURED_METRICS: OrganizationMeasuredMetrics = {
  ...EMPTY_FULFILLMENT_METRICS,
  reorderRate: null,
  reorderSampleSize: 0,
  measuredResponseTimeHours: null,
  responseSampleSize: 0,
};

/** Rates are shipped as fractions rounded to four places, never pre-formatted strings. */
function deriveRate(numerator: number, denominator: number, minimumSample: number): number | null {
  if (denominator < minimumSample || denominator === 0) return null;
  return Number.parseFloat((numerator / denominator).toFixed(4));
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
 * THE CARD PATH: completed volume and on-time rate (Appendix A13 item 1).
 *
 * Two aggregates, each a single `= any($1)` + GROUP BY, so this is two round trips whether
 * the caller asks for one organization or forty-eight. `onTimeShipmentRate` was hardcoded
 * `null` here until Phase 12 supplied `commerce_order.promisedDeliveryAt`.
 *
 * Reorder rate and measured response time are deliberately NOT here — see
 * {@link loadOrganizationMeasuredMetrics}.
 */
export async function loadOrganizationFulfillmentMetrics(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, OrganizationFulfillmentMetrics>> {
  const metrics = new Map<string, OrganizationFulfillmentMetrics>();
  if (organizationIds.length === 0) return metrics;

  const requestedIds = [...organizationIds];

  const [completionRows, onTimeRows] = await Promise.all([
    completedOrderCountQuery(requestedIds),
    onTimeQuery(requestedIds),
  ]);

  for (const organizationId of requestedIds) {
    metrics.set(organizationId, EMPTY_FULFILLMENT_METRICS);
  }
  for (const row of completionRows) {
    const current = metrics.get(row.counterpartyOrganizationId) ?? EMPTY_FULFILLMENT_METRICS;
    metrics.set(row.counterpartyOrganizationId, {
      ...current,
      completedOrderCount: row.completedOrderCount,
    });
  }
  for (const row of onTimeRows) {
    const current = metrics.get(row.counterpartyOrganizationId) ?? EMPTY_FULFILLMENT_METRICS;
    metrics.set(row.counterpartyOrganizationId, {
      ...current,
      onTimeSampleSize: row.onTimeSampleSize,
      onTimeShipmentRate: deriveRate(row.onTimeCount, row.onTimeSampleSize, ON_TIME_MINIMUM_SAMPLE),
    });
  }
  return metrics;
}

/**
 * An order counts as delivered at its LAST shipment's delivered event, matching
 * `latestPromisedDeliveryAt`: the order is done when its slowest part arrived. Scoring
 * against the first delivery would pass a split shipment whose remainder never came.
 */
function deliveredOrdersSubquery() {
  return db
    .select({
      orderId: commerceShipment.orderId,
      deliveredAt: sql<Date>`max(${commerceShipmentEvent.occurredAt})`.as("delivered_at"),
    })
    .from(commerceShipment)
    .innerJoin(
      commerceShipmentEvent,
      and(
        eq(commerceShipmentEvent.shipmentId, commerceShipment.id),
        eq(commerceShipmentEvent.eventKind, "delivered"),
      ),
    )
    .groupBy(commerceShipment.orderId)
    .as("delivered_orders");
}

function completedOrderCountQuery(requestedIds: readonly string[]) {
  return db
    .select({
      counterpartyOrganizationId: commerceCompletion.counterpartyOrganizationId,
      completedOrderCount: sql<number>`count(distinct ${commerceCompletion.orderId})::int`,
    })
    .from(commerceCompletion)
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceCompletion.orderId))
    .where(
      and(
        inArray(commerceCompletion.counterpartyOrganizationId, [...requestedIds]),
        eq(commerceCompletion.targetKind, "product_order_line"),
        eq(commerceOrder.state, "completed"),
      ),
    )
    .groupBy(commerceCompletion.counterpartyOrganizationId);
}

function onTimeQuery(requestedIds: readonly string[]) {
  const deliveredOrders = deliveredOrdersSubquery();
  return db
    .select({
      counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
      onTimeSampleSize: sql<number>`count(*)::int`,
      onTimeCount: sql<number>`count(*) filter (where ${deliveredOrders.deliveredAt} <= ${commerceOrder.promisedDeliveryAt})::int`,
    })
    .from(commerceOrder)
    .innerJoin(deliveredOrders, eq(deliveredOrders.orderId, commerceOrder.id))
    .where(
      and(
        inArray(commerceOrder.counterpartyOrganizationId, [...requestedIds]),
        // No promise, no score. Absent from the denominator, never counted as met.
        isNotNull(commerceOrder.promisedDeliveryAt),
        // A cancelled order's delivery date is moot even if a shipment moved.
        ne(commerceOrder.state, "cancelled"),
      ),
    )
    .groupBy(commerceOrder.counterpartyOrganizationId);
}

/**
 * THE COMPANY-PAGE PATH: all six measured facts (Appendix A13 items 1 and 7).
 *
 * Four independent aggregates, because they group over different tables and different
 * windows — completions, orders joined to delivery events, orders by buyer, and messages.
 * Each is a single `= any($1)` + GROUP BY, so this is four round trips regardless of how
 * many organizations are asked for. They run concurrently.
 *
 * Called only by the storefront and provider DETAIL reads. A category page's 48 cards go
 * through {@link loadOrganizationFulfillmentMetrics} instead, which skips the per-buyer
 * year of orders and the ninety-day message window they do not render.
 */
export async function loadOrganizationMeasuredMetrics(
  organizationIds: readonly string[],
  asOf: Date = new Date(),
): Promise<ReadonlyMap<string, OrganizationMeasuredMetrics>> {
  const metrics = new Map<string, OrganizationMeasuredMetrics>();
  if (organizationIds.length === 0) return metrics;

  const requestedIds = [...organizationIds];

  /**
   * Repeat buyers per seller. `state = 'completed'` on both sides of the fraction: a
   * cancelled order is not a purchase, so it neither proves a first buy nor a return.
   */
  const buyerOrderCounts = db
    .select({
      counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
      buyerOrganizationId: commerceOrder.buyerOrganizationId,
      orderCount: sql<number>`count(*)::int`.as("order_count"),
    })
    .from(commerceOrder)
    .where(
      and(
        inArray(commerceOrder.counterpartyOrganizationId, requestedIds),
        eq(commerceOrder.state, "completed"),
        gte(
          commerceOrder.createdAt,
          new Date(asOf.getTime() - REORDER_WINDOW_DAYS * MILLISECONDS_PER_DAY),
        ),
      ),
    )
    .groupBy(commerceOrder.counterpartyOrganizationId, commerceOrder.buyerOrganizationId)
    .as("buyer_order_counts");

  /**
   * Every message in the window with the organization that sent it and the message
   * immediately before it in the same thread.
   *
   * The join to `commerce_organization_member` resolves the sender's organization even for
   * a member who has since left — those rows persist as `state = 'left'` history, so
   * attribution stays correct rather than silently dropping a departed employee's replies
   * out of the denominator.
   *
   * Ordered by `(createdAt, id)`: two messages in the same millisecond must have a
   * deterministic predecessor, or the median would wobble between reads. Same reason §7
   * requires a unique tiebreaker on every cursor.
   */
  const adjacentMessages = db
    .select({
      organizationId: commerceOrganizationMember.organizationId,
      createdAt: commerceMessage.createdAt,
      previousCreatedAt:
        sql<Date | null>`lag(${commerceMessage.createdAt}) over (partition by ${commerceMessage.threadId} order by ${commerceMessage.createdAt}, ${commerceMessage.id})`.as(
          "previous_created_at",
        ),
      previousOrganizationId: sql<
        string | null
      >`lag(${commerceOrganizationMember.organizationId}) over (partition by ${commerceMessage.threadId} order by ${commerceMessage.createdAt}, ${commerceMessage.id})`.as(
        "previous_organization_id",
      ),
    })
    .from(commerceMessage)
    .innerJoin(
      commerceOrganizationMember,
      eq(commerceOrganizationMember.id, commerceMessage.authorMemberId),
    )
    .where(
      gte(
        commerceMessage.createdAt,
        new Date(asOf.getTime() - RESPONSE_WINDOW_DAYS * MILLISECONDS_PER_DAY),
      ),
    )
    .as("adjacent_messages");

  const [completionRows, onTimeRows, reorderRows, responseRows] = await Promise.all([
    completedOrderCountQuery(requestedIds),
    onTimeQuery(requestedIds),

    db
      .select({
        counterpartyOrganizationId: buyerOrderCounts.counterpartyOrganizationId,
        buyerCount: sql<number>`count(*)::int`,
        repeatBuyerCount: sql<number>`count(*) filter (where ${buyerOrderCounts.orderCount} >= 2)::int`,
      })
      .from(buyerOrderCounts)
      .groupBy(buyerOrderCounts.counterpartyOrganizationId),

    db
      .select({
        organizationId: adjacentMessages.organizationId,
        responseSampleSize: sql<number>`count(*)::int`,
        /**
         * MEDIAN, not mean. One thread left unanswered over a weekend moves a mean by
         * hours and a median not at all, and "typically replies within N hours" is the
         * claim a buyer reads into this number.
         */
        medianHours: sql<
          string | null
        >`(percentile_cont(0.5) within group (order by extract(epoch from (${adjacentMessages.createdAt} - ${adjacentMessages.previousCreatedAt})) / 3600.0))::text`,
      })
      .from(adjacentMessages)
      .where(
        and(
          inArray(adjacentMessages.organizationId, requestedIds),
          // A reply, not a follow-up to itself: the preceding message must be another org's.
          isNotNull(adjacentMessages.previousOrganizationId),
          ne(adjacentMessages.previousOrganizationId, adjacentMessages.organizationId),
        ),
      )
      .groupBy(adjacentMessages.organizationId),
  ]);

  for (const organizationId of requestedIds) {
    metrics.set(organizationId, EMPTY_MEASURED_METRICS);
  }

  function mergeInto(organizationId: string, patch: Partial<OrganizationMeasuredMetrics>): void {
    const current = metrics.get(organizationId) ?? EMPTY_MEASURED_METRICS;
    metrics.set(organizationId, { ...current, ...patch });
  }

  for (const row of completionRows) {
    mergeInto(row.counterpartyOrganizationId, {
      completedOrderCount: row.completedOrderCount,
    });
  }
  for (const row of onTimeRows) {
    mergeInto(row.counterpartyOrganizationId, {
      onTimeSampleSize: row.onTimeSampleSize,
      onTimeShipmentRate: deriveRate(row.onTimeCount, row.onTimeSampleSize, ON_TIME_MINIMUM_SAMPLE),
    });
  }
  for (const row of reorderRows) {
    mergeInto(row.counterpartyOrganizationId, {
      reorderSampleSize: row.buyerCount,
      reorderRate: deriveRate(row.repeatBuyerCount, row.buyerCount, REORDER_MINIMUM_BUYERS),
    });
  }
  for (const row of responseRows) {
    mergeInto(row.organizationId, {
      responseSampleSize: row.responseSampleSize,
      measuredResponseTimeHours:
        row.responseSampleSize < RESPONSE_MINIMUM_SAMPLE ? null : parseAverage(row.medianHours),
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
