import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  commerceCartLineCustomization,
  commerceCartProductLine,
  commerceCheckoutGroup,
  commerceCheckoutGroupCurrencyTotal,
  commerceCheckoutPrepare,
  commerceCheckoutPrepareCurrencyTotal,
  commerceCheckoutPrepareLineCustomization,
  commerceCheckoutPrepareProductLine,
  commerceInventoryReservation,
  commerceOrder,
  commerceOrderLineCustomization,
  commerceOrderProductLine,
  commerceOrganization,
  commerceOrganizationAddress,
  commerceProductVariant,
  product,
} from "#src/db/schema.js";
import {
  buildSpecificationSnapshot,
  inventoryScopeKey,
  loadHeldQuantitiesByProduct,
  loadPurchasableProductForCheckout,
  type CommercePricingError,
  type PricedProductLine,
} from "#src/lib/commerce-pricing.js";
import {
  derivePromisedDeliveryAt,
  latestPromisedDeliveryAt,
} from "#src/lib/commerce-promised-delivery.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import {
  getOrCreateCartForUpdate,
  supersedeActiveCheckoutPrepares,
  type CommerceCartActorContext,
  type DatabaseTransaction,
} from "#src/modules/store/orders/commerce-cart.service.js";
import {
  createEscrowSessionForOrder,
  scheduleEscrowCommands,
} from "#src/modules/store/orders/commerce-escrow.service.js";
import {
  consumeSampleCredits,
  listSpendableSampleCredits,
  selectConsumableCredits,
} from "#src/modules/store/orders/commerce-sample-credit.service.js";
import {
  consumeSettlementAgreement,
  resolveSettlementRail,
} from "#src/modules/store/orders/commerce-settlement.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { projectPrepareArrivalWindow } from "#src/services/commerce-arrival-window.service.js";
import {
  resolveCustomizationSelections,
  type CommerceCustomizationError,
  type ResolvedCustomizationSelection,
} from "#src/services/commerce-customization.service.js";
import {
  estimateDeliveryForLines,
  type DeliveryEstimateProjection,
} from "#src/services/commerce-delivery-estimate.service.js";
import type { Result } from "#src/types/index.js";

type PrepareRow = typeof commerceCheckoutPrepare.$inferSelect;
type PrepareProductLineRow = typeof commerceCheckoutPrepareProductLine.$inferSelect;
type PrepareCurrencyTotalRow = typeof commerceCheckoutPrepareCurrencyTotal.$inferSelect;
type OrderRow = typeof commerceOrder.$inferSelect;

export type CommerceCheckoutError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "ORGANIZATION_NOT_ACTIVE" }
  | { type: "EMPTY_CART" }
  | { type: "ADDRESS_NOT_OWNED" }
  /**
   * A15. The address is the buyer's own, but it is not for receiving goods. Distinct
   * from ADDRESS_NOT_OWNED because telling a buyer they do not own their own billing
   * address answers a question nobody asked.
   */
  | { type: "ADDRESS_KIND_INVALID"; addressKind: string }
  /** A17. The listing does not sell a sample, though it sells the product in bulk. */
  | { type: "SAMPLE_NOT_AVAILABLE"; productId: string }
  /** A18. A required slot is unsupplied, or a selection no longer validates. */
  | {
      type: "CUSTOMIZATION_REJECTED";
      productId: string;
      customizationError: CommerceCustomizationError;
    }
  /**
   * STORE Phase 14. A settlement agreement the buyer named cannot be used — expired, its
   * provider suspended, or the order total no longer matches what the parties agreed.
   *
   * A REFUSAL, NEVER A SILENT DOWNGRADE. Settling this order without escrow would leave the
   * buyer believing a licensed third party holds their money when nobody does, which is
   * strictly worse than telling them the terms lapsed.
   */
  | { type: "SETTLEMENT_UNAVAILABLE"; sellerOrganizationId: string; reason: string }
  /** The agreement was usable but the escrow session could not be opened locally. */
  | { type: "ESCROW_SESSION_FAILED"; sellerOrganizationId: string; reason: string }
  | { type: "PRODUCT_NOT_PURCHASABLE"; productId: string }
  | { type: "BELOW_MINIMUM_ORDER_QUANTITY"; productId: string; minimumOrderQuantity: number }
  | { type: "INSUFFICIENT_STOCK"; productId: string; availableQuantity: number }
  /**
   * A1. Distinct from `PRODUCT_NOT_PURCHASABLE` because the product IS purchasable —
   * the line just does not say which variant, and flattening the two would tell a
   * buyer to give up on a listing they can still buy.
   */
  | { type: "VARIANT_REQUIRED"; productId: string }
  | { type: "VARIANT_NOT_PURCHASABLE"; productId: string }
  | {
      type: "PRICE_CHANGED";
      productId: string;
      previousUnitPriceInCents: number;
      currentUnitPriceInCents: number;
    }
  | { type: "PREPARE_EXPIRED" }
  | { type: "PREPARE_NOT_ACTIVE" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "CONFLICT"; message: string };

export interface PrepareCheckoutInput {
  readonly deliveryAddressId?: string;
}

export interface ConfirmCheckoutInput {
  readonly prepareId: string;
  readonly deliveryAddressId?: string;
  /**
   * STORE Phase 14. Which accepted settlement agreement applies to which seller.
   *
   * PER SELLER, not per checkout, because §2.3 already produces one order per counterparty
   * and escrow is negotiated with one counterparty at a time. A cart spanning three sellers
   * may legitimately be escrowed with one of them and settled directly with the other two.
   *
   * Absent, or absent for a given seller, means that seller's order settles WITHOUT escrow.
   * That is the default and it is not an error. What is an error is naming an agreement that
   * has become unusable — see `resolveSettlementRail`, which refuses rather than downgrades.
   */
  readonly settlementAgreements?: readonly {
    readonly sellerOrganizationId: string;
    readonly agreementId: string;
  }[];
}

export interface CheckoutPrepareLineProjection {
  readonly productId: string;
  readonly sellerOrganizationId: string;
  readonly title: string;
  readonly quantity: number;
  readonly unitPriceInCents: number;
  readonly lineTotalInCents: number;
  readonly currency: string;
  readonly isMadeToOrder: boolean;
}

export interface CheckoutCurrencyTotalProjection {
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly totalInCents: number;
}

export interface CheckoutPrepareProjection {
  readonly prepareId: string;
  readonly expiresAt: Date;
  readonly items: readonly CheckoutPrepareLineProjection[];
  readonly currencyTotals: readonly CheckoutCurrencyTotalProjection[];
  readonly deliveryAddressSnapshot: string | null;
  /**
   * A16. Indicative and per seller, because each seller organization becomes its own
   * order and ships separately. EMPTY IS A REAL ANSWER — no covering provider means
   * "we do not know", which is not the same as "free", and the mock this replaces
   * rendered the second one.
   *
   * None of this reaches `shippingInCents`. Nothing is being charged for freight.
   */
  readonly deliveryEstimates: readonly SellerDeliveryEstimateProjection[];
  /**
   * Phase 20, §19.5. Grouped per seller exactly like `deliveryEstimates`, because §2.3 makes
   * each seller its own order and each order its own journey.
   *
   * `arrivalWindow` inside each entry is ALWAYS null here — there is no order yet, so no clock
   * (§19.4). The COMPONENTS are what the sheet renders.
   */
  readonly arrivalWindows: readonly SellerArrivalWindowProjection[];
}

