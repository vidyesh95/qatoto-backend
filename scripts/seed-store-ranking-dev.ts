/**
 * Seeds the demand history the STORE Phase 13 ranking engine needs, backdated.
 *
 *   pnpm run db:seed-store-ranking-dev -- --i-understand-this-writes-fake-commerce-data
 *
 * WHY THIS EXISTS. Every signal the ranking engine reads is a TIME SERIES. Qualified order
 * velocity compares W1 (days 1-7) against W2 (days 8-14); the category floor needs 30 days;
 * the refund and cancellation rates need 30; the MAD spike baseline needs a per-product
 * daily series. On a fresh database all of those are empty, so the engine computes nothing
 * and every rail is honestly blank — for two calendar weeks minimum.
 *
 * That is correct behaviour in production and useless in development. This script writes
 * the history instead of waiting for it.
 *
 * WHAT IT IS NOT. It is not evidence that the thresholds are right. Synthetic data proves
 * the code computes what the specification says; it says nothing about whether a real B2B
 * buyer behaves like the fixtures below. The corporate-NAT fixture passing the exemption
 * test is evidence about the fixture, not about procurement teams.
 *
 * ## Refuse-closed, three ways
 *
 *   1. `NODE_ENV=production` throws outright.
 *   2. An explicit `--i-understand-this-writes-fake-commerce-data` flag is required. A
 *      long flag on purpose: nobody types it by muscle memory.
 *   3. A rerun without `--reset` refuses if seeded rows already exist, rather than
 *      layering a second history on top of the first and doubling every velocity.
 *
 * Every row carries the `devseed-` slug prefix, so a teardown is one predicate.
 *
 * ## Why the seed does NOT add its organizations to the ranking-exclusion list
 *
 * That was the original design and it is self-defeating: `evaluateBuyerQualification`
 * checks that list for the BUYER organization and returns `unqualified`, so excluding the
 * seed's own buyers would make every seeded order unqualified and leave the engine with
 * exactly the empty input this script exists to fill.
 *
 * One fixture organization IS excluded — the self-dealing seller — which gives the
 * exclusion path real coverage without neutering the rest. Protection against an
 * accidental production run is the three guards above, not the exclusion list.
 *
 * ## Determinism
 *
 * A fixed PRNG seed and an injected `asOf` mean two runs produce identical data. That is
 * what makes the ranking jobs' own determinism assertions meaningful: if a score differs
 * between runs on this data, the scorer is at fault, not the fixtures.
 */
