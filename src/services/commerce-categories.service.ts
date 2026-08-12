/**
 * The store's browse taxonomy — `commerce_category` — and the seller requests that grow it.
 *
 * WHAT MAKES THIS DOMAIN DIFFERENT. A category has no member owner. `product` belongs to a
 * seller and `research_project` to a founder, so both answer 404 when a caller asks about a
 * row they do not own — the id must not be probeable. A category belongs to the platform:
 * there is nothing to own, so there is nothing to hide, and the entire gate is
 * `moderate_commerce`, checked before any id is read.
 *
 * THE ORDERING RULE IS NOT OPTIONAL (platform-role.service.ts). Capability first, resource
 * second, in every staff function below. Reversed, a 404-vs-403 difference turns each route
 * into an id oracle for anyone holding a session.
 *
 * WHY `moderate_commerce` AND NOT `manage_promotions`. Both are front-of-store, but a
 * promotional slide may point at an arbitrary external https URL and only `admin` holds
 * that. A category is internal structure over the catalogue, which is the moderator's
 * ordinary job — the same capability that already gates pathway moderation and commerce
 * content reports.
 *
 * SELLER REQUESTS ARE THE ONE UNGATED WRITE, and they do not touch this table. A request
 * lands in `commerce_category_request` and mints nothing; only a verdict creates a
 * category. That separation is what lets a seller publish immediately (parked in `misc`)
 * without their unreviewed wording ever appearing on the storefront.
 *
 * IMAGES live at a DETERMINISTIC Cloudinary public id derived from the category id, so a
 * replace overwrites in place and cannot orphan the previous asset — which is also why
 * there is no `cloudinaryPublicId` column to drift. The returned secure_url must be written
 * back on every upload; its `/v<timestamp>/` segment is the cache bust.
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceCategory, commerceCategoryRequest, product } from "#src/db/schema.js";
import { uploadCommerceCategoryImage, type CloudinaryError } from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { recordPlatformAction } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Where a listing waits while the category it asked for is being reviewed. Seeded by
 * migration 0098 with a fixed id, so this is a constant rather than a lookup.
 */
export const MISC_CATEGORY_ID = "commerce_category_misc";

/**
 * How many roots the store home rail renders.
 *
 * A PRODUCT DECISION about a finite strip of attention, enforced by the caller passing
 * `limit`, not by the table. `/store/categories` still lists everything — this bounds one
 * surface, not the taxonomy.
 */
export const HOME_RAIL_CATEGORY_LIMIT = 8;

/**
 * The output box for a category tile. A tile renders at most ~400 CSS px wide (the rail is
 * eight across at `xl`), so 1200 covers it at 3×. Smaller than the promotional slide's 2400
 * because a slide renders full-bleed and a tile does not.
 */
const CATEGORY_OUTPUT_MAX_DIMENSION_PX = 1200;

export type CommerceCategoryError =
  | PlatformAccessError
  | { type: "COMMERCE_CATEGORY_NOT_FOUND"; categoryId: string }
  | { type: "COMMERCE_CATEGORY_SLUG_TAKEN"; slug: string }
  | { type: "COMMERCE_CATEGORY_PARENT_NOT_FOUND"; parentCategoryId: string }
  | { type: "COMMERCE_CATEGORY_PARENT_CYCLE"; categoryId: string }
  | { type: "COMMERCE_CATEGORY_ORDER_MISMATCH" }
  | { type: "COMMERCE_CATEGORY_HAS_CHILDREN"; categoryId: string; childCount: number }
  | { type: "COMMERCE_CATEGORY_IN_USE"; categoryId: string; productCount: number }
  | { type: "COMMERCE_CATEGORY_PROTECTED"; categoryId: string }
  | { type: "COMMERCE_CATEGORY_REQUEST_NOT_FOUND"; requestId: string }
  | {
      type: "COMMERCE_CATEGORY_REQUEST_ALREADY_DECIDED";
      requestId: string;
      state: "approved" | "rejected";
    }
  | { type: "COMMERCE_CATEGORY_ASSIGNMENT_INVALID"; productId: string }
  | ImageValidationError
  | CloudinaryError;

/**
 * What a VISITOR sees.
 *
 * `siblingOrder` IS included here, unlike the promotional carousel which hides `position`.
 * The difference is real: a carousel is one ordered strip and the array order is the whole
 * contract, whereas a category tree is fetched a level at a time and merged, and a client
 * that has to stitch two levels together needs the key they were ordered by. `state` is
 * still absent — a visitor only ever receives active rows.
 */
export interface PublicCommerceCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly parentCategoryId: string | null;
  readonly siblingOrder: number;
  readonly imageUrl: string | null;
}

