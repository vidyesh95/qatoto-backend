import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCart,
  commerceCartLineCustomization,
  commerceCartProductLine,
  commerceCheckoutPrepare,
  commerceInventoryReservation,
  commerceOrganization,
  commerceProductVariant,
  product,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import type { StoreStockState } from "#src/modules/store/catalog/store-catalog.service.js";
import {
  inventoryScopeKey,
  loadHeldQuantitiesByProduct,
  loadPurchasableProductForCheckout,
  type CommercePricingError,
  type PricedProductLine,
} from "#src/modules/store/commerce-pricing.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import {
  resolveCustomizationSelections,
  type CommerceCustomizationError,
  type CustomizationSelectionInput,
  type ResolvedCustomizationSelection,
} from "#src/modules/store/storefront/commerce-customization.service.js";
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
  /**
   * A1. Unlike the three tags above, these ARE top-level results: a line that does
   * not name a required variant is not a stale line, it is an unbuyable request, and
   * accepting it would put an unshippable row in the cart.
   */
  | { type: "VARIANT_REQUIRED" }
  | { type: "VARIANT_NOT_APPLICABLE" }
  | { type: "VARIANT_NOT_FOUND" }
  | { type: "VARIANT_NOT_PURCHASABLE" }
  | { type: "VALIDATION_FAILED"; message: string }
  /** A18. Passed through from the customization resolver so the client can act on it. */
  | { type: "CUSTOMIZATION_REJECTED"; customizationError: CommerceCustomizationError }
  /** A17. The listing does not sell a sample, so a sample line can never be bought. */
  | { type: "SAMPLE_NOT_AVAILABLE" }
  | { type: "ORGANIZATION_NOT_ACTIVE" };

export interface CommerceCartActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface CommerceCartItemProjection {
  readonly productId: string;
  /** Null only for products with no active variants (Appendix A1). */
  readonly variantId: string | null;
  readonly variantName: string | null;
  readonly quantity: number;
  /** A17. A sample line and a bulk line of one product are two entries here. */
  readonly isSample: boolean;
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

/**
 * Whether this organization may hold a cart.
 *
 * WIDENED IN PHASE 21 TO ADMIT `pending`, and the narrowing was the bug §14 named: a cart is
 * a draft, and putting a buyer's first tap behind human verification is what made the
 * signed-in buyer surface unreachable. `suspended` and `closed` are still refused, because
 * those are a withdrawal of trust rather than an absence of it.
 *
 * THE CHECKOUT-SIDE TWIN IS DELIBERATELY NOT WIDENED. `commerce-checkout.service.ts` keeps
 * requiring `active`, and that is what actually enforces §14's `checkout/confirm` gate
 * inside the transaction that creates orders — not merely at the router door (§0).
 */
async function assertOrganizationCanHoldCart(
  transaction: DatabaseTransaction,
  organizationId: string,
): Promise<boolean> {
  const [organizationRow] = await transaction
    .select({ tradeState: commerceOrganization.tradeState })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, organizationId))
    .limit(1);
  return (
    organizationRow !== undefined &&
    (organizationRow.tradeState === "active" || organizationRow.tradeState === "pending")
  );
}

/**
 * What one line write can conclude. `upserted` is the only success; the rest are the
 * A1 variant gate, which decides WHICH variant is being bought here rather than at
 * prepare time — a line naming no variant for a product that has them cannot be
 * priced, reserved or shipped, so it must never become a row.
 */
export type CartProductLineUpsertOutcome =
  | { readonly status: "upserted"; readonly cartProductLineId: string }
  | { readonly status: "not_found" }
  | { readonly status: "variant_required" }
  | { readonly status: "variant_not_applicable" }
  | { readonly status: "variant_not_found" }
  | { readonly status: "variant_not_purchasable" };

/**
 * Writes one cart line inside a caller's transaction.
 *
 * Extracted from `setCartItem` so seeding a cart from a guided pathway (§15.4) can add
 * every slot's line under ONE cart row lock, in one transaction. Calling `setCartItem`
 * N times would supersede the buyer's checkout preparation N times, append N audit
 * rows for what is one action, and leave a half-seeded cart if line 4 of 6 failed.
 *
 * The caller is responsible for the cart lock (`getOrCreateCartForUpdate`), for
 * superseding prepares, and for the audit entry — all three are per-action, not
 * per-line.
 */
