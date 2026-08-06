import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceCompletion, commerceOrder, commerceReview } from "#src/db/schema.js";

export interface ProductReviewMetrics {
  readonly averageRating: number | null;
  readonly reviewCount: number;
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