/** What the admin console sees — including draft and retired rows, and how used each is. */
export interface AdminCommerceCategory extends PublicCommerceCategory {
  readonly state: "draft" | "active" | "retired";
  readonly searchSynonyms: readonly string[];
  readonly childCount: number;
  readonly productCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One seller request, as the moderation queue renders it. */
export interface CommerceCategoryRequestView {
  readonly id: string;
  readonly requestedByUserId: string | null;
  readonly requestedOrganizationId: string | null;
  readonly proposedName: string;
  readonly proposedParentCategoryId: string | null;
  readonly justification: string | null;
  readonly state: "pending" | "approved" | "rejected";
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  readonly resultingCategoryId: string | null;
  /**
   * The listings this request would rehome, NAMED rather than counted.
   *
   * A count would tell a moderator how many listings move; the titles are what let them
   * decide that one of them plainly belongs in a category that already exists and route it
   * there via `productAssignments`. That is the whole reason the decide route takes
   * per-product overrides, and a count-only queue would leave that route unreachable.
   *
   * Drawn from the request LINK, never from "everything in misc" — that distinction is why
   * `product.pendingCategoryRequestId` exists.
   */
  readonly waitingProducts: readonly { readonly id: string; readonly title: string }[];
  readonly createdAt: Date;
}

const PUBLIC_VIEW_COLUMNS = {
  id: commerceCategory.id,
  slug: commerceCategory.slug,
  name: commerceCategory.name,
  parentCategoryId: commerceCategory.parentCategoryId,
  siblingOrder: commerceCategory.siblingOrder,
  imageUrl: commerceCategory.imageUrl,
} as const;

const ADMIN_SCALAR_COLUMNS = {
  ...PUBLIC_VIEW_COLUMNS,
  state: commerceCategory.state,
  searchSynonyms: commerceCategory.searchSynonyms,
  createdAt: commerceCategory.createdAt,
  updatedAt: commerceCategory.updatedAt,
} as const;

export interface CreateCommerceCategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly parentCategoryId: string | null;
  readonly searchSynonyms: readonly string[];
  readonly state: "draft" | "active";
}

export interface UpdateCommerceCategoryInput {
  readonly name?: string;
  readonly parentCategoryId?: string | null;
  readonly searchSynonyms?: readonly string[];
  readonly state?: "draft" | "active" | "retired";
}

export interface SubmitCommerceCategoryRequestInput {
  readonly proposedName: string;
  readonly proposedParentCategoryId: string | null;
  readonly justification: string | null;
}

/**
 * How the moderator answers a request.
 *
 * `productAssignments` is on BOTH arms deliberately. Approving usually moves every waiting
 * listing into the new category, but a moderator reading the queue can see that one of them
 * plainly belongs somewhere that already exists — and rejecting a request still leaves real
 * listings parked in `misc` that deserve a home. Entries here override the default target
 * per product; anything unlisted follows the arm's default.
 */
export type DecideCommerceCategoryRequestInput =
  | {
      readonly decision: "approve";
      /** The moderator's edit of the seller's wording. Absent keeps the proposal. */
      readonly name?: string;
      readonly slug: string;
      readonly parentCategoryId?: string | null;
      readonly note?: string;
      readonly productAssignments?: readonly { productId: string; categoryId: string }[];
    }
  | {
      readonly decision: "reject";
      readonly note: string;
      readonly productAssignments?: readonly { productId: string; categoryId: string }[];
    };

// ---------------------------------------------------------------------------
// STAFF READS
//
// THERE ARE NO PUBLIC READS IN THIS FILE. `GET /store/categories` and its detail route
// already live in `store-catalog.service.ts`, where the detail read also assembles facets
// and the first page of products. A second public list here would be two endpoints
// answering the same question differently, and the storefront would eventually be reading
// the poorer one. `listActiveCategories` there grew a `limit` for the home rail instead.
// ---------------------------------------------------------------------------

/**
 * Attach the two counts the admin list needs. Done as one grouped query per relation rather
 * than a correlated subquery per row, so the page cost does not scale with the tree.
 */
async function withUsageCounts(
  rows: readonly (Omit<AdminCommerceCategory, "childCount" | "productCount"> & {
    readonly searchSynonyms: readonly string[];
  })[],
): Promise<readonly AdminCommerceCategory[]> {
  if (rows.length === 0) return [];
  const categoryIds = rows.map((row) => row.id);

  const childCounts = await db
    .select({
      parentCategoryId: commerceCategory.parentCategoryId,
      total: sql<number>`count(*)::int`,
    })
    .from(commerceCategory)
    .where(inArray(commerceCategory.parentCategoryId, categoryIds))
    .groupBy(commerceCategory.parentCategoryId);

  const productCounts = await db
    .select({ categoryId: product.categoryId, total: sql<number>`count(*)::int` })
    .from(product)
    .where(inArray(product.categoryId, categoryIds))
    .groupBy(product.categoryId);

  const childCountByParentId = new Map(
    childCounts.map((entry) => [entry.parentCategoryId, entry.total]),
  );
  const productCountByCategoryId = new Map(
    productCounts.map((entry) => [entry.categoryId, entry.total]),
  );

  return rows.map((row) => ({
    ...row,
    childCount: childCountByParentId.get(row.id) ?? 0,
    productCount: productCountByCategoryId.get(row.id) ?? 0,
  }));
}

/**
 * `GET /commerce/admin/categories` — the WHOLE tree, every state.
 *
 * Unpaginated on purpose: the taxonomy is staff-authored and bounded, and an admin
 * reordering siblings needs to see all of them at once. Ordered parent-first so a client can
 * build the tree in one pass.
 */
export async function listCommerceCategoriesForStaff(
  actorUserId: string,
): Promise<Result<readonly AdminCommerceCategory[], CommerceCategoryError>> {
  // CAPABILITY FIRST. The admin list is gated too — it exposes draft and retired rows.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select(ADMIN_SCALAR_COLUMNS)
    .from(commerceCategory)
    .orderBy(asc(commerceCategory.siblingOrder), asc(commerceCategory.id));

  return { success: true, value: await withUsageCounts(rows) };
}

// ---------------------------------------------------------------------------
// STAFF WRITES
// ---------------------------------------------------------------------------

