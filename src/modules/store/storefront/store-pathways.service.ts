import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceProductRelation,
  commerceProductVariant,
  storePathway,
  storePathwaySlot,
  storePathwaySlotCandidate,
} from "#src/db/schema.js";
import type { CommerceProductRelationKind } from "#src/modules/store/catalog/commerce-product-relations.service.js";
import {
  resolveEligibleProductCardsByIds,
  type StoreProductCardProjection,
  type StoreStockState,
} from "#src/modules/store/catalog/store-catalog.service.js";
import {
  loadPurchasableProductForCheckout,
  type CommercePricingError,
} from "#src/modules/store/commerce-pricing.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import { merchandisingWindowOpen } from "#src/modules/store/store-merchandising-window.js";
import type { Result } from "#src/types/index.js";

export type StorePathwayError = { type: "NOT_FOUND" } | { type: "INVALID_CURSOR" };

/**
 * A pathway with 200 slots is a legitimate kit and an illegitimate response, so the
 * set read is bounded in three places: how many slots it will consider at all, how
 * many candidates it shows per slot, and how many of those it will PRICE.
 *
 * Pricing is the expensive one — `loadPurchasableProductForCheckout` runs several
 * queries per candidate — so only the top ranks are priced. Deeper alternatives are
 * still projected, marked `unpriced`, which is honest: the set is not claiming a
 * price it did not compute.
 */
const MAXIMUM_SLOTS_PER_PATHWAY = 100;
const MAXIMUM_CANDIDATES_PER_SLOT = 12;
const MAXIMUM_PRICED_CANDIDATES_PER_SLOT = 4;

export type StorePathwaySlotState = "available" | "substituted" | "unavailable";

export type StorePathwayCandidateSourceKind = "curated" | "derived";

/**
 * Why a slot could not be filled. `NO_ELIGIBLE_CANDIDATE` covers "nothing was ever
 * authored here" and "every candidate is a listing a buyer may no longer see"; the
 * pricing tags cover "the product exists and cannot be bought at this quantity".
 */
export type StorePathwaySlotUnavailableReason =
  | { readonly type: "NO_ELIGIBLE_CANDIDATE" }
  | { readonly type: "VARIANT_SELECTION_REQUIRED" }
  | {
      readonly type: "PRICING_FAILED";
      readonly pricingError: CommercePricingError;
    };

/**
 * A candidate's commercial state, as a discriminated union rather than a bag of
 * nullable price fields — `priced` and `unavailable` must not be representable at once.
 */
export type StorePathwayCandidatePricing =
  | {
      readonly status: "priced";
      readonly currency: string;
      readonly unitPriceInCents: number;
      readonly lineTotalInCents: number;
      readonly minimumOrderQuantity: number;
      readonly stockState: StoreStockState;
    }
  | { readonly status: "unpriced" }
  | {
      readonly status: "unavailable";
      readonly pricingError: CommercePricingError;
    }
  /**
   * A derived candidate whose product has active variants. The graph names a product,
   * not a colour, and the server must not pick one on the buyer's behalf — that choice
   * would end up in an immutable order snapshot nobody made.
   */
  | { readonly status: "variant_selection_required" };

export interface StorePathwayCandidateProjection {
  /**
   * Stable across curated and derived candidates so a client can name one back in a
   * cart-seeding selection. Curated rows use their id; derived ones are synthesised,
   * because no row exists to carry an id.
   */
  readonly key: string;
  readonly rank: number;
  readonly sourceKind: StorePathwayCandidateSourceKind;
  /** Non-null only for derived candidates: which edge suggested this product. */
  readonly relationKind: CommerceProductRelationKind | null;
  readonly productId: string;
  readonly variantId: string | null;
  readonly variantName: string | null;
  readonly product: StoreProductCardProjection;
  readonly pricing: StorePathwayCandidatePricing;
}

export interface StorePathwaySlotProjection {
  readonly id: string;
  readonly roleLabel: string;
  readonly isRequired: boolean;
  readonly quantity: number;
  readonly siblingOrder: number;
  readonly derivedRelationKind: CommerceProductRelationKind | null;
  readonly state: StorePathwaySlotState;
  /** The candidate `key` the set currently proposes, or null when nothing can fill it. */
  readonly chosenCandidateKey: string | null;
  readonly unavailableReason: StorePathwaySlotUnavailableReason | null;
  readonly candidates: readonly StorePathwayCandidateProjection[];
}

