/**
 * Seeds a complete demo store into an empty database.
 *
 *   pnpm run db:seed-store-demo
 *
 * WHY THIS EXISTS. The smoke sections of every `docs/STORE_PHASE_*_ROLLOUT.md` describe
 * curl flows against a seller organization, a buyer organization, products, categories
 * and provider coverage — none of which any migration creates. Without this script those
 * sections are prose nobody can execute, which is how a rollout doc quietly stops being
 * true. `scripts/smoke-store-phases-9-11.ts` runs against what this creates.
 *
 * IDEMPOTENT, and `ON CONFLICT DO NOTHING` throughout rather than `DO UPDATE` — the house
 * rule every other seed follows. A seed that overwrites is a seed that reverts whatever
 * an operator edited by hand.
 *
 * NOT FOR PRODUCTION. Every identity here has a published password.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  commerceCategory,
  commerceOrganization,
  commerceOrganizationAddress,
  commerceOrganizationMember,
  commerceProductCustomizationOption,
  commerceProductStats,
  commerceProductVariant,
  commerceProviderKindLink,
  commerceProviderProfile,
  commerceServiceCoverage,
  commerceServiceOffering,
  freightOfferingDetail,
  product,
  productPricingTier,
  storeHeroSlide,
  storePathway,
  storePathwaySlot,
  storePathwaySlotCandidate,
  storeRail,
  storeRailPlacement,
  user,
} from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";
import {
  encryptCommercePii,
  isCommercePiiEncryptionConfigured,
} from "#src/lib/commerce-pii-encryption.js";
import { refreshProductSearchDocument } from "#src/services/store-search.service.js";

/**
 * Fixed ids, so a rerun is a no-op and a teardown is one `LIKE 'store_demo_%'`. The
 * password is deliberately in the source: the smoke script has to sign these accounts in,
 * and a secret nobody can read is not a secret, it is a broken fixture.
 */
const DEMO_PASSWORD = "store-demo-password-2026";

const DEMO_USERS = [
  { key: "seller", email: "store-demo-seller@example.invalid", name: "Demo Seller" },
  { key: "buyer", email: "store-demo-buyer@example.invalid", name: "Demo Buyer" },
  { key: "provider", email: "store-demo-provider@example.invalid", name: "Demo Provider" },
  /**
   * A FOURTH, SEPARATE identity. `transitionTradeState` refuses to let the creator of an
   * organization approve it, so a demo that moderates anything needs a moderator who did
   * not create the thing being moderated.
   */
  { key: "staff", email: "store-demo-staff@example.invalid", name: "Demo Staff" },
] as const;

type DemoUserKey = (typeof DEMO_USERS)[number]["key"];

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const PROVIDER_ORGANIZATION_ID = "store_demo_org_provider";

const CHAIR_PRODUCT_ID = "store_demo_product_chair";
const LAMP_PRODUCT_ID = "store_demo_product_lamp";
const RUG_PRODUCT_ID = "store_demo_product_rug";

async function ensureDemoUsers(): Promise<Record<DemoUserKey, string>> {
  const userIdByKey = new Map<DemoUserKey, string>();

  for (const demoUser of DEMO_USERS) {
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, demoUser.email))
      .limit(1);
    if (existing) {
      userIdByKey.set(demoUser.key, existing.id);
      continue;
    }

    /**
     * Through Better Auth rather than a hand-written `user` + `account` pair, so the
     * credential is a real argon2 hash the sign-in route accepts. Inserting the rows
     * directly would produce an account that exists and cannot log in.
     */
    await auth.api.signUpEmail({
      body: { email: demoUser.email, password: DEMO_PASSWORD, name: demoUser.name },
    });
    const [created] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, demoUser.email))
      .limit(1);
    if (!created) throw new Error(`Demo user ${demoUser.email} was not created.`);
    userIdByKey.set(demoUser.key, created.id);
  }

  /**
   * Named explicitly rather than assembled from entries: every id here is a foreign key
   * on rows created below, and a missing one should fail with the account it belongs to
   * rather than with a null violation three functions later.
   */
  const requireUserId = (key: DemoUserKey): string => {
    const userId = userIdByKey.get(key);
    if (userId === undefined) throw new Error(`Demo user "${key}" is missing an id.`);
    return userId;
  };

  return {
    seller: requireUserId("seller"),
    buyer: requireUserId("buyer"),
    provider: requireUserId("provider"),
    staff: requireUserId("staff"),
  };
}

/** Grants the staff identity `moderate_commerce` by way of the platform moderator role. */
async function ensureStaffPlatformRole(staffUserId: string): Promise<void> {
  await db.update(user).set({ platformRole: "moderator" }).where(eq(user.id, staffUserId));
}

