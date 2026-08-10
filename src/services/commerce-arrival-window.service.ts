import { and, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceOrganizationAddress,
  commerceQuote,
  commerceRfq,
  product,
} from "#src/db/schema.js";
import { resolveShippingOriginCountryCode } from "#src/services/commerce-delivery-estimate.service.js";
import {
  resolveCustomsDwell,
  type CustomsDwellResolution,
} from "#src/services/commerce-customs-dwell.service.js";
import {
  planFreightJourney,
  type FreightJourneyLegSelection,
  type FreightLanePlan,
} from "#src/services/commerce-freight-journey.service.js";
import { FREIGHT_MODE_ORDER } from "#src/services/commerce-freight-rating.service.js";
import type { ConsignmentMeasurement } from "#src/services/commerce-freight-rating.service.js";
import type { CommerceOrdersError } from "#src/services/commerce-orders.service.js";
import type { FreightMode } from "#src/schemas/commerce-freight-rates.schemas.js";
import type { Result } from "#src/types/index.js";

/**
 * The arrival window (STORE_BACKEND_STRUCTURE.md §19.4).
 *
 * WHAT THIS REFUSES TO DO IS THE POINT. When a component cannot be resolved the window is
 * `null` and the component is NAMED. Nothing is defaulted, averaged, or extrapolated: B2B
 * freight variance is large enough that an average is wrong more often than right — a
 * container sitting at port for three weeks is ordinary, not an outlier — and a printed date
 * is a claim the platform then owns. Amazon prints one date because it owns the network and
 * absorbs the risk; Qatoto owns neither, and this is Alibaba's degradation, chosen.
 *
 * EVERY COMPONENT IS A DISCRIMINATED UNION, not a nullable object. §19.4 argues this for
 * customs — a bare `null` collapses "no customs leg on a domestic lane" into "we do not know
 * the clearance" — and the same argument applies to freight (a service-only order has no
 * goods) and to manufacturing (a seller may have declared no lead time). Uniformity means the
 * emission rule reads once: a component is RESOLVED iff its status is `known` or
 * `not_applicable`, and only `unknown` reaches `missingComponents`.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

export type ArrivalWindowComponentName = "manufacturing" | "freight" | "customs";

export type ManufacturingComponentProjection =
  | {
      readonly status: "known";
      readonly daysMin: number | null;
      readonly daysMax: number;
      /** `order.promisedDeliveryAt` — a STORED instant, not a duration re-added to a clock. */
      readonly endsAt: Date;
      readonly basis: "declared_maximum_only" | "declared_range";
    }
  | { readonly status: "not_applicable"; readonly reason: "no_physical_goods_on_order" }
  | { readonly status: "unknown"; readonly reason: "no_seller_declared_lead_time" };

export type FreightUnknownReason =
  | "destination_unresolved"
  | "origin_country_unresolved"
  | "consignment_not_measurable"
  | "no_active_rate_card"
  | "leg_uncovered"
  | "no_common_currency_across_legs"
  | "mode_not_selected"
  | "mode_not_covered";

export type FreightComponentProjection =
  | {
      readonly status: "known";
      readonly daysMin: number;
      readonly daysMax: number;
      readonly mode: FreightMode;
      readonly priceInCents: number;
      readonly currency: string;
      readonly validUntil: Date | null;
      readonly legSelections: readonly FreightJourneyLegSelection[];
    }
  | { readonly status: "not_applicable"; readonly reason: "no_physical_goods_on_order" }
  | {
      readonly status: "unknown";
      readonly reason: FreightUnknownReason;
      /** Non-empty only when a mode could have been chosen and was not. */
      readonly availableModes: readonly FreightMode[];
    };

export type CustomsComponentProjection =
  | CustomsDwellResolution
  | { readonly status: "not_applicable"; readonly reason: "no_physical_goods_on_order" };