/**
 * §15.4. One total per currency and no single number: a kit sourced from three
 * countries has three totals, and inventing one would mean converting currencies
 * without an FX quote.
 */
export interface StorePathwayCurrencyTotalProjection {
  readonly currency: string;
  readonly subtotalInCents: number;
  readonly slotCount: number;
}

export interface StorePathwayCardProjection {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly accent: (typeof storePathway.$inferSelect)["accent"];
  readonly cardImageUrl: string | null;
  readonly isAnchored: boolean;
  readonly slotCount: number;
}

export interface StorePathwaySetProjection {
  readonly pathway: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly summary: string | null;
    readonly accent: (typeof storePathway.$inferSelect)["accent"];
    readonly heroImageUrl: string | null;
    readonly cardImageUrl: string | null;
    readonly anchorProduct: StoreProductCardProjection | null;
  };
  readonly slots: readonly StorePathwaySlotProjection[];
  readonly currencyTotals: readonly StorePathwayCurrencyTotalProjection[];
  /** §15.6. "3 of 5 pieces available", computed over EVERY slot, not the page. */
  readonly completeness: {
    readonly slotCount: number;
    readonly requiredSlotCount: number;
    readonly filledRequiredSlotCount: number;
    readonly isComplete: boolean;
  };
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

interface PageInput {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

const publicPathwayEligibility = and(
  eq(storePathway.state, "active"),
  merchandisingWindowOpen(storePathway),
);

function derivedCandidateKey(productId: string): string {
  return `derived:${productId}`;
}

/**
 * Active pathways for the index page, cursor-paginated over `(title, id)`.
 *
 * Replaces the Phase 1 `listPathways`, which returned every active pathway with no
 * limit and no cursor.
 */
export async function listActivePathways(input: PageInput): Promise<
  Result<
    {
      readonly items: readonly StorePathwayCardProjection[];
      readonly page: {
        readonly nextCursor: string | null;
        readonly hasMore: boolean;
      };
    },
    StorePathwayError
  >
> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          gt(storePathway.title, decodedCursor.sortKey),
          and(eq(storePathway.title, decodedCursor.sortKey), gt(storePathway.id, decodedCursor.id)),
        );

  const rows = await db
    .select({
      id: storePathway.id,
      slug: storePathway.slug,
      title: storePathway.title,
      summary: storePathway.summary,
      accent: storePathway.accent,
      cardImageUrl: storePathway.cardImageUrl,
      anchorProductId: storePathway.anchorProductId,
    })
    .from(storePathway)
    .where(and(publicPathwayEligibility, cursorPredicate))
    .orderBy(asc(storePathway.title), asc(storePathway.id))
    // One extra row decides `hasMore` without a second count query.
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const slotCountByPathwayId = await countSlotsByPathwayId(pageRows.map((row) => row.id));

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > input.limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.title, id: lastRow.id })
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        accent: row.accent,
        cardImageUrl: row.cardImageUrl,
        isAnchored: row.anchorProductId !== null,
        slotCount: slotCountByPathwayId.get(row.id) ?? 0,
      })),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

