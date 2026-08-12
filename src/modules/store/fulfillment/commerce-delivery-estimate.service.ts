import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrganization,
  commerceOrganizationAddress,
  commerceProviderProfile,
  commerceServiceCoverage,
  commerceServiceOffering,
  product,
} from "#src/db/schema.js";

/**
 * Indicative delivery estimates (Appendix A16).
 *
 * `shippingInCents` is written literal `0` everywhere in the checkout path, and this
 * service does NOT change that. Nothing here is charged: an estimate assembled from a
 * provider's advertised price RANGE has no carrier booking behind it, and billing a
 * buyer from it would put an invented number into an immutable order total.
 *
 * THE RULE THAT GOVERNS THIS FILE (§A16, §14): an estimate is not a quote and must
 * never be rendered as a promise. Nothing here returns a delivery DATE, a single
 * figure, or a currency conversion. It returns a range per currency, the inputs it was
 * derived from, and the offerings that produced it — so a buyer can see it is an
 * estimate and see whose numbers it came from.
 *
 * The inputs all existed before this file. `commerce_service_coverage` has modelled
 * origin and destination since Phase 2, and Phase 8 added the package geometry whose
 * schema comment already said "freight rating (A16) is the whole reason these exist".
 * Nothing had read either.
 */

/** Kinds that actually move goods. An inspection agency covering a route does not ship it. */
const FREIGHT_PROVIDER_KINDS = ["freight_forwarder", "logistics_operator"] as const;

/**
 * A seller's shipping origin, in preference order. `warehouse` is where goods sit;
 * `pickup` is where a carrier collects them; the organization's own country is the last
 * resort and the only field guaranteed to exist.
 */
const ORIGIN_ADDRESS_KINDS = ["warehouse", "pickup"] as const;

/** Bounded so one prepare cannot fan out into an unbounded provider scan. */
const MAXIMUM_OFFERINGS_PER_ESTIMATE = 25;

export interface DeliveryEstimateLineInput {
  readonly productId: string;
  readonly quantity: number;
}

/**
 * What the estimate was computed from, on the wire.
 *
 * `hasIncompletePackageData` is the honest half of this: a seller who never declared
 * package geometry produces an estimate with no weight behind it, and the buyer should
 * be able to tell that from one backed by real dimensions.
 */
export interface DeliveryEstimateBasis {
  readonly originCountryCode: string | null;
  readonly destinationCountryCode: string;
  readonly billableWeightGrams: number | null;
  readonly packageCount: number | null;
  readonly hasIncompletePackageData: boolean;
}

export interface DeliveryEstimateSourceOffering {
  readonly offeringId: string;
  readonly offeringSlug: string;
  readonly providerOrganizationSlug: string;
  readonly providerDisplayName: string;
  readonly providerKind: string;
}

/**
 * One estimate per currency, never converted — an offering's currency is independent of
 * the order's, and converting without an FX quote would invent a rate. The same rule
 * Phase 9's set totals follow.
 */
export interface DeliveryEstimateProjection {
  readonly currency: string;
  readonly estimatedMinInCents: number;
  readonly estimatedMaxInCents: number;
  readonly leadTimeMinDays: number | null;
  readonly leadTimeMaxDays: number | null;
  readonly basis: DeliveryEstimateBasis;
  readonly derivedFrom: readonly DeliveryEstimateSourceOffering[];
}

/**
 * Resolves where a seller ships from.
 *
 * Nothing in this backend resolved a seller's shipping origin before Phase 11 —
 * `commerce_shipment.origin_country_code` is whatever the seller typed into the request
 * body at ship time, which is not a fact anything can plan against.
 */
export async function resolveShippingOriginCountryCode(
  sellerOrganizationId: string,
): Promise<string | null> {
  const originAddresses = await db
    .select({
      addressKind: commerceOrganizationAddress.addressKind,
      countryCode: commerceOrganizationAddress.countryCode,
      isDefault: commerceOrganizationAddress.isDefault,
    })
    .from(commerceOrganizationAddress)
    .where(
      and(
        eq(commerceOrganizationAddress.organizationId, sellerOrganizationId),
        inArray(commerceOrganizationAddress.addressKind, [...ORIGIN_ADDRESS_KINDS]),
      ),
    );

  for (const addressKind of ORIGIN_ADDRESS_KINDS) {
    const ofKind = originAddresses.filter((address) => address.addressKind === addressKind);
    const chosen = ofKind.find((address) => address.isDefault) ?? ofKind[0];
    if (chosen) return chosen.countryCode;
  }

  const [organization] = await db
    .select({ countryCode: commerceOrganization.countryCode })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, sellerOrganizationId))
    .limit(1);
  return organization?.countryCode ?? null;
}