export interface ArrivalWindowProjection {
  /**
   * §19.4: `order.confirmedAt`. STATED ON THE WIRE rather than left for the client to assume,
   * because "confirmed", "payment settled" and "first shipment event" give three different
   * answers and the buyer is entitled to know which promise they were given.
   *
   * NULL until settlement stamps it, and null on every order placed before Phase 13.
   */
  readonly clockStartAt: Date | null;
  readonly clockStartBasis: "order_confirmed_at" | "not_confirmed";
  /**
   * `order.createdAt` — when the manufacturing clock ACTUALLY started.
   *
   * §19.4 assumes `clockStartAt` and the manufacturing clock share a start. THEY DO NOT in the
   * shipped schema: `promisedDeliveryAt` is derived at order creation, while `confirmedAt` is
   * stamped later by settlement, so the gap between them is however long payment took. This
   * field puts that gap on the wire rather than hiding it inside the arithmetic.
   */
  readonly orderPlacedAt: Date;
  readonly lane: {
    readonly originCountryCode: string | null;
    readonly destinationCountryCode: string | null;
    readonly destinationSource: "order_delivery_address" | "rfq_destination" | "unresolved";
  };
  readonly consignment: ConsignmentMeasurement | null;
  readonly components: {
    readonly manufacturing: ManufacturingComponentProjection;
    readonly freight: FreightComponentProjection;
    readonly customs: CustomsComponentProjection;
  };
  readonly arrivalWindow: {
    readonly fromDate: Date;
    readonly toDate: Date;
    readonly basis: "manufacturing_deadline_anchored";
  } | null;
  /**
   * §19.4 enumerates only freight and customs. MANUFACTURING IS ADDED because
   * `leadTimeMaxDaysSnapshot` is nullable: an order whose seller declared no lead time would
   * otherwise return a null window with an EMPTY `missingComponents`, which is an unnamed
   * absence — precisely what §19.6 forbids.
   */
  readonly missingComponents: readonly ArrivalWindowComponentName[];
}

/**
 * PURE. Composes the window from three resolved components.
 *
 * ANCHORED ON THE STORED `promisedDeliveryAt`, NOT on `clockStartAt + manufacturingDays`. The
 * two clocks do not share a start (see `orderPlacedAt`), so re-adding a reconstructed duration
 * to `confirmedAt` would let payment latency silently shorten the manufacturing leg.
 */
export function composeArrivalWindow(input: {
  readonly clockStartAt: Date | null;
  readonly manufacturing: ManufacturingComponentProjection;
  readonly freight: FreightComponentProjection;
  readonly customs: CustomsComponentProjection;
}): {
  readonly arrivalWindow: ArrivalWindowProjection["arrivalWindow"];
  readonly missingComponents: readonly ArrivalWindowComponentName[];
} {
  const missingComponents: ArrivalWindowComponentName[] = [];
  if (input.manufacturing.status === "unknown") missingComponents.push("manufacturing");
  if (input.freight.status === "unknown") missingComponents.push("freight");
  if (input.customs.status === "unknown") missingComponents.push("customs");

  if (missingComponents.length > 0 || input.clockStartAt === null) {
    return { arrivalWindow: null, missingComponents };
  }

  // Nothing is being manufactured, so there is no instant to anchor to. A resolved set of
  // "not applicable" components is an honest answer with no calendar behind it.
  if (input.manufacturing.status !== "known") {
    return { arrivalWindow: null, missingComponents };
  }

  const freightDaysMin = input.freight.status === "known" ? input.freight.daysMin : 0;
  const freightDaysMax = input.freight.status === "known" ? input.freight.daysMax : 0;
  const customsDaysMin = input.customs.status === "known" ? input.customs.clearanceDaysMin : 0;
  const customsDaysMax = input.customs.status === "known" ? input.customs.clearanceDaysMax : 0;

  const anchorMs = input.manufacturing.endsAt.getTime();
  return {
    arrivalWindow: {
      fromDate: new Date(anchorMs + (freightDaysMin + customsDaysMin) * MILLISECONDS_PER_DAY),
      toDate: new Date(anchorMs + (freightDaysMax + customsDaysMax) * MILLISECONDS_PER_DAY),
      basis: "manufacturing_deadline_anchored",
    },
    missingComponents,
  };
}