async function countSlotsByPathwayId(pathwayIds: readonly string[]): Promise<Map<string, number>> {
  if (pathwayIds.length === 0) return new Map();

  const rows = await db
    .select({
      pathwayId: storePathwaySlot.pathwayId,
      slotCount: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(storePathwaySlot)
    .where(
      and(
        inArray(storePathwaySlot.pathwayId, [...pathwayIds]),
        merchandisingWindowOpen(storePathwaySlot),
      ),
    )
    .groupBy(storePathwaySlot.pathwayId);

  return new Map(rows.map((row) => [row.pathwayId, row.slotCount]));
}

interface ResolvedCandidateSeed {
  readonly slotId: string;
  readonly key: string;
  readonly rank: number;
  readonly sourceKind: StorePathwayCandidateSourceKind;
  readonly relationKind: CommerceProductRelationKind | null;
  readonly productId: string;
  readonly variantId: string | null;
}

/**
 * The full set read (§15.7): slots in order, ranked candidates, per-currency totals
 * and completeness.
 *
 * Slots are PAGED but totals and completeness are computed over all of them — a
 * page-scoped total would be a different number on every scroll, and a page-scoped
 * completeness would call a five-piece set complete because the page held three.
 */
export async function getPathwaySetBySlug(
  input: { readonly pathwaySlug: string } & PageInput,
): Promise<Result<StorePathwaySetProjection, StorePathwayError>> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }
  /**
   * The slot cursor's sort key is a sibling order, so a well-formed cursor carrying
   * something that is not an integer is still a bad cursor. Rejecting it here keeps a
   * tampered value from silently becoming `NaN` and paging from the start.
   */
  const cursorSiblingOrder = decodedCursor === null ? null : Number(decodedCursor.sortKey);
  if (cursorSiblingOrder !== null && !Number.isInteger(cursorSiblingOrder)) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const [pathwayRow] = await db
    .select({
      id: storePathway.id,
      slug: storePathway.slug,
      title: storePathway.title,
      summary: storePathway.summary,
      accent: storePathway.accent,
      heroImageUrl: storePathway.heroImageUrl,
      cardImageUrl: storePathway.cardImageUrl,
      anchorProductId: storePathway.anchorProductId,
    })
    .from(storePathway)
    .where(and(eq(storePathway.slug, input.pathwaySlug), publicPathwayEligibility))
    .limit(1);

  if (!pathwayRow) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const slotRows = await db
    .select({
      id: storePathwaySlot.id,
      roleLabel: storePathwaySlot.roleLabel,
      isRequired: storePathwaySlot.isRequired,
      quantity: storePathwaySlot.quantity,
      siblingOrder: storePathwaySlot.siblingOrder,
      derivedRelationKind: storePathwaySlot.derivedRelationKind,
    })
    .from(storePathwaySlot)
    .where(
      and(eq(storePathwaySlot.pathwayId, pathwayRow.id), merchandisingWindowOpen(storePathwaySlot)),
    )
    .orderBy(asc(storePathwaySlot.siblingOrder), asc(storePathwaySlot.id))
    .limit(MAXIMUM_SLOTS_PER_PATHWAY);

  const candidateSeeds = await resolveCandidateSeeds(slotRows, pathwayRow.anchorProductId);

  const productIds = [
    ...new Set([
      ...candidateSeeds.map((seed) => seed.productId),
      ...(pathwayRow.anchorProductId === null ? [] : [pathwayRow.anchorProductId]),
    ]),
  ];
  const [productCards, variantNameById] = await Promise.all([
    resolveEligibleProductCardsByIds(productIds),
    loadVariantNames(candidateSeeds.map((seed) => seed.variantId)),
  ]);
  const productCardById = new Map(productCards.map((card) => [card.id, card]));

  const seedsBySlotId = new Map<string, ResolvedCandidateSeed[]>();
  for (const seed of candidateSeeds) {
    // A candidate whose product is draft, suspended or unapproved is not shown at
    // all — but its SLOT still is (§15.6). Dropping the slot is what turned a
    // five-piece look into a silent three-piece one.
    if (!productCardById.has(seed.productId)) continue;
    const seeds = seedsBySlotId.get(seed.slotId) ?? [];
    if (seeds.length >= MAXIMUM_CANDIDATES_PER_SLOT) continue;
    seeds.push(seed);
    seedsBySlotId.set(seed.slotId, seeds);
  }

  const slots = await Promise.all(
    slotRows.map(async (slotRow) =>
      projectSlot({
        slotRow,
        seeds: seedsBySlotId.get(slotRow.id) ?? [],
        productCardById,
        variantNameById,
      }),
    ),
  );

  const requiredSlots = slots.filter((slot) => slot.isRequired);
  const filledRequiredSlotCount = requiredSlots.filter(
    (slot) => slot.state !== "unavailable",
  ).length;

  const currencyTotals = aggregateCurrencyTotals(slots);

  const pagedSlots = paginateSlots(slots, {
    limit: input.limit,
    afterSiblingOrder: cursorSiblingOrder,
    afterId: decodedCursor?.id ?? null,
  });

  return {
    success: true,
    value: {
      pathway: {
        id: pathwayRow.id,
        slug: pathwayRow.slug,
        title: pathwayRow.title,
        summary: pathwayRow.summary,
        accent: pathwayRow.accent,
        heroImageUrl: pathwayRow.heroImageUrl,
        cardImageUrl: pathwayRow.cardImageUrl,
        anchorProduct:
          pathwayRow.anchorProductId === null
            ? null
            : (productCardById.get(pathwayRow.anchorProductId) ?? null),
      },
      slots: pagedSlots.items,
      currencyTotals,
      completeness: {
        slotCount: slots.length,
        requiredSlotCount: requiredSlots.length,
        filledRequiredSlotCount,
        isComplete: filledRequiredSlotCount === requiredSlots.length,
      },
      page: pagedSlots.page,
    },
  };
}

