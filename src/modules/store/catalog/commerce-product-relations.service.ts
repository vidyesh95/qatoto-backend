import { and, asc, eq, gt, gte, inArray, lt, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "#src/db/index.js";
import {
  commerceOrganization,
  commerceOrganizationMember,
  commerceProductRelation,
  product,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import {
  resolveEligibleProductCardsByIds,
  type StoreProductCardProjection,
} from "#src/modules/store/catalog/store-catalog.service.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CommerceProductRelationKind =
  (typeof commerceProductRelation.$inferSelect)["relationKind"];
export type CommerceProductRelationSourceKind =
  (typeof commerceProductRelation.$inferSelect)["sourceKind"];

export type CommerceProductRelationError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  /** One or more `toProductId` values are not products a buyer could ever see. */
  | { type: "INVALID_TARGET"; productIds: readonly string[] }
  | { type: "SELF_RELATION" }
  /**
   * ⚠️ **A SELLER RE-SENT AN EDGE A MODERATOR HAS ALREADY CURATED.**
   *
   * `commerce_product_relation_edge_uidx` is `(fromProductId, toProductId, relationKind)` and does
   * NOT include `sourceKind`, while the delete above is scoped to `seller_declared` — so a curated
   * row survives the wipe and then collides with the seller's re-insert. Until this member existed
   * the `23505` escaped as an unmapped **500** on an entirely foreseeable action: read your own
   * relations, send them back unchanged.
   *
   * It is a finding rather than a retry — the edge already exists, with more authority than the
   * seller was claiming for it.
   */
  | { type: "RELATION_ALREADY_CURATED" }
  | { type: "ALREADY_VERIFIED" }
  /** A cursor this service did not mint. Never a 500 — a bad page token is a caller error. */
  | { type: "INVALID_CURSOR" }
  /**
   * §4.11: the moderator belongs to the organization that sells the FROM product, so they are a
   * party to the claim they are trying to confirm. Holding `moderate_commerce` is not enough.
   */
  | { type: "SELF_MODERATION_FORBIDDEN" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

/**
 * One relation as a MODERATOR sees it.
 *
 * ⚠️ **BOTH ENDS ARE NAMED, AND THE TARGET'S STATE RIDES ALONG.** The row stores only ids, and a
 * reviewer cannot judge "does this bolt really fit that bicycle" from two uuids. The target's
 * `status` and `moderationState` are here deliberately: they are how a reviewer sees that the
 * seller has since unpublished what they were claiming a fit against.
 */
export interface ProductRelationModerationProjection {
  readonly id: string;
  readonly relationKind: CommerceProductRelationKind;
  readonly sourceKind: CommerceProductRelationSourceKind;
  readonly createdAt: string;
  readonly fromProductId: string;
  readonly fromProductTitle: string;
  readonly fromProductPublicSlug: string | null;
  readonly toProductId: string;
  readonly toProductTitle: string;
  readonly toProductPublicSlug: string | null;
  readonly toProductStatus: string;
  readonly toProductModerationState: string;
  /** Who made the claim. A claim with no claimant behind it cannot be judged. */
  readonly sellerOrganizationId: string;
  readonly sellerOrganizationDisplayName: string;
}

export interface ListRelationsForModerationQuery {
  readonly sourceKind: CommerceProductRelationSourceKind;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * The claims a moderator can promote.
 *
 * ⚠️ **THIS LIST CANNOT BE DISMISSED FROM, AND THAT IS A PROPERTY OF THE SCHEMA RATHER THAN AN
 * OVERSIGHT HERE.** There is no review state beside `sourceKind`, and
 * `commerce_product_relation_verified_ck` enforces that attribution exists IFF `moderator_curated`,
 * so nothing can record "a moderator looked at this and left it". `updatedAt` cannot stand in
 * either — verification is the only UPDATE in the codebase, so it equals `createdAt` on every
 * unverified row. The list therefore shrinks only when a claim is CONFIRMED or the seller retracts
 * it. Adding real dismissal is a migration; until then the console says so rather than implying a
 * queue that drains.
 *
 * ⚠️ **FILTERED ON `sourceKind`, NEVER ON `verifiedAt IS NULL`.** Those look equivalent and are
 * not: `derived_cooccurrence` rows are null-attributed too, so the timestamp predicate would pour
 * the nightly co-occurrence graph into a human review list.
 *
 * ⚠️ **INNER JOINS, NOT `resolveEligibleProductCardsByIds`.** That helper applies
 * `publicProductEligibility` and silently DROPS a target that is not publicly visible — which would
 * let a seller hide a claim from review by unpublishing the thing they claimed a fit against, and
 * would under-fill the page and corrupt `hasMore` on the way. Both FKs are `NOT NULL` with
 * `ON DELETE restrict`, so the joined rows always exist.
 *
 * ASC, because this is a queue and not a feed: newest-first is how the oldest claim never gets read.
 */
export async function listRelationsForModeration(
  actorUserId: string,
  query: ListRelationsForModerationQuery,
): Promise<
  Result<
    {
      items: readonly ProductRelationModerationProjection[];
      page: { nextCursor: string | null; hasMore: boolean };
    },
    CommerceProductRelationError
  >
> {
  // Before any row is read, so the route is not an existence oracle for a caller without it.
  const capability = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const fromProduct = alias(product, "from_product");
  const toProduct = alias(product, "to_product");

  const filters: SQL[] = [eq(commerceProductRelation.sourceKind, query.sourceKind)];

  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    /**
     * ⚠️ **A MILLISECOND WINDOW, NOT AN EQUALITY, AND THE OBVIOUS VERSION IS BROKEN HERE.**
     *
     * The sibling queues write `gt(sortColumn, cursor) OR (eq(sortColumn, cursor) AND gt(id, …))`,
     * and that is correct FOR THEM because their sort columns are written from JavaScript, so the
     * stored value is millisecond-precise and `toISOString()` round-trips it exactly.
     *
     * `created_at` here defaults to Postgres `now()`, which is **microsecond**-precise —
     * `11:15:24.538694`. The cursor can only carry `…538Z`, so `eq` never matches and `gt` matches
     * the row the cursor points AT. **Measured, not reasoned about**: page 2 returned page 1's row.
     *
     * So the comparison is done against the millisecond the cursor names: everything after that
     * millisecond, plus anything inside it with a larger id. Correct at any stored precision, and
     * still a range scan.
     */
    const cursorMillisecond = cursor.sortKey;
    const nextMillisecond = new Date(cursorMillisecond.getTime() + 1);
    const keyset = or(
      gte(commerceProductRelation.createdAt, nextMillisecond),
      and(
        gte(commerceProductRelation.createdAt, cursorMillisecond),
        lt(commerceProductRelation.createdAt, nextMillisecond),
        gt(commerceProductRelation.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select({
      id: commerceProductRelation.id,
      relationKind: commerceProductRelation.relationKind,
      sourceKind: commerceProductRelation.sourceKind,
      createdAt: commerceProductRelation.createdAt,
      fromProductId: commerceProductRelation.fromProductId,
      fromProductTitle: fromProduct.title,
      fromProductPublicSlug: fromProduct.publicSlug,
      toProductId: commerceProductRelation.toProductId,
      toProductTitle: toProduct.title,
      toProductPublicSlug: toProduct.publicSlug,
      toProductStatus: toProduct.status,
      toProductModerationState: toProduct.moderationState,
      sellerOrganizationId: fromProduct.sellerOrganizationId,
      sellerOrganizationDisplayName: commerceOrganization.displayName,
    })
    .from(commerceProductRelation)
    .innerJoin(fromProduct, eq(fromProduct.id, commerceProductRelation.fromProductId))
    .innerJoin(toProduct, eq(toProduct.id, commerceProductRelation.toProductId))
    .innerJoin(commerceOrganization, eq(commerceOrganization.id, fromProduct.sellerOrganizationId))
    .where(and(...filters))
    .orderBy(asc(commerceProductRelation.createdAt), asc(commerceProductRelation.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        id: row.id,
        relationKind: row.relationKind,
        sourceKind: row.sourceKind,
        createdAt: row.createdAt.toISOString(),
        fromProductId: row.fromProductId,
        fromProductTitle: row.fromProductTitle,
        fromProductPublicSlug: row.fromProductPublicSlug,
        toProductId: row.toProductId,
        toProductTitle: row.toProductTitle,
        toProductPublicSlug: row.toProductPublicSlug,
        toProductStatus: row.toProductStatus,
        toProductModerationState: row.toProductModerationState,
        sellerOrganizationId: row.sellerOrganizationId,
        sellerOrganizationDisplayName: row.sellerOrganizationDisplayName,
      })),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

export interface CommerceProductRelationActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface DeclaredRelationInput {
  readonly toProductId: string;
  readonly relationKind: CommerceProductRelationKind;
  readonly rank?: number | undefined;
}

export interface ProductRelationProjection {
  readonly id: string;
  readonly fromProductId: string;
  readonly toProductId: string;
  readonly relationKind: CommerceProductRelationKind;
  readonly sourceKind: CommerceProductRelationSourceKind;
  readonly rank: number;
  readonly verifiedAt: Date | null;
}

/**
 * One companion on a product detail page, grouped by kind.
 *
 * `sourceKind` RIDES THE WIRE DELIBERATELY (§15.3). A seller saying its bolt fits a
 * given bicycle is a claim, not a fact — the same posture §0 takes on prices and
 * badges. Only `moderator_curated` may be rendered with confirmatory language, and
 * the client cannot make that distinction unless the server ships it.
 */
export interface ProductCompanionProjection {
  readonly relationKind: CommerceProductRelationKind;
  readonly sourceKind: CommerceProductRelationSourceKind;
  readonly rank: number;
  readonly product: StoreProductCardProjection;
}

export interface ProductCompanionGroupProjection {
  readonly relationKind: CommerceProductRelationKind;
  readonly items: readonly ProductCompanionProjection[];
}

/** Bounded so a PDP read cannot be turned into a catalog dump. */
const MAXIMUM_COMPANIONS_PER_KIND = 12;

/**
 * Is this moderator a member of the organization that owns the claim?
 *
 * Same shape as the content-report queue's guard (`commerce-content-reports.service.ts`) and the
 * pathway one, deliberately: `state: "active"` means a suspended or departed member is NOT a party,
 * and taking the executor as a parameter is what lets this run INSIDE the caller's transaction,
 * after the row lock.
 */
async function isModeratorPartyToTarget(
  executor: DatabaseTransaction | typeof db,
  moderatorUserId: string,
  ownerOrganizationId: string | null,
): Promise<boolean> {
  if (ownerOrganizationId === null) return false;
  const [membership] = await executor
    .select({ id: commerceOrganizationMember.id })
    .from(commerceOrganizationMember)
    .where(
      and(
        eq(commerceOrganizationMember.userId, moderatorUserId),
        eq(commerceOrganizationMember.organizationId, ownerOrganizationId),
        eq(commerceOrganizationMember.state, "active"),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce product relation audit append failed: ${appended.error.type}`);
  }
}

function projectRelation(
  row: typeof commerceProductRelation.$inferSelect,
): ProductRelationProjection {
  return {
    id: row.id,
    fromProductId: row.fromProductId,
    toProductId: row.toProductId,
    relationKind: row.relationKind,
    sourceKind: row.sourceKind,
    rank: row.rank,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * Replace every `seller_declared` relation leaving one product.
 *
 * SOURCE KIND IS NOT AN INPUT. Whatever the body says, a seller write is
 * `seller_declared` — a client that could set `moderator_curated` could manufacture
 * a verified-compatibility badge for its own parts, which is precisely the failure
 * §15.3 exists to prevent.
 *
 * Moderator-curated and derived rows are left alone: a seller must not be able to
 * erase a reviewer's decision or the co-occurrence graph by sending a shorter list.
 */
export async function replaceSellerDeclaredRelations(
  actor: CommerceProductRelationActorContext,
  fromProductId: string,
  relations: readonly DeclaredRelationInput[],
): Promise<Result<readonly ProductRelationProjection[], CommerceProductRelationError>> {
  if (relations.some((relation) => relation.toProductId === fromProductId)) {
    return { success: false, error: { type: "SELF_RELATION" } };
  }

  const outcome = await db
    .transaction(async (transaction) => {
      const [ownedProduct] = await transaction
        .select({ id: product.id })
        .from(product)
        .where(
          and(
            eq(product.id, fromProductId),
            eq(product.sellerOrganizationId, actor.organizationId),
          ),
        )
        .limit(1);
      // NOT_FOUND rather than FORBIDDEN: a caller must not learn that a listing they
      // do not own exists.
      if (!ownedProduct) return { status: "not_found" as const };

      const targetProductIds = [...new Set(relations.map((relation) => relation.toProductId))];
      if (targetProductIds.length > 0) {
        /**
         * A relation may only point at something a buyer could reach. Checking mere
         * existence would let a seller mine draft or suspended listings by watching
         * which ids are accepted.
         */
        const eligibleTargets = await resolveEligibleProductCardsByIds(targetProductIds);
        const eligibleIds = new Set(eligibleTargets.map((card) => card.id));
        const invalidIds = targetProductIds.filter((productId) => !eligibleIds.has(productId));
        if (invalidIds.length > 0) {
          return { status: "invalid_target" as const, productIds: invalidIds };
        }
      }

      await transaction
        .delete(commerceProductRelation)
        .where(
          and(
            eq(commerceProductRelation.fromProductId, fromProductId),
            eq(commerceProductRelation.sourceKind, "seller_declared"),
          ),
        );

      if (relations.length > 0) {
        await transaction.insert(commerceProductRelation).values(
          relations.map((relation, index) => ({
            fromProductId,
            toProductId: relation.toProductId,
            relationKind: relation.relationKind,
            sourceKind: "seller_declared" as const,
            rank: relation.rank ?? index,
            createdByUserId: actor.actorUserId,
            createdByOrganizationId: actor.organizationId,
          })),
        );
      }

      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "product_relations_declared",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "product",
        targetEntityId: fromProductId,
        payload: {
          fromProductId,
          relationCount: String(relations.length),
          relationKinds: [...new Set(relations.map((relation) => relation.relationKind))],
        },
        occurredAt: new Date(),
      });

      const rows = await transaction
        .select()
        .from(commerceProductRelation)
        .where(eq(commerceProductRelation.fromProductId, fromProductId))
        .orderBy(
          asc(commerceProductRelation.relationKind),
          asc(commerceProductRelation.rank),
          asc(commerceProductRelation.id),
        );

      return { status: "replaced" as const, rows };
    })
    .catch((error: unknown) => {
      // The only unique index reachable from here is the edge one — see RELATION_ALREADY_CURATED.
      if (isUniqueViolation(error)) return { status: "already_curated" as const };
      throw error;
    });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_target":
      return {
        success: false,
        error: { type: "INVALID_TARGET", productIds: outcome.productIds },
      };
    case "already_curated":
      return { success: false, error: { type: "RELATION_ALREADY_CURATED" } };
    case "replaced":
      return { success: true, value: outcome.rows.map(projectRelation) };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled relation replace outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Promote one relation to `moderator_curated` (§15.8).
 *
 * This is the only path that makes a compatibility claim renderable as confirmed,
 * so it requires the platform `moderate_commerce` capability rather than any
 * organization role — a seller with every role in its own organization still cannot
 * verify its own claim.
 */
export async function verifyRelation(
  actorUserId: string,
  relationId: string,
): Promise<Result<ProductRelationProjection, CommerceProductRelationError>> {
  const capability = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [relation] = await transaction
      .select()
      .from(commerceProductRelation)
      .where(eq(commerceProductRelation.id, relationId))
      .for("update");
    if (!relation) return { status: "not_found" as const };

    /**
     * ⚠️ **HOISTED ABOVE THE REPLAY RETURN ON PURPOSE.** This select used to sit after the UPDATE,
     * where it only fed the audit append. The self-moderation guard below needs the owning
     * organization, and it has to refuse a party moderator on a REPLAY too — otherwise "verify it
     * twice" would be a way around the check.
     */
    const [fromProduct] = await transaction
      .select({ sellerOrganizationId: product.sellerOrganizationId })
      .from(product)
      .where(eq(product.id, relation.fromProductId))
      .limit(1);

    /**
     * §4.11: a party to the claim cannot be the one who confirms it. A moderator with
     * `moderate_commerce` who also belongs to the selling organization would otherwise be able to
     * promote their own company's compatibility claim to "we checked".
     *
     * ⚠️ This runs AFTER the capability check, which is deliberate — the capability check happens
     * before any row is read, so a caller without `moderate_commerce` still learns nothing about
     * whether `relationId` exists. Moving this earlier would turn the route into an existence
     * oracle.
     */
    if (
      await isModeratorPartyToTarget(
        transaction,
        actorUserId,
        fromProduct?.sellerOrganizationId ?? null,
      )
    ) {
      return { status: "self_moderation" as const };
    }

    if (relation.sourceKind === "moderator_curated") {
      // Idempotent replays return the existing row; a genuine re-verification of an
      // already-curated edge has nothing left to change.
      return { status: "already_verified" as const, relation };
    }

    const verifiedAt = new Date();
    const [updated] = await transaction
      .update(commerceProductRelation)
      .set({ sourceKind: "moderator_curated", verifiedByUserId: actorUserId, verifiedAt })
      .where(eq(commerceProductRelation.id, relationId))
      .returning();
    if (!updated) throw new Error("Product relation verify returned no row.");

    if (fromProduct?.sellerOrganizationId) {
      await appendAuditOrThrow(transaction, {
        organizationId: fromProduct.sellerOrganizationId,
        eventKind: "product_relation_verified",
        actorUserId,
        actorMemberRoleSnapshot: null,
        targetEntityType: "commerce_product_relation",
        targetEntityId: relationId,
        payload: {
          relationId,
          fromProductId: relation.fromProductId,
          toProductId: relation.toProductId,
          relationKind: relation.relationKind,
        },
        occurredAt: verifiedAt,
      });
    }

    return { status: "verified" as const, relation: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_moderation":
      return { success: false, error: { type: "SELF_MODERATION_FORBIDDEN" } };
    case "already_verified":
    case "verified":
      return { success: true, value: projectRelation(outcome.relation) };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled relation verify outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Relation-graph companions for a public product detail page (§15.7).
 *
 * Grouped by kind, each carrying `sourceKind`. Targets that are no longer publicly
 * eligible are dropped by `resolveEligibleProductCardsByIds` — for a companion rail
 * that is correct, because unlike a pathway slot (§15.6) a missing companion is not
 * a promise the buyer was shown.
 */
export async function listProductCompanions(
  productSlug: string,
): Promise<Result<readonly ProductCompanionGroupProjection[], CommerceProductRelationError>> {
  const [sourceProduct] = await db
    .select({ id: product.id })
    .from(product)
    .where(eq(product.publicSlug, productSlug))
    .limit(1);
  if (!sourceProduct) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  // The source product itself must be publicly visible, or a draft listing's slug
  // would become a readable relation index.
  const [visibleSource] = await resolveEligibleProductCardsByIds([sourceProduct.id]);
  if (!visibleSource) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const relationRows = await db
    .select({
      toProductId: commerceProductRelation.toProductId,
      relationKind: commerceProductRelation.relationKind,
      sourceKind: commerceProductRelation.sourceKind,
      rank: commerceProductRelation.rank,
    })
    .from(commerceProductRelation)
    .where(eq(commerceProductRelation.fromProductId, sourceProduct.id))
    .orderBy(
      asc(commerceProductRelation.relationKind),
      asc(commerceProductRelation.rank),
      asc(commerceProductRelation.id),
    );

  if (relationRows.length === 0) {
    return { success: true, value: [] };
  }

  const cards = await resolveEligibleProductCardsByIds([
    ...new Set(relationRows.map((relation) => relation.toProductId)),
  ]);
  const cardById = new Map(cards.map((card) => [card.id, card]));

  const groupedByKind = new Map<CommerceProductRelationKind, ProductCompanionProjection[]>();
  for (const relation of relationRows) {
    const card = cardById.get(relation.toProductId);
    if (!card) continue;
    const group = groupedByKind.get(relation.relationKind) ?? [];
    if (group.length >= MAXIMUM_COMPANIONS_PER_KIND) continue;
    group.push({
      relationKind: relation.relationKind,
      sourceKind: relation.sourceKind,
      rank: relation.rank,
      product: card,
    });
    groupedByKind.set(relation.relationKind, group);
  }

  return {
    success: true,
    value: [...groupedByKind.entries()].map(([relationKind, items]) => ({
      relationKind,
      items,
    })),
  };
}

/**
 * Spare-part lookup from a set of products the buyer already owns — the fifth
 * surface §15.3 promised one table would serve. Reads the graph in reverse: what
 * are the spare parts and consumables FOR these products.
 */
export async function listSparePartsForProducts(
  productIds: readonly string[],
): Promise<readonly ProductCompanionProjection[]> {
  if (productIds.length === 0) {
    return [];
  }
  const relationRows = await db
    .select({
      fromProductId: commerceProductRelation.fromProductId,
      relationKind: commerceProductRelation.relationKind,
      sourceKind: commerceProductRelation.sourceKind,
      rank: commerceProductRelation.rank,
    })
    .from(commerceProductRelation)
    .where(
      and(
        inArray(commerceProductRelation.toProductId, [...productIds]),
        inArray(commerceProductRelation.relationKind, ["spare_part_of", "consumable_for"]),
      ),
    )
    .orderBy(asc(commerceProductRelation.rank), asc(commerceProductRelation.id));

  const cards = await resolveEligibleProductCardsByIds([
    ...new Set(relationRows.map((relation) => relation.fromProductId)),
  ]);
  const cardById = new Map(cards.map((card) => [card.id, card]));

  return relationRows.flatMap((relation) => {
    const card = cardById.get(relation.fromProductId);
    return card === undefined
      ? []
      : [
          {
            relationKind: relation.relationKind,
            sourceKind: relation.sourceKind,
            rank: relation.rank,
            product: card,
          },
        ];
  });
}