/**
 * PURE. The manufacturing component from the order's stored facts.
 *
 * `daysMax` IS RECONSTRUCTED FROM `promisedDeliveryAt − createdAt`, and losslessly:
 * `derivePromisedDeliveryAt` added whole days to the insert instant. It uses `createdAt` and
 * NOT `confirmedAt` — see `orderPlacedAt`.
 *
 * `daysMin` comes from the Phase 20 snapshot and is `null` for every order placed before that
 * column existed, and for every quote-originated order (a quote line carries a single lead-time
 * figure, not a range). Null is REPORTED, never filled in.
 */
export function projectManufacturing(input: {
  readonly hasPhysicalGoods: boolean;
  readonly orderPlacedAt: Date;
  readonly promisedDeliveryAt: Date | null;
  readonly leadTimeMinDaysSnapshots: readonly (number | null)[];
}): ManufacturingComponentProjection {
  if (!input.hasPhysicalGoods) {
    return { status: "not_applicable", reason: "no_physical_goods_on_order" };
  }
  if (input.promisedDeliveryAt === null) {
    return { status: "unknown", reason: "no_seller_declared_lead_time" };
  }

  const daysMax = Math.round(
    (input.promisedDeliveryAt.getTime() - input.orderPlacedAt.getTime()) / MILLISECONDS_PER_DAY,
  );

  /**
   * The MAXIMUM of the line minimums, not the minimum.
   *
   * An order is complete when its SLOWEST line is, which is the call `latestPromisedDeliveryAt`
   * already made for the maximum. And a single line with no declared minimum makes the order's
   * minimum unknown — taking the max of what happens to be present would publish a floor that
   * ignores the very line most likely to be late.
   */
  const minimums = input.leadTimeMinDaysSnapshots;
  const daysMin =
    minimums.length > 0 && minimums.every((days): days is number => days !== null)
      ? Math.max(...minimums)
      : null;

  return {
    status: "known",
    daysMin,
    daysMax,
    endsAt: input.promisedDeliveryAt,
    basis: daysMin === null ? "declared_maximum_only" : "declared_range",
  };
}

/**
 * PURE. The freight component for the mode the caller asked about.
 *
 * NO MODE IS EVER AUTO-SELECTED. §19.4 lists "no mode selected yet" as a legitimate reason the
 * window is null, and picking the cheapest would systematically publish the slowest window as
 * though the buyer had chosen it — sea is nearly always cheapest and roughly four times slower.
 * With no `?mode=`, the covered modes are listed and the client renders the choice.
 */