/**
 * Curated candidates come from the table; derived ones are read from the relation
 * graph against the pathway's anchor and are NEVER stored — a stored copy would be
 * stale the moment a seller edits the graph (§15.3, §15.9).
 */
async function resolveCandidateSeeds(
  slotRows: readonly {
    readonly id: string;
    readonly derivedRelationKind: CommerceProductRelationKind | null;
  }[],
  anchorProductId: string | null,
): Promise<readonly ResolvedCandidateSeed[]> {
  if (slotRows.length === 0) return [];

  const curatedRows = await db
    .select({
      id: storePathwaySlotCandidate.id,
      slotId: storePathwaySlotCandidate.slotId,
      productId: storePathwaySlotCandidate.productId,
      variantId: storePathwaySlotCandidate.variantId,
      rank: storePathwaySlotCandidate.rank,
    })
    .from(storePathwaySlotCandidate)
    .where(
      inArray(
        storePathwaySlotCandidate.slotId,
        slotRows.map((slotRow) => slotRow.id),
      ),
    )
    .orderBy(asc(storePathwaySlotCandidate.rank), asc(storePathwaySlotCandidate.id));

  const seeds: ResolvedCandidateSeed[] = curatedRows.map((row) => ({
    slotId: row.slotId,
    key: row.id,
    rank: row.rank,
    sourceKind: "curated",
    relationKind: null,
    productId: row.productId,
    variantId: row.variantId,
  }));

  const derivedSlotRows = slotRows.filter((slotRow) => slotRow.derivedRelationKind !== null);
  if (anchorProductId === null || derivedSlotRows.length === 0) {
    return seeds;
  }

  const relationKinds = [
    ...new Set(
      derivedSlotRows.flatMap((slotRow) =>
        slotRow.derivedRelationKind === null ? [] : [slotRow.derivedRelationKind],
      ),
    ),
  ];

  const relationRows = await db
    .select({
      toProductId: commerceProductRelation.toProductId,
      relationKind: commerceProductRelation.relationKind,
      rank: commerceProductRelation.rank,
    })
    .from(commerceProductRelation)
    .where(
      and(
        eq(commerceProductRelation.fromProductId, anchorProductId),
        inArray(commerceProductRelation.relationKind, relationKinds),
        // §15.8: a dismissed claim is suppressed from every buyer-facing surface, and a pathway
        // slot is one — otherwise a refused edge keeps filling merchandising slots.
        isNull(commerceProductRelation.dismissedAt),
      ),
    )
    .orderBy(asc(commerceProductRelation.rank), asc(commerceProductRelation.id));

  const curatedProductIdsBySlotId = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const productIds = curatedProductIdsBySlotId.get(seed.slotId) ?? new Set<string>();
    productIds.add(seed.productId);
    curatedProductIdsBySlotId.set(seed.slotId, productIds);
  }

  for (const slotRow of derivedSlotRows) {
    const curatedProductIds = curatedProductIdsBySlotId.get(slotRow.id) ?? new Set<string>();
    // Derived candidates are appended AFTER curated ones: a merchandiser's explicit
    // choice outranks a graph suggestion for the same role.
    const curatedCount = seeds.filter((seed) => seed.slotId === slotRow.id).length;
    let derivedIndex = 0;
    for (const relationRow of relationRows) {
      if (relationRow.relationKind !== slotRow.derivedRelationKind) continue;
      if (curatedProductIds.has(relationRow.toProductId)) continue;
      seeds.push({
        slotId: slotRow.id,
        key: derivedCandidateKey(relationRow.toProductId),
        rank: curatedCount + derivedIndex,
        sourceKind: "derived",
        relationKind: relationRow.relationKind,
        productId: relationRow.toProductId,
        variantId: null,
      });
      derivedIndex += 1;
      if (derivedIndex >= MAXIMUM_CANDIDATES_PER_SLOT) break;
    }
  }

  return seeds;
}