/** Resolve the parent for a create/update, proving it exists and is not the row itself. */
async function validateParent(
  parentCategoryId: string | null,
  selfCategoryId: string | null,
): Promise<Result<null, CommerceCategoryError>> {
  if (parentCategoryId === null) return { success: true, value: null };
  if (selfCategoryId !== null && parentCategoryId === selfCategoryId) {
    return {
      success: false,
      error: { type: "COMMERCE_CATEGORY_PARENT_CYCLE", categoryId: selfCategoryId },
    };
  }

  const [parentRow] = await db
    .select({ id: commerceCategory.id, parentCategoryId: commerceCategory.parentCategoryId })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, parentCategoryId))
    .limit(1);
  if (!parentRow) {
    return {
      success: false,
      error: { type: "COMMERCE_CATEGORY_PARENT_NOT_FOUND", parentCategoryId },
    };
  }

  // Walk up from the proposed parent. Re-parenting a node under its own descendant would
  // detach that whole branch from the tree with no error from the FK, which only forbids
  // a row being its own direct parent.
  if (selfCategoryId !== null) {
    let ancestorId = parentRow.parentCategoryId;
    while (ancestorId !== null) {
      if (ancestorId === selfCategoryId) {
        return {
          success: false,
          error: { type: "COMMERCE_CATEGORY_PARENT_CYCLE", categoryId: selfCategoryId },
        };
      }
      const [ancestorRow] = await db
        .select({ parentCategoryId: commerceCategory.parentCategoryId })
        .from(commerceCategory)
        .where(eq(commerceCategory.id, ancestorId))
        .limit(1);
      if (!ancestorRow) break;
      ancestorId = ancestorRow.parentCategoryId;
    }
  }

  return { success: true, value: null };
}

/** The next free `siblingOrder` under a parent. Appends; order changes only via reorder. */
async function nextSiblingOrder(parentCategoryId: string | null): Promise<number> {
  const [highest] = await db
    .select({ value: sql<number | null>`max(${commerceCategory.siblingOrder})` })
    .from(commerceCategory)
    .where(
      parentCategoryId === null
        ? isNull(commerceCategory.parentCategoryId)
        : eq(commerceCategory.parentCategoryId, parentCategoryId),
    );
  return (highest?.value ?? -1) + 1;
}

async function isSlugTaken(slug: string, exceptCategoryId: string | null): Promise<boolean> {
  const [row] = await db
    .select({ id: commerceCategory.id })
    .from(commerceCategory)
    .where(
      exceptCategoryId === null
        ? eq(commerceCategory.slug, slug)
        : and(eq(commerceCategory.slug, slug), ne(commerceCategory.id, exceptCategoryId)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * `POST /commerce/admin/categories` — mints a category, optionally with its tile image.
 *
 * WHY THE ID IS MINTED BEFORE THE ROW EXISTS. The Cloudinary public id is derived from the
 * category id, but the insert has not happened yet. Generate the uuid here, upload to that
 * id, then insert with it — the alternative, insert-then-upload-then-update, leaves an
 * image-less row visible to the admin list whenever the upload fails.
 *
 * A failed insert after a successful upload leaves ONE orphaned asset. Accepted, and
 * reclaimable precisely because the id is deterministic; every upload path here trades the
 * same way.
 *
 * THE IMAGE IS OPTIONAL. `misc` ships without one and `image_url` is nullable, so requiring
 * art to create a category would be a stricter rule than the schema's.
 */
export async function createCommerceCategory(
  actorUserId: string,
  input: CreateCommerceCategoryInput,
  rawImageBytes: Buffer | null,
): Promise<Result<AdminCommerceCategory, CommerceCategoryError>> {
  // 1. CAPABILITY FIRST — before the body is even looked at.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Cheap validation before the expensive image work.
  if (await isSlugTaken(input.slug, null)) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_SLUG_TAKEN", slug: input.slug } };
  }
  const parentResult = await validateParent(input.parentCategoryId, null);
  if (!parentResult.success) return { success: false, error: parentResult.error };

  const categoryId = randomUUID();

  // 3. Prove the bytes are a real image and re-encode them (strips EXIF, refuses bombs).
  let imageUrl: string | null = null;
  if (rawImageBytes !== null) {
    const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
      outputMaxDimensionPx: CATEGORY_OUTPUT_MAX_DIMENSION_PX,
      outputFormat: "avif",
    });
    if (!normalizedResult.success) {
      return { success: false, error: normalizedResult.error };
    }
    const uploadResult = await uploadCommerceCategoryImage(
      categoryId,
      normalizedResult.value.buffer,
    );
    if (!uploadResult.success) {
      return { success: false, error: uploadResult.error };
    }
    imageUrl = uploadResult.value.secureUrl;
  }

  const siblingOrder = await nextSiblingOrder(input.parentCategoryId);

  const [inserted] = await recordPlatformAction(
    async (tx) =>
      tx
        .insert(commerceCategory)
        .values({
          id: categoryId,
          slug: input.slug,
          name: input.name,
          parentCategoryId: input.parentCategoryId,
          siblingOrder,
          state: input.state,
          imageUrl,
          searchSynonyms: [...input.searchSynonyms],
        })
        .returning(ADMIN_SCALAR_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "commerce_category_created",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Created a store category",
            targetLabel: `commerce category ${input.slug}`,
            payload: {
              categoryId,
              slug: input.slug,
              parentCategoryId: input.parentCategoryId,
              state: input.state,
            },
            occurredAt: new Date(),
          },
  );

  if (!inserted) {
    throw new Error("createCommerceCategory: insert returned no row");
  }
  const [view] = await withUsageCounts([inserted]);
  if (!view) throw new Error("createCommerceCategory: usage counts returned no row");
  return { success: true, value: view };
}