import "dotenv/config";
import { and, eq, like, sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import {
  commerceBusinessEmailDomain,
  commerceCart,
  commerceCategory,
  commerceCheckoutGroup,
  commerceCheckoutPrepare,
  commerceEncryptedDocument,
  commerceOrder,
  commerceOrderProductLine,
  commerceOrganization,
  commerceOrganizationMember,
  commerceOrganizationRankingExclusion,
  commerceOrganizationVerification,
  commerceProductEngagement,
  commerceProductShare,
  commerceProductStats,
  commerceProductViewSession,
  commerceRefund,
  product,
  productPricingTier,
  user,
} from "#src/db/schema.js";
import { auth } from "#src/lib/auth.js";
import { utcDayStringOf } from "#src/lib/utc-day.js";
import { refreshProductSearchDocument } from "#src/modules/store/catalog/store-search.service.js";
import { evaluateBuyerQualification } from "#src/services/commerce-buyer-qualification.service.js";

const SLUG_PREFIX = "devseed-";
const ID_PREFIX = "devseed_";
const SEED_PASSWORD = "store-ranking-dev-2026";
const REQUIRED_FLAG = "--i-understand-this-writes-fake-commerce-data";

/** The window every backdated row is measured from. */
const HISTORY_DAYS = 120;

/**
 * Accounts that only ever save, bookmark and share.
 *
 * Sized so the subnet fixtures can express a real ratio: a "38 of 40 saves from one
 * network" claim needs 40 users to exist, because the engagement primary key allows one
 * save per user per product.
 */
const ENGAGEMENT_USER_COUNT = 40;
const MILLISECONDS_PER_DAY = 86_400_000;

/* ------------------------------------------------------------------------- *
 * Determinism
 * ------------------------------------------------------------------------- */

/**
 * mulberry32. Small, fast, and — the only property that matters here — identical across
 * runs and machines. `Math.random()` would make the ranking jobs' determinism assertions
 * meaningless, because a differing score could always be blamed on the fixtures.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const nextRandom = createSeededRandom(20_260_807);

function randomInteger(minimum: number, maximum: number): number {
  return minimum + Math.floor(nextRandom() * (maximum - minimum + 1));
}

function pickOne<T>(values: readonly T[]): T {
  const picked = values[Math.floor(nextRandom() * values.length)];
  if (picked === undefined) throw new Error("pickOne received an empty list.");
  return picked;
}

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * The eight named scenarios. Each one is an assertion the phase verifier reads back, not
 * decoration — a ranking engine that only proves it can suppress has not been shown to
 * promote, which is why `honest_bestseller` is on this list.
 */
type FixtureKey =
  | "honest_bestseller"
  | "click_farm"
  | "corporate_nat"
  | "penny_spam"
  | "self_dealing"
  | "spike_no_conversion"
  | "sparse_category"
  | "stale_surge"
  | "ordinary";

interface SeedSeller {
  readonly key: string;
  readonly legalName: string;
  readonly countryCode: string;
  readonly currency: string;
  /** Whether an approved business-registration verification is written for it. */
  readonly verified: boolean;
}

const SELLERS: readonly SeedSeller[] = [
  {
    key: "atlas",
    legalName: "Atlas Industrial Works",
    countryCode: "IN",
    currency: "USD",
    verified: true,
  },
  {
    key: "meridian",
    legalName: "Meridian Cold Chain",
    countryCode: "DE",
    currency: "EUR",
    verified: true,
  },
  {
    key: "kestrel",
    legalName: "Kestrel Fabrication",
    countryCode: "VN",
    currency: "USD",
    verified: false,
  },
  {
    key: "borealis",
    legalName: "Borealis Packaging",
    countryCode: "PL",
    currency: "EUR",
    verified: true,
  },
  {
    key: "solstice",
    legalName: "Solstice Components",
    countryCode: "IN",
    currency: "INR",
    verified: false,
  },
];

interface SeedBuyer {
  readonly key: string;
  readonly legalName: string;
  readonly countryCode: string;
  /** Days before `asOf` the ACCOUNT was created — the age half of the qualification bar. */
  readonly accountAgeDays: number;
  readonly emailDomain: string;
  /** Whether the organization carries an approved registration verification. */
  readonly verified: boolean;
  /** Whether a tax identifier ciphertext is present. */
  readonly hasTaxIdentifier: boolean;
}

/**
 * Deliberately spread across the qualification boundary so `buyer_qualification_state`
 * takes every value the enum has, INCLUDING the ones that fail. A seed where everything
 * qualifies would never exercise the filter.
 */
const BUYERS: readonly SeedBuyer[] = [
  {
    key: "northwind",
    legalName: "Northwind Procurement",
    countryCode: "GB",
    accountAgeDays: 400,
    emailDomain: "northwind-devseed.example",
    verified: true,
    hasTaxIdentifier: true,
  },
  {
    key: "cascade",
    legalName: "Cascade Hospitality Group",
    countryCode: "US",
    accountAgeDays: 220,
    emailDomain: "cascade-devseed.example",
    verified: true,
    hasTaxIdentifier: false,
  },
  {
    key: "lumen",
    legalName: "Lumen Retail",
    countryCode: "AE",
    accountAgeDays: 90,
    emailDomain: "lumen-devseed.example",
    verified: false,
    hasTaxIdentifier: true,
  },
  // Fails the AGE half: three days old at `asOf`. Its orders must never count.
  {
    key: "fledgling",
    legalName: "Fledgling Trading",
    countryCode: "SG",
    accountAgeDays: 3,
    emailDomain: "fledgling-devseed.example",
    verified: true,
    hasTaxIdentifier: true,
  },
  // Fails the CREDENTIAL half: old enough, no verification, no identifier, and its domain
  // is classified disposable — the hard-fail branch.
  {
    key: "driftmail",
    legalName: "Driftmail Holdings",
    countryCode: "US",
    accountAgeDays: 300,
    emailDomain: "driftmail-devseed.example",
    verified: false,
    hasTaxIdentifier: false,
  },
];

interface SeedCategory {
  readonly key: string;
  readonly name: string;
  readonly parentKey: string | null;
}

/** Three levels, because the prior ladder walks category -> parent -> global. */
const CATEGORIES: readonly SeedCategory[] = [
  { key: "industrial", name: "Industrial Equipment", parentKey: null },
  { key: "cooling", name: "Industrial Cooling", parentKey: "industrial" },
  { key: "freezers", name: "Commercial Freezers", parentKey: "cooling" },
  { key: "compressors", name: "Compressors", parentKey: "cooling" },
  { key: "packaging", name: "Packaging", parentKey: null },
  { key: "cartons", name: "Cartons and Cases", parentKey: "packaging" },
  // Deliberately starved of orders, to force `sparse_exploration`.
  { key: "instruments", name: "Precision Instruments", parentKey: "industrial" },
];

interface SeedProduct {
  readonly key: string;
  readonly title: string;
  readonly sellerKey: string;
  readonly categoryKey: string;
  readonly priceInCents: number;
  readonly fixture: FixtureKey;
}

const PRODUCTS: readonly SeedProduct[] = [
  {
    key: "chest-freezer-500",
    title: "Solar Chest Freezer 500L",
    sellerKey: "meridian",
    categoryKey: "freezers",
    priceInCents: 189_000,
    fixture: "honest_bestseller",
  },
  {
    key: "chest-freezer-300",
    title: "Solar Chest Freezer 300L",
    sellerKey: "meridian",
    categoryKey: "freezers",
    priceInCents: 142_000,
    fixture: "ordinary",
  },
  {
    key: "blast-chiller",
    title: "Blast Chiller Cabinet",
    sellerKey: "meridian",
    categoryKey: "freezers",
    priceInCents: 268_000,
    fixture: "ordinary",
  },
  {
    key: "scroll-compressor",
    title: "Scroll Compressor 5HP",
    sellerKey: "atlas",
    categoryKey: "compressors",
    priceInCents: 96_000,
    fixture: "click_farm",
  },
  {
    key: "piston-compressor",
    title: "Piston Compressor 3HP",
    sellerKey: "atlas",
    categoryKey: "compressors",
    priceInCents: 71_000,
    fixture: "corporate_nat",
  },
  {
    key: "condenser-coil",
    title: "Condenser Coil Assembly",
    sellerKey: "atlas",
    categoryKey: "compressors",
    priceInCents: 24_500,
    fixture: "ordinary",
  },
  {
    key: "carton-a4",
    title: "Double-Wall Carton A4",
    sellerKey: "borealis",
    categoryKey: "cartons",
    priceInCents: 180,
    fixture: "penny_spam",
  },
  {
    key: "carton-pallet",
    title: "Pallet Case, Reinforced",
    sellerKey: "borealis",
    categoryKey: "cartons",
    priceInCents: 940,
    fixture: "ordinary",
  },
  {
    key: "strap-roll",
    title: "Polyester Strapping Roll",
    sellerKey: "borealis",
    categoryKey: "cartons",
    priceInCents: 3_200,
    fixture: "ordinary",
  },
  {
    key: "gasket-set",
    title: "Door Gasket Set",
    sellerKey: "kestrel",
    categoryKey: "freezers",
    priceInCents: 8_900,
    fixture: "self_dealing",
  },
  {
    key: "thermal-probe",
    title: "Thermal Probe, Wireless",
    sellerKey: "kestrel",
    categoryKey: "instruments",
    priceInCents: 15_600,
    fixture: "sparse_category",
  },
  {
    key: "calibration-kit",
    title: "Calibration Kit",
    sellerKey: "solstice",
    categoryKey: "instruments",
    priceInCents: 42_000,
    fixture: "sparse_category",
  },
  {
    key: "inverter-board",
    title: "Inverter Control Board",
    sellerKey: "solstice",
    categoryKey: "compressors",
    priceInCents: 33_400,
    fixture: "spike_no_conversion",
  },
  {
    key: "evaporator-fan",
    title: "Evaporator Fan Motor",
    sellerKey: "solstice",
    categoryKey: "compressors",
    priceInCents: 12_800,
    fixture: "stale_surge",
  },
];

/* ------------------------------------------------------------------------- *
 * Guards
 * ------------------------------------------------------------------------- */

interface SeedOptions {
  readonly reset: boolean;
}

function parseArguments(): SeedOptions {
  const flags = process.argv.slice(2);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed-store-ranking-dev refuses to run with NODE_ENV=production. It writes fabricated orders, views and refunds.",
    );
  }
  if (!flags.includes(REQUIRED_FLAG)) {
    throw new Error(
      `seed-store-ranking-dev writes fabricated commerce data. Re-run with ${REQUIRED_FLAG} if that is what you want.`,
    );
  }

  return { reset: flags.includes("--reset") };
}