async function loadVariantNames(
  variantIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const presentIds = [...new Set(variantIds.filter((id): id is string => id !== null))];
  if (presentIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: commerceProductVariant.id,
      name: commerceProductVariant.name,
    })
    .from(commerceProductVariant)
    .where(inArray(commerceProductVariant.id, presentIds));

  return new Map(rows.map((row) => [row.id, row.name]));
}

async function projectSlot(input: {
  readonly slotRow: {
    readonly id: string;
    readonly roleLabel: string;
    readonly isRequired: boolean;
    readonly quantity: number;
    readonly siblingOrder: number;
    readonly derivedRelationKind: CommerceProductRelationKind | null;
  };
  readonly seeds: readonly ResolvedCandidateSeed[];
  readonly productCardById: ReadonlyMap<string, StoreProductCardProjection>;
  readonly variantNameById: ReadonlyMap<string, string>;
}): Promise<StorePathwaySlotProjection> {
  const orderedSeeds = input.seeds.toSorted(
    (left, right) => left.rank - right.rank || left.key.localeCompare(right.key),
  );

  const candidates: StorePathwayCandidateProjection[] = [];
  let chosenCandidateKey: string | null = null;
  let firstPricingFailure: CommercePricingError | null = null;
  let sawVariantSelectionRequired = false;

  for (const [seedIndex, seed] of orderedSeeds.entries()) {
    const productCard = input.productCardById.get(seed.productId);
    // Filtered out above; the guard keeps this function total rather than throwing.
    if (productCard === undefined) continue;

    const pricing = await priceCandidate({
      seed,
      quantity: input.slotRow.quantity,
      shouldPrice: seedIndex < MAXIMUM_PRICED_CANDIDATES_PER_SLOT,
      productCard,
    });

    if (pricing.status === "unavailable" && firstPricingFailure === null) {
      firstPricingFailure = pricing.pricingError;
    }
    if (pricing.status === "variant_selection_required") {
      sawVariantSelectionRequired = true;
    }
    if (pricing.status === "priced" && chosenCandidateKey === null) {
      chosenCandidateKey = seed.key;
    }

    candidates.push({
      key: seed.key,
      rank: seed.rank,
      sourceKind: seed.sourceKind,
      relationKind: seed.relationKind,
      productId: seed.productId,
      variantId: seed.variantId,
      variantName:
        seed.variantId === null ? null : (input.variantNameById.get(seed.variantId) ?? null),
      product: productCard,
      pricing,
    });
  }

  const state = deriveSlotState({ candidates, chosenCandidateKey });

  return {
    id: input.slotRow.id,
    roleLabel: input.slotRow.roleLabel,
    isRequired: input.slotRow.isRequired,
    quantity: input.slotRow.quantity,
    siblingOrder: input.slotRow.siblingOrder,
    derivedRelationKind: input.slotRow.derivedRelationKind,
    state,
    chosenCandidateKey,
    unavailableReason:
      state !== "unavailable"
        ? null
        : deriveUnavailableReason({
            candidateCount: candidates.length,
            firstPricingFailure,
            sawVariantSelectionRequired,
          }),
    candidates,
  };
}