async function ensureOrganizations(userIdByKey: Record<DemoUserKey, string>): Promise<void> {
  const organizations = [
    {
      id: SELLER_ORGANIZATION_ID,
      slug: "store-demo-furnishings",
      legalName: "Store Demo Furnishings Private Limited",
      displayName: "Store Demo Furnishings",
      createdByUserId: userIdByKey.seller,
    },
    {
      id: BUYER_ORGANIZATION_ID,
      slug: "store-demo-hotels",
      legalName: "Store Demo Hotels Private Limited",
      displayName: "Store Demo Hotels",
      createdByUserId: userIdByKey.buyer,
    },
    {
      id: PROVIDER_ORGANIZATION_ID,
      slug: "store-demo-freight",
      legalName: "Store Demo Freight Private Limited",
      displayName: "Store Demo Freight",
      createdByUserId: userIdByKey.provider,
    },
  ];

  for (const organization of organizations) {
    await db
      .insert(commerceOrganization)
      .values({
        ...organization,
        normalizedLegalName: organization.legalName.toLocaleLowerCase("en-US"),
        organizationType: "company",
        countryCode: "IN",
        /**
         * BOTH OVERRIDDEN ON PURPOSE. The defaults are `pending` and `private`, and six
         * of the eight columns behind `publicProductEligibility` default to a value that
         * hides the row. A demo that used the defaults would seed a store with nothing
         * in it and look like a broken projection.
         */
        tradeState: "active",
        visibility: "public",
      })
      .onConflictDoNothing({ target: commerceOrganization.id });
  }

  const memberships = [
    { organizationId: SELLER_ORGANIZATION_ID, userId: userIdByKey.seller },
    { organizationId: BUYER_ORGANIZATION_ID, userId: userIdByKey.buyer },
    { organizationId: PROVIDER_ORGANIZATION_ID, userId: userIdByKey.provider },
  ];
  for (const membership of memberships) {
    await db
      .insert(commerceOrganizationMember)
      .values({
        id: `store_demo_member_${membership.organizationId}`,
        ...membership,
        role: "owner",
        state: "active",
        // `commerce_organization_member_dates_ck` requires this for an active member.
        joinedAt: new Date(),
      })
      .onConflictDoNothing({ target: commerceOrganizationMember.id });
  }
}

/** The buyer's `delivery` address — the A15 kind, and the only one checkout accepts. */
async function ensureBuyerDeliveryAddress(buyerUserId: string): Promise<void> {
  if (!isCommercePiiEncryptionConfigured()) {
    throw new Error(
      'COMMERCE_PII_ENCRYPTION_SECRET is not set, so no address can be encrypted. Generate one with: echo "COMMERCE_PII_ENCRYPTION_SECRET=$(openssl rand -base64 48)" >> .env',
    );
  }

  const addressLineOne = encryptCommercePii("14 Baner Road");
  const recipientName = encryptCommercePii("Priya Rao");
  const phone = encryptCommercePii("+91 99999 00000");
  if (!addressLineOne.success || !recipientName.success || !phone.success) {
    throw new Error("Demo address encryption failed.");
  }

  await db
    .insert(commerceOrganizationAddress)
    .values({
      id: "store_demo_address_delivery",
      organizationId: BUYER_ORGANIZATION_ID,
      addressKind: "delivery",
      label: "Pune head office",
      countryCode: "IN",
      regionCode: "MH",
      locality: "Pune",
      postalCode: "411045",
      recipientNameEncrypted: recipientName.value,
      addressLineOneEncrypted: addressLineOne.value,
      phoneEncrypted: phone.value,
      isDefault: true,
      createdByUserId: buyerUserId,
    })
    .onConflictDoNothing({ target: commerceOrganizationAddress.id });

  /** A billing address too, so the smoke can prove the kind filter refuses it. */
  const billingLineOne = encryptCommercePii("1 Finance Street");
  if (!billingLineOne.success) throw new Error("Demo billing address encryption failed.");
  await db
    .insert(commerceOrganizationAddress)
    .values({
      id: "store_demo_address_billing",
      organizationId: BUYER_ORGANIZATION_ID,
      addressKind: "billing",
      label: "Accounts",
      countryCode: "IN",
      regionCode: "MH",
      locality: "Pune",
      postalCode: "411045",
      addressLineOneEncrypted: billingLineOne.value,
      isDefault: true,
      createdByUserId: buyerUserId,
    })
    .onConflictDoNothing({ target: commerceOrganizationAddress.id });
}