/**
 * Deletes every seeded row, in foreign-key order.
 *
 * Scoped by the `devseed_` id prefix rather than by a date or a heuristic: an operator
 * running `--reset` must be able to see, from the predicate alone, that nothing of theirs
 * is in range.
 */
async function resetSeed(): Promise<void> {
  const seededOrders = db
    .select({ id: commerceOrder.id })
    .from(commerceOrder)
    .where(like(commerceOrder.id, `${ID_PREFIX}%`));

  await db.delete(commerceRefund).where(like(commerceRefund.id, `${ID_PREFIX}%`));
  await db
    .delete(commerceOrderProductLine)
    .where(sql`${commerceOrderProductLine.orderId} IN ${seededOrders}`);

  /*
   * AN ORDER CANNOT BE DELETED. `commerce_order_snapshot_append_only` raises on DELETE
   * outright — §2.2's immutability rule, enforced in the database rather than by
   * convention — so this reset has to switch the trigger off around its own delete and
   * switch it straight back on.
   *
   * That is a deliberate, narrow exception and it is worth naming rather than hiding:
   *
   *   - it is scoped to ONE named trigger, not `DISABLE TRIGGER USER`, so the shipment and
   *     event append-only guards stay armed throughout;
   *   - the re-enable is in a `finally`, so a failure mid-delete cannot leave a development
   *     database with its order immutability quietly switched off;
   *   - it only ever runs behind the three guards at the top of this file, and it only
   *     deletes rows whose ids start with `devseed_`.
   *
   * If this ever needs to run somewhere it should not, the right fix is to delete the
   * database, not to widen this.
   */
  await db.execute(
    sql`ALTER TABLE commerce_order DISABLE TRIGGER commerce_order_snapshot_append_only`,
  );
  try {
    await db.delete(commerceOrder).where(like(commerceOrder.id, `${ID_PREFIX}%`));
  } finally {
    await db.execute(
      sql`ALTER TABLE commerce_order ENABLE TRIGGER commerce_order_snapshot_append_only`,
    );
  }
  await db.delete(commerceCheckoutGroup).where(like(commerceCheckoutGroup.id, `${ID_PREFIX}%`));
  await db.delete(commerceCheckoutPrepare).where(like(commerceCheckoutPrepare.id, `${ID_PREFIX}%`));
  await db.delete(commerceCart).where(like(commerceCart.id, `${ID_PREFIX}%`));
  await db
    .delete(commerceProductViewSession)
    .where(like(commerceProductViewSession.productId, `${ID_PREFIX}%`));
  await db
    .delete(commerceProductShare)
    .where(like(commerceProductShare.productId, `${ID_PREFIX}%`));
  await db
    .delete(commerceProductEngagement)
    .where(like(commerceProductEngagement.productId, `${ID_PREFIX}%`));
  await db
    .delete(commerceProductStats)
    .where(like(commerceProductStats.productId, `${ID_PREFIX}%`));
  await db.delete(productPricingTier).where(like(productPricingTier.productId, `${ID_PREFIX}%`));
  await db.delete(product).where(like(product.id, `${ID_PREFIX}%`));
  await db
    .delete(commerceOrganizationVerification)
    .where(like(commerceOrganizationVerification.organizationId, `${ID_PREFIX}%`));
  await db
    .delete(commerceOrganizationRankingExclusion)
    .where(like(commerceOrganizationRankingExclusion.organizationId, `${ID_PREFIX}%`));
  // After the verification that references it, before the organization it belongs to.
  await db
    .delete(commerceEncryptedDocument)
    .where(like(commerceEncryptedDocument.id, `${ID_PREFIX}%`));
  await db
    .delete(commerceOrganizationMember)
    .where(like(commerceOrganizationMember.organizationId, `${ID_PREFIX}%`));
  await db.delete(commerceOrganization).where(like(commerceOrganization.id, `${ID_PREFIX}%`));
  await db.delete(commerceCategory).where(like(commerceCategory.id, `${ID_PREFIX}%`));
  await db
    .delete(commerceBusinessEmailDomain)
    .where(like(commerceBusinessEmailDomain.sourceNote, "devseed%"));

  console.log("  reset: seeded rows removed");
}

async function refuseIfAlreadySeeded(): Promise<void> {
  const [existing] = await db
    .select({ id: commerceOrganization.id })
    .from(commerceOrganization)
    .where(like(commerceOrganization.id, `${ID_PREFIX}%`))
    .limit(1);

  if (existing) {
    throw new Error(
      "This database already carries devseed rows. Re-run with --reset to replace them; layering a second history on the first would double every velocity.",
    );
  }
}

/* ------------------------------------------------------------------------- *
 * Seeding
 * ------------------------------------------------------------------------- */

const asOf = new Date();
const daysAgo = (days: number): Date => new Date(asOf.getTime() - days * MILLISECONDS_PER_DAY);