export function projectFreight(input: {
  readonly hasPhysicalGoods: boolean;
  readonly lanePlan: FreightLanePlan | null;
  readonly requestedMode: FreightMode | undefined;
}): FreightComponentProjection {
  if (!input.hasPhysicalGoods) {
    return { status: "not_applicable", reason: "no_physical_goods_on_order" };
  }
  if (input.lanePlan === null) {
    return { status: "unknown", reason: "origin_country_unresolved", availableModes: [] };
  }

  const availableModes = [
    ...new Set(input.lanePlan.journeys.map((journey) => journey.primaryMode)),
  ].toSorted((left, right) => FREIGHT_MODE_ORDER.indexOf(left) - FREIGHT_MODE_ORDER.indexOf(right));

  if (input.lanePlan.journeys.length === 0) {
    const firstReason = input.lanePlan.unpriceableReasons[0];
    const reason: FreightUnknownReason =
      firstReason === undefined
        ? "no_active_rate_card"
        : firstReason.kind === "leg_uncovered"
          ? "leg_uncovered"
          : firstReason.kind === "no_common_currency_across_legs"
            ? "no_common_currency_across_legs"
            : "origin_country_unresolved";
    return { status: "unknown", reason, availableModes: [] };
  }

  if (input.requestedMode === undefined) {
    return { status: "unknown", reason: "mode_not_selected", availableModes };
  }

  // Cheapest journey in the requested mode. Several currencies may cover one mode; each is a
  // real, separate price, and the client picks by currency.
  const inMode = input.lanePlan.journeys.filter(
    (journey) => journey.primaryMode === input.requestedMode,
  );
  const chosen = inMode.toSorted(
    (left, right) => left.totalInCents - right.totalInCents || left.currency.localeCompare(right.currency),
  )[0];

  if (!chosen) {
    // The order exists and the question is answerable, so this is not a 404 — it is "that mode
    // is not covered on this lane, and here is what is".
    return { status: "unknown", reason: "mode_not_covered", availableModes };
  }

  return {
    status: "known",
    daysMin: chosen.transitDaysMin,
    daysMax: chosen.transitDaysMax,
    mode: chosen.primaryMode,
    priceInCents: chosen.totalInCents,
    currency: chosen.currency,
    validUntil: chosen.validUntil,
    legSelections: chosen.legSelections,
  };
}

interface OrderActor {
  readonly organizationId: string;
}

/**
 * The order-scoped read.
 *
 * AUTHORIZATION IS `getOrder`'s, COPIED RATHER THAN ABSTRACTED. A stranger must not learn that
 * an order id exists, so a caller who is neither the buyer nor the counterparty gets the same
 * 404 as a caller naming an id that was never minted. `CommerceOrdersError` is REUSED so
 * `mapOrdersError` keeps working — a second near-identical union is how two 404s start
 * disagreeing.
 */
export async function getOrderArrivalWindow(
  actor: OrderActor,
  orderId: string,
  options: { readonly mode: FreightMode | undefined; readonly asOf: Date },
): Promise<Result<ArrivalWindowProjection, CommerceOrdersError>> {
  const [order] = await db
    .select({
      id: commerceOrder.id,
      buyerOrganizationId: commerceOrder.buyerOrganizationId,
      counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
      acceptedQuoteId: commerceOrder.acceptedQuoteId,
      deliveryAddressId: commerceOrder.deliveryAddressId,
      promisedDeliveryAt: commerceOrder.promisedDeliveryAt,
      confirmedAt: commerceOrder.confirmedAt,
      createdAt: commerceOrder.createdAt,
    })
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);

  if (!order) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  if (
    order.buyerOrganizationId !== actor.organizationId &&
    order.counterpartyOrganizationId !== actor.organizationId
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const lines = await db
    .select({
      productId: commerceOrderProductLine.productId,
      quantityOrdered: commerceOrderProductLine.quantityOrdered,
      leadTimeMinDaysSnapshot: commerceOrderProductLine.leadTimeMinDaysSnapshot,
    })
    .from(commerceOrderProductLine)
    .where(eq(commerceOrderProductLine.orderId, orderId));

  const goodsLines = lines.filter(
    (line): line is typeof line & { readonly productId: string } => line.productId !== null,
  );
  const hasPhysicalGoods = goodsLines.length > 0;

  const destination = await resolveDestination(order);
  const originCountryCode = hasPhysicalGoods
    ? await resolveShippingOriginCountryCode(order.counterpartyOrganizationId)
    : null;

  const lanePlan =
    hasPhysicalGoods && destination.countryCode !== null
      ? await planFreightJourney({
          originCountryCode,
          originLocality: null,
          destinationCountryCode: destination.countryCode,
          destinationLocality: destination.locality,
          lines: goodsLines.map((line) => ({
            productId: line.productId,
            quantity: line.quantityOrdered,
          })),
          asOf: options.asOf,
        })
      : null;

  const manufacturing = projectManufacturing({
    hasPhysicalGoods,
    orderPlacedAt: order.createdAt,
    promisedDeliveryAt: order.promisedDeliveryAt,
    leadTimeMinDaysSnapshots: goodsLines.map((line) => line.leadTimeMinDaysSnapshot),
  });

  const freight: FreightComponentProjection =
    hasPhysicalGoods && destination.countryCode === null
      ? { status: "unknown", reason: "destination_unresolved", availableModes: [] }
      : projectFreight({ hasPhysicalGoods, lanePlan, requestedMode: options.mode });

  const customs: CustomsComponentProjection = !hasPhysicalGoods
    ? { status: "not_applicable", reason: "no_physical_goods_on_order" }
    : destination.countryCode === null
      ? { status: "unknown", reason: "no_dwell_estimate_for_lane" }
      : await resolveCustomsDwell({
          originCountryCode,
          destinationCountryCode: destination.countryCode,
          commodityCategoryIds: await loadCommodityCategoryIds(
            goodsLines.map((line) => line.productId),
          ),
          asOf: options.asOf,
        });

  const composed = composeArrivalWindow({
    clockStartAt: order.confirmedAt,
    manufacturing,
    freight,
    customs,
  });

  return {
    success: true,
    value: {
      clockStartAt: order.confirmedAt,
      clockStartBasis: order.confirmedAt === null ? "not_confirmed" : "order_confirmed_at",
      orderPlacedAt: order.createdAt,
      lane: {
        originCountryCode,
        destinationCountryCode: destination.countryCode,
        destinationSource: destination.source,
      },
      consignment: lanePlan?.consignment ?? null,
      components: { manufacturing, freight, customs },
      arrivalWindow: composed.arrivalWindow,
      missingComponents: composed.missingComponents,
    },
  };
}