/**
 * `PATCH /commerce/admin/categories/:categoryId` — name, parent, synonyms, state.
 *
 * `slug` IS NOT HERE, and that is the point. A slug is a public URL identity: it is linked,
 * bookmarked and indexed the moment the category is published, and renaming it silently
 * breaks every one of those. A category that needs a different slug is a new category.
 *
 * `siblingOrder` is not here either — order is changed only through `reorderCommerceCategories`,
 * which rewrites a whole sibling set at once. A per-row order write would let two siblings
 * claim the same slot with no way to say which the admin meant, and the unique index would
 * reject the second one at random.
 */
export async function updateCommerceCategory(
  actorUserId: string,
  categoryId: string,
  input: UpdateCommerceCategoryInput,
): Promise<Result<AdminCommerceCategory, CommerceCategoryError>> {
  // 1. CAPABILITY FIRST — before `categoryId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select(ADMIN_SCALAR_COLUMNS)
    .from(commerceCategory)
    .where(eq(commerceCategory.id, categoryId))
    .limit(1);
  if (!existing) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_NOT_FOUND", categoryId } };
  }

  if (input.parentCategoryId !== undefined) {
    const parentResult = await validateParent(input.parentCategoryId, categoryId);
    if (!parentResult.success) return { success: false, error: parentResult.error };
  }

  // Retiring is a state change like any other here, but it carries the same two guards the
  // dedicated retire route applies — a category with children or listings under it cannot
  // vanish from browse and strand them.
  if (input.state === "retired" && existing.state !== "retired") {
    const blockResult = await assertRetirable(categoryId);
    if (!blockResult.success) return { success: false, error: blockResult.error };
  }

  const scalarUpdates: Record<string, unknown> = {};
  if (input.name !== undefined) scalarUpdates.name = input.name;
  if (input.parentCategoryId !== undefined) {
    scalarUpdates.parentCategoryId = input.parentCategoryId;
    // Moving to a new parent means the old sibling slot is vacated and a new one is taken.
    // Appending is the only safe answer: the target set's existing order is not this
    // request's business, and the unique index forbids reusing an occupied slot.
    if (input.parentCategoryId !== existing.parentCategoryId) {
      scalarUpdates.siblingOrder = await nextSiblingOrder(input.parentCategoryId);
    }
  }
  if (input.searchSynonyms !== undefined) scalarUpdates.searchSynonyms = [...input.searchSynonyms];
  if (input.state !== undefined) scalarUpdates.state = input.state;

  if (Object.keys(scalarUpdates).length === 0) {
    const [unchanged] = await withUsageCounts([existing]);
    if (!unchanged) throw new Error("updateCommerceCategory: usage counts returned no row");
    return { success: true, value: unchanged };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(commerceCategory)
        .set(scalarUpdates)
        .where(eq(commerceCategory.id, categoryId))
        .returning(ADMIN_SCALAR_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind:
              input.state === "retired" && existing.state !== "retired"
                ? "commerce_category_retired"
                : "commerce_category_updated",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel:
              input.state === "retired" && existing.state !== "retired"
                ? "Retired a store category"
                : "Updated a store category",
            targetLabel: `commerce category ${existing.slug}`,
            payload: { categoryId, changedFields: Object.keys(scalarUpdates) },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    throw new Error("updateCommerceCategory: update returned no row");
  }
  const [view] = await withUsageCounts([updated]);
  if (!view) throw new Error("updateCommerceCategory: usage counts returned no row");
  return { success: true, value: view };
}

/**
 * `PATCH /commerce/admin/categories/:categoryId/image` — replaces the tile art.
 *
 * The upload overwrites in place at the deterministic public id, so there is no previous
 * asset to clean up. The row must still be updated: the new `secure_url` carries a fresh
 * `/v<timestamp>/` segment, and keeping the stored URL would serve the old tile forever.
 */
export async function replaceCommerceCategoryImage(
  actorUserId: string,
  categoryId: string,
  rawImageBytes: Buffer,
): Promise<Result<AdminCommerceCategory, CommerceCategoryError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second — and before the expensive decode, so a bad id is cheap.
  const [existing] = await db
    .select({ id: commerceCategory.id, slug: commerceCategory.slug })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, categoryId))
    .limit(1);
  if (!existing) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_NOT_FOUND", categoryId } };
  }

  const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: CATEGORY_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedResult.success) {
    return { success: false, error: normalizedResult.error };
  }

  const uploadResult = await uploadCommerceCategoryImage(categoryId, normalizedResult.value.buffer);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(commerceCategory)
        .set({ imageUrl: uploadResult.value.secureUrl })
        .where(eq(commerceCategory.id, categoryId))
        .returning(ADMIN_SCALAR_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "commerce_category_image_replaced",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Replaced a store category image",
            targetLabel: `commerce category ${existing.slug}`,
            payload: { categoryId },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    throw new Error("replaceCommerceCategoryImage: update returned no row");
  }
  const [view] = await withUsageCounts([updated]);
  if (!view) throw new Error("replaceCommerceCategoryImage: usage counts returned no row");
  return { success: true, value: view };
}

/**
 * `PATCH /commerce/admin/categories/reorder` — sets a whole sibling set's order at once.
 *
 * `categoryIds` must be an EXACT PERMUTATION of every category under that parent, in every
 * state. Anything else is a mismatch, never a partial apply: a client working from a stale
 * list would otherwise silently drop whichever sibling it had not seen yet to the end.
 *
 * THE TWO-PASS REWRITE IS NOT OPTIONAL. `commerce_category_siblingOrder_uidx` is UNIQUE per
 * parent, unlike `promotional_slide.position` which carries no unique index precisely so its
 * loop can assign in place. Writing 0,1,2… directly here would collide with whichever row
 * still holds the target value.
 *
 * The parking range is ABOVE the current maximum, not below zero: `commerce_category_shape_ck`
 * asserts `sibling_order >= 0`, and a CHECK is evaluated per row as each statement runs — it
 * is not deferred to commit, so negative parking would fail on the first update. Parking at
 * `max + 1 + index` is collision-free for the same reason the promotional loop is not: every
 * target is strictly greater than every value currently in the set, and the targets are
 * distinct from each other.
 */
