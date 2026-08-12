import { describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("dotenv/config", () => ({}));

const { aggregateCurrencyTotals, deriveSlotState } =
  await import("#src/modules/store/storefront/store-pathways.service.js");

type SlotProjection = Parameters<typeof aggregateCurrencyTotals>[0][number];
type ProductCard = SlotProjection["candidates"][number]["product"];

/**
 * Built in full rather than asserted from `{}`: the card is irrelevant to the two pure
 * functions under test, but a type assertion here would be the one place in this suite
 * that lies about a shape, and it costs nothing to be honest.
 */
function buildProductCard(key: string): ProductCard {
  return {
    id: `product_${key}`,
    publicSlug: `product-${key}`,
    title: `Product ${key}`,
    brand: null,
    currency: "USD",
    priceInCents: 1000,
    compareAtPriceInCents: null,
    minimumOrderQuantity: 1,
    stockState: "in_stock",
    hasVariants: false,
    variantCount: 0,
    condition: "new",
    samplePolicy: "unavailable",
    leadTimeMinDays: null,
    leadTimeMaxDays: null,
    mainImageUrl: null,
    seller: {
      organizationId: "commerce_org_seller",
      slug: "seller",
      displayName: "Seller",
      countryCode: "IN",
      logoUrl: null,
      summary: null,
    },
    category: { id: "cat_1", slug: "lighting", name: "Lighting" },
    reviewMetrics: { averageRating: null, reviewCount: 0 },
    fulfillmentMetrics: { onTimeShipmentRate: null, onTimeSampleSize: 0, completedOrderCount: 0 },
  };
}

function buildCandidate(input: {
  readonly key: string;
  readonly currency?: string;
  readonly lineTotalInCents?: number;
  readonly status?: "priced" | "unpriced" | "unavailable" | "variant_selection_required";
}): SlotProjection["candidates"][number] {
  const status = input.status ?? "priced";
  const pricing =
    status === "priced"
      ? ({
          status: "priced",
          currency: input.currency ?? "USD",
          unitPriceInCents: input.lineTotalInCents ?? 1000,
          lineTotalInCents: input.lineTotalInCents ?? 1000,
          minimumOrderQuantity: 1,
          stockState: "in_stock",
        } as const)
      : status === "unavailable"
        ? ({ status: "unavailable", pricingError: { type: "INSUFFICIENT_STOCK", availableQuantity: 0 } } as const)
        : status === "variant_selection_required"
          ? ({ status: "variant_selection_required" } as const)
          : ({ status: "unpriced" } as const);

  return {
    key: input.key,
    rank: 0,
    sourceKind: "curated",
    relationKind: null,
    productId: `product_${input.key}`,
    variantId: null,
    variantName: null,
    // The card is irrelevant to the two pure functions under test.
    product: buildProductCard(input.key),
    pricing,
  };
}

function buildSlot(input: {
  readonly id: string;
  readonly candidates: readonly SlotProjection["candidates"][number][];
  readonly chosenCandidateKey: string | null;
}): SlotProjection {
  return {
    id: input.id,
    roleLabel: "Front light",
    isRequired: true,
    quantity: 1,
    siblingOrder: 0,
    derivedRelationKind: null,
    state: input.chosenCandidateKey === null ? "unavailable" : "available",
    chosenCandidateKey: input.chosenCandidateKey,
    unavailableReason: null,
    candidates: input.candidates,
  };
}

describe("guided pathway slot state (§15.6)", () => {
  it("is available when the set proposes its own first choice", () => {
    expect(
      deriveSlotState({
        candidates: [{ key: "candidate_a" }, { key: "candidate_b" }],
        chosenCandidateKey: "candidate_a",
      }),
    ).toBe("available");
  });

  it("is substituted when the first choice fell through to a lower rank", () => {
    expect(
      deriveSlotState({
        candidates: [{ key: "candidate_a" }, { key: "candidate_b" }],
        chosenCandidateKey: "candidate_b",
      }),
    ).toBe("substituted");
  });

  it("is unavailable when nothing can fill it, rather than the slot disappearing", () => {
    expect(deriveSlotState({ candidates: [{ key: "candidate_a" }], chosenCandidateKey: null })).toBe("unavailable");
    // A slot with no candidates at all is still a slot: an absent slot and a slot with
    // nothing in it are different facts, and only the second one is true.
    expect(deriveSlotState({ candidates: [], chosenCandidateKey: null })).toBe("unavailable");
  });
});

describe("guided pathway set totals (§15.4)", () => {
  it("totals only what the set currently proposes, per currency", () => {
    const totals = aggregateCurrencyTotals([
      buildSlot({
        id: "slot_1",
        chosenCandidateKey: "candidate_a",
        candidates: [
          buildCandidate({ key: "candidate_a", currency: "USD", lineTotalInCents: 2500 }),
          // Not chosen, so its price must not reach the total.
          buildCandidate({ key: "candidate_b", currency: "USD", lineTotalInCents: 9900 }),
        ],
      }),
      buildSlot({
        id: "slot_2",
        chosenCandidateKey: "candidate_c",
        candidates: [buildCandidate({ key: "candidate_c", currency: "USD", lineTotalInCents: 500 })],
      }),
    ]);

    expect(totals).toEqual([{ currency: "USD", subtotalInCents: 3000, slotCount: 2 }]);
  });

  it("returns one total per currency and never converts between them", () => {
    const totals = aggregateCurrencyTotals([
      buildSlot({
        id: "slot_1",
        chosenCandidateKey: "candidate_a",
        candidates: [buildCandidate({ key: "candidate_a", currency: "USD", lineTotalInCents: 1000 })],
      }),
      buildSlot({
        id: "slot_2",
        chosenCandidateKey: "candidate_b",
        candidates: [buildCandidate({ key: "candidate_b", currency: "INR", lineTotalInCents: 7000 })],
      }),
    ]);

    expect(totals).toEqual([
      { currency: "INR", subtotalInCents: 7000, slotCount: 1 },
      { currency: "USD", subtotalInCents: 1000, slotCount: 1 },
    ]);
  });

  it("excludes unfillable and unpriced slots from every total", () => {
    const totals = aggregateCurrencyTotals([
      buildSlot({
        id: "slot_1",
        chosenCandidateKey: "candidate_a",
        candidates: [buildCandidate({ key: "candidate_a", currency: "USD", lineTotalInCents: 1200 })],
      }),
      buildSlot({
        id: "slot_2",
        chosenCandidateKey: null,
        candidates: [buildCandidate({ key: "candidate_b", status: "unavailable" })],
      }),
      buildSlot({
        id: "slot_3",
        chosenCandidateKey: "candidate_c",
        candidates: [buildCandidate({ key: "candidate_c", status: "unpriced" })],
      }),
    ]);

    expect(totals).toEqual([{ currency: "USD", subtotalInCents: 1200, slotCount: 1 }]);
  });

  it("has no total at all when the set can fill nothing", () => {
    expect(
      aggregateCurrencyTotals([
        buildSlot({
          id: "slot_1",
          chosenCandidateKey: null,
          candidates: [buildCandidate({ key: "candidate_a", status: "variant_selection_required" })],
        }),
      ]),
    ).toEqual([]);
  });
});