/**
 * Where is this going?
 *
 * `buyerAddressSnapshot` IS NEVER PARSED. It is a display string built by
 * `formatDeliveryAddressSnapshot`, and reading geography back out of formatted prose is how a
 * comma inside a locality becomes a wrong country.
 */
async function resolveDestination(order: {
  readonly deliveryAddressId: string | null;
  readonly acceptedQuoteId: string | null;
}): Promise<{
  readonly countryCode: string | null;
  readonly locality: string | null;
  readonly source: "order_delivery_address" | "rfq_destination" | "unresolved";
}> {
  if (order.deliveryAddressId !== null) {
    const [address] = await db
      .select({
        countryCode: commerceOrganizationAddress.countryCode,
        locality: commerceOrganizationAddress.locality,
      })
      .from(commerceOrganizationAddress)
      .where(eq(commerceOrganizationAddress.id, order.deliveryAddressId))
      .limit(1);

    if (address) {
      return {
        countryCode: address.countryCode,
        locality: address.locality,
        source: "order_delivery_address",
      };
    }
  }

  // A quote-originated order has no prepare and so no `deliveryAddressId`, but its RFQ carries
  // a structured destination — there is no need to fall back to prose.
  if (order.acceptedQuoteId !== null) {
    const [rfqDestination] = await db
      .select({
        countryCode: commerceRfq.destinationCountryCode,
        locality: commerceRfq.destinationLocality,
      })
      .from(commerceQuote)
      .innerJoin(commerceRfq, eq(commerceQuote.rfqId, commerceRfq.id))
      .where(eq(commerceQuote.id, order.acceptedQuoteId))
      .limit(1);

    if (rfqDestination?.countryCode) {
      return {
        countryCode: rfqDestination.countryCode,
        locality: rfqDestination.locality,
        source: "rfq_destination",
      };
    }
  }

  return { countryCode: null, locality: null, source: "unresolved" };
}

async function loadCommodityCategoryIds(
  productIds: readonly string[],
): Promise<readonly string[]> {
  if (productIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({ categoryId: product.categoryId })
    .from(product)
    .where(and(inArray(product.id, [...new Set(productIds)])));

  return [...new Set(rows.map((row) => row.categoryId).filter((id): id is string => id !== null))];
}