async function resolveCategoryId(slug: string): Promise<string> {
  const [category] = await db
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(eq(commerceCategory.slug, slug))
    .limit(1);
  if (!category) throw new Error(`Root category ${slug} is missing; run db:migrate first.`);
  return category.id;
}

async function ensureProducts(sellerUserId: string): Promise<void> {
  const homeCategoryId = await resolveCategoryId("home-kitchen");

  /**
   * Every one of these is publicly eligible: `status: 'active'`,
   * `moderationState: 'approved'`, a `publicSlug`, and stock above the low-stock
   * threshold so the projection reads `in_stock` rather than `low_stock`.
   */
  const products = [
    {
      id: CHAIR_PRODUCT_ID,
      title: "Banquet chair, stackable",
      publicSlug: "banquet-chair-stackable",
      priceInCents: 480_000,
      // A17: orderable and refundable, so a completed sample mints a credit.
      samplePolicy: "refundable" as const,
      samplePriceInCents: 60_000,
    },
    {
      id: LAMP_PRODUCT_ID,
      title: "Bedside reading lamp",
      publicSlug: "bedside-reading-lamp",
      priceInCents: 120_000,
      samplePolicy: "paid" as const,
      samplePriceInCents: 18_000,
    },
    {
      id: RUG_PRODUCT_ID,
      title: "Guest room rug",
      publicSlug: "guest-room-rug",
      priceInCents: 260_000,
      samplePolicy: "unavailable" as const,
      samplePriceInCents: null,
    },
  ];

  for (const demoProduct of products) {
    await db
      .insert(product)
      .values({
        id: demoProduct.id,
        sellerOrganizationId: SELLER_ORGANIZATION_ID,
        createdByUserId: sellerUserId,
        title: demoProduct.title,
        brand: "Store Demo",
        description: "Seeded by db:seed-store-demo. Not a real listing.",
        category: "home_kitchen",
        categoryId: homeCategoryId,
        priceInCents: demoProduct.priceInCents,
        currency: "USD",
        stockQuantity: 500,
        status: "active",
        moderationState: "approved",
        publicSlug: demoProduct.publicSlug,
        publishedAt: new Date(),
        samplePolicy: demoProduct.samplePolicy,
        samplePriceInCents: demoProduct.samplePriceInCents,
        leadTimeMinDays: 14,
        leadTimeMaxDays: 28,
        /** A5/A16: without these the delivery estimate has no weight to rate. */
        packageLengthMm: 900,
        packageWidthMm: 600,
        packageHeightMm: 1_100,
        packageGrossWeightGrams: 8_500,
        unitsPerPackage: 4,
      })
      /**
       * STOCK IS RESTORED ON EVERY RE-SEED, and only stock.
       *
       * This was `onConflictDoNothing`, which is right for the listing's commercial content — a
       * local edit to a title or a price is somebody's work in progress. It is wrong for the
       * quantity: every smoke that checks out consumes some, nothing puts it back, and the demo
       * product silently becomes unbuyable after a few runs. `smoke-store-phase-23` hit exactly
       * that, and a smoke that fails because a fixture ran out reports a defect that is not there.
       */
      .onConflictDoUpdate({ target: product.id, set: { stockQuantity: 500 } });

    /**
     * A11. This seed writes `product` rows DIRECTLY rather than through
     * `createProduct`, so it does not get `ensureCommerceProductStatsRow` for free —
     * and migration `0066`'s backfill already ran, before these rows existed.
     *
     * Without this insert a freshly-migrated-then-seeded database fails
     * `db:verify-store-phase-10-constraints`' "every product has an engagement stats
     * row" check, which is exactly the condition that makes an engagement counter
     * UPDATE affect zero rows and lose the count silently.
     */
    await db
      .insert(commerceProductStats)
      .values({ productId: demoProduct.id })
      .onConflictDoNothing();

    await db
      .insert(productPricingTier)
      .values([
        {
          id: `store_demo_tier_${demoProduct.id}_1`,
          productId: demoProduct.id,
          unitPriceInCents: demoProduct.priceInCents,
          minimumOrderQuantity: 10,
          position: 0,
        },
        {
          id: `store_demo_tier_${demoProduct.id}_2`,
          productId: demoProduct.id,
          unitPriceInCents: Math.floor(demoProduct.priceInCents * 0.9),
          minimumOrderQuantity: 100,
          position: 1,
        },
      ])
      .onConflictDoNothing();
  }

  /**
   * A1: one product carries variants, because a variant-bearing product refuses a cart
   * line that names none — a rule worth having a fixture for.
   */
  await db
    .insert(commerceProductVariant)
    .values([
      {
        id: "store_demo_variant_lamp_brass",
        productId: LAMP_PRODUCT_ID,
        name: "Brass",
        publicSlug: "brass",
        priceInCents: 120_000,
        stockQuantity: 300,
        position: 0,
      },
      {
        id: "store_demo_variant_lamp_black",
        productId: LAMP_PRODUCT_ID,
        name: "Matte black",
        publicSlug: "matte-black",
        priceInCents: 132_000,
        stockQuantity: 150,
        position: 1,
      },
    ])
    .onConflictDoNothing();

  /** A18: a slot whose minimum order quantity the server enforces at cart and checkout. */
  await db
    .insert(commerceProductCustomizationOption)
    .values([
      {
        id: "store_demo_customization_logo",
        productId: CHAIR_PRODUCT_ID,
        slotKey: "logo",
        label: "Your logo",
        customizationKind: "file_upload",
        acceptedMediaTypes: ["image/png", "image/jpeg"],
        choiceValues: [],
        minimumOrderQuantity: 50,
        isRequired: false,
        position: 0,
      },
      {
        id: "store_demo_customization_packaging",
        productId: CHAIR_PRODUCT_ID,
        slotKey: "packaging_material",
        label: "Packaging material",
        customizationKind: "choice",
        acceptedMediaTypes: [],
        choiceValues: ["kraft", "corrugated"],
        minimumOrderQuantity: 200,
        isRequired: false,
        position: 1,
      },
    ])
    .onConflictDoNothing();
}

