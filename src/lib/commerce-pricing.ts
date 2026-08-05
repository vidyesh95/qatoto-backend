import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCategory,
  commerceInventoryReservation,
  commerceOrganization,
  product,
  productPricingTier,
} from "#src/db/schema.js";
import { deriveStockState } from "#src/services/store-catalog.service.js";
import type { Result } from "#src/types/index.js";

export type CommercePricingError =
  | { type: "PRODUCT_NOT_FOUND" }
  | { type: "PRODUCT_NOT_PURCHASABLE" }
  | { type: "BELOW_MINIMUM_ORDER_QUANTITY"; minimumOrderQuantity: number }
  | { type: "INSUFFICIENT_STOCK"; availableQuantity: number }
  | { type: "SELLER_ORGANIZATION_MISSING" };

export interface PricedProductLine {
  readonly productId: string;
  readonly sellerOrganizationId: string;
  readonly title: string;
  readonly brand: string | null;
  readonly description: string | null;
  readonly currency: string;
  readonly quantity: number;
  readonly unitPriceInCents: number;
  readonly lineTotalInCents: number;
  readonly minimumOrderQuantity: number;
  readonly isMadeToOrder: boolean;
  readonly stockQuantity: number;
  readonly availableQuantity: number;
}

type DatabaseExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Resolves the authoritative unit price for a quantity.
 * Highest eligible tier (by MOQ) wins; base product price is used when no tiers exist.
 */
export function resolveUnitPriceInCents(input: {
  readonly basePriceInCents: number;
  readonly quantity: number;
  readonly tiers: readonly {
    readonly unitPriceInCents: number;
    readonly minimumOrderQuantity: number;
  }[];
}): { readonly unitPriceInCents: number; readonly minimumOrderQuantity: number } {
  if (input.tiers.length === 0) {
    return { unitPriceInCents: input.basePriceInCents, minimumOrderQuantity: 1 };
  }

  const sortedTiers = [...input.tiers].toSorted(
    (left, right) => right.minimumOrderQuantity - left.minimumOrderQuantity,
  );
  const lowestMoq = Math.min(...input.tiers.map((tier) => tier.minimumOrderQuantity));
  const eligibleTier = sortedTiers.filter((tier) => input.quantity >= tier.minimumOrderQuantity);
  if (eligibleTier.length === 0) {
    return {
      unitPriceInCents: input.basePriceInCents,
      minimumOrderQuantity: lowestMoq,
    };
  }

  const selectedTier = eligibleTier[0];
  return {
    unitPriceInCents: selectedTier.unitPriceInCents,
    minimumOrderQuantity: lowestMoq,
  };
}

export async function loadHeldQuantitiesByProduct(
  databaseExecutor: DatabaseExecutor,
  productIds: readonly string[],
  asOf: Date,
  excludePrepareId?: string,
): Promise<Map<string, number>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const rows = await databaseExecutor
    .select({
      productId: commerceInventoryReservation.productId,
      quantity:
        sql<number>`coalesce(sum(${commerceInventoryReservation.quantity}), 0)::int`.mapWith(
          Number,
        ),
    })
    .from(commerceInventoryReservation)
    .where(
      and(
        inArray(commerceInventoryReservation.productId, [...productIds]),
        eq(commerceInventoryReservation.state, "held"),
        eq(commerceInventoryReservation.isMadeToOrder, false),
        gt(commerceInventoryReservation.expiresAt, asOf),
        excludePrepareId === undefined
          ? undefined
          : sql`${commerceInventoryReservation.checkoutPrepareId} IS DISTINCT FROM ${excludePrepareId}`,
      ),
    )
    .groupBy(commerceInventoryReservation.productId);

  return new Map(rows.map((row) => [row.productId, row.quantity]));
}