interface PackagingTotals {
  readonly billableWeightGrams: number | null;
  readonly packageCount: number | null;
  readonly hasIncompletePackageData: boolean;
}

/**
 * Package count and gross weight across the lines being estimated.
 *
 * `unitsPerPackage` NULL means UNSTATED, not one — the schema comment is explicit — so
 * a line missing it contributes nothing and flips `hasIncompletePackageData`. Guessing
 * one unit per package would manufacture a weight the seller never declared, and the
 * whole point of A16 is that the estimate is attributable.
 */
export function computePackagingTotals(
  lines: readonly {
    readonly quantity: number;
    readonly unitsPerPackage: number | null;
    readonly packageGrossWeightGrams: number | null;
  }[],
): PackagingTotals {
  let packageCount = 0;
  let billableWeightGrams = 0;
  let hasIncompletePackageData = false;
  let contributedAnyLine = false;

  for (const line of lines) {
    if (line.unitsPerPackage === null || line.packageGrossWeightGrams === null) {
      hasIncompletePackageData = true;
      continue;
    }
    const packagesForLine = Math.ceil(line.quantity / line.unitsPerPackage);
    packageCount += packagesForLine;
    billableWeightGrams += packagesForLine * line.packageGrossWeightGrams;
    contributedAnyLine = true;
  }

  if (!contributedAnyLine) {
    return { billableWeightGrams: null, packageCount: null, hasIncompletePackageData: true };
  }
  return { billableWeightGrams, packageCount, hasIncompletePackageData };
}

/**
 * The estimate itself.
 *
 * Returns an empty array rather than a zero when no offering covers the route. "We do
 * not know" and "it is free" are different answers, and the mock this replaces rendered
 * the second one over a hardcoded date range.
 */
export async function estimateDeliveryForLines(input: {
  readonly sellerOrganizationId: string;
  readonly destinationCountryCode: string;
  readonly lines: readonly DeliveryEstimateLineInput[];
}): Promise<readonly DeliveryEstimateProjection[]> {
  if (input.lines.length === 0) return [];

  const originCountryCode = await resolveShippingOriginCountryCode(input.sellerOrganizationId);

  const productRows = await db
    .select({
      id: product.id,
      unitsPerPackage: product.unitsPerPackage,
      packageGrossWeightGrams: product.packageGrossWeightGrams,
    })
    .from(product)
    .where(inArray(product.id, [...new Set(input.lines.map((line) => line.productId))]));
  const productById = new Map(productRows.map((row) => [row.id, row]));

  const packaging = computePackagingTotals(
    input.lines.map((line) => ({
      quantity: line.quantity,
      unitsPerPackage: productById.get(line.productId)?.unitsPerPackage ?? null,
      packageGrossWeightGrams: productById.get(line.productId)?.packageGrossWeightGrams ?? null,
    })),
  );

  const coveringOfferings = await loadCoveringOfferings({
    originCountryCode,
    destinationCountryCode: input.destinationCountryCode,
  });
  if (coveringOfferings.length === 0) return [];

  const basis: DeliveryEstimateBasis = {
    originCountryCode,
    destinationCountryCode: input.destinationCountryCode,
    billableWeightGrams: packaging.billableWeightGrams,
    packageCount: packaging.packageCount,
    hasIncompletePackageData: packaging.hasIncompletePackageData,
  };

  return groupOfferingsIntoEstimates(coveringOfferings, basis);
}

interface CoveringOffering {
  readonly offeringId: string;
  readonly offeringSlug: string;
  readonly providerKind: string;
  readonly currency: string;
  readonly indicativePriceMinInCents: number;
  readonly indicativePriceMaxInCents: number;
  readonly minimumLeadTimeDays: number | null;
  readonly maximumLeadTimeDays: number | null;
  readonly providerOrganizationSlug: string;
  readonly providerDisplayName: string;
}

