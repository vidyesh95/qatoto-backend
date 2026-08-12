import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceProductRelation, product } from "#src/db/schema.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import {
  resolveEligibleProductCardsByIds,
  type StoreProductCardProjection,
} from "#src/services/store-catalog.service.js";
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
  | { type: "ALREADY_VERIFIED" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

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

  const outcome = await db.transaction(async (transaction) => {
    const [ownedProduct] = await transaction
      .select({ id: product.id })
      .from(product)
      .where(
        and(eq(product.id, fromProductId), eq(product.sellerOrganizationId, actor.organizationId)),
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
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_target":
      return {
        success: false,
        error: { type: "INVALID_TARGET", productIds: outcome.productIds },
      };
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

    const [fromProduct] = await transaction
      .select({ sellerOrganizationId: product.sellerOrganizationId })
      .from(product)
      .where(eq(product.id, relation.fromProductId))
      .limit(1);

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