export async function reorderCommerceCategories(
  actorUserId: string,
  parentCategoryId: string | null,
  categoryIds: readonly string[],
): Promise<Result<readonly AdminCommerceCategory[], CommerceCategoryError>> {
  // 1. CAPABILITY FIRST — before any id in the body is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const existing = await db
    .select({ id: commerceCategory.id, siblingOrder: commerceCategory.siblingOrder })
    .from(commerceCategory)
    .where(
      parentCategoryId === null
        ? isNull(commerceCategory.parentCategoryId)
        : eq(commerceCategory.parentCategoryId, parentCategoryId),
    );
  const existingIds = existing.map((row) => row.id);
  const parkingBase =
    existing.reduce((highest, row) => Math.max(highest, row.siblingOrder), -1) + 1;

  const requestedIds = new Set(categoryIds);
  const isPermutation =
    requestedIds.size === categoryIds.length &&
    requestedIds.size === existingIds.length &&
    existingIds.every((id) => requestedIds.has(id));

  if (!isPermutation) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_ORDER_MISMATCH" } };
  }

  await recordPlatformAction(
    async (tx) => {
      // Pass 1: park every row above the set's current maximum, where nothing can be
      // sitting yet. Positive, because the `sibling_order >= 0` CHECK is not deferred.
      for (let index = 0; index < categoryIds.length; index += 1) {
        await tx
          .update(commerceCategory)
          .set({ siblingOrder: parkingBase + index })
          .where(eq(commerceCategory.id, categoryIds[index]));
      }
      // Pass 2: assign the real order into slots now guaranteed free.
      for (let index = 0; index < categoryIds.length; index += 1) {
        await tx
          .update(commerceCategory)
          .set({ siblingOrder: index })
          .where(eq(commerceCategory.id, categoryIds[index]));
      }
      return categoryIds.length;
    },
    (rewrittenCount) =>
      rewrittenCount === 0
        ? null
        : {
            eventKind: "commerce_category_reordered",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Reordered store categories",
            targetLabel:
              parentCategoryId === null
                ? `${String(rewrittenCount)} root categories`
                : `${String(rewrittenCount)} categories under ${parentCategoryId}`,
            payload: { parentCategoryId, categoryIds: [...categoryIds] },
            occurredAt: new Date(),
          },
  );

  const rows = await db
    .select(ADMIN_SCALAR_COLUMNS)
    .from(commerceCategory)
    .where(
      parentCategoryId === null
        ? isNull(commerceCategory.parentCategoryId)
        : eq(commerceCategory.parentCategoryId, parentCategoryId),
    )
    .orderBy(asc(commerceCategory.siblingOrder), asc(commerceCategory.id));

  return { success: true, value: await withUsageCounts(rows) };
}

/** The two things that make a category unsafe to take out of browse. */
async function assertRetirable(categoryId: string): Promise<Result<null, CommerceCategoryError>> {
  if (categoryId === MISC_CATEGORY_ID) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_PROTECTED", categoryId } };
  }

  const [children] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(commerceCategory)
    .where(eq(commerceCategory.parentCategoryId, categoryId));
  if ((children?.total ?? 0) > 0) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CATEGORY_HAS_CHILDREN",
        categoryId,
        childCount: children?.total ?? 0,
      },
    };
  }

  const [listings] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(product)
    .where(eq(product.categoryId, categoryId));
  if ((listings?.total ?? 0) > 0) {
    return {
      success: false,
      error: {
        type: "COMMERCE_CATEGORY_IN_USE",
        categoryId,
        productCount: listings?.total ?? 0,
      },
    };
  }

  return { success: true, value: null };
}

/**
 * `POST /commerce/admin/categories/:categoryId/retire` — takes a category out of browse.
 *
 * RETIRE, NOT DELETE, and there is no delete route at all. `product.categoryId` is
 * `ON DELETE RESTRICT`, so removing a category with listings would fail at the database
 * anyway; and `commerce_category_demand_snapshot` cascades, so forcing it would take
 * history with it. Retiring reaches the same end state a moderator wants — gone from browse,
 * 404 on its slug — while staying reversible and keeping the slug reserved so it cannot be
 * re-minted to mean something else.
 *
 * The two guards are reported with their COUNTS rather than as a bare refusal: "3 listings
 * are still here" tells a moderator what to do next, "cannot retire" does not.
 */
export async function retireCommerceCategory(
  actorUserId: string,
  categoryId: string,
): Promise<Result<AdminCommerceCategory, CommerceCategoryError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select({ id: commerceCategory.id, slug: commerceCategory.slug })
    .from(commerceCategory)
    .where(eq(commerceCategory.id, categoryId))
    .limit(1);
  if (!existing) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_NOT_FOUND", categoryId } };
  }

  const blockResult = await assertRetirable(categoryId);
  if (!blockResult.success) return { success: false, error: blockResult.error };

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(commerceCategory)
        .set({ state: "retired" })
        .where(eq(commerceCategory.id, categoryId))
        .returning(ADMIN_SCALAR_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "commerce_category_retired",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Retired a store category",
            targetLabel: `commerce category ${existing.slug}`,
            payload: { categoryId },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    throw new Error("retireCommerceCategory: update returned no row");
  }
  const [view] = await withUsageCounts([updated]);
  if (!view) throw new Error("retireCommerceCategory: usage counts returned no row");
  return { success: true, value: view };
}