export async function loadPurchasableProductForCheckout(
  databaseExecutor: DatabaseExecutor,
  productId: string,
  quantity: number,
  heldQuantityExcludingSelf = 0,
): Promise<Result<PricedProductLine, CommercePricingError>> {
  const [row] = await databaseExecutor
    .select({
      id: product.id,
      title: product.title,
      brand: product.brand,
      description: product.description,
      currency: product.currency,
      priceInCents: product.priceInCents,
      stockQuantity: product.stockQuantity,
      leadTimeMinDays: product.leadTimeMinDays,
      leadTimeMaxDays: product.leadTimeMaxDays,
      sellerOrganizationId: product.sellerOrganizationId,
      status: product.status,
      moderationState: product.moderationState,
      publicSlug: product.publicSlug,
      organizationTradeState: commerceOrganization.tradeState,
      organizationVisibility: commerceOrganization.visibility,
      categoryState: commerceCategory.state,
    })
    .from(product)
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, product.sellerOrganizationId))
    .innerJoin(commerceCategory, eq(commerceCategory.id, product.categoryId))
    .where(eq(product.id, productId))
    .limit(1);

  if (!row) {
    return { success: false, error: { type: "PRODUCT_NOT_FOUND" } };
  }
  if (row.sellerOrganizationId === null) {
    return { success: false, error: { type: "SELLER_ORGANIZATION_MISSING" } };
  }
  if (
    row.status !== "active" ||
    row.moderationState !== "approved" ||
    row.publicSlug === null ||
    row.organizationTradeState !== "active" ||
    row.organizationVisibility !== "public" ||
    row.categoryState !== "active"
  ) {
    return { success: false, error: { type: "PRODUCT_NOT_PURCHASABLE" } };
  }

  const tiers = await databaseExecutor
    .select({
      unitPriceInCents: productPricingTier.unitPriceInCents,
      minimumOrderQuantity: productPricingTier.minimumOrderQuantity,
    })
    .from(productPricingTier)
    .where(eq(productPricingTier.productId, productId))
    .orderBy(asc(productPricingTier.position));

  const priced = resolveUnitPriceInCents({
    basePriceInCents: row.priceInCents,
    quantity,
    tiers,
  });
  if (quantity < priced.minimumOrderQuantity) {
    return {
      success: false,
      error: {
        type: "BELOW_MINIMUM_ORDER_QUANTITY",
        minimumOrderQuantity: priced.minimumOrderQuantity,
      },
    };
  }

  const stockState = deriveStockState({
    stockQuantity: row.stockQuantity,
    leadTimeMinDays: row.leadTimeMinDays,
    leadTimeMaxDays: row.leadTimeMaxDays,
  });
  const isMadeToOrder = stockState === "made_to_order";
  if (stockState === "unavailable") {
    return {
      success: false,
      error: { type: "INSUFFICIENT_STOCK", availableQuantity: 0 },
    };
  }

  const availableQuantity = Math.max(0, row.stockQuantity - heldQuantityExcludingSelf);
  if (!isMadeToOrder && quantity > availableQuantity) {
    return {
      success: false,
      error: { type: "INSUFFICIENT_STOCK", availableQuantity },
    };
  }

  return {
    success: true,
    value: {
      productId: row.id,
      sellerOrganizationId: row.sellerOrganizationId,
      title: row.title,
      brand: row.brand,
      description: row.description,
      currency: row.currency,
      quantity,
      unitPriceInCents: priced.unitPriceInCents,
      lineTotalInCents: priced.unitPriceInCents * quantity,
      minimumOrderQuantity: priced.minimumOrderQuantity,
      isMadeToOrder,
      stockQuantity: row.stockQuantity,
      availableQuantity: isMadeToOrder ? Number.MAX_SAFE_INTEGER : availableQuantity,
    },
  };
}

export function buildSpecificationSnapshot(input: {
  readonly brand: string | null;
  readonly description: string | null;
}): string {
  const parts: string[] = [];
  if (input.brand !== null && input.brand.trim() !== "") {
    parts.push(`Brand: ${input.brand.trim()}`);
  }
  if (input.description !== null && input.description.trim() !== "") {
    parts.push(input.description.trim());
  }
  return parts.length > 0 ? parts.join("\n").slice(0, 10_000) : "Product listing snapshot";
}
