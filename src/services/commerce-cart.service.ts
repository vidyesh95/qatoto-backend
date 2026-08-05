import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCart,
  commerceCartProductLine,
  commerceCheckoutPrepare,
  commerceInventoryReservation,
  commerceOrganization,
  product,
} from "#src/db/schema.js";
import {
  loadHeldQuantitiesByProduct,
  loadPurchasableProductForCheckout,
  type CommercePricingError,
  type PricedProductLine,
} from "#src/lib/commerce-pricing.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { StoreStockState } from "#src/services/store-catalog.service.js";
import type { Result } from "#src/types/index.js";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CartRow = typeof commerceCart.$inferSelect;

/**
 * The cart mutation/read surface. `PRODUCT_NOT_PURCHASABLE`, `BELOW_MINIMUM_ORDER_QUANTITY`,
 * and `INSUFFICIENT_STOCK` are never the top-level result of `getCart` — a cart never fails
 * to load because one line went stale. They exist in this union so a per-line `pricingError`
 * (see `CommerceCartItemProjection`) can be typed against the same tags the checkout service
 * uses, rather than inventing a parallel vocabulary for the same three facts.
 */
export type CommerceCartError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "PRODUCT_NOT_PURCHASABLE" }
  | { type: "BELOW_MINIMUM_ORDER_QUANTITY"; minimumOrderQuantity: number }
  | { type: "INSUFFICIENT_STOCK"; availableQuantity: number }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "ORGANIZATION_NOT_ACTIVE" };

export interface CommerceCartActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface CommerceCartItemProjection {
  readonly productId: string;
  readonly quantity: number;
  readonly title: string;
  readonly currency: string | null;
  readonly unitPriceInCents: number | null;
  readonly lineTotalInCents: number | null;
  readonly isMadeToOrder: boolean | null;
  readonly minimumOrderQuantity: number | null;
  readonly stockState?: StoreStockState;
  readonly pricingError?: CommercePricingError;
}

export interface CommerceCartCurrencyTotalProjection {
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly totalInCents: number;
}

export interface CommerceCartProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly items: readonly CommerceCartItemProjection[];
  readonly currencyTotals: readonly CommerceCartCurrencyTotalProjection[];
  readonly updatedAt: Date;
}