async function ensureUser(email: string, name: string, createdAt: Date): Promise<string> {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing) return existing.id;

  // Through Better Auth so the credential is a real hash a sign-in route accepts —
  // inserting `user` + `account` by hand produces an account that exists and cannot log in.
  await auth.api.signUpEmail({ body: { email, password: SEED_PASSWORD, name } });

  const [created] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!created) throw new Error(`Seed user ${email} was not created.`);

  // Backdated AFTER creation: better-auth stamps `now()`, and the account-age half of the
  // qualification bar is the entire point of the older buyers.
  await db.update(user).set({ createdAt, emailVerified: true }).where(eq(user.id, created.id));
  return created.id;
}

/**
 * Sibling order is unique per parent — `commerce_category_siblingOrder_uidx` keys on
 * `(coalesce(parent_category_id, '__root__'), sibling_order)`. A seed that numbered from
 * zero would collide with whatever roots the database already has, which is exactly what
 * happened the first time this ran. Seeded categories are therefore numbered from a high
 * base, per parent, so they sort after real ones and cannot contend with them.
 */
const SEED_SIBLING_ORDER_BASE = 900;

async function seedCategories(): Promise<Map<string, string>> {
  const categoryIdByKey = new Map<string, string>();
  const nextSiblingOrderByParent = new Map<string, number>();

  for (const category of CATEGORIES) {
    const id = `${ID_PREFIX}cat_${category.key}`;
    const parentId = category.parentKey === null ? null : `${ID_PREFIX}cat_${category.parentKey}`;

    const parentBucket = parentId ?? "__root__";
    const siblingOrder = nextSiblingOrderByParent.get(parentBucket) ?? SEED_SIBLING_ORDER_BASE;
    nextSiblingOrderByParent.set(parentBucket, siblingOrder + 1);

    await db
      .insert(commerceCategory)
      .values({
        id,
        slug: `${SLUG_PREFIX}${category.key}`,
        name: category.name,
        parentCategoryId: parentId,
        siblingOrder,
        state: "active",
      })
      .onConflictDoNothing({ target: commerceCategory.id });

    categoryIdByKey.set(category.key, id);
  }

  console.log(`  categories: ${CATEGORIES.length}`);
  return categoryIdByKey;
}

interface SeededOrganization {
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly legalName: string;
}

async function seedOrganization(input: {
  readonly key: string;
  readonly legalName: string;
  readonly countryCode: string;
  readonly accountAgeDays: number;
  readonly emailDomain: string;
  readonly verified: boolean;
  readonly hasTaxIdentifier: boolean;
  readonly role: "seller" | "buyer";
}): Promise<SeededOrganization> {
  const organizationId = `${ID_PREFIX}org_${input.key}`;
  const memberId = `${ID_PREFIX}member_${input.key}`;
  const userId = await ensureUser(
    `${input.key}@${input.emailDomain}`,
    input.legalName,
    daysAgo(input.accountAgeDays),
  );

  await db
    .insert(commerceOrganization)
    .values({
      id: organizationId,
      slug: `${SLUG_PREFIX}${input.key}`,
      legalName: input.legalName,
      normalizedLegalName: input.legalName.toLowerCase(),
      displayName: input.legalName,
      organizationType: "company",
      tradeState: "active",
      visibility: "public",
      countryCode: input.countryCode,
      // Presence is the signal the qualification bar reads; the value is never compared.
      taxIdentifierEncrypted: input.hasTaxIdentifier ? `devseed-ciphertext-${input.key}` : null,
      createdByUserId: userId,
      createdAt: daysAgo(input.accountAgeDays),
    })
    .onConflictDoNothing({ target: commerceOrganization.id });

  await db
    .insert(commerceOrganizationMember)
    .values({
      id: memberId,
      organizationId,
      userId,
      role: input.role === "seller" ? "owner" : "buyer",
      state: "active",
      joinedAt: daysAgo(input.accountAgeDays),
    })
    .onConflictDoNothing({ target: commerceOrganizationMember.id });

  if (input.verified) {
    /*
     * A verification requires an evidence document, so the seed writes one. EVERY FIELD IS
     * VISIBLY FAKE — there is no object behind `objectStorageKey`, and the "encryption"
     * metadata names no real key. That is deliberate: a fixture that looked like genuine
     * crypto material would invite someone to treat it as such. The row exists so the
     * foreign key resolves and the approved-verification branch of `verifiedStanding` has
     * something to read.
     */
    const documentId = `${ID_PREFIX}doc_${input.key}`;
    await db
      .insert(commerceEncryptedDocument)
      .values({
        id: documentId,
        organizationId,
        documentKind: "business_registration",
        state: "available",
        storageProvider: "devseed-none",
        objectStorageKey: `devseed/no-such-object/${input.key}`,
        mediaType: "application/pdf",
        fileByteSize: 1,
        contentSha256: fabricatedSubnetHash(`${input.key}-doc-sha`),
        encryptionAlgorithm: "devseed-not-encrypted",
        encryptionKeyVersion: 1,
        encryptedDataKey: "devseed-not-a-key",
        initializationVector: "devseed-not-an-iv",
        uploadedByUserId: userId,
        createdAt: daysAgo(input.accountAgeDays - 1),
      })
      .onConflictDoNothing({ target: commerceEncryptedDocument.id });

    await db
      .insert(commerceOrganizationVerification)
      .values({
        id: `${ID_PREFIX}ver_${input.key}`,
        organizationId,
        verificationKind: "business_registration",
        state: "approved",
        evidenceDocumentId: documentId,
        submittedByUserId: userId,
        // An approved verification requires a reviewer distinct from the submitter, so the
        // seed's staff identity signs these off.
        reviewedByUserId: staffUserId,
        submittedAt: daysAgo(input.accountAgeDays - 1),
        decidedAt: daysAgo(input.accountAgeDays - 2),
      })
      .onConflictDoNothing({ target: commerceOrganizationVerification.id });
  }

  return { organizationId, memberId, userId, legalName: input.legalName };
}