/** A16 needs a real provider on the route, or the estimate is empty for the wrong reason. */
async function ensureFreightProvider(): Promise<void> {
  await db
    .insert(commerceProviderProfile)
    .values({
      organizationId: PROVIDER_ORGANIZATION_ID,
      publicSummary: "Seeded demo freight forwarder.",
      verificationState: "verified",
      acceptingRequests: true,
    })
    .onConflictDoNothing({ target: commerceProviderProfile.organizationId });

  await db
    .insert(commerceProviderKindLink)
    .values({
      id: "store_demo_kind_link_freight",
      organizationId: PROVIDER_ORGANIZATION_ID,
      providerKind: "freight_forwarder",
      verificationState: "verified",
    })
    .onConflictDoNothing({ target: commerceProviderKindLink.id });

  await db
    .insert(commerceServiceOffering)
    .values({
      id: "store_demo_offering_sea",
      slug: "store-demo-sea-freight",
      providerOrganizationId: PROVIDER_ORGANIZATION_ID,
      providerKind: "freight_forwarder",
      title: "Sea freight, India to Europe",
      summary: "Seeded demo offering.",
      state: "active",
      pricingModel: "quote_only",
      indicativePriceMinInCents: 40_000,
      indicativePriceMaxInCents: 90_000,
      currency: "USD",
      minimumLeadTimeDays: 18,
      maximumLeadTimeDays: 32,
    })
    .onConflictDoNothing({ target: commerceServiceOffering.id });

  await db
    .insert(freightOfferingDetail)
    .values({
      offeringId: "store_demo_offering_sea",
      transportModes: ["sea"],
      supportsConsolidation: true,
    })
    .onConflictDoNothing({ target: freightOfferingDetail.offeringId });

  await db
    .insert(commerceServiceCoverage)
    .values([
      {
        id: "store_demo_coverage_in_de",
        offeringId: "store_demo_offering_sea",
        originCountryCode: "IN",
        destinationCountryCode: "DE",
      },
      {
        id: "store_demo_coverage_in_in",
        offeringId: "store_demo_offering_sea",
        originCountryCode: "IN",
        destinationCountryCode: "IN",
      },
    ])
    .onConflictDoNothing();
}