// ---------------------------------------------------------------------------
// SELLER REQUESTS
// ---------------------------------------------------------------------------

const REQUEST_VIEW_COLUMNS = {
  id: commerceCategoryRequest.id,
  requestedByUserId: commerceCategoryRequest.requestedByUserId,
  requestedOrganizationId: commerceCategoryRequest.requestedOrganizationId,
  proposedName: commerceCategoryRequest.proposedName,
  proposedParentCategoryId: commerceCategoryRequest.proposedParentCategoryId,
  justification: commerceCategoryRequest.justification,
  state: commerceCategoryRequest.state,
  reviewedByUserId: commerceCategoryRequest.reviewedByUserId,
  reviewedAt: commerceCategoryRequest.reviewedAt,
  reviewNote: commerceCategoryRequest.reviewNote,
  resultingCategoryId: commerceCategoryRequest.resultingCategoryId,
  createdAt: commerceCategoryRequest.createdAt,
} as const;

/**
 * Which listings each request would rehome. Drawn from the request LINK, never from
 * "everything in misc" — that distinction is the whole reason the column exists.
 *
 * One grouped query for the whole page rather than a lookup per row, so the queue's cost
 * does not scale with its length.
 */
async function withWaitingProducts(
  rows: readonly Omit<CommerceCategoryRequestView, "waitingProducts">[],
): Promise<readonly CommerceCategoryRequestView[]> {
  if (rows.length === 0) return [];
  const requestIds = rows.map((row) => row.id);

  const waitingRows = await db
    .select({
      requestId: product.pendingCategoryRequestId,
      id: product.id,
      title: product.title,
    })
    .from(product)
    .where(inArray(product.pendingCategoryRequestId, requestIds))
    .orderBy(asc(product.title), asc(product.id));

  const productsByRequestId = new Map<string, { id: string; title: string }[]>();
  for (const waitingRow of waitingRows) {
    if (waitingRow.requestId === null) continue;
    const bucket = productsByRequestId.get(waitingRow.requestId) ?? [];
    bucket.push({ id: waitingRow.id, title: waitingRow.title });
    productsByRequestId.set(waitingRow.requestId, bucket);
  }

  return rows.map((row) => ({
    ...row,
    waitingProducts: productsByRequestId.get(row.id) ?? [],
  }));
}

/**
 * `POST /commerce/category-requests` — a seller asks for a category that does not exist.
 *
 * THE ONE UNGATED WRITE in this file, and it mints nothing. It records a request; only a
 * moderator's verdict creates a category. That is what lets this be open to any identified
 * seller without their unreviewed wording ever reaching the storefront.
 *
 * No duplicate detection. Two sellers asking for the same thing is INFORMATION — it is the
 * strongest signal the category is missing — and collapsing them would hide it. The
 * moderator resolves both, and the second one's listings can be assigned to the category the
 * first one produced.
 */
export async function submitCommerceCategoryRequest(
  actor: { readonly userId: string; readonly organizationId: string | null },
  input: SubmitCommerceCategoryRequestInput,
): Promise<Result<CommerceCategoryRequestView, CommerceCategoryError>> {
  if (input.proposedParentCategoryId !== null) {
    const parentResult = await validateParent(input.proposedParentCategoryId, null);
    if (!parentResult.success) return { success: false, error: parentResult.error };
  }

  const [inserted] = await db
    .insert(commerceCategoryRequest)
    .values({
      requestedByUserId: actor.userId,
      requestedOrganizationId: actor.organizationId,
      proposedName: input.proposedName,
      proposedParentCategoryId: input.proposedParentCategoryId,
      justification: input.justification,
    })
    .returning(REQUEST_VIEW_COLUMNS);

  if (!inserted) {
    throw new Error("submitCommerceCategoryRequest: insert returned no row");
  }
  const [view] = await withWaitingProducts([inserted]);
  if (!view) throw new Error("submitCommerceCategoryRequest: count returned no row");
  return { success: true, value: view };
}

/** `GET /commerce/category-requests/mine` — what this seller has asked for, and how it went. */
export async function listOwnCommerceCategoryRequests(
  actorUserId: string,
): Promise<readonly CommerceCategoryRequestView[]> {
  const rows = await db
    .select(REQUEST_VIEW_COLUMNS)
    .from(commerceCategoryRequest)
    .where(eq(commerceCategoryRequest.requestedByUserId, actorUserId))
    .orderBy(asc(commerceCategoryRequest.createdAt), asc(commerceCategoryRequest.id));
  return withWaitingProducts(rows);
}

/** `GET /commerce/admin/category-requests` — the moderation queue. */
export async function listCommerceCategoryRequestsForStaff(
  actorUserId: string,
  filter: { readonly state?: "pending" | "approved" | "rejected" },
): Promise<Result<readonly CommerceCategoryRequestView[], CommerceCategoryError>> {
  // CAPABILITY FIRST. Unlike the R&D taxonomy queue, which is a public read because a
  // proposed term there is usable the moment it is proposed, nothing here is usable until
  // it is decided — so a pending row is staff-only, and so is its author's identity.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select(REQUEST_VIEW_COLUMNS)
    .from(commerceCategoryRequest)
    .where(filter.state === undefined ? undefined : eq(commerceCategoryRequest.state, filter.state))
    .orderBy(asc(commerceCategoryRequest.createdAt), asc(commerceCategoryRequest.id));

  return { success: true, value: await withWaitingProducts(rows) };
}