let staffUserId = "";

async function seedProducts(
  categoryIdByKey: ReadonlyMap<string, string>,
  sellerByKey: ReadonlyMap<string, SeededOrganization>,
): Promise<void> {
  for (const seedProduct of PRODUCTS) {
    const seller = sellerByKey.get(seedProduct.sellerKey);
    const categoryId = categoryIdByKey.get(seedProduct.categoryKey);
    if (!seller || categoryId === undefined) {
      throw new Error(`Product ${seedProduct.key} references a missing seller or category.`);
    }

    const productId = `${ID_PREFIX}prod_${seedProduct.key}`;

    await db
      .insert(product)
      .values({
        id: productId,
        sellerOrganizationId: seller.organizationId,
        createdByUserId: seller.userId,
        title: seedProduct.title,
        brand: seller.legalName,
        description: `Seeded by db:seed-store-ranking-dev for ${seedProduct.fixture}. Not a real listing.`,
        // The legacy seller enum has no industrial member; `categoryId` above is the real
        // taxonomy and this column is the retired one Phase 0 kept for old readers.
        category: "home_kitchen",
        categoryId,
        priceInCents: seedProduct.priceInCents,
        currency: SELLERS.find((entry) => entry.key === seedProduct.sellerKey)?.currency ?? "USD",
        stockQuantity: 5_000,
        status: "active",
        moderationState: "approved",
        publicSlug: `${SLUG_PREFIX}${seedProduct.key}`,
        publishedAt: daysAgo(HISTORY_DAYS),
        samplePolicy: "paid",
        samplePriceInCents: Math.max(500, Math.round(seedProduct.priceInCents / 20)),
        leadTimeMinDays: 14,
        leadTimeMaxDays: 30,
        packageLengthMm: 900,
        packageWidthMm: 600,
        packageHeightMm: 1_100,
        packageGrossWeightGrams: 8_500,
        unitsPerPackage: 1,
      })
      .onConflictDoNothing({ target: product.id });

    await db
      .insert(commerceProductStats)
      .values({ productId })
      .onConflictDoNothing({ target: commerceProductStats.productId });

    await db
      .insert(productPricingTier)
      .values({
        id: `${ID_PREFIX}tier_${seedProduct.key}`,
        productId,
        minimumOrderQuantity: 1,
        position: 0,
        unitPriceInCents: seedProduct.priceInCents,
      })
      .onConflictDoNothing({ target: productPricingTier.id });

    await refreshProductSearchDocument(productId);
  }

  console.log(`  products: ${PRODUCTS.length}`);
}

/**
 * How many orders each fixture receives in W1 (days 1-7) and W2 (days 8-14), and how far
 * back its long tail runs.
 *
 * `stale_surge` is the shape worth reading twice: volume 20 days ago and NOTHING since, so
 * it must be INELIGIBLE for trending rather than merely decayed — refinement 1 makes a
 * product with no qualified order in W2 ineligible outright, and a decay curve alone would
 * still surface it.
 */