export async function upsertCartProductLine(
  transaction: DatabaseTransaction,
  input: {
    readonly cartId: string;
    readonly productId: string;
    readonly variantId: string | null;
    readonly quantity: number;
    readonly now: Date;
    /** A17. A sample is its own line, never a quantity update on the bulk line. */
    readonly isSample?: boolean;
  },
): Promise<CartProductLineUpsertOutcome> {
  const isSample = input.isSample ?? false;
  const [productRow] = await transaction
    .select({ id: product.id })
    .from(product)
    .where(eq(product.id, input.productId))
    .limit(1);
  if (!productRow) return { status: "not_found" };

  const activeVariants = await transaction
    .select({ id: commerceProductVariant.id })
    .from(commerceProductVariant)
    .where(
      and(
        eq(commerceProductVariant.productId, input.productId),
        eq(commerceProductVariant.state, "active"),
      ),
    );

  if (input.variantId === null && activeVariants.length > 0) {
    return { status: "variant_required" };
  }
  if (input.variantId !== null && activeVariants.length === 0) {
    return { status: "variant_not_applicable" };
  }
  if (
    input.variantId !== null &&
    !activeVariants.some((variant) => variant.id === input.variantId)
  ) {
    // Retired-but-owned and belongs-to-another-product are both "not buyable";
    // separating them would let a buyer probe another seller's variant ids.
    const [existingVariant] = await transaction
      .select({ productId: commerceProductVariant.productId })
      .from(commerceProductVariant)
      .where(eq(commerceProductVariant.id, input.variantId))
      .limit(1);
    return existingVariant && existingVariant.productId === input.productId
      ? { status: "variant_not_purchasable" }
      : { status: "variant_not_found" };
  }

  /**
   * Select-then-write rather than ON CONFLICT: uniqueness is the expression index
   * `(cart_id, product_id, coalesce(variant_id, ''))`, which drizzle cannot name as a
   * conflict target. The caller's cart row lock serializes concurrent writers.
   */
  const [existingLine] = await transaction
    .select({ id: commerceCartProductLine.id })
    .from(commerceCartProductLine)
    .where(
      and(
        eq(commerceCartProductLine.cartId, input.cartId),
        eq(commerceCartProductLine.productId, input.productId),
        input.variantId === null
          ? isNull(commerceCartProductLine.variantId)
          : eq(commerceCartProductLine.variantId, input.variantId),
        eq(commerceCartProductLine.isSample, isSample),
      ),
    )
    .limit(1);

  if (existingLine) {
    await transaction
      .update(commerceCartProductLine)
      .set({ quantity: input.quantity, updatedAt: input.now })
      .where(eq(commerceCartProductLine.id, existingLine.id));
    return { status: "upserted", cartProductLineId: existingLine.id };
  }

  const [insertedLine] = await transaction
    .insert(commerceCartProductLine)
    .values({
      cartId: input.cartId,
      productId: input.productId,
      variantId: input.variantId,
      quantity: input.quantity,
      isSample,
    })
    .returning({ id: commerceCartProductLine.id });
  if (!insertedLine) throw new Error("Cart product line insert returned no row.");

  return { status: "upserted", cartProductLineId: insertedLine.id };
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
  const heldQuantityByScope = await loadHeldQuantitiesByProduct(db, productIds, now);

  const items: CommerceCartItemProjection[] = [];
  const subtotalByCurrency = new Map<string, number>();

  for (const line of lines) {
    const priced = await loadPurchasableProductForCheckout(
      db,
      line.productId,
      line.quantity,
      heldQuantityByScope.get(inventoryScopeKey(line.productId, line.variantId)) ?? 0,
      line.variantId,
      line.isSample,
    );

    if (!priced.success) {
      const basics = basicsByProductId.get(line.productId);
      items.push({
        productId: line.productId,
        variantId: line.variantId,
        // The variant may itself be what went stale, so the stored id is reported
        // without pretending we could still resolve its name.
        variantName: null,
        quantity: line.quantity,
        isSample: line.isSample,
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
      variantId: priced.value.variantId,
      variantName: priced.value.variantName,
      quantity: line.quantity,
      isSample: line.isSample,
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
  requestedVariantId: string | null = null,
  isSample = false,
  customizationSelections: readonly CustomizationSelectionInput[] = [],
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
    const organizationCanHoldCart = await assertOrganizationCanHoldCart(
      transaction,
      actor.organizationId,
    );
    if (!organizationCanHoldCart) return { status: "org_inactive" as const };

    /**
     * EVERY REJECTION HAPPENS BEFORE THE FIRST WRITE, and that ordering is the point.
     *
     * Returning a failure status from inside `db.transaction` COMMITS whatever ran before
     * it — only a throw rolls back. So a validation placed after the line write turned a
     * refused request into a partially applied one: the smoke run caught a cart line
     * whose quantity had changed to 20 on a request that answered 422.
     */
    if (isSample) {
      const [sampleRow] = await transaction
        .select({
          samplePolicy: product.samplePolicy,
          samplePriceInCents: product.samplePriceInCents,
        })
        .from(product)
        .where(eq(product.id, productId))
        .limit(1);
      if (
        sampleRow &&
        (sampleRow.samplePolicy === "unavailable" ||
          sampleRow.samplePriceInCents === null ||
          sampleRow.samplePriceInCents <= 0)
      ) {
        /**
         * A17. Refused here rather than left to price later, for the reason A1 gives for
         * VARIANT_REQUIRED: a sample of a listing that sells no sample is not a stale
         * line, it is an unbuyable request, and it can never become buyable.
         */
        return { status: "sample_not_available" as const };
      }
    }

    /**
     * A18. `requireRequiredOptions` is FALSE here: a buyer should be able to build a cart
     * before uploading artwork. Checkout preparation is where a missing required slot
     * stops the order.
     */
    let resolvedSelections: readonly ResolvedCustomizationSelection[] = [];
    if (customizationSelections.length > 0) {
      const resolved = await resolveCustomizationSelections(transaction, {
        productId,
        buyerOrganizationId: actor.organizationId,
        quantity,
        selections: customizationSelections,
        requireRequiredOptions: false,
      });
      if (!resolved.success) {
        return {
          status: "customization_rejected" as const,
          customizationError: resolved.error,
        };
      }
      resolvedSelections = resolved.value;
    }

    const cart = await getOrCreateCartForUpdate(transaction, actor.organizationId);
    const now = new Date();

    const upsertOutcome = await upsertCartProductLine(transaction, {
      cartId: cart.id,
      productId,
      variantId: requestedVariantId,
      quantity,
      now,
      isSample,
    });
    if (upsertOutcome.status !== "upserted") return upsertOutcome;

    // Replaced wholesale with the line, so changing artwork does not leave the previous
    // selection attached.
    await transaction
      .delete(commerceCartLineCustomization)
      .where(eq(commerceCartLineCustomization.cartProductLineId, upsertOutcome.cartProductLineId));

    if (resolvedSelections.length > 0) {
      await transaction.insert(commerceCartLineCustomization).values(
        resolvedSelections.map((selection) => ({
          cartProductLineId: upsertOutcome.cartProductLineId,
          customizationOptionId: selection.customizationOptionId,
          encryptedDocumentId: selection.encryptedDocumentId,
          choiceValue: selection.choiceValue,
          slotKeySnapshot: selection.slotKeySnapshot,
          labelSnapshot: selection.labelSnapshot,
        })),
      );
    }

    await supersedeActiveCheckoutPrepares(transaction, cart.id, now);

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "cart_line_updated",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_cart_product_line",
      targetEntityId: productId,
      payload: {
        cartId: cart.id,
        productId,
        variantId: requestedVariantId ?? "",
        quantity: String(quantity),
        isSample,
      },
      occurredAt: now,
    });

    return { status: "updated" as const };
  });

  switch (outcome.status) {
    case "org_inactive":
      return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "variant_required":
      return { success: false, error: { type: "VARIANT_REQUIRED" } };
    case "variant_not_applicable":
      return { success: false, error: { type: "VARIANT_NOT_APPLICABLE" } };
    case "variant_not_found":
      return { success: false, error: { type: "VARIANT_NOT_FOUND" } };
    case "variant_not_purchasable":
      return { success: false, error: { type: "VARIANT_NOT_PURCHASABLE" } };
    case "sample_not_available":
      return { success: false, error: { type: "SAMPLE_NOT_AVAILABLE" } };
    case "customization_rejected":
      return {
        success: false,
        error: {
          type: "CUSTOMIZATION_REJECTED",
          customizationError: outcome.customizationError,
        },
      };
    case "updated":
      return getCart(actor);
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled setCartItem outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Removes one line. Also supersedes any active checkout preparation for this cart.
 *
 * A1: with variants, one product can occupy several lines. Naming a variant removes
 * that line; omitting one removes every line for the product, which is what
 * "remove this product from my cart" means.
 */
export async function removeCartItem(
  actor: CommerceCartActorContext,
  productId: string,
  requestedVariantId: string | null = null,
): Promise<Result<CommerceCartProjection, CommerceCartError>> {
  const outcome = await db.transaction(async (transaction) => {
    const organizationCanHoldCart = await assertOrganizationCanHoldCart(
      transaction,
      actor.organizationId,
    );
    if (!organizationCanHoldCart) return { status: "org_inactive" as const };

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
          requestedVariantId === null
            ? undefined
            : eq(commerceCartProductLine.variantId, requestedVariantId),
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
      payload: { cartId: cart.id, productId, variantId: requestedVariantId ?? "" },
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