/**
 * `POST /commerce/admin/category-requests/:requestId/decide` — the verdict.
 *
 * THE LOAD-BEARING FUNCTION. Everything about the request feature that could go wrong goes
 * wrong here, so read the four rules:
 *
 * 1. A DECIDED REQUEST IS TERMINAL. Deciding one again answers 409 naming the state it
 *    holds — another moderator got there first, which is a finding to read and not an
 *    action to retry. The row is locked `FOR UPDATE` so two moderators pressing at once
 *    cannot both mint a category.
 *
 * 2. ONLY THIS REQUEST'S LISTINGS MOVE. The repoint is scoped to
 *    `pendingCategoryRequestId = requestId`, NEVER to `categoryId = misc`. Misc holds
 *    genuinely miscellaneous listings from unrelated sellers, and sweeping those into a
 *    stranger's new category is the single worst thing this feature could do.
 *
 * 3. THE MODERATOR'S EDIT WINS. `name`/`parentCategoryId` on the approve arm replace the
 *    seller's proposal; `slug` is required because a slug is a public URL identity and
 *    deriving one from user-typed text would let a requester choose it by construction.
 *
 * 4. THE LINK IS ALWAYS CLEARED. On both arms, every listing that pointed at this request
 *    stops pointing at it. A rejected request that left the link set would leave those
 *    listings waiting forever on a verdict that already happened.
 */
export async function decideCommerceCategoryRequest(
  actorUserId: string,
  requestId: string,
  input: DecideCommerceCategoryRequestInput,
): Promise<
  Result<
    {
      readonly request: CommerceCategoryRequestView;
      readonly category: AdminCommerceCategory | null;
    },
    CommerceCategoryError
  >
