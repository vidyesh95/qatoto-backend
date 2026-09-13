/**
 * Gives the teardown arm's `storeProductClass` a real store category to point at, and one demo
 * listing under each, so the market-signal band on a teardown page has something to show.
 *
 *   pnpm db:seed-blueprint-store-categories
 *
 * ⚠️ WITHOUT THIS, THE MARKET SIGNAL IS CORRECT AND ALWAYS EMPTY. `teardown.store_product_class_category_slug`
 * is free text with a slug shape and NO foreign key — deliberately, for
 * `built_from_blueprint_slug`'s reason: a publisher may name a class the store does not carry yet,
 * and an FK would refuse the pick. The consequence is that the join can legitimately resolve to
 * nothing, and it did: the seeded teardowns name `solar-refrigeration`, `borehole-pumps`,
 * `battery-management-modules`, `dairy-cooling` and `agricultural-instruments`, and
 * `commerce_category` carried none of them.
 *
 * ⚠️ FIVE, NOT THREE. The three names that appear in the frontend fixture file are the ones a
 * reader notices; the database holds five distinct classes across the twelve seeded teardowns.
 * Seeding the visible three would have left two teardowns with a band that never fills and no
 * indication why.
 *
 * CHILDREN OF `machinery`, NOT NEW ROOTS, and the choice costs nothing to undo. A root renders in
 * the home rail and would need tile art — `commerce_category.image_url` is nullable, and a child
 * is not rendered there, so this script needs no Cloudinary credentials at all. The store's eight
 * roots are inserted by migration 0098; these are a seed, like every other blueprint fixture.
 *
 * ⚠️ `product.category` IS THE LEGACY ENUM AND IS NOT THE TAXONOMY. It carries eight values, none
 * of them `machinery`, while `product.category_id` is the real foreign key into
 * `commerce_category`. Each listing below picks the closest of the eight and files itself under
 * the right `category_id`; the search document reads the id, which is what the market signal
 * queries.
 *
 * IDEMPOTENT. Categories and products are `onConflictDoNothing` on their natural keys, so a second
 * run is a no-op and never overwrites an edit somebody made through the admin surface.
 *
 * REQUIRES `pnpm db:seed-store-demo` to have run — it reuses that seller organization rather than
 * inventing a second one, because a demo store with two unrelated sellers is harder to read than
 * one with a few more listings.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import { commerceCategory, commerceOrganization, product } from "#src/db/schema.js";
import { refreshProductSearchDocument } from "#src/modules/store/catalog/store-search.service.js";

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";

interface BlueprintProductClass {
  /** Must match `teardown.store_product_class_category_slug` exactly — that is the join key. */
  readonly categorySlug: string;
  readonly categoryName: string;
  /** The closest of the eight legacy enum values. Not the taxonomy; see the file docblock. */
  readonly legacyCategory: "electronics" | "home_kitchen" | "sports_outdoors";
  readonly listings: readonly {
    readonly slug: string;
    readonly title: string;
    readonly priceInCents: number;
  }[];
}

const PRODUCT_CLASSES: readonly BlueprintProductClass[] = [
  {
    categorySlug: "solar-refrigeration",
    categoryName: "Solar refrigeration",
    legacyCategory: "home_kitchen",
    listings: [
      {
        slug: "bp-solar-chest-fridge-120l",
        title: "120 L solar chest refrigerator",
        priceInCents: 78_000_00,
      },
      {
        slug: "bp-solar-vaccine-cooler",
        title: "Solar vaccine cooler, WHO PQS listed",
        priceInCents: 142_500_00,
      },
    ],
  },
  {
    categorySlug: "borehole-pumps",
    categoryName: "Borehole pumps",
    legacyCategory: "sports_outdoors",
    listings: [
      {
        slug: "bp-borehole-pump-4in-1hp",
        title: '4" borehole pump, 1 HP, stainless',
        priceInCents: 31_900_00,
      },
      {
        slug: "bp-borehole-pump-solar-kit",
        title: "Solar borehole pump kit with controller",
        priceInCents: 96_400_00,
      },
    ],
  },
  {
    categorySlug: "battery-management-modules",
    categoryName: "Battery management modules",
    legacyCategory: "electronics",
    listings: [
      {
        slug: "bp-bms-16s-100a",
        title: "16S 100 A battery management module",
        priceInCents: 8_900_00,
      },
      { slug: "bp-bms-8s-60a-can", title: "8S 60 A BMS with CAN bus", priceInCents: 6_200_00 },
    ],
  },
  {
    categorySlug: "dairy-cooling",
    categoryName: "Dairy cooling",
    legacyCategory: "home_kitchen",
    listings: [
      { slug: "bp-milk-chiller-500l", title: "500 L bulk milk chiller", priceInCents: 210_000_00 },
    ],
  },
  {
    categorySlug: "agricultural-instruments",
    categoryName: "Agricultural instruments",
    legacyCategory: "electronics",
    listings: [
      {
        slug: "bp-soil-moisture-probe",
        title: "Capacitive soil moisture probe, RS-485",
        priceInCents: 4_400_00,
      },
    ],
  },
];