function orderPlanFor(fixture: FixtureKey): {
  readonly w1: number;
  readonly w2: number;
  readonly tail: number;
} {
  switch (fixture) {
    case "honest_bestseller":
      return { w1: 14, w2: 11, tail: 40 };
    case "penny_spam":
      return { w1: 22, w2: 18, tail: 30 };
    case "click_farm":
      return { w1: 3, w2: 2, tail: 4 };
    case "corporate_nat":
      return { w1: 6, w2: 5, tail: 12 };
    case "self_dealing":
      return { w1: 8, w2: 7, tail: 10 };
    case "spike_no_conversion":
      return { w1: 1, w2: 1, tail: 2 };
    case "sparse_category":
      return { w1: 1, w2: 1, tail: 3 };
    case "stale_surge":
      return { w1: 0, w2: 0, tail: 18 };
    case "ordinary":
      return { w1: 4, w2: 4, tail: 12 };
    default: {
      const exhaustive: never = fixture;
      throw new Error(`Unhandled fixture ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The buyer's single cart, created on first use.
 *
 * Reads the id back rather than assuming the insert won: `onConflictDoNothing` on the
 * buyer-unique index means a second call inserts nothing, and returning the id we TRIED to
 * use would hand a foreign key a row that does not exist.
 */
const cartIdByOrganization = new Map<string, string>();

async function ensureCartForBuyer(organizationId: string, createdAt: Date): Promise<string> {
  const cached = cartIdByOrganization.get(organizationId);
  if (cached !== undefined) return cached;

  await db
    .insert(commerceCart)
    .values({
      id: `${ID_PREFIX}cart_${organizationId}`,
      buyerOrganizationId: organizationId,
      createdAt,
    })
    .onConflictDoNothing();

  const [cart] = await db
    .select({ id: commerceCart.id })
    .from(commerceCart)
    .where(eq(commerceCart.buyerOrganizationId, organizationId))
    .limit(1);
  if (!cart) throw new Error(`Cart for ${organizationId} was neither created nor found.`);

  cartIdByOrganization.set(organizationId, cart.id);
  return cart.id;
}

interface OrderSeedContext {
  readonly buyerByKey: ReadonlyMap<string, SeededOrganization>;
  readonly sellerByKey: ReadonlyMap<string, SeededOrganization>;
}

async function seedOrdersForProduct(
  seedProduct: SeedProduct,
  context: OrderSeedContext,
  counters: { orders: number; refunds: number; cancellations: number },
): Promise<void> {
  const seller = context.sellerByKey.get(seedProduct.sellerKey);
  if (!seller) throw new Error(`Missing seller for ${seedProduct.key}`);

  const productId = `${ID_PREFIX}prod_${seedProduct.key}`;
  const currency = SELLERS.find((entry) => entry.key === seedProduct.sellerKey)?.currency ?? "USD";
  const plan = orderPlanFor(seedProduct.fixture);

  const windows: readonly {
    readonly count: number;
    readonly minDay: number;
    readonly maxDay: number;
  }[] = [
    { count: plan.w1, minDay: 1, maxDay: 7 },
    { count: plan.w2, minDay: 8, maxDay: 14 },
    { count: plan.tail, minDay: 15, maxDay: seedProduct.fixture === "stale_surge" ? 24 : 90 },
  ];

  let sequence = 0;

  for (const window of windows) {
    for (let index = 0; index < window.count; index += 1) {
      sequence += 1;

      /*
       * The self-dealing fixture buys from ITSELF — the seller's own organization acting as
       * buyer. `issueCompletionsForOrder` already refuses to mint a completion for such an
       * order, and this makes sure the velocity path refuses it too rather than relying on
       * a downstream table to notice.
       */
      const buyer =
        seedProduct.fixture === "self_dealing" ? seller : pickOne([...context.buyerByKey.values()]);

      const confirmedAt = daysAgo(randomInteger(window.minDay, window.maxDay));
      const createdAt = new Date(confirmedAt.getTime() - MILLISECONDS_PER_DAY);

      const quantity =
        seedProduct.fixture === "penny_spam" ? randomInteger(1, 2) : randomInteger(4, 60);
      const unitPriceInCents = seedProduct.priceInCents;
      const lineTotalInCents = quantity * unitPriceInCents;

      const suffix = `${seedProduct.key}_${sequence}`;
      const prepareId = `${ID_PREFIX}prep_${suffix}`;
      const groupId = `${ID_PREFIX}grp_${suffix}`;
      const orderId = `${ID_PREFIX}order_${suffix}`;

      // ONE CART PER BUYER ORGANIZATION — `commerce_cart_buyer_uidx` enforces it, which is
      // correct (a cart is a workspace, not a receipt) and means the seed cannot mint one
      // per order. Every prepare row for a buyer therefore points at that buyer's single
      // cart, which is also what the real checkout path does.
      const cartId = await ensureCartForBuyer(buyer.organizationId, createdAt);

      await db
        .insert(commerceCheckoutPrepare)
        .values({
          id: prepareId,
          cartId,
          buyerOrganizationId: buyer.organizationId,
          state: "consumed",
          expiresAt: new Date(createdAt.getTime() + MILLISECONDS_PER_DAY),
          createdByMemberId: buyer.memberId,
          createdAt,
        })
        .onConflictDoNothing({ target: commerceCheckoutPrepare.id });

      await db
        .insert(commerceCheckoutGroup)
        .values({
          id: groupId,
          buyerOrganizationId: buyer.organizationId,
          checkoutPrepareId: prepareId,
          state: "confirmed",
          createdByMemberId: buyer.memberId,
          createdAt,
        })
        .onConflictDoNothing({ target: commerceCheckoutGroup.id });

      /*
       * Outcome mix. A few orders cancel and a few refund, so the negative-signal rates in
       * refinement 10 have something to measure — and the click-farm fixture refunds far
       * more often, because a farm's orders do not survive contact with fulfillment.
       */
      const outcomeRoll = nextRandom();
      const isCancelled = outcomeRoll < (seedProduct.fixture === "click_farm" ? 0.3 : 0.06);
      const isRefunded =
        !isCancelled && outcomeRoll < (seedProduct.fixture === "click_farm" ? 0.55 : 0.09);
      const completedAt = isCancelled
        ? null
        : new Date(confirmedAt.getTime() + randomInteger(2, 20) * MILLISECONDS_PER_DAY);
      // Nothing completes in the future: a completion after `asOf` would be a fact about a
      // day that has not happened.
      const boundedCompletedAt =
        completedAt !== null && completedAt.getTime() > asOf.getTime() ? null : completedAt;

      /*
       * THE VERDICT IS COMPUTED BY THE REAL FUNCTION, and it is computed BEFORE the insert.
       *
       * Before: because `commerce_prevent_order_snapshot_mutation` refuses to let an order's
       * commercial snapshot be rewritten after creation — correctly, since §2.2 makes an
       * accepted order immutable — so a seed that inserted first and stamped second was
       * rejected by the database. Confirmation is exactly where the real path stamps it too.
       *
       * By the real function: so the seed exercises `evaluateBuyerQualification` against
       * every fixture. A bug in the bar then shows up as implausible seeded data rather than
       * waiting for production traffic to meet it.
       *
       * Passing `orderId` for a row that does not exist yet is intentional — the prior-order
       * query excludes that id, and excluding a row that is absent is a no-op.
       */
      const verdict = await evaluateBuyerQualification(db, {
        buyerOrganizationId: buyer.organizationId,
        actingUserId: buyer.userId,
        orderId,
        isSampleOnlyOrder: false,
        occurredAt: confirmedAt,
      });

      await db
        .insert(commerceOrder)
        .values({
          id: orderId,
          buyerQualificationState: verdict.state,
          buyerQualificationReasons: [...verdict.reasons],
          buyerOrganizationId: buyer.organizationId,
          counterpartyOrganizationId: seller.organizationId,
          checkoutGroupId: groupId,
          source: "direct_checkout",
          state: isCancelled
            ? "cancelled"
            : boundedCompletedAt !== null
              ? "completed"
              : "confirmed",
          currency,
          subtotalInCents: lineTotalInCents,
          totalInCents: lineTotalInCents,
          buyerLegalNameSnapshot: buyer.legalName,
          counterpartyLegalNameSnapshot: seller.legalName,
          promisedDeliveryAt: new Date(confirmedAt.getTime() + 30 * MILLISECONDS_PER_DAY),
          confirmedAt,
          completedAt: isCancelled ? null : boundedCompletedAt,
          cancelledAt: isCancelled ? new Date(confirmedAt.getTime() + MILLISECONDS_PER_DAY) : null,
          createdByMemberId: buyer.memberId,
          createdAt,
        })
        .onConflictDoNothing({ target: commerceOrder.id });

      await db
        .insert(commerceOrderProductLine)
        .values({
          id: `${ID_PREFIX}line_${suffix}`,
          orderId,
          productId,
          titleSnapshot: seedProduct.title,
          specificationSnapshot: `devseed fixture: ${seedProduct.fixture}`,
          isSample: false,
          quantityOrdered: quantity,
          quantityFulfilled: isCancelled ? 0 : quantity,
          quantityCancelled: isCancelled ? quantity : 0,
          quantityRefunded: isRefunded ? quantity : 0,
          unitPriceInCents,
          lineTotalInCents,
          promisedDeliveryAt: new Date(confirmedAt.getTime() + 30 * MILLISECONDS_PER_DAY),
          siblingOrder: 0,
          createdAt,
        })
        .onConflictDoNothing({ target: commerceOrderProductLine.id });

      if (isRefunded) {
        counters.refunds += 1;
      }
      if (isCancelled) counters.cancellations += 1;
      counters.orders += 1;
    }
  }
}

/**
 * Views, saves and shares.
 *
 * The subnet hashes here are FABRICATED STRINGS, not real hashes — the seed has no client
 * addresses to hash and inventing an IP to feed through `computeClientSubnetHash` would
 * only obscure that. What matters to the guard is the DISTRIBUTION of distinct 64-hex
 * values, which is exactly what the fixtures below control.
 */
function fabricatedSubnetHash(label: string): string {
  // Indexed rather than spread: every label here is ASCII, and spreading a string yields
  // code points, which oxlint rightly refuses because it silently splits anything that is
  // not. A seed's fixture keys are ASCII today and nobody should have to remember that.
  let seed = 7;
  for (let index = 0; index < label.length; index += 1) {
    seed += label.charCodeAt(index);
  }

  // A 64-character lowercase hex string, which is what the CHECK constraint demands.
  let hash = "";
  const source = createSeededRandom(seed);
  while (hash.length < 64) hash += Math.floor(source() * 16).toString(16);
  return hash.slice(0, 64);
}

async function seedEngagementForProduct(
  seedProduct: SeedProduct,
  buyerUserIds: readonly string[],
  counters: { views: number; saves: number; shares: number },
): Promise<void> {
  const productId = `${ID_PREFIX}prod_${seedProduct.key}`;

  /** How many counted view sessions, and how concentrated their networks are. */
  const viewPlan = ((): { readonly total: number; readonly dominantShare: number } => {
    switch (seedProduct.fixture) {
      case "honest_bestseller":
        return { total: 260, dominantShare: 0.12 };
      case "spike_no_conversion":
        // The spike: a great deal of attention, almost no orders behind it.
        return { total: 900, dominantShare: 0.2 };
      case "click_farm":
        return { total: 120, dominantShare: 0.95 };
      case "corporate_nat":
        // Same concentration as the farm. The ONLY thing distinguishing them is that these
        // buyers hold a verified business domain — which is the exemption that does not
        // exist yet, and the reason the penalty carries a floor.
        return { total: 110, dominantShare: 0.93 };
      case "stale_surge":
        return { total: 40, dominantShare: 0.15 };
      default:
        return { total: randomInteger(40, 180), dominantShare: 0.18 };
    }
  })();

  const dominantSubnet = fabricatedSubnetHash(`${seedProduct.key}-dominant`);

  for (let index = 0; index < viewPlan.total; index += 1) {
    // A stale surge's attention is as old as its orders.
    const dayOffset =
      seedProduct.fixture === "stale_surge" ? randomInteger(18, 26) : randomInteger(1, 30);
    const observedAt = daysAgo(dayOffset);
    const subnetHash =
      nextRandom() < viewPlan.dominantShare
        ? dominantSubnet
        : fabricatedSubnetHash(`${seedProduct.key}-${index % 40}`);

    // Signed-in for roughly half, because an anonymous session counts as a view and never
    // as a conversion — the seed needs both populations to exercise that gate.
    const viewerId = nextRandom() < 0.5 ? pickOne(buyerUserIds) : null;

    await db
      .insert(commerceProductViewSession)
      .values({
        id: `${ID_PREFIX}view_${seedProduct.key}_${index}`,
        productId,
        viewerId,
        viewerFingerprint: fabricatedSubnetHash(`${seedProduct.key}-fp-${index}`),
        viewDayBucket: utcDayStringOf(observedAt),
        viewSource: pickOne(["product_detail", "search", "rail", "companion"] as const),
        subnetHash,
        dwellSeconds: randomInteger(6, 240),
        isCountedView: true,
        firstBeaconAt: observedAt,
        lastBeaconAt: new Date(observedAt.getTime() + 60_000),
      })
      .onConflictDoNothing();
    counters.views += 1;
  }

  await db
    .update(commerceProductStats)
    .set({ viewCount: viewPlan.total })
    .where(eq(commerceProductStats.productId, productId));

  /*
   * Saves: one row per user per product. The click-farm and corporate-NAT fixtures need a
   * dense sample to express concentration at all, so they save from nearly everyone; the
   * rest sample lightly, which is what an ordinary listing looks like.
   */
  const saveParticipation =
    seedProduct.fixture === "click_farm" || seedProduct.fixture === "corporate_nat" ? 0.95 : 0.35;
  let savedCount = 0;
  for (const [index, buyerUserId] of buyerUserIds.entries()) {
    if (nextRandom() > saveParticipation) continue;
    const inserted = await db
      .insert(commerceProductEngagement)
      .values({
        productId,
        userId: buyerUserId,
        engagementKind: "saved",
        subnetHash:
          nextRandom() < viewPlan.dominantShare
            ? dominantSubnet
            : fabricatedSubnetHash(`${seedProduct.key}-save-${index}`),
        createdAt: daysAgo(randomInteger(1, 25)),
      })
      .onConflictDoNothing()
      .returning({ productId: commerceProductEngagement.productId });
    if (inserted.length > 0) savedCount += 1;
  }

  await db
    .update(commerceProductStats)
    .set({ savedCount })
    .where(eq(commerceProductStats.productId, productId));
  counters.saves += savedCount;

  // Shares, respecting the Phase 13 rule: signed-in only, one per user per day, counted.
  let shareCount = 0;
  for (const [index, buyerUserId] of buyerUserIds.entries()) {
    if (nextRandom() > 0.4) continue;
    const sharedAt = daysAgo(randomInteger(1, 25));
    const inserted = await db
      .insert(commerceProductShare)
      .values({
        id: `${ID_PREFIX}share_${seedProduct.key}_${index}`,
        productId,
        userId: buyerUserId,
        shareDayBucket: utcDayStringOf(sharedAt),
        subnetHash: fabricatedSubnetHash(`${seedProduct.key}-share-${index}`),
        counted: true,
        createdAt: sharedAt,
      })
      .onConflictDoNothing()
      .returning({ id: commerceProductShare.id });
    if (inserted.length > 0) shareCount += 1;
  }

  await db
    .update(commerceProductStats)
    .set({ shareCount })
    .where(eq(commerceProductStats.productId, productId));
  counters.shares += shareCount;
}

async function seedEmailDomains(): Promise<void> {
  for (const buyer of BUYERS) {
    const classification =
      buyer.key === "driftmail" ? "disposable" : buyer.verified ? "verified_business" : "unknown";

    // `unknown` is the ABSENCE of a row, never a stored value — storing it would make an
    // unclassified domain look assessed.
    if (classification === "unknown") continue;

    await db
      .insert(commerceBusinessEmailDomain)
      .values({
        domain: buyer.emailDomain,
        classification,
        sourceNote: "devseed: fixture classification for ranking development",
      })
      .onConflictDoNothing({ target: commerceBusinessEmailDomain.domain });
  }
}

async function main(): Promise<void> {
  const options = parseArguments();

  console.log("seed-store-ranking-dev");
  if (options.reset) await resetSeed();
  await refuseIfAlreadySeeded();

  staffUserId = await ensureUser("staff@devseed.example", "Devseed Staff", daysAgo(HISTORY_DAYS));

  const categoryIdByKey = await seedCategories();

  const sellerByKey = new Map<string, SeededOrganization>();
  for (const seller of SELLERS) {
    sellerByKey.set(
      seller.key,
      await seedOrganization({
        key: seller.key,
        legalName: seller.legalName,
        countryCode: seller.countryCode,
        accountAgeDays: HISTORY_DAYS,
        emailDomain: "sellers-devseed.example",
        verified: seller.verified,
        hasTaxIdentifier: seller.verified,
        role: "seller",
      }),
    );
  }

  const buyerByKey = new Map<string, SeededOrganization>();
  for (const buyer of BUYERS) {
    buyerByKey.set(
      buyer.key,
      await seedOrganization({
        key: buyer.key,
        legalName: buyer.legalName,
        countryCode: buyer.countryCode,
        accountAgeDays: buyer.accountAgeDays,
        emailDomain: buyer.emailDomain,
        verified: buyer.verified,
        hasTaxIdentifier: buyer.hasTaxIdentifier,
        role: "buyer",
      }),
    );
  }
  console.log(`  organizations: ${SELLERS.length} sellers, ${BUYERS.length} buyers`);

  await seedEmailDomains();

  /*
   * The ONE exclusion. The self-dealing seller is registered so the exclusion path has real
   * coverage; excluding the rest would make every seeded order unqualified and leave the
   * ranking engine with the empty input this script exists to fill.
   */
  const selfDealingSeller = sellerByKey.get("kestrel");
  if (selfDealingSeller) {
    await db
      .insert(commerceOrganizationRankingExclusion)
      .values({
        organizationId: selfDealingSeller.organizationId,
        reason: "devseed: self-dealing fixture, exercises the exclusion path",
      })
      .onConflictDoNothing({ target: commerceOrganizationRankingExclusion.organizationId });
  }

  await seedProducts(categoryIdByKey, sellerByKey);

  const orderCounters = { orders: 0, refunds: 0, cancellations: 0 };
  for (const seedProduct of PRODUCTS) {
    await seedOrdersForProduct(seedProduct, { buyerByKey, sellerByKey }, orderCounters);
  }
  console.log(
    `  orders: ${orderCounters.orders} (${orderCounters.cancellations} cancelled, ${orderCounters.refunds} refunded)`,
  );

  /*
   * A POPULATION, not just the five order-placing accounts.
   *
   * `commerce_product_engagement` is keyed `(productId, userId, engagementKind)`, so one
   * user can save a product exactly once — which means the number of saves a fixture can
   * express is bounded by the number of users that exist. With only the five buyer owners,
   * the click-farm fixture could show "4 of 4 saves from one subnet", which is not the
   * signal it is meant to demonstrate: concentration over a sample that small is
   * indistinguishable from coincidence, and the guard's own minimum-sample rule would
   * skip it.
   *
   * These accounts place no orders. They exist to give the save and share signals a
   * realistic population, which is what makes the subnet fixtures meaningful.
   */
  const engagementUserIds: string[] = [];
  for (let index = 0; index < ENGAGEMENT_USER_COUNT; index += 1) {
    engagementUserIds.push(
      await ensureUser(
        `engager-${index}@engagers-devseed.example`,
        `Devseed Engager ${index}`,
        daysAgo(randomInteger(20, HISTORY_DAYS)),
      ),
    );
  }

  const buyerUserIds = [
    ...[...buyerByKey.values()].map((buyer) => buyer.userId),
    ...engagementUserIds,
  ];
  const engagementCounters = { views: 0, saves: 0, shares: 0 };
  for (const seedProduct of PRODUCTS) {
    await seedEngagementForProduct(seedProduct, buyerUserIds, engagementCounters);
  }
  console.log(
    `  engagement: ${engagementCounters.views} views, ${engagementCounters.saves} saves, ${engagementCounters.shares} shares`,
  );

  const [qualified] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(commerceOrder)
    .where(
      and(
        like(commerceOrder.id, `${ID_PREFIX}%`),
        eq(commerceOrder.buyerQualificationState, "qualified"),
      ),
    );
  console.log(`  qualified orders: ${qualified?.total ?? 0} of ${orderCounters.orders}`);
  console.log("done.");
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