> {
  // 1. CAPABILITY FIRST — before `requestId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // Slug uniqueness is checked before the transaction so the common conflict is a cheap
  // read rather than a rolled-back write. The transaction re-checks by relying on the
  // unique index, which is the only authority.
  if (input.decision === "approve" && (await isSlugTaken(input.slug, null))) {
    return { success: false, error: { type: "COMMERCE_CATEGORY_SLUG_TAKEN", slug: input.slug } };
  }

  const outcome = await recordPlatformAction(
    async (
      tx,
    ): Promise<
      | {
          readonly status: "decided";
          readonly categoryId: string | null;
          readonly slug: string;
          /**
           * A39. Every listing whose `categoryId` this verdict moved, carried out so the
           * search documents can be refreshed after commit — `category_slug` is a
           * denormalized copy that both the filters and the facet counts scope on.
           */
          readonly movedProductIds: readonly string[];
        }
      | { readonly status: "not_found" }
      | { readonly status: "already_decided"; readonly state: "approved" | "rejected" }
      | { readonly status: "assignment_invalid"; readonly productId: string }
      | { readonly status: "parent_not_found"; readonly parentCategoryId: string }
    > => {
      const [existing] = await tx
        .select({
          id: commerceCategoryRequest.id,
          state: commerceCategoryRequest.state,
          proposedName: commerceCategoryRequest.proposedName,
          proposedParentCategoryId: commerceCategoryRequest.proposedParentCategoryId,
        })
        .from(commerceCategoryRequest)
        .where(eq(commerceCategoryRequest.id, requestId))
        .for("update");

      if (!existing) return { status: "not_found" };
      if (existing.state !== "pending") {
        return { status: "already_decided", state: existing.state };
      }

      // Every explicitly named target must be a real, active category. An assignment
      // pointing at a draft or retired row would hide the listing rather than move it.
      const assignments = input.productAssignments ?? [];
      for (const assignment of assignments) {
        const [targetCategory] = await tx
          .select({ id: commerceCategory.id })
          .from(commerceCategory)
          .where(
            and(
              eq(commerceCategory.id, assignment.categoryId),
              eq(commerceCategory.state, "active"),
            ),
          )
          .limit(1);
        if (!targetCategory) {
          return { status: "assignment_invalid", productId: assignment.productId };
        }
      }

      let mintedCategoryId: string | null = null;
      let auditSlug = existing.proposedName;

      if (input.decision === "approve") {
        const parentCategoryId =
          input.parentCategoryId === undefined
            ? existing.proposedParentCategoryId
            : input.parentCategoryId;

        if (parentCategoryId !== null) {
          const [parentRow] = await tx
            .select({ id: commerceCategory.id })
            .from(commerceCategory)
            .where(eq(commerceCategory.id, parentCategoryId))
            .limit(1);
          if (!parentRow) return { status: "parent_not_found", parentCategoryId };
        }

        const [highest] = await tx
          .select({ value: sql<number | null>`max(${commerceCategory.siblingOrder})` })
          .from(commerceCategory)
          .where(
            parentCategoryId === null
              ? isNull(commerceCategory.parentCategoryId)
              : eq(commerceCategory.parentCategoryId, parentCategoryId),
          );

        const [minted] = await tx
          .insert(commerceCategory)
          .values({
            slug: input.slug,
            name: input.name ?? existing.proposedName,
            parentCategoryId,
            siblingOrder: (highest?.value ?? -1) + 1,
            // ACTIVE, not draft. A moderator approving a seller's request is publishing
            // it; leaving it draft would answer the seller "yes" while the storefront
            // still says the category does not exist.
            state: "active",
          })
          .returning({ id: commerceCategory.id, slug: commerceCategory.slug });
        if (!minted)
          throw new Error("decideCommerceCategoryRequest: category insert returned no row");
        mintedCategoryId = minted.id;
        auditSlug = minted.slug;
      }

      // Explicit assignments first, so a product named here is not also caught by the
      // blanket move below.
      const assignedProductIds = new Set<string>();
      for (const assignment of assignments) {
        await tx
          .update(product)
          .set({ categoryId: assignment.categoryId, pendingCategoryRequestId: null })
          .where(
            and(
              eq(product.id, assignment.productId),
              eq(product.pendingCategoryRequestId, requestId),
            ),
          );
        assignedProductIds.add(assignment.productId);
      }

      /**
       * A39. Collected before the blanket move, because the move CLEARS the predicate that
       * identifies them — after it runs there is no way to ask which listings it touched.
       *
       * Every product whose `categoryId` this verdict changes needs its search document
       * refreshed. `store_search_document.category_slug` is a denormalized copy, and both the
       * search filters AND (since Phase 22) the facet counts scope on it, so a listing left
       * with the old slug is missing from its new category's results and counted under its
       * old one. `verify-store-phase-22-constraints` found three such rows in this very
       * database, which is how this was noticed.
       */
      const movedProductRows =
        mintedCategoryId === null
          ? []
          : await tx
              .select({ id: product.id })
              .from(product)
              .where(eq(product.pendingCategoryRequestId, requestId));

      // The blanket move. On approval the remaining waiting listings go to the new
      // category; on rejection they stay in `misc` and only lose the link.
      await tx
        .update(product)
        .set({
          ...(mintedCategoryId === null ? {} : { categoryId: mintedCategoryId }),
          pendingCategoryRequestId: null,
        })
        .where(eq(product.pendingCategoryRequestId, requestId));

      await tx
        .update(commerceCategoryRequest)
        .set({
          state: input.decision === "approve" ? "approved" : "rejected",
          reviewedByUserId: actorUserId,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
          resultingCategoryId: mintedCategoryId,
        })
        .where(eq(commerceCategoryRequest.id, requestId));

      return {
        status: "decided",
        categoryId: mintedCategoryId,
        slug: auditSlug,
        // A39. Both halves: the explicitly named assignments and the blanket move.
        movedProductIds: [...assignedProductIds, ...movedProductRows.map((row) => row.id)],
      };
    },
    (result) =>
      result.status !== "decided"
        ? null
        : {
            eventKind:
              input.decision === "approve"
                ? "commerce_category_request_approved"
                : "commerce_category_request_rejected",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel:
              input.decision === "approve"
                ? "Approved a store category request"
                : "Rejected a store category request",
            targetLabel: `category request ${requestId}`,
            payload: {
              requestId,
              resultingCategoryId: result.categoryId,
              slug: result.slug,
            },
            occurredAt: new Date(),
          },
  );

  switch (outcome.status) {
    case "not_found":
      return {
        success: false,
        error: { type: "COMMERCE_CATEGORY_REQUEST_NOT_FOUND", requestId },
      };
    case "already_decided":
      return {
        success: false,
        error: {
          type: "COMMERCE_CATEGORY_REQUEST_ALREADY_DECIDED",
          requestId,
          state: outcome.state,
        },
      };
    case "assignment_invalid":
      return {
        success: false,
        error: { type: "COMMERCE_CATEGORY_ASSIGNMENT_INVALID", productId: outcome.productId },
      };
    case "parent_not_found":
      return {
        success: false,
        error: {
          type: "COMMERCE_CATEGORY_PARENT_NOT_FOUND",
          parentCategoryId: outcome.parentCategoryId,
        },
      };
    case "decided":
      break;
    default: {
      const exhaustiveOutcome: never = outcome;
      return exhaustiveOutcome;
    }
  }

  /**
   * A39. AFTER COMMIT, and the only category write that needs this.
   *
   * `updateCommerceCategory` cannot move a listing — it edits the category, and a category
   * cannot be retired while it holds one (`assertRetirable`) — and §6.5 makes a slug immutable.
   * This verdict is therefore the single path that changes which category a product belongs to,
   * and `store_search_document.category_slug` is a denormalized copy of that.
   *
   * Dynamic import: `store-search.service` reaches this module's siblings, and this is the
   * shape `updateOrganization` and `getCategoryFacets` already use to reach it.
   */
  if (outcome.movedProductIds.length > 0) {
    const { enqueueProductSearchDocumentRefresh } =
      await import("#src/services/store-search.service.js");
    await Promise.all(outcome.movedProductIds.map(enqueueProductSearchDocumentRefresh));
  }

  const [requestRow] = await db
    .select(REQUEST_VIEW_COLUMNS)
    .from(commerceCategoryRequest)
    .where(eq(commerceCategoryRequest.id, requestId))
    .limit(1);
  if (!requestRow) throw new Error("decideCommerceCategoryRequest: request vanished after decide");
  const [requestView] = await withWaitingProducts([requestRow]);
  if (!requestView) throw new Error("decideCommerceCategoryRequest: count returned no row");

  if (outcome.categoryId === null) {
    return { success: true, value: { request: requestView, category: null } };
  }

  const [categoryRow] = await db
    .select(ADMIN_SCALAR_COLUMNS)
    .from(commerceCategory)
    .where(eq(commerceCategory.id, outcome.categoryId))
    .limit(1);
  if (!categoryRow) throw new Error("decideCommerceCategoryRequest: category vanished after mint");
  const [categoryView] = await withUsageCounts([categoryRow]);
  if (!categoryView) throw new Error("decideCommerceCategoryRequest: usage counts returned no row");

  return { success: true, value: { request: requestView, category: categoryView } };
}