/** Generous enough for any legitimate B2B order line; guards against integer abuse. */
const MAXIMUM_CART_LINE_QUANTITY = 1_000_000;

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce cart audit append failed: ${appended.error.type}`);
  }
}

/**
 * Loads or creates the one cart a buyer organization owns, without a row lock.
 * Safe for read paths; mutation paths must go through `getOrCreateCartForUpdate` instead.
 */
export async function getOrCreateCart(buyerOrganizationId: string): Promise<CartRow> {
  const [existing] = await db
    .select()
    .from(commerceCart)
    .where(eq(commerceCart.buyerOrganizationId, buyerOrganizationId))
    .limit(1);
  if (existing) return existing;

  try {
    const [created] = await db.insert(commerceCart).values({ buyerOrganizationId }).returning();
    if (!created) throw new Error("Cart insert returned no row.");
    return created;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      const [raced] = await db
        .select()
        .from(commerceCart)
        .where(eq(commerceCart.buyerOrganizationId, buyerOrganizationId))
        .limit(1);
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Same as `getOrCreateCart`, but takes and holds a row lock inside `transaction` — the shape
 * every cart-mutating and checkout-preparing transaction needs before touching lines,
 * reservations, or prepares for this buyer.
 */
export async function getOrCreateCartForUpdate(
  transaction: DatabaseTransaction,
  buyerOrganizationId: string,
): Promise<CartRow> {
  const [existing] = await transaction
    .select()
    .from(commerceCart)
    .where(eq(commerceCart.buyerOrganizationId, buyerOrganizationId))
    .for("update");
  if (existing) return existing;

  try {
    const [created] = await transaction
      .insert(commerceCart)
      .values({ buyerOrganizationId })
      .returning();
    if (!created) throw new Error("Cart insert returned no row.");
    return created;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      const [raced] = await transaction
        .select()
        .from(commerceCart)
        .where(eq(commerceCart.buyerOrganizationId, buyerOrganizationId))
        .for("update");
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Supersedes every active checkout preparation for one cart and releases the inventory it
 * was holding. Cart line mutations call this so a stale prepare can never be confirmed
 * against a cart that has since changed; `commerce-checkout.service.ts` calls it again
 * immediately before creating a fresh prepare, for the same reason.
 */
export async function supersedeActiveCheckoutPrepares(
  transaction: DatabaseTransaction,
  cartId: string,
  now: Date,
): Promise<void> {
  const activePrepares = await transaction
    .select({ id: commerceCheckoutPrepare.id })
    .from(commerceCheckoutPrepare)
    .where(
      and(eq(commerceCheckoutPrepare.cartId, cartId), eq(commerceCheckoutPrepare.state, "active")),
    )
    .for("update");
  if (activePrepares.length === 0) return;

  const preparedIds = activePrepares.map((row) => row.id);
  await transaction
    .update(commerceCheckoutPrepare)
    .set({ state: "superseded", updatedAt: now })
    .where(inArray(commerceCheckoutPrepare.id, preparedIds));

  await transaction
    .update(commerceInventoryReservation)
    .set({ state: "released", releasedAt: now })
    .where(
      and(
        inArray(commerceInventoryReservation.checkoutPrepareId, preparedIds),
        eq(commerceInventoryReservation.state, "held"),
      ),
    );
}

async function assertOrganizationActive(
  transaction: DatabaseTransaction,
  organizationId: string,
): Promise<boolean> {
  const [organizationRow] = await transaction
    .select({ tradeState: commerceOrganization.tradeState })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, organizationId))
    .limit(1);
  return organizationRow !== undefined && organizationRow.tradeState === "active";
}

function stockStateFromPricedLine(pricedLine: PricedProductLine): StoreStockState {
  if (pricedLine.isMadeToOrder) return "made_to_order";
  if (pricedLine.availableQuantity <= 0) return "unavailable";
  if (pricedLine.availableQuantity <= 5) return "low_stock";
  return "in_stock";
}

/**
 * Server-priced cart projection. A line that has gone stale (delisted, below the current
 * MOQ, out of stock) is never dropped and never fails the whole read — it is returned with
 * `pricingError` set and no price fields, so the buyer sees exactly what needs attention
 * before checkout.
 */
export async function getCart(
  actor: CommerceCartActorContext,
): Promise<Result<CommerceCartProjection, CommerceCartError>> {
  const cart = await getOrCreateCart(actor.organizationId);

  const lines = await db
    .select()
    .from(commerceCartProductLine)
    .where(eq(commerceCartProductLine.cartId, cart.id))
    .orderBy(asc(commerceCartProductLine.createdAt), asc(commerceCartProductLine.id));

  if (lines.length === 0) {
    return {
      success: true,
      value: {
        id: cart.id,
        buyerOrganizationId: cart.buyerOrganizationId,
        items: [],
        currencyTotals: [],
        updatedAt: cart.updatedAt,
      },
    };
  }

  const productIds = lines.map((line) => line.productId);
  const basicsRows = await db
    .select({ id: product.id, title: product.title, currency: product.currency })
    .from(product)
    .where(inArray(product.id, productIds));
  const basicsByProductId = new Map(basicsRows.map((row) => [row.id, row]));

  const now = new Date();
  const heldQuantityByProductId = await loadHeldQuantitiesByProduct(db, productIds, now);

  const items: CommerceCartItemProjection[] = [];
  const subtotalByCurrency = new Map<string, number>();

  for (const line of lines) {
    const priced = await loadPurchasableProductForCheckout(
      db,
      line.productId,
      line.quantity,
      heldQuantityByProductId.get(line.productId) ?? 0,
    );

    if (!priced.success) {
      const basics = basicsByProductId.get(line.productId);
      items.push({
        productId: line.productId,
        quantity: line.quantity,
        title: basics?.title ?? "Unknown product",
        currency: basics?.currency ?? null,
        unitPriceInCents: null,
        lineTotalInCents: null,
        isMadeToOrder: null,
        minimumOrderQuantity: null,
        pricingError: priced.error,
      });
      continue;
    }

    items.push({
      productId: line.productId,
      quantity: line.quantity,
      title: priced.value.title,
      currency: priced.value.currency,
      unitPriceInCents: priced.value.unitPriceInCents,
      lineTotalInCents: priced.value.lineTotalInCents,
      isMadeToOrder: priced.value.isMadeToOrder,
      minimumOrderQuantity: priced.value.minimumOrderQuantity,
      stockState: stockStateFromPricedLine(priced.value),
    });

    subtotalByCurrency.set(
      priced.value.currency,
      (subtotalByCurrency.get(priced.value.currency) ?? 0) + priced.value.lineTotalInCents,
    );
  }

  const currencyTotals: CommerceCartCurrencyTotalProjection[] = [...subtotalByCurrency.entries()]
    .toSorted(([leftCurrency], [rightCurrency]) =>
      leftCurrency < rightCurrency ? -1 : leftCurrency > rightCurrency ? 1 : 0,
    )
    .map(([currency, subtotalInCents]) => ({
      currency,
      subtotalInCents,
      totalInCents: subtotalInCents,
    }));

  return {
    success: true,
    value: {
      id: cart.id,
      buyerOrganizationId: cart.buyerOrganizationId,
      items,
      currencyTotals,
      updatedAt: cart.updatedAt,
    },
  };
}

/**
 * Upserts one desired quantity. Carts store desired quantity only — no authoritative price
 * or stock check runs here; that is `commerce-checkout.service.ts`'s job at prepare time. Any
 * active checkout preparation for this cart is superseded in the same transaction, because a
 * changed cart can no longer be confirmed against a stale snapshot.
 */
export async function setCartItem(
  actor: CommerceCartActorContext,
  productId: string,
  quantity: number,
): Promise<Result<CommerceCartProjection, CommerceCartError>> {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAXIMUM_CART_LINE_QUANTITY) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: `quantity must be an integer between 1 and ${String(MAXIMUM_CART_LINE_QUANTITY)}.`,
      },
    };
  }

  const outcome = await db.transaction(async (transaction) => {
    const organizationIsActive = await assertOrganizationActive(transaction, actor.organizationId);
    if (!organizationIsActive) return { status: "org_inactive" as const };

    const [productRow] = await transaction
      .select({ id: product.id })
      .from(product)
      .where(eq(product.id, productId))
      .limit(1);
    if (!productRow) return { status: "not_found" as const };

    const cart = await getOrCreateCartForUpdate(transaction, actor.organizationId);
    const now = new Date();

    await transaction
      .insert(commerceCartProductLine)
      .values({ cartId: cart.id, productId, quantity })
      .onConflictDoUpdate({
        target: [commerceCartProductLine.cartId, commerceCartProductLine.productId],
        set: { quantity, updatedAt: now },
      });

    await supersedeActiveCheckoutPrepares(transaction, cart.id, now);

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "cart_line_updated",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_cart_product_line",
      targetEntityId: productId,
      payload: { cartId: cart.id, productId, quantity: String(quantity) },
      occurredAt: now,
    });

    return { status: "updated" as const };
  });

  switch (outcome.status) {
    case "org_inactive":
      return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "updated":
      return getCart(actor);
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled setCartItem outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Removes one line. Also supersedes any active checkout preparation for this cart. */
export async function removeCartItem(
  actor: CommerceCartActorContext,
  productId: string,
): Promise<Result<CommerceCartProjection, CommerceCartError>> {
  const outcome = await db.transaction(async (transaction) => {
    const organizationIsActive = await assertOrganizationActive(transaction, actor.organizationId);
    if (!organizationIsActive) return { status: "org_inactive" as const };

    const [cart] = await transaction
      .select()
      .from(commerceCart)
      .where(eq(commerceCart.buyerOrganizationId, actor.organizationId))
      .for("update");
    if (!cart) return { status: "not_found" as const };

    const now = new Date();
    const deletedLines = await transaction
      .delete(commerceCartProductLine)
      .where(
        and(
          eq(commerceCartProductLine.cartId, cart.id),
          eq(commerceCartProductLine.productId, productId),
        ),
      )
      .returning({ id: commerceCartProductLine.id });
    if (deletedLines.length === 0) return { status: "not_found" as const };

    await supersedeActiveCheckoutPrepares(transaction, cart.id, now);

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "cart_line_removed",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_cart_product_line",
      targetEntityId: productId,
      payload: { cartId: cart.id, productId },
      occurredAt: now,
    });

    return { status: "removed" as const };
  });

  switch (outcome.status) {
    case "org_inactive":
      return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "removed":
      return getCart(actor);
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled removeCartItem outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