async function loadCoveringOfferings(input: {
  readonly originCountryCode: string | null;
  readonly destinationCountryCode: string;
}): Promise<readonly CoveringOffering[]> {
  /**
   * A NULL coverage country means UNRESTRICTED, not unknown: a global forwarder
   * declares no origin rather than declaring two hundred of them. An unresolved seller
   * origin therefore matches only unrestricted-origin coverage, which is the honest
   * reading — we cannot claim a route we cannot name one end of.
   */
  const originMatches =
    input.originCountryCode === null
      ? isNull(commerceServiceCoverage.originCountryCode)
      : or(
          isNull(commerceServiceCoverage.originCountryCode),
          eq(commerceServiceCoverage.originCountryCode, input.originCountryCode),
        );

  const rows = await db
    .selectDistinctOn([commerceServiceOffering.id], {
      offeringId: commerceServiceOffering.id,
      offeringSlug: commerceServiceOffering.slug,
      providerKind: commerceServiceOffering.providerKind,
      currency: commerceServiceOffering.currency,
      indicativePriceMinInCents: commerceServiceOffering.indicativePriceMinInCents,
      indicativePriceMaxInCents: commerceServiceOffering.indicativePriceMaxInCents,
      minimumLeadTimeDays: commerceServiceOffering.minimumLeadTimeDays,
      maximumLeadTimeDays: commerceServiceOffering.maximumLeadTimeDays,
      providerOrganizationSlug: commerceOrganization.slug,
      providerDisplayName: commerceOrganization.displayName,
    })
    .from(commerceServiceCoverage)
    .innerJoin(
      commerceServiceOffering,
      eq(commerceServiceOffering.id, commerceServiceCoverage.offeringId),
    )
    .innerJoin(
      commerceProviderProfile,
      eq(commerceProviderProfile.organizationId, commerceServiceOffering.providerOrganizationId),
    )
    .innerJoin(
      commerceOrganization,
      eq(commerceOrganization.id, commerceProviderProfile.organizationId),
    )
    .where(
      and(
        eq(commerceServiceOffering.state, "active"),
        inArray(commerceServiceOffering.providerKind, [...FREIGHT_PROVIDER_KINDS]),
        // An offering with no advertised range cannot contribute a number.
        sql`${commerceServiceOffering.indicativePriceMinInCents} IS NOT NULL`,
        sql`${commerceServiceOffering.indicativePriceMaxInCents} IS NOT NULL`,
        // Public eligibility, the same rule every other buyer-facing provider read uses.
        eq(commerceOrganization.tradeState, "active"),
        eq(commerceOrganization.visibility, "public"),
        sql`${commerceProviderProfile.verificationState} NOT IN ('rejected', 'suspended')`,
        originMatches,
        or(
          isNull(commerceServiceCoverage.destinationCountryCode),
          eq(commerceServiceCoverage.destinationCountryCode, input.destinationCountryCode),
        ),
      ),
    )
    .orderBy(asc(commerceServiceOffering.id))
    .limit(MAXIMUM_OFFERINGS_PER_ESTIMATE);

  return rows.flatMap((row) =>
    row.indicativePriceMinInCents === null || row.indicativePriceMaxInCents === null
      ? []
      : [
          {
            offeringId: row.offeringId,
            offeringSlug: row.offeringSlug,
            providerKind: row.providerKind,
            currency: row.currency,
            indicativePriceMinInCents: row.indicativePriceMinInCents,
            indicativePriceMaxInCents: row.indicativePriceMaxInCents,
            minimumLeadTimeDays: row.minimumLeadTimeDays,
            maximumLeadTimeDays: row.maximumLeadTimeDays,
            providerOrganizationSlug: row.providerOrganizationSlug,
            providerDisplayName: row.providerDisplayName,
          },
        ],
  );
}

/**
 * Collapses the covering offerings into one range per currency: the cheapest floor any
 * provider advertises to the dearest ceiling, with the lead-time window to match.
 *
 * The width is the point. A narrow range would read as a price; a range spanning every
 * provider on the route reads as what it is.
 */
export function groupOfferingsIntoEstimates(
  offerings: readonly CoveringOffering[],
  basis: DeliveryEstimateBasis,
): readonly DeliveryEstimateProjection[] {
  const byCurrency = new Map<string, CoveringOffering[]>();
  for (const offering of offerings) {
    const group = byCurrency.get(offering.currency) ?? [];
    group.push(offering);
    byCurrency.set(offering.currency, group);
  }

  return [...byCurrency.entries()]
    .map(([currency, group]) => {
      const leadMinimums = group.flatMap((offering) =>
        offering.minimumLeadTimeDays === null ? [] : [offering.minimumLeadTimeDays],
      );
      const leadMaximums = group.flatMap((offering) =>
        offering.maximumLeadTimeDays === null ? [] : [offering.maximumLeadTimeDays],
      );

      return {
        currency,
        estimatedMinInCents: Math.min(
          ...group.map((offering) => offering.indicativePriceMinInCents),
        ),
        estimatedMaxInCents: Math.max(
          ...group.map((offering) => offering.indicativePriceMaxInCents),
        ),
        leadTimeMinDays: leadMinimums.length > 0 ? Math.min(...leadMinimums) : null,
        leadTimeMaxDays: leadMaximums.length > 0 ? Math.max(...leadMaximums) : null,
        basis,
        derivedFrom: group.map((offering) => ({
          offeringId: offering.offeringId,
          offeringSlug: offering.offeringSlug,
          providerOrganizationSlug: offering.providerOrganizationSlug,
          providerDisplayName: offering.providerDisplayName,
          providerKind: offering.providerKind,
        })),
      };
    })
    .toSorted((left, right) => left.currency.localeCompare(right.currency));
}