async function priceCandidate(input: {
  readonly seed: ResolvedCandidateSeed;
  readonly quantity: number;
  readonly shouldPrice: boolean;
  readonly productCard: StoreProductCardProjection;
}): Promise<StorePathwayCandidatePricing> {
  /**
   * A derived candidate names a product, not a variant, so a variant-bearing product
   * cannot be auto-filled. Saying so is the honest answer; picking a colour on the
   * buyer's behalf would put a choice nobody made into an order snapshot.
   */
  if (input.seed.variantId === null && input.productCard.hasVariants) {
    return { status: "variant_selection_required" };
  }
  if (!input.shouldPrice) {
    return { status: "unpriced" };
  }

  const priced = await loadPurchasableProductForCheckout(
    db,
    input.seed.productId,
    input.quantity,
    0,
    input.seed.variantId,
  );
  if (!priced.success) {
    return { status: "unavailable", pricingError: priced.error };
  }

  return {
    status: "priced",
    currency: priced.value.currency,
    unitPriceInCents: priced.value.unitPriceInCents,
    lineTotalInCents: priced.value.lineTotalInCents,
    minimumOrderQuantity: priced.value.minimumOrderQuantity,
    stockState: priced.value.isMadeToOrder ? "made_to_order" : input.productCard.stockState,
  };
}

/**
 * §15.6. `substituted` is the whole point of ranked candidates: rank 0 failing is not
 * the set failing, and the buyer deserves to know a swap happened rather than seeing
 * a silently different product.
 */
export function deriveSlotState(input: {
  readonly candidates: readonly { readonly key: string }[];
  readonly chosenCandidateKey: string | null;
}): StorePathwaySlotState {
  if (input.chosenCandidateKey === null) return "unavailable";
  return input.candidates[0]?.key === input.chosenCandidateKey ? "available" : "substituted";
}

function deriveUnavailableReason(input: {
  readonly candidateCount: number;
  readonly firstPricingFailure: CommercePricingError | null;
  readonly sawVariantSelectionRequired: boolean;
}): StorePathwaySlotUnavailableReason {
  if (input.firstPricingFailure !== null) {
    return { type: "PRICING_FAILED", pricingError: input.firstPricingFailure };
  }
  if (input.sawVariantSelectionRequired) {
    return { type: "VARIANT_SELECTION_REQUIRED" };
  }
  return { type: "NO_ELIGIBLE_CANDIDATE" };
}

/** §15.4. Derived at read time from what the set currently proposes, never stored. */
export function aggregateCurrencyTotals(
  slots: readonly StorePathwaySlotProjection[],
): readonly StorePathwayCurrencyTotalProjection[] {
  const totalsByCurrency = new Map<string, { subtotalInCents: number; slotCount: number }>();

  for (const slot of slots) {
    const chosen = slot.candidates.find((candidate) => candidate.key === slot.chosenCandidateKey);
    if (chosen === undefined || chosen.pricing.status !== "priced") continue;
    const running = totalsByCurrency.get(chosen.pricing.currency) ?? {
      subtotalInCents: 0,
      slotCount: 0,
    };
    totalsByCurrency.set(chosen.pricing.currency, {
      subtotalInCents: running.subtotalInCents + chosen.pricing.lineTotalInCents,
      slotCount: running.slotCount + 1,
    });
  }

  return [...totalsByCurrency.entries()]
    .map(([currency, running]) => ({
      currency,
      subtotalInCents: running.subtotalInCents,
      slotCount: running.slotCount,
    }))
    .toSorted((left, right) => left.currency.localeCompare(right.currency));
}

/**
 * Slots are paged in memory rather than in SQL because completeness and totals need
 * every slot anyway, and the set is bounded at {@link MAXIMUM_SLOTS_PER_PATHWAY}.
 * The cursor still ends in a unique id so equal sibling orders cannot skip a slot.
 */
function paginateSlots(
  slots: readonly StorePathwaySlotProjection[],
  input: {
    readonly limit: number;
    readonly afterSiblingOrder: number | null;
    readonly afterId: string | null;
  },
): {
  readonly items: readonly StorePathwaySlotProjection[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
} {
  const afterSiblingOrder = input.afterSiblingOrder;
  const afterId = input.afterId;
  const remaining =
    afterSiblingOrder === null || afterId === null
      ? slots
      : slots.filter(
          (slot) =>
            slot.siblingOrder > afterSiblingOrder ||
            (slot.siblingOrder === afterSiblingOrder && slot.id > afterId),
        );

  const items = remaining.slice(0, input.limit);
  const lastItem = items[items.length - 1];
  const nextCursor =
    remaining.length > items.length && lastItem
      ? encodeStoreCursor({
          sortKey: String(lastItem.siblingOrder),
          id: lastItem.id,
        })
      : null;

  return { items, page: { nextCursor, hasMore: nextCursor !== null } };
}