export interface SellerArrivalWindowProjection {
  readonly sellerOrganizationId: string;
  readonly arrivalWindow: Awaited<ReturnType<typeof projectPrepareArrivalWindow>>;
}

export interface SellerDeliveryEstimateProjection {
  readonly sellerOrganizationId: string;
  readonly estimates: readonly DeliveryEstimateProjection[];
}

/**
 * Same fifteen fields `commerce-quotes.service.ts` projects for an accepted-quote order,
 * plus `checkoutGroupId` — the one column that phase introduced without a value to fill.
 * Kept as a local type rather than importing the quotes module's (unexported) projector, so
 * this service does not reach into another bounded context's internals for a shape this
 * phase now also produces independently.
 */
export interface OrderProjection {
  readonly id: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly checkoutGroupId: string | null;
  readonly source: OrderRow["source"];
  readonly state: OrderRow["state"];
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly taxInCents: number;
  readonly serviceFeeInCents: number;
  readonly shippingInCents: number;
  readonly discountInCents: number;
  readonly totalInCents: number;
  readonly paymentTermsSnapshot: string | null;
  readonly incotermSnapshot: string | null;
  readonly buyerLegalNameSnapshot: string;
  readonly counterpartyLegalNameSnapshot: string;
  /**
   * STORE Phase 14. How this order settles, and whether a third party is holding the money.
   *
   * `hasEscrowProtection` is derived from the rail rather than being a second stored fact,
   * and it is on the wire because ABSENCE MUST BE LEGIBLE. A client has to be able to say
   * plainly that nobody is holding the funds; leaving it to be inferred from a rail name is
   * how an interface ends up implying a protection that was never agreed.
   */
  readonly settlementRail: OrderRow["settlementRail"];
  readonly hasEscrowProtection: boolean;
  readonly createdAt: Date;
}