async function main(): Promise<void> {
  const [parentCategory] = await db
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(eq(commerceCategory.slug, "machinery"));
  if (!parentCategory) {
    console.error("The `machinery` root category is missing. Run `pnpm db:migrate` first.");
    process.exit(1);
  }

  const [sellerOrganization] = await db
    .select({ id: commerceOrganization.id })
    .from(commerceOrganization)
    .where(eq(commerceOrganization.id, SELLER_ORGANIZATION_ID));
  if (!sellerOrganization) {
    console.error(
      "The demo seller organization is missing. Run `pnpm db:seed-store-demo` first — this script reuses it rather than inventing a second seller.",
    );
    process.exit(1);
  }

  /*
   * ⚠️ THE AUTHOR IS TAKEN FROM AN EXISTING LISTING, not from the organization. `product.created_by_user_id`
   * is a real foreign key into `user`, and `commerce_organization` carries no owner column — so the
   * only account guaranteed to be a legitimate author for this org is one that has already authored
   * for it. Inventing an id here would be a 23503 at the first insert.
   */
  const [existingListing] = await db
    .select({ createdByUserId: product.createdByUserId })
    .from(product)
    .where(eq(product.sellerOrganizationId, sellerOrganization.id))
    .limit(1);
  if (!existingListing) {
    console.error(
      "The demo seller has no listings to borrow an author from. Run `pnpm db:seed-store-demo` first.",
    );
    process.exit(1);
  }
  const sellerUserId = existingListing.createdByUserId;

  // Sibling order is unique per parent, so continue from whatever is already under `machinery`.
  const [siblingRow] = await db
    .select({
      highest: sql<number>`coalesce(max(${commerceCategory.siblingOrder}), -1)`.mapWith(Number),
    })
    .from(commerceCategory)
    .where(eq(commerceCategory.parentCategoryId, parentCategory.id));
  let nextSiblingOrder = (siblingRow?.highest ?? -1) + 1;

  let createdCategoryCount = 0;
  let createdProductCount = 0;
  const refreshedProductIds: string[] = [];

  for (const productClass of PRODUCT_CLASSES) {
    const categoryId = `bp_cat_${productClass.categorySlug.replaceAll("-", "_")}`;

    const insertedCategory = await db
      .insert(commerceCategory)
      .values({
        id: categoryId,
        slug: productClass.categorySlug,
        name: productClass.categoryName,
        parentCategoryId: parentCategory.id,
        siblingOrder: nextSiblingOrder,
        state: "active",
        // Nullable, and left NULL on purpose: a child does not render in the home rail, so this
        // script never needs Cloudinary.
        imageUrl: null,
      })
      .onConflictDoNothing()
      .returning({ id: commerceCategory.id });
    if (insertedCategory.length > 0) {
      createdCategoryCount += 1;
      nextSiblingOrder += 1;
    }

    const [storedCategory] = await db
      .select({ id: commerceCategory.id })
      .from(commerceCategory)
      .where(eq(commerceCategory.slug, productClass.categorySlug));
    if (!storedCategory) continue;

    for (const listing of productClass.listings) {
      const productId = `bp_prod_${listing.slug.replaceAll("-", "_")}`;
      const insertedProduct = await db
        .insert(product)
        .values({
          id: productId,
          sellerOrganizationId: sellerOrganization.id,
          createdByUserId: sellerUserId,
          title: listing.title,
          brand: "Blueprint Demo",
          description:
            "Seeded by db:seed-blueprint-store-categories so a teardown's market-signal band has a real listing to name. Not a real listing.",
          category: productClass.legacyCategory,
          categoryId: storedCategory.id,
          priceInCents: listing.priceInCents,
          currency: "USD",
          stockQuantity: 250,
          status: "active",
          moderationState: "approved",
          publicSlug: listing.slug,
          publishedAt: new Date(),
          samplePolicy: "unavailable",
          samplePriceInCents: null,
          leadTimeMinDays: 21,
          leadTimeMaxDays: 45,
          packageLengthMm: 900,
          packageWidthMm: 600,
          packageHeightMm: 1_100,
          packageGrossWeightGrams: 45_000,
          unitsPerPackage: 1,
        })
        .onConflictDoNothing()
        .returning({ id: product.id });
      if (insertedProduct.length > 0) createdProductCount += 1;
      refreshedProductIds.push(productId);
    }
  }

  /*
   * ⚠️ THE SEARCH DOCUMENT IS WHAT THE MARKET SIGNAL READS, and it is maintained by a JOB. A seed
   * that inserted products and stopped would leave `store_search_document` without them, and the
   * band would stay empty for a reason no amount of reading the endpoint would explain.
   */
  for (const productId of refreshedProductIds) {
    await refreshProductSearchDocument(productId);
  }

  console.log(
    `Categories created: ${String(createdCategoryCount)} (of ${String(PRODUCT_CLASSES.length)})`,
  );
  console.log(
    `Listings created:   ${String(createdProductCount)} (of ${String(refreshedProductIds.length)})`,
  );
  console.log(`Search documents refreshed: ${String(refreshedProductIds.length)}`);
  console.log(
    "\nEvery `storeProductClass` the seeded teardowns name now resolves to a real category.",
  );
}

main()
  .then(async () => {
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Blueprint store category seeding failed:", error);
    await pool.end();
    process.exit(1);
  });