/** Merchandising, so `GET /store/home` returns something other than empty arrays. */
async function ensureMerchandising(): Promise<void> {
  await db
    .insert(storeHeroSlide)
    .values({
      id: "store_demo_hero",
      title: "Fit out a hotel room",
      subtitle: "Seeded demo merchandising.",
      accent: "amber",
      // All three link columns or none — `store_hero_slide_link_target_ck`.
      linkTargetKind: "product",
      linkTargetId: CHAIR_PRODUCT_ID,
      linkTargetSlug: "banquet-chair-stackable",
      siblingOrder: 0,
      state: "active",
    })
    .onConflictDoNothing({ target: storeHeroSlide.id });

  await db
    .insert(storeRail)
    .values({
      id: "store_demo_rail",
      slug: "store-demo-new-arrivals",
      title: "New arrivals",
      strategy: "curated",
      state: "active",
    })
    .onConflictDoNothing({ target: storeRail.id });

  await db
    .insert(storeRailPlacement)
    .values(
      [CHAIR_PRODUCT_ID, LAMP_PRODUCT_ID, RUG_PRODUCT_ID].map((productId, index) => ({
        id: `store_demo_rail_placement_${productId}`,
        railId: "store_demo_rail",
        entityKind: "product" as const,
        entityId: productId,
        position: index,
      })),
    )
    .onConflictDoNothing();

  /**
   * PLATFORM-CURATED: `ownerOrganizationId` NULL, `state: 'active'`, review columns NULL.
   * That is the one shape `store_pathway_review_ck` lets reach `active` without a
   * reviewer — a seller proposal would need moderating first, which is the smoke
   * script's job, not the seed's.
   */
  await db
    .insert(storePathway)
    .values({
      id: "store_demo_pathway",
      slug: "store-demo-hotel-room-refit",
      title: "Everything for a hotel room refit",
      summary: "Seeded demo guided pathway.",
      accent: "emerald",
      state: "active",
    })
    .onConflictDoNothing({ target: storePathway.id });

  await db
    .insert(storePathwaySlot)
    .values([
      {
        id: "store_demo_slot_seating",
        pathwayId: "store_demo_pathway",
        roleLabel: "Seating",
        isRequired: true,
        quantity: 10,
        siblingOrder: 0,
      },
      {
        id: "store_demo_slot_lighting",
        pathwayId: "store_demo_pathway",
        roleLabel: "Lighting",
        isRequired: true,
        quantity: 10,
        siblingOrder: 1,
      },
      {
        id: "store_demo_slot_flooring",
        pathwayId: "store_demo_pathway",
        roleLabel: "Flooring",
        isRequired: false,
        quantity: 10,
        siblingOrder: 2,
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(storePathwaySlotCandidate)
    .values([
      {
        id: "store_demo_candidate_chair",
        slotId: "store_demo_slot_seating",
        productId: CHAIR_PRODUCT_ID,
        rank: 0,
      },
      /** The variant-bearing product, so the candidate must name a variant (A1). */
      {
        id: "store_demo_candidate_lamp",
        slotId: "store_demo_slot_lighting",
        productId: LAMP_PRODUCT_ID,
        variantId: "store_demo_variant_lamp_brass",
        rank: 0,
      },
      {
        id: "store_demo_candidate_lamp_alt",
        slotId: "store_demo_slot_lighting",
        productId: LAMP_PRODUCT_ID,
        variantId: "store_demo_variant_lamp_black",
        rank: 1,
      },
      {
        id: "store_demo_candidate_rug",
        slotId: "store_demo_slot_flooring",
        productId: RUG_PRODUCT_ID,
        rank: 0,
      },
    ])
    .onConflictDoNothing();
}

async function main(): Promise<void> {
  const userIdByKey = await ensureDemoUsers();
  await ensureStaffPlatformRole(userIdByKey.staff);
  await ensureOrganizations(userIdByKey);
  await ensureBuyerDeliveryAddress(userIdByKey.buyer);
  await ensureProducts(userIdByKey.seller);
  await ensureFreightProvider();
  await ensureMerchandising();

  /**
   * Direct inserts do not enqueue `refresh-store-search-document`, so `/store/search`
   * would stay empty while `/store/products/:slug` worked — a difference that reads as a
   * search bug rather than a seeding gap.
   */
  for (const productId of [CHAIR_PRODUCT_ID, LAMP_PRODUCT_ID, RUG_PRODUCT_ID]) {
    await refreshProductSearchDocument(productId);
  }

  const [counts] = await db
    .select({
      organizations: sql<number>`(SELECT count(*)::int FROM commerce_organization)`,
      products: sql<number>`(SELECT count(*)::int FROM product)`,
      offerings: sql<number>`(SELECT count(*)::int FROM commerce_service_offering)`,
      pathwaySlots: sql<number>`(SELECT count(*)::int FROM store_pathway_slot)`,
    })
    .from(commerceOrganization)
    .limit(1);

  console.log("Store demo seeded.");
  console.log(`  organizations: ${String(counts?.organizations ?? 0)}`);
  console.log(`  products:      ${String(counts?.products ?? 0)}`);
  console.log(`  offerings:     ${String(counts?.offerings ?? 0)}`);
  console.log(`  pathway slots: ${String(counts?.pathwaySlots ?? 0)}`);
  console.log(`  sign-in password for every demo account: ${DEMO_PASSWORD}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("Store demo seed failed:", error);
    await pool.end();
    process.exit(1);
  });