export interface ConfirmCheckoutProjection {
  readonly checkoutGroupId: string;
  readonly orders: readonly OrderProjection[];
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce checkout audit append failed: ${appended.error.type}`);
  }
}

function mapPricingErrorToCheckoutError(
  productId: string,
  error: CommercePricingError,
): CommerceCheckoutError {
  switch (error.type) {
    case "PRODUCT_NOT_FOUND":
    case "SELLER_ORGANIZATION_MISSING":
    case "PRODUCT_NOT_PURCHASABLE":
      return { type: "PRODUCT_NOT_PURCHASABLE", productId };
    case "BELOW_MINIMUM_ORDER_QUANTITY":
      return {
        type: "BELOW_MINIMUM_ORDER_QUANTITY",
        productId,
        minimumOrderQuantity: error.minimumOrderQuantity,
      };
    case "INSUFFICIENT_STOCK":
      return { type: "INSUFFICIENT_STOCK", productId, availableQuantity: error.availableQuantity };
    case "VARIANT_REQUIRED":
      return { type: "VARIANT_REQUIRED", productId };
    case "VARIANT_NOT_APPLICABLE":
    case "VARIANT_NOT_FOUND":
    case "VARIANT_NOT_PURCHASABLE":
      // All three mean "the variant on this line cannot be bought". Splitting them
      // on the wire would let a buyer probe which variant ids exist.
      return { type: "VARIANT_NOT_PURCHASABLE", productId };
    case "SAMPLE_NOT_AVAILABLE":
      return { type: "SAMPLE_NOT_AVAILABLE", productId };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce pricing error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Redacted, audit-safe address text: country, region, and locality only. Recipient name and
 * street lines stay encrypted-at-rest and never enter a snapshot or an audit payload.
 */
function formatDeliveryAddressSnapshot(address: {
  readonly countryCode: string;
  readonly regionCode: string | null;
  readonly locality: string;
  readonly postalCode: string | null;
}): string {
  const namedParts = [address.countryCode, address.regionCode ?? "", address.locality].filter(
    (part) => part !== "",
  );
  const base = namedParts.join(", ");
  return address.postalCode !== null ? `${base} ${address.postalCode}` : base;
}

/**
 * Why the outcome is a union rather than `| null` (A15).
 *
 * "You do not own that address" and "that address is not for receiving goods" are
 * different facts, and collapsing them told a buyer who picked their own billing
 * address that it was not theirs — a wrong answer to the question they asked.
 */
type OwnedDeliveryAddressOutcome =
  | {
      readonly status: "resolved";
      readonly id: string;
      readonly snapshot: string;
      /** A16 needs the destination country; the snapshot is prose, not a field. */
      readonly countryCode: string;
    }
  | { readonly status: "not_owned" }
  | { readonly status: "wrong_kind"; readonly addressKind: string };

/**
 * A15's central fix. Until Phase 11 this filtered on id and organization and **not on
 * `addressKind` at all**, because there was no `delivery` kind to filter on — so a
 * registered office or a return address could silently become a shipping destination.
 */
async function assertOwnedDeliveryAddress(
  transaction: DatabaseTransaction,
  buyerOrganizationId: string,
  deliveryAddressId: string,
): Promise<OwnedDeliveryAddressOutcome> {
  const [address] = await transaction
    .select({
      id: commerceOrganizationAddress.id,
      addressKind: commerceOrganizationAddress.addressKind,
      countryCode: commerceOrganizationAddress.countryCode,
      regionCode: commerceOrganizationAddress.regionCode,
      locality: commerceOrganizationAddress.locality,
      postalCode: commerceOrganizationAddress.postalCode,
    })
    .from(commerceOrganizationAddress)
    .where(
      and(
        eq(commerceOrganizationAddress.id, deliveryAddressId),
        eq(commerceOrganizationAddress.organizationId, buyerOrganizationId),
      ),
    )
    .limit(1);
  if (!address) return { status: "not_owned" };
  if (address.addressKind !== "delivery") {
    return { status: "wrong_kind", addressKind: address.addressKind };
  }
  return {
    status: "resolved",
    id: address.id,
    snapshot: formatDeliveryAddressSnapshot(address),
    countryCode: address.countryCode,
  };
}

/**
 * THE `checkout/confirm` GATE, and the reason it lives here rather than only on the router.
 *
 * §14 named `checkout/confirm` as one of the four places the trust gate still earns
 * something, and §0's rule is that a state transition re-checks its own preconditions inside
 * the transaction that performs it. A router guard can be bypassed by a future route that
 * forgets it; this cannot.
 *
 * PREPARE DOES NOT USE THIS — see `assertOrganizationCanPrepareCheckout` below.
 */
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

/**
 * Whether this organization may PRICE a checkout, which is a different question from whether
 * it may place one.
 *
 * SPLIT FROM `assertOrganizationActive` IN PHASE 21, and the shared helper was the bug: §14
 * put the gate at `confirm`, but both halves called the same strict check, so opening the
 * router on `prepare` still answered 403 from inside the transaction. The smoke script caught
 * it; nothing else would have, because prepare's 403 and confirm's 403 are the same string.
 *
 * A prepare reserves stock and returns authoritative totals. Neither is a promise to anyone
 * outside the platform, and both are superseded by the next cart edit — so a pending
 * workspace may do it, exactly as it may hold the cart the prepare reads.
 */
async function assertOrganizationCanPrepareCheckout(
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
 * One estimate group per seller organization, because each becomes its own order and
 * ships on its own (§2.3).
 *
 * Returns an empty array when there is no delivery address yet — a buyer who has not
 * chosen where the goods go has not asked a question freight can answer.
 */
async function estimatePrepareDelivery(
  items: readonly PrepareProductLineRow[],
  deliveryCountryCode: string | null,
): Promise<readonly SellerDeliveryEstimateProjection[]> {
  if (deliveryCountryCode === null || items.length === 0) return [];

  const linesBySeller = new Map<string, { productId: string; quantity: number }[]>();
  for (const line of items) {
    const sellerLines = linesBySeller.get(line.sellerOrganizationId) ?? [];
    sellerLines.push({ productId: line.productId, quantity: line.quantity });
    linesBySeller.set(line.sellerOrganizationId, sellerLines);
  }

  const estimated = await Promise.all(
    [...linesBySeller.entries()].map(async ([sellerOrganizationId, sellerLines]) => ({
      sellerOrganizationId,
      estimates: await estimateDeliveryForLines({
        sellerOrganizationId,
        destinationCountryCode: deliveryCountryCode,
        lines: sellerLines,
      }),
    })),
  );

  return estimated.toSorted((left, right) =>
    left.sellerOrganizationId.localeCompare(right.sellerOrganizationId),
  );
}

/**
 * Phase 20, §19.5. The §19.4 components, per seller, at prepare time.
 *
 * Grouped exactly like `estimatePrepareDelivery` because each seller becomes its own order,
 * and returning `[]` for an unresolved destination for the same reason: a buyer who has not
 * chosen where the goods go has not asked a question freight can answer.
 */
async function projectPrepareArrivalWindows(
  items: readonly PrepareProductLineRow[],
  deliveryCountryCode: string | null,
): Promise<readonly SellerArrivalWindowProjection[]> {
  if (deliveryCountryCode === null || items.length === 0) return [];

  const linesBySeller = new Map<string, PrepareProductLineRow[]>();
  for (const line of items) {
    const sellerLines = linesBySeller.get(line.sellerOrganizationId) ?? [];
    sellerLines.push(line);
    linesBySeller.set(line.sellerOrganizationId, sellerLines);
  }

  const projected = await Promise.all(
    [...linesBySeller.entries()].map(async ([sellerOrganizationId, sellerLines]) => ({
      sellerOrganizationId,
      arrivalWindow: await projectPrepareArrivalWindow({
        sellerOrganizationId,
        destinationCountryCode: deliveryCountryCode,
        lines: sellerLines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          leadTimeMinDaysSnapshot: line.leadTimeMinDaysSnapshot,
          leadTimeMaxDaysSnapshot: line.leadTimeMaxDaysSnapshot,
        })),
        asOf: new Date(),
      }),
    })),
  );

  return projected.toSorted((left, right) =>
    left.sellerOrganizationId.localeCompare(right.sellerOrganizationId),
  );
}

function projectPrepare(
  prepare: PrepareRow,
  items: readonly PrepareProductLineRow[],
  currencyTotals: readonly PrepareCurrencyTotalRow[],
  deliveryEstimates: readonly SellerDeliveryEstimateProjection[] = [],
  arrivalWindows: readonly SellerArrivalWindowProjection[] = [],
): CheckoutPrepareProjection {
  return {
    prepareId: prepare.id,
    expiresAt: prepare.expiresAt,
    items: [...items]
      .toSorted((left, right) => left.siblingOrder - right.siblingOrder)
      .map((line) => ({
        productId: line.productId,
        sellerOrganizationId: line.sellerOrganizationId,
        title: line.titleSnapshot,
        quantity: line.quantity,
        unitPriceInCents: line.unitPriceInCents,
        lineTotalInCents: line.lineTotalInCents,
        currency: line.currency,
        isMadeToOrder: line.isMadeToOrder,
      })),
    deliveryEstimates,
    arrivalWindows,
    currencyTotals: currencyTotals.map((total) => ({
      currency: total.currency,
      subtotalInCents: total.subtotalInCents,
      taxInCents: total.taxInCents,
      serviceFeeInCents: total.serviceFeeInCents,
      shippingInCents: total.shippingInCents,
      discountInCents: total.discountInCents,
      totalInCents: total.totalInCents,
    })),
    deliveryAddressSnapshot: prepare.deliveryAddressSnapshot,
  };
}

async function loadPrepareProjection(prepareId: string): Promise<CheckoutPrepareProjection | null> {
  const [prepare] = await db
    .select()
    .from(commerceCheckoutPrepare)
    .where(eq(commerceCheckoutPrepare.id, prepareId))
    .limit(1);
  if (!prepare) return null;

  const items = await db
    .select()
    .from(commerceCheckoutPrepareProductLine)
    .where(eq(commerceCheckoutPrepareProductLine.prepareId, prepare.id));
  const currencyTotals = await db
    .select()
    .from(commerceCheckoutPrepareCurrencyTotal)
    .where(eq(commerceCheckoutPrepareCurrencyTotal.prepareId, prepare.id));

  return projectPrepare(prepare, items, currencyTotals);
}

async function loadPrepareProjectionByIdempotencyKey(
  buyerOrganizationId: string,
  prepareIdempotencyKey: string,
): Promise<CheckoutPrepareProjection | null> {
  const [prepare] = await db
    .select({ id: commerceCheckoutPrepare.id })
    .from(commerceCheckoutPrepare)
    .where(
      and(
        eq(commerceCheckoutPrepare.buyerOrganizationId, buyerOrganizationId),
        eq(commerceCheckoutPrepare.prepareIdempotencyKey, prepareIdempotencyKey),
      ),
    )
    .limit(1);
  if (!prepare) return null;
  return loadPrepareProjection(prepare.id);
}

function projectOrder(order: OrderRow): OrderProjection {
  return {
    id: order.id,
    buyerOrganizationId: order.buyerOrganizationId,
    counterpartyOrganizationId: order.counterpartyOrganizationId,
    checkoutGroupId: order.checkoutGroupId,
    source: order.source,
    state: order.state,
    currency: order.currency,
    subtotalInCents: order.subtotalInCents,
    taxInCents: order.taxInCents,
    serviceFeeInCents: order.serviceFeeInCents,
    shippingInCents: order.shippingInCents,
    discountInCents: order.discountInCents,
    totalInCents: order.totalInCents,
    paymentTermsSnapshot: order.paymentTermsSnapshot,
    incotermSnapshot: order.incotermSnapshot,
    buyerLegalNameSnapshot: order.buyerLegalNameSnapshot,
    counterpartyLegalNameSnapshot: order.counterpartyLegalNameSnapshot,
    settlementRail: order.settlementRail,
    // Derived, never stored twice: one fact cannot then disagree with itself.
    hasEscrowProtection: order.settlementRail === "external_escrow",
    createdAt: order.createdAt,
  };
}

async function loadConfirmProjectionByGroupId(
  checkoutGroupId: string,
): Promise<ConfirmCheckoutProjection> {
  const orders = await db
    .select()
    .from(commerceOrder)
    .where(eq(commerceOrder.checkoutGroupId, checkoutGroupId))
    .orderBy(asc(commerceOrder.createdAt), asc(commerceOrder.id));
  return { checkoutGroupId, orders: orders.map(projectOrder) };
}

async function loadConfirmProjectionByPrepareId(
  prepareId: string,
): Promise<ConfirmCheckoutProjection | null> {
  const [group] = await db
    .select({ id: commerceCheckoutGroup.id })
    .from(commerceCheckoutGroup)
    .where(eq(commerceCheckoutGroup.checkoutPrepareId, prepareId))
    .limit(1);
  if (!group) return null;
  return loadConfirmProjectionByGroupId(group.id);
}

async function loadConfirmProjectionByIdempotencyKey(
  buyerOrganizationId: string,
  confirmIdempotencyKey: string,
): Promise<ConfirmCheckoutProjection | null> {
  const [group] = await db
    .select({ id: commerceCheckoutGroup.id })
    .from(commerceCheckoutGroup)
    .where(
      and(
        eq(commerceCheckoutGroup.buyerOrganizationId, buyerOrganizationId),
        eq(commerceCheckoutGroup.confirmIdempotencyKey, confirmIdempotencyKey),
      ),
    )
    .limit(1);
  if (!group) return null;
  return loadConfirmProjectionByGroupId(group.id);
}

/**
 * Validates the cart, prices every line, holds inventory, and persists an immutable
 * preparation snapshot. Never creates an order — that is `confirmCheckout`'s job, and only
 * after re-validating this snapshot has not gone stale.
 */
export async function prepareCheckout(
  actor: CommerceCartActorContext,
  input: PrepareCheckoutInput,
  prepareIdempotencyKey?: string,
): Promise<Result<CheckoutPrepareProjection, CommerceCheckoutError>> {
  if (prepareIdempotencyKey !== undefined) {
    const replayed = await loadPrepareProjectionByIdempotencyKey(
      actor.organizationId,
      prepareIdempotencyKey,
    );
    if (replayed) return { success: true, value: replayed };
  }

  try {
    const outcome = await db.transaction(async (transaction) => {
      const organizationCanPrepare = await assertOrganizationCanPrepareCheckout(
        transaction,
        actor.organizationId,
      );
      if (!organizationCanPrepare) return { status: "org_inactive" as const };

      const cart = await getOrCreateCartForUpdate(transaction, actor.organizationId);
      const lines = await transaction
        .select()
        .from(commerceCartProductLine)
        .where(eq(commerceCartProductLine.cartId, cart.id))
        .orderBy(asc(commerceCartProductLine.createdAt), asc(commerceCartProductLine.id))
        .for("update");
      if (lines.length === 0) return { status: "empty_cart" as const };

      let deliveryAddressId: string | null = null;
      let deliveryAddressSnapshot: string | null = null;
      let deliveryCountryCode: string | null = null;
      if (input.deliveryAddressId !== undefined) {
        const owned = await assertOwnedDeliveryAddress(
          transaction,
          actor.organizationId,
          input.deliveryAddressId,
        );
        if (owned.status === "not_owned") return { status: "address_not_owned" as const };
        if (owned.status === "wrong_kind") {
          return { status: "address_wrong_kind" as const, addressKind: owned.addressKind };
        }
        deliveryAddressId = owned.id;
        deliveryAddressSnapshot = owned.snapshot;
        deliveryCountryCode = owned.countryCode;
      }

      const now = new Date();
      await supersedeActiveCheckoutPrepares(transaction, cart.id, now);

      const productIds = lines.map((line) => line.productId);
      const heldQuantityByScope = await loadHeldQuantitiesByProduct(transaction, productIds, now);

      const pricedLines: (PricedProductLine & { readonly siblingOrder: number })[] = [];
      const selectionsBySiblingOrder = new Map<number, readonly ResolvedCustomizationSelection[]>();
      for (const line of lines) {
        const priced = await loadPurchasableProductForCheckout(
          transaction,
          line.productId,
          line.quantity,
          heldQuantityByScope.get(inventoryScopeKey(line.productId, line.variantId)) ?? 0,
          line.variantId,
          line.isSample,
        );
        if (!priced.success) {
          return {
            status: "pricing_failed" as const,
            productId: line.productId,
            error: priced.error,
          };
        }
        /**
         * A18. VALIDATED HERE, BEFORE THE FIRST INSERT, for the same reason the cart path
         * validates before its write: returning a failure status from inside
         * `db.transaction` commits everything that ran before it — only a throw rolls
         * back. Checked after the prepare row existed, a refused checkout left behind an
         * active prepare holding inventory reservations.
         *
         * `requireRequiredOptions` is TRUE here and false in the cart: a buyer may build a
         * cart before uploading artwork, but must not confirm an order missing a slot the
         * seller declared required.
         */
        const storedSelections = await transaction
          .select()
          .from(commerceCartLineCustomization)
          .where(eq(commerceCartLineCustomization.cartProductLineId, line.id));

        const revalidated = await resolveCustomizationSelections(transaction, {
          productId: line.productId,
          buyerOrganizationId: actor.organizationId,
          quantity: line.quantity,
          selections: storedSelections.map((selection) => ({
            slotKey: selection.slotKeySnapshot,
            encryptedDocumentId: selection.encryptedDocumentId ?? undefined,
            choiceValue: selection.choiceValue ?? undefined,
          })),
          requireRequiredOptions: true,
        });
        if (!revalidated.success) {
          return {
            status: "customization_rejected" as const,
            productId: line.productId,
            customizationError: revalidated.error,
          };
        }
        selectionsBySiblingOrder.set(pricedLines.length, revalidated.value);

        pricedLines.push({ ...priced.value, siblingOrder: pricedLines.length });
      }

      const expiresAt = new Date(now.getTime() + config.COMMERCE_CHECKOUT_PREPARE_TTL_MS);
      const [prepare] = await transaction
        .insert(commerceCheckoutPrepare)
        .values({
          cartId: cart.id,
          buyerOrganizationId: actor.organizationId,
          state: "active",
          deliveryAddressId,
          deliveryAddressSnapshot,
          expiresAt,
          prepareIdempotencyKey: prepareIdempotencyKey ?? null,
          createdByMemberId: actor.memberId,
        })
        .returning();
      if (!prepare) throw new Error("Checkout prepare insert returned no row.");

      const subtotalByCurrency = new Map<string, number>();
      const insertedLines: PrepareProductLineRow[] = [];
      for (const pricedLine of pricedLines) {
        const [insertedLine] = await transaction
          .insert(commerceCheckoutPrepareProductLine)
          .values({
            prepareId: prepare.id,
            productId: pricedLine.productId,
            variantId: pricedLine.variantId,
            variantNameSnapshot: pricedLine.variantName,
            sellerOrganizationId: pricedLine.sellerOrganizationId,
            titleSnapshot: pricedLine.title,
            specificationSnapshot: buildSpecificationSnapshot({
              brand: pricedLine.brand,
              description: pricedLine.description,
              variantName: pricedLine.variantName,
            }),
            quantity: pricedLine.quantity,
            unitPriceInCents: pricedLine.unitPriceInCents,
            lineTotalInCents: pricedLine.lineTotalInCents,
            currency: pricedLine.currency,
            isMadeToOrder: pricedLine.isMadeToOrder,
            isSample: pricedLine.isSample,
            /**
             * A13. Snapshotted here, not re-read at confirm. `confirmCheckout` builds the
             * order line verbatim from this row, so this is the only place the lead time
             * the buyer was shown can be captured.
             */
            leadTimeMaxDaysSnapshot: pricedLine.leadTimeMaxDays,
            /** Phase 20, §19.4. The other end of the same declaration, snapshotted here for
             *  the reason above: this is the only place the range the buyer saw is capturable. */
            leadTimeMinDaysSnapshot: pricedLine.leadTimeMinDays,
            siblingOrder: pricedLine.siblingOrder,
          })
          .returning();
        if (!insertedLine) throw new Error("Checkout prepare product line insert returned no row.");
        insertedLines.push(insertedLine);

        /**
         * Copied onto the prepare line, because `confirmCheckout` builds the order line
         * verbatim from the prepare row and never re-reads the cart — a selection that
         * does not exist here cannot reach an order. Already validated above.
         */
        const validatedSelections = selectionsBySiblingOrder.get(pricedLine.siblingOrder) ?? [];
        if (validatedSelections.length > 0) {
          await transaction.insert(commerceCheckoutPrepareLineCustomization).values(
            validatedSelections.map((selection) => ({
              prepareProductLineId: insertedLine.id,
              customizationOptionId: selection.customizationOptionId,
              encryptedDocumentId: selection.encryptedDocumentId,
              choiceValue: selection.choiceValue,
              slotKeySnapshot: selection.slotKeySnapshot,
              labelSnapshot: selection.labelSnapshot,
            })),
          );
        }

        await transaction.insert(commerceInventoryReservation).values({
          productId: pricedLine.productId,
          variantId: pricedLine.variantId,
          buyerOrganizationId: actor.organizationId,
          cartId: cart.id,
          checkoutPrepareId: prepare.id,
          quantity: pricedLine.isMadeToOrder ? 0 : pricedLine.quantity,
          isMadeToOrder: pricedLine.isMadeToOrder,
          isSample: pricedLine.isSample,
          state: "held",
          expiresAt,
        });

        subtotalByCurrency.set(
          pricedLine.currency,
          (subtotalByCurrency.get(pricedLine.currency) ?? 0) + pricedLine.lineTotalInCents,
        );
      }

      const insertedCurrencyTotals: PrepareCurrencyTotalRow[] = [];
      for (const [currency, subtotalInCents] of subtotalByCurrency) {
        const [insertedTotal] = await transaction
          .insert(commerceCheckoutPrepareCurrencyTotal)
          .values({
            prepareId: prepare.id,
            currency,
            subtotalInCents,
            taxInCents: 0,
            serviceFeeInCents: 0,
            shippingInCents: 0,
            discountInCents: 0,
            totalInCents: subtotalInCents,
          })
          .returning();
        if (!insertedTotal) {
          throw new Error("Checkout prepare currency total insert returned no row.");
        }
        insertedCurrencyTotals.push(insertedTotal);
      }

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "checkout_prepared",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_checkout_prepare",
        targetEntityId: prepare.id,
        payload: {
          prepareId: prepare.id,
          cartId: cart.id,
          lineCount: String(insertedLines.length),
        },
        occurredAt: now,
      });

      return {
        status: "created" as const,
        prepare,
        items: insertedLines,
        currencyTotals: insertedCurrencyTotals,
        deliveryCountryCode,
      };
    });

    switch (outcome.status) {
      case "org_inactive":
        return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
      case "empty_cart":
        return { success: false, error: { type: "EMPTY_CART" } };
      case "address_not_owned":
        return { success: false, error: { type: "ADDRESS_NOT_OWNED" } };
      case "address_wrong_kind":
        return {
          success: false,
          error: { type: "ADDRESS_KIND_INVALID", addressKind: outcome.addressKind },
        };
      case "customization_rejected":
        return {
          success: false,
          error: {
            type: "CUSTOMIZATION_REJECTED",
            productId: outcome.productId,
            customizationError: outcome.customizationError,
          },
        };
      case "pricing_failed":
        return {
          success: false,
          error: mapPricingErrorToCheckoutError(outcome.productId, outcome.error),
        };
      case "created": {
        /**
         * Estimated AFTER the transaction commits, deliberately. An estimate is
         * display-only (A16) — nothing about it gates the prepare, so a slow or empty
         * provider directory must not hold a row lock or fail a checkout.
         */
        const [deliveryEstimates, arrivalWindows] = await Promise.all([
          estimatePrepareDelivery(outcome.items, outcome.deliveryCountryCode),
          projectPrepareArrivalWindows(outcome.items, outcome.deliveryCountryCode),
        ]);
        return {
          success: true,
          value: projectPrepare(
            outcome.prepare,
            outcome.items,
            outcome.currencyTotals,
            deliveryEstimates,
            arrivalWindows,
          ),
        };
      }
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled prepareCheckout outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error: unknown) {
    if (isUniqueViolation(error) && prepareIdempotencyKey !== undefined) {
      const replayed = await loadPrepareProjectionByIdempotencyKey(
        actor.organizationId,
        prepareIdempotencyKey,
      );
      if (replayed) return { success: true, value: replayed };
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "Checkout preparation conflicted with a concurrent request.",
        },
      };
    }
    throw error;
  }
}

interface SellerOrderGroup {
  readonly sellerOrganizationId: string;
  readonly currency: string;
  readonly lines: PrepareProductLineRow[];
}

function groupPrepareLinesBySellerAndCurrency(
  lines: readonly PrepareProductLineRow[],
): readonly SellerOrderGroup[] {
  const groupsByKey = new Map<string, SellerOrderGroup>();
  for (const line of lines) {
    const key = `${line.sellerOrganizationId}\u0000${line.currency}`;
    const existingGroup = groupsByKey.get(key);
    if (existingGroup) {
      existingGroup.lines.push(line);
      continue;
    }
    groupsByKey.set(key, {
      sellerOrganizationId: line.sellerOrganizationId,
      currency: line.currency,
      lines: [line],
    });
  }
  return [...groupsByKey.values()];
}

/**
 * Re-validates a prepare against current product state and, only if nothing has drifted,
 * atomically creates one checkout group and one order per (seller, currency) pair,
 * decrements stock, consumes the held reservations, and clears the confirmed cart lines.
 */
export async function confirmCheckout(
  actor: CommerceCartActorContext,
  input: ConfirmCheckoutInput,
  confirmIdempotencyKey?: string,
): Promise<Result<ConfirmCheckoutProjection, CommerceCheckoutError>> {
  if (confirmIdempotencyKey !== undefined) {
    const replayed = await loadConfirmProjectionByIdempotencyKey(
      actor.organizationId,
      confirmIdempotencyKey,
    );
    if (replayed) return { success: true, value: replayed };
  }

  try {
    const outcome = await db.transaction(async (transaction) => {
      const organizationIsActive = await assertOrganizationActive(
        transaction,
        actor.organizationId,
      );
      if (!organizationIsActive) return { status: "org_inactive" as const };

      const [prepare] = await transaction
        .select()
        .from(commerceCheckoutPrepare)
        .where(eq(commerceCheckoutPrepare.id, input.prepareId))
        .for("update");
      if (!prepare || prepare.buyerOrganizationId !== actor.organizationId) {
        return { status: "not_found" as const };
      }

      const now = new Date();
      if (prepare.state === "active" && prepare.expiresAt.getTime() <= now.getTime()) {
        await transaction
          .update(commerceCheckoutPrepare)
          .set({ state: "expired", updatedAt: now })
          .where(eq(commerceCheckoutPrepare.id, prepare.id));
        await transaction
          .update(commerceInventoryReservation)
          .set({ state: "expired", releasedAt: now })
          .where(
            and(
              eq(commerceInventoryReservation.checkoutPrepareId, prepare.id),
              eq(commerceInventoryReservation.state, "held"),
            ),
          );
        return { status: "prepare_expired" as const };
      }
      if (prepare.state !== "active") {
        return { status: "prepare_not_active" as const };
      }

      let deliveryAddressId = prepare.deliveryAddressId;
      let deliveryAddressSnapshot = prepare.deliveryAddressSnapshot;
      if (input.deliveryAddressId !== undefined) {
        const owned = await assertOwnedDeliveryAddress(
          transaction,
          actor.organizationId,
          input.deliveryAddressId,
        );
        if (owned.status === "not_owned") return { status: "address_not_owned" as const };
        if (owned.status === "wrong_kind") {
          return { status: "address_wrong_kind" as const, addressKind: owned.addressKind };
        }
        deliveryAddressId = owned.id;
        deliveryAddressSnapshot = owned.snapshot;
      }

      const prepareLines = await transaction
        .select()
        .from(commerceCheckoutPrepareProductLine)
        .where(eq(commerceCheckoutPrepareProductLine.prepareId, prepare.id))
        .orderBy(asc(commerceCheckoutPrepareProductLine.siblingOrder));
      if (prepareLines.length === 0) {
        return { status: "empty_cart" as const };
      }

      const productIds = prepareLines.map((line) => line.productId);
      await transaction
        .select({ id: product.id })
        .from(product)
        .where(inArray(product.id, productIds))
        .for("update");

      const heldQuantityExcludingSelf = await loadHeldQuantitiesByProduct(
        transaction,
        productIds,
        now,
        prepare.id,
      );

      for (const prepareLine of prepareLines) {
        const revalidated = await loadPurchasableProductForCheckout(
          transaction,
          prepareLine.productId,
          prepareLine.quantity,
          heldQuantityExcludingSelf.get(
            inventoryScopeKey(prepareLine.productId, prepareLine.variantId),
          ) ?? 0,
          prepareLine.variantId,
          prepareLine.isSample,
        );
        if (!revalidated.success) {
          return {
            status: "pricing_failed" as const,
            productId: prepareLine.productId,
            error: revalidated.error,
          };
        }
        if (revalidated.value.unitPriceInCents !== prepareLine.unitPriceInCents) {
          return {
            status: "price_changed" as const,
            productId: prepareLine.productId,
            previousUnitPriceInCents: prepareLine.unitPriceInCents,
            currentUnitPriceInCents: revalidated.value.unitPriceInCents,
          };
        }
      }

      const sellerGroups = groupPrepareLinesBySellerAndCurrency(prepareLines);

      const [buyerOrganization] = await transaction
        .select({ legalName: commerceOrganization.legalName })
        .from(commerceOrganization)
        .where(eq(commerceOrganization.id, actor.organizationId))
        .limit(1);
      if (!buyerOrganization) return { status: "not_found" as const };

      const sellerOrganizationIds = [
        ...new Set(sellerGroups.map((group) => group.sellerOrganizationId)),
      ];
      const sellerOrganizations = await transaction
        .select({ id: commerceOrganization.id, legalName: commerceOrganization.legalName })
        .from(commerceOrganization)
        .where(inArray(commerceOrganization.id, sellerOrganizationIds));
      const sellerLegalNameById = new Map(
        sellerOrganizations.map((row) => [row.id, row.legalName]),
      );

      const [checkoutGroup] = await transaction
        .insert(commerceCheckoutGroup)
        .values({
          buyerOrganizationId: actor.organizationId,
          checkoutPrepareId: prepare.id,
          state: "confirmed",
          deliveryAddressSnapshot,
          confirmIdempotencyKey: confirmIdempotencyKey ?? null,
          createdByMemberId: actor.memberId,
        })
        .returning();
      if (!checkoutGroup) throw new Error("Checkout group insert returned no row.");

      const prepareCurrencyTotals = await transaction
        .select()
        .from(commerceCheckoutPrepareCurrencyTotal)
        .where(eq(commerceCheckoutPrepareCurrencyTotal.prepareId, prepare.id));
      for (const total of prepareCurrencyTotals) {
        await transaction.insert(commerceCheckoutGroupCurrencyTotal).values({
          checkoutGroupId: checkoutGroup.id,
          currency: total.currency,
          subtotalInCents: total.subtotalInCents,
          taxInCents: total.taxInCents,
          serviceFeeInCents: total.serviceFeeInCents,
          shippingInCents: total.shippingInCents,
          discountInCents: total.discountInCents,
          totalInCents: total.totalInCents,
        });
      }

      /**
       * STORE Phase 14. The buyer's claimed agreements, indexed by seller. A body may NAME
       * an agreement; `resolveSettlementRail` decides whether it establishes anything (§0).
       */
      const agreementBySeller = new Map<string, string>(
        (input.settlementAgreements ?? []).map((entry) => [
          entry.sellerOrganizationId,
          entry.agreementId,
        ]),
      );

      const createdOrders: OrderRow[] = [];
      /**
       * STORE Phase 14. Connector commands enqueued in this transaction, dispatched after
       * it commits. Enqueueing the job inside would let a worker claim the row before it
       * is visible and conclude it does not exist.
       */
      const escrowOutboxIds: string[] = [];
      /**
       * A17. Accumulated so the buyer-facing group totals can be reconciled after the
       * loop. A group total that still read the pre-credit figure would tell the buyer
       * they owe more than their orders actually charge.
       */
      const discountByCurrency = new Map<string, number>();
      for (const sellerGroup of sellerGroups) {
        const sellerLegalName = sellerLegalNameById.get(sellerGroup.sellerOrganizationId);
        if (!sellerLegalName) return { status: "not_found" as const };

        const subtotalInCents = sellerGroup.lines.reduce(
          (sum, line) => sum + line.lineTotalInCents,
          0,
        );

        /**
         * A17. Credits are resolved HERE, under the row lock, not from whatever the
         * prepare displayed — a credit consumed by another confirm in between must not
         * be applied twice. The prepare's figure is a preview; this one is the charge.
         *
         * `shippingInCents` stays 0 (A16): the delivery estimate is display-only, and
         * an order total must not contain a number nobody quoted.
         */
        const spendableCredits = await listSpendableSampleCredits(transaction, {
          buyerOrganizationId: actor.organizationId,
          sellerOrganizationId: sellerGroup.sellerOrganizationId,
          currency: sellerGroup.currency,
          asOf: now,
          forUpdate: true,
        });
        const { consumedCredits, discountInCents } = selectConsumableCredits(
          spendableCredits,
          subtotalInCents,
        );

        /**
         * A13. Derived here, from the lead time each prepare line snapshotted, so the
         * order and its lines commit to the same dates in the same transaction.
         *
         * `now` is the confirm instant — the moment the buyer became committed — not the
         * prepare instant. A prepare may sit unconfirmed for a while, and a seller's
         * lead time starts when the order does.
         */
        const linePromisedDeliveryDates = sellerGroup.lines.map((line) =>
          derivePromisedDeliveryAt({
            orderedAt: now,
            leadTimeMaxDays: line.leadTimeMaxDaysSnapshot,
          }),
        );
        const orderPromisedDeliveryAt = latestPromisedDeliveryAt(linePromisedDeliveryDates);

        /**
         * STORE Phase 14. THE RAIL IS RESOLVED BEFORE THE INSERT, and it has to be:
         * `settlement_rail` is part of the immutable commercial snapshot that
         * `commerce_prevent_order_snapshot_mutation` guards, so an UPDATE after the fact
         * is refused by the database. It is also the honest place for it — how an order
         * settles is decided when the order is created, not afterwards.
         */
        const orderTotalInCents = subtotalInCents - discountInCents;
        const railResolution = await resolveSettlementRail(transaction, {
          buyerOrganizationId: actor.organizationId,
          sellerOrganizationId: sellerGroup.sellerOrganizationId,
          currency: sellerGroup.currency,
          totalInCents: orderTotalInCents,
          /**
           * Direct-checkout orders take a payment intent, so the processor rail is the
           * right non-escrow default here. `direct_offline` belongs to quote-originated
           * orders settled by wire, which do not come through this path.
           */
          hasProcessorPayment: true,
          requestedAgreementId: agreementBySeller.get(sellerGroup.sellerOrganizationId) ?? null,
        });
        if (!railResolution.success) {
          return {
            status: "settlement_unavailable" as const,
            sellerOrganizationId: sellerGroup.sellerOrganizationId,
            error: railResolution.error,
          };
        }

        const [order] = await transaction
          .insert(commerceOrder)
          .values({
            settlementRail: railResolution.value.rail,
            buyerOrganizationId: actor.organizationId,
            counterpartyOrganizationId: sellerGroup.sellerOrganizationId,
            checkoutGroupId: checkoutGroup.id,
            source: "direct_checkout",
            state: "pending_payment",
            currency: sellerGroup.currency,
            subtotalInCents,
            taxInCents: 0,
            serviceFeeInCents: 0,
            shippingInCents: 0,
            discountInCents,
            totalInCents: subtotalInCents - discountInCents,
            paymentTermsSnapshot: null,
            incotermSnapshot: null,
            buyerLegalNameSnapshot: buyerOrganization.legalName,
            counterpartyLegalNameSnapshot: sellerLegalName,
            buyerAddressSnapshot: deliveryAddressSnapshot,
            counterpartyAddressSnapshot: null,
            /**
             * A15. The snapshot above is redacted by design; this is the durable
             * pointer an authorized seller decrypts the rest through. Written here,
             * at confirm, because this is the moment the address becomes part of an
             * immutable commercial record.
             */
            deliveryAddressId,
            /**
             * A13. Null when no line on this order declared a lead time, which keeps the
             * order out of the on-time denominator rather than scoring it against a
             * promise nobody made.
             */
            promisedDeliveryAt: orderPromisedDeliveryAt,
            createdByMemberId: actor.memberId,
          })
          .returning();
        if (!order) throw new Error("Order insert returned no row.");
        createdOrders.push(order);

        /**
         * STORE Phase 14. Spend the agreement and open the escrow session inside the same
         * transaction as the order, so a session can never exist without its order and an
         * agreement can never be spent by an order that failed to commit.
         *
         * The provider is NOT called here. `createEscrowSessionForOrder` enqueues an outbox
         * command; the call happens in a worker after commit, which is what stops a slow
         * escrow API from holding inventory row locks open.
         */
        if (railResolution.value.rail === "external_escrow") {
          const consumed = await consumeSettlementAgreement(
            transaction,
            railResolution.value.agreementId,
            order.id,
          );
          if (!consumed.success) {
            return {
              status: "settlement_unavailable" as const,
              sellerOrganizationId: sellerGroup.sellerOrganizationId,
              error: consumed.error,
            };
          }

          const session = await createEscrowSessionForOrder(transaction, {
            orderId: order.id,
            agreementId: railResolution.value.agreementId,
            providerId: railResolution.value.providerId,
            currency: railResolution.value.currency,
            totalInCents: railResolution.value.totalInCents,
          });
          if (!session.success) {
            return {
              status: "escrow_session_failed" as const,
              sellerOrganizationId: sellerGroup.sellerOrganizationId,
              reason: "reason" in session.error ? session.error.reason : session.error.type,
            };
          }
          escrowOutboxIds.push(session.value.outboxId);
        }

        if (discountInCents > 0) {
          discountByCurrency.set(
            sellerGroup.currency,
            (discountByCurrency.get(sellerGroup.currency) ?? 0) + discountInCents,
          );
        }

        await consumeSampleCredits(transaction, {
          creditIds: consumedCredits.map((credit) => credit.id),
          consumedByOrderId: order.id,
          buyerOrganizationId: actor.organizationId,
          actorUserId: actor.actorUserId,
          occurredAt: now,
        });

        for (const [index, line] of sellerGroup.lines.entries()) {
          const [orderLine] = await transaction
            .insert(commerceOrderProductLine)
            .values({
              orderId: order.id,
              productId: line.productId,
              variantId: line.variantId,
              variantNameSnapshot: line.variantNameSnapshot,
              titleSnapshot: line.titleSnapshot,
              specificationSnapshot: line.specificationSnapshot,
              isSample: line.isSample,
              quantityOrdered: line.quantity,
              quantityReserved: line.isMadeToOrder ? 0 : line.quantity,
              unitPriceInCents: line.unitPriceInCents,
              lineTotalInCents: line.lineTotalInCents,
              promisedDeliveryAt: linePromisedDeliveryDates[index] ?? null,
              /**
               * Phase 20, §19.4. Carried VERBATIM from the prepare line, like every other
               * snapshot column here. The maximum is not copied alongside it: it is already
               * recoverable from `promisedDeliveryAt` minus the order's `createdAt`, and that
               * derivation works on orders placed before this column existed.
               */
              leadTimeMinDaysSnapshot: line.leadTimeMinDaysSnapshot,
              siblingOrder: index,
            })
            .returning({ id: commerceOrderProductLine.id });
          if (!orderLine) throw new Error("Order product line insert returned no row.");

          /**
           * A18. The last hop of the snapshot chain. Copied verbatim from the prepare
           * line — including `slotKeySnapshot` and `labelSnapshot` — because a seller
           * renaming a slot after the sale must not change what the order says the
           * buyer agreed to.
           */
          const prepareCustomizations = await transaction
            .select()
            .from(commerceCheckoutPrepareLineCustomization)
            .where(eq(commerceCheckoutPrepareLineCustomization.prepareProductLineId, line.id));
          if (prepareCustomizations.length > 0) {
            await transaction.insert(commerceOrderLineCustomization).values(
              prepareCustomizations.map((selection) => ({
                orderProductLineId: orderLine.id,
                customizationOptionId: selection.customizationOptionId,
                encryptedDocumentId: selection.encryptedDocumentId,
                choiceValue: selection.choiceValue,
                slotKeySnapshot: selection.slotKeySnapshot,
                labelSnapshot: selection.labelSnapshot,
              })),
            );
          }

          if (!line.isMadeToOrder) {
            /**
             * A1: stock is drawn from whichever row owns it. Decrementing the
             * product when a variant was bought would take units from a pool the
             * buyer never bought out of, and leave the sold variant sellable.
             */
            if (line.variantId === null) {
              await transaction
                .update(product)
                .set({ stockQuantity: sql`${product.stockQuantity} - ${line.quantity}` })
                .where(eq(product.id, line.productId));
            } else {
              await transaction
                .update(commerceProductVariant)
                .set({
                  stockQuantity: sql`${commerceProductVariant.stockQuantity} - ${line.quantity}`,
                })
                .where(eq(commerceProductVariant.id, line.variantId));
            }
          }
        }

        await appendAuditOrThrow(transaction, {
          organizationId: actor.organizationId,
          eventKind: "order_created_from_checkout",
          actorUserId: actor.actorUserId,
          actorMemberRoleSnapshot: actor.memberRole,
          targetEntityType: "commerce_order",
          targetEntityId: order.id,
          payload: {
            orderId: order.id,
            checkoutGroupId: checkoutGroup.id,
            prepareId: prepare.id,
            totalInCents: String(order.totalInCents),
          },
          occurredAt: now,
        });
      }

      await transaction
        .update(commerceInventoryReservation)
        .set({ state: "consumed", consumedAt: now })
        .where(
          and(
            eq(commerceInventoryReservation.checkoutPrepareId, prepare.id),
            eq(commerceInventoryReservation.state, "held"),
          ),
        );

      /**
       * A17. Reconcile the buyer-facing aggregate with what the orders actually charge.
       * The money CHECK on this table enforces
       * `total = subtotal + tax + serviceFee + shipping - discount`, so both columns
       * move together or neither does.
       */
      for (const [currency, discountInCents] of discountByCurrency) {
        await transaction
          .update(commerceCheckoutGroupCurrencyTotal)
          .set({
            discountInCents,
            totalInCents: sql`${commerceCheckoutGroupCurrencyTotal.totalInCents} - ${discountInCents}`,
          })
          .where(
            and(
              eq(commerceCheckoutGroupCurrencyTotal.checkoutGroupId, checkoutGroup.id),
              eq(commerceCheckoutGroupCurrencyTotal.currency, currency),
            ),
          );
      }

      await transaction
        .update(commerceCheckoutPrepare)
        .set({ state: "consumed", deliveryAddressId, deliveryAddressSnapshot, updatedAt: now })
        .where(eq(commerceCheckoutPrepare.id, prepare.id));

      await transaction
        .delete(commerceCartProductLine)
        .where(eq(commerceCartProductLine.cartId, prepare.cartId));

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "checkout_confirmed",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_checkout_group",
        targetEntityId: checkoutGroup.id,
        payload: {
          checkoutGroupId: checkoutGroup.id,
          prepareId: prepare.id,
          orderCount: String(createdOrders.length),
        },
        occurredAt: now,
      });

      return {
        status: "confirmed" as const,
        checkoutGroupId: checkoutGroup.id,
        orders: createdOrders,
        escrowOutboxIds,
      };
    });

    switch (outcome.status) {
      case "org_inactive":
        return { success: false, error: { type: "ORGANIZATION_NOT_ACTIVE" } };
      case "not_found":
        return { success: false, error: { type: "NOT_FOUND" } };
      case "prepare_expired":
        return { success: false, error: { type: "PREPARE_EXPIRED" } };
      case "prepare_not_active":
        return { success: false, error: { type: "PREPARE_NOT_ACTIVE" } };
      case "address_not_owned":
        return { success: false, error: { type: "ADDRESS_NOT_OWNED" } };
      case "address_wrong_kind":
        return {
          success: false,
          error: { type: "ADDRESS_KIND_INVALID", addressKind: outcome.addressKind },
        };
      case "empty_cart":
        return { success: false, error: { type: "EMPTY_CART" } };
      case "pricing_failed":
        return {
          success: false,
          error: mapPricingErrorToCheckoutError(outcome.productId, outcome.error),
        };
      case "price_changed":
        return {
          success: false,
          error: {
            type: "PRICE_CHANGED",
            productId: outcome.productId,
            previousUnitPriceInCents: outcome.previousUnitPriceInCents,
            currentUnitPriceInCents: outcome.currentUnitPriceInCents,
          },
        };
      case "settlement_unavailable":
        return {
          success: false,
          error: {
            type: "SETTLEMENT_UNAVAILABLE",
            sellerOrganizationId: outcome.sellerOrganizationId,
            reason: outcome.error.reason,
          },
        };
      case "escrow_session_failed":
        return {
          success: false,
          error: {
            type: "ESCROW_SESSION_FAILED",
            sellerOrganizationId: outcome.sellerOrganizationId,
            reason: outcome.reason,
          },
        };
      case "confirmed":
        /**
         * Dispatch AFTER commit. The outbox rows are durable, so a failed enqueue costs
         * latency rather than the command — the hourly reconciler re-enqueues anything
         * still pending.
         */
        await scheduleEscrowCommands(outcome.escrowOutboxIds);
        return {
          success: true,
          value: {
            checkoutGroupId: outcome.checkoutGroupId,
            orders: outcome.orders.map(projectOrder),
          },
        };
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled confirmCheckout outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      const byPrepare = await loadConfirmProjectionByPrepareId(input.prepareId);
      if (byPrepare) return { success: true, value: byPrepare };
      if (confirmIdempotencyKey !== undefined) {
        const byKey = await loadConfirmProjectionByIdempotencyKey(
          actor.organizationId,
          confirmIdempotencyKey,
        );
        if (byKey) return { success: true, value: byKey };
      }
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "Checkout confirmation conflicted with a concurrent request.",
        },
      };
    }
    throw error;
  }
}

/**
 * The expiry sweep (STORE_BACKEND_STRUCTURE.md §10). Queries persisted `expiresAt` values
 * rather than a timer, so a worker that was down for hours locks nothing early and loses
 * nothing — every prepare/reservation past its own recorded deadline expires exactly once,
 * however late this runs.
 */
export async function releaseExpiredInventoryReservations(
  asOf: Date,
): Promise<{ readonly expiredPrepareCount: number; readonly releasedReservationCount: number }> {
  return db.transaction(async (transaction) => {
    const expiredPrepares = await transaction
      .update(commerceCheckoutPrepare)
      .set({ state: "expired", updatedAt: asOf })
      .where(
        and(
          eq(commerceCheckoutPrepare.state, "active"),
          lte(commerceCheckoutPrepare.expiresAt, asOf),
        ),
      )
      .returning({ id: commerceCheckoutPrepare.id });

    const releasedReservations = await transaction
      .update(commerceInventoryReservation)
      .set({ state: "expired", releasedAt: asOf })
      .where(
        and(
          eq(commerceInventoryReservation.state, "held"),
          lte(commerceInventoryReservation.expiresAt, asOf),
        ),
      )
      .returning({ id: commerceInventoryReservation.id });

    return {
      expiredPrepareCount: expiredPrepares.length,
      releasedReservationCount: releasedReservations.length,
    };
  });
}
