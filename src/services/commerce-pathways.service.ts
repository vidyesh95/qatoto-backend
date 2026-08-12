import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrganizationMember,
  commerceProductVariant,
  product,
  productPricingTier,
  storePathway,
  storePathwaySlot,
  storePathwaySlotCandidate,
} from "#src/db/schema.js";
import type { CloudinaryError } from "#src/lib/cloudinary.js";
import { deleteStorePathwayImage, uploadStorePathwayImage } from "#src/lib/cloudinary.js";
import { resolveUnitPriceInCents } from "#src/lib/commerce-pricing.js";
import type { ImageValidationError } from "#src/lib/image.js";
import { validateAndNormalizeImage } from "#src/lib/image.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import {
  getCart,
  getOrCreateCartForUpdate,
  supersedeActiveCheckoutPrepares,
  upsertCartProductLine,
  type CommerceCartProjection,
} from "#src/services/commerce-cart.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { CommerceProductRelationKind } from "#src/services/commerce-product-relations.service.js";
import { resolveEligibleProductCardsByIds } from "#src/services/store-catalog.service.js";
import { getPathwaySetBySlug } from "#src/services/store-pathways.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Who is authoring. §15.5 gives a guided pathway two legitimate authors — a seller
 * proposing a set of its own goods, and a platform merchandiser curating one — and
 * they are not the same principal: one is scoped to an organization, the other holds
 * a platform capability and may belong to no organization at all.
 */
export type CommercePathwayActor =
  | {
      readonly kind: "organization";
      readonly organizationId: string;
      readonly memberId: string;
      readonly memberRole: CommerceOrganizationMemberRole;
      readonly actorUserId: string;
    }
  | { readonly kind: "platform"; readonly actorUserId: string };

export type CommercePathwayError =
  | { type: "NOT_FOUND" }
  | { type: "SLUG_TAKEN" }
  | { type: "INVALID_CURSOR" }
  | { type: "INVALID_STATE"; message: string }
  /** One or more products are not listings a buyer could ever see. */
  | { type: "INVALID_TARGET"; productIds: readonly string[] }
  | { type: "VARIANT_REQUIRED"; productIds: readonly string[] }
  | { type: "VARIANT_NOT_APPLICABLE"; productIds: readonly string[] }
  | { type: "VARIANT_NOT_FOUND"; variantIds: readonly string[] }
  | { type: "ANCHOR_NOT_ELIGIBLE" }
  | { type: "ANCHOR_NOT_OWNED" }
  | {
      type: "QUANTITY_BELOW_MINIMUM";
      productId: string;
      minimumOrderQuantity: number;
      quantity: number;
    }
  /** A moderator may not decide a proposal from an organization they belong to. */
  | { type: "SELF_MODERATION_FORBIDDEN" }
  /** `0091`. The same two tags every other hosted-image surface in commerce uses. */
  | { type: "IMAGE_REJECTED"; imageError: ImageValidationError }
  | { type: "IMAGE_STORAGE_FAILED"; storageError: CloudinaryError }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

export interface PathwayCandidateAuthoringProjection {
  readonly id: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly rank: number;
}

export interface PathwaySlotAuthoringProjection {
  readonly id: string;
  readonly roleLabel: string;
  readonly isRequired: boolean;
  readonly quantity: number;
  readonly siblingOrder: number;
  readonly derivedRelationKind: CommerceProductRelationKind | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly candidates: readonly PathwayCandidateAuthoringProjection[];
}

export interface PathwayAuthoringProjection {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly accent: (typeof storePathway.$inferSelect)["accent"];
  readonly state: (typeof storePathway.$inferSelect)["state"];
  readonly anchorProductId: string | null;
  readonly heroImageUrl: string | null;
  readonly cardImageUrl: string | null;
  readonly ownerOrganizationId: string | null;
  readonly submittedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly slots: readonly PathwaySlotAuthoringProjection[];
}

/**
 * §15.5's reason for moderating at all: without review a seller composes a set
 * entirely from its own SKUs and a curated look becomes an advertisement. The share
 * is SURFACED, not auto-rejected — a bicycle maker legitimately supplies most of a
 * bicycle kit, and only a reviewer can tell that from self-dealing.
 */
export interface PathwayModerationProjection extends PathwayAuthoringProjection {
  readonly ownCandidateShare: number | null;
  readonly candidateCount: number;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAXIMUM_SLOTS_PER_PATHWAY = 100;
const MAXIMUM_CANDIDATES_PER_SLOT = 12;

/** A set is editable while nobody is looking at it, and after it comes back rejected. */
const EDITABLE_PATHWAY_STATES = ["draft", "rejected"] as const;
/** Hero art is full-bleed on the store's widest surface. */
const PATHWAY_IMAGE_OUTPUT_MAX_DIMENSION_PX = 2048;

interface SlotInput {
  readonly roleLabel: string;
  readonly isRequired?: boolean | undefined;
  readonly quantity?: number | undefined;
  readonly derivedRelationKind?: CommerceProductRelationKind | undefined;
  readonly startsAt?: Date | undefined;
  readonly endsAt?: Date | undefined;
}

interface CandidateInput {
  readonly productId: string;
  readonly variantId?: string | undefined;
  readonly rank?: number | undefined;
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce pathway audit append failed: ${appended.error.type}`);
  }
}

/**
 * A platform-curated pathway has no owning organization, so there is no organization
 * audit stream to append to. The row's own reviewer attribution is the record in that
 * case; inventing an organization to blame would be worse than not writing one.
 */
async function appendPathwayAudit(
  transaction: DatabaseTransaction,
  input: {
    readonly organizationId: string | null;
    readonly eventKind: Parameters<typeof appendCommerceOrganizationAuditEntry>[1]["eventKind"];
    readonly actorUserId: string;
    readonly memberRole: CommerceOrganizationMemberRole | null;
    readonly pathwayId: string;
    readonly payload: Parameters<typeof appendCommerceOrganizationAuditEntry>[1]["payload"];
    readonly occurredAt: Date;
  },
): Promise<void> {
  if (input.organizationId === null) return;
  await appendAuditOrThrow(transaction, {
    organizationId: input.organizationId,
    eventKind: input.eventKind,
    actorUserId: input.actorUserId,
    actorMemberRoleSnapshot: input.memberRole,
    targetEntityType: "store_pathway",
    targetEntityId: input.pathwayId,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
}

/**
 * Every authoring entry point runs through here.
 *
 * An organization actor is authorized by ownership; anyone else must hold
 * `moderate_commerce`. Note the capability check happens in the SERVICE, never in the
 * route chain, so staff capability is not probeable from the route table — the rule
 * `commerce-catalog.routes.ts` established for relation verification.
 */
async function authorizeActor(
  actor: CommercePathwayActor,
): Promise<Result<CommercePathwayActor, CommercePathwayError>> {
  if (actor.kind === "organization") return { success: true, value: actor };

  const capability = await requirePlatformCapability(actor.actorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }
  return { success: true, value: actor };
}

type PathwayRow = typeof storePathway.$inferSelect;

/**
 * Loads a pathway the actor may write to, under a row lock.
 *
 * NOT_FOUND rather than FORBIDDEN when an organization does not own the row: a caller
 * must not learn that a set they cannot touch exists — the same reason
 * `replaceSellerDeclaredRelations` returns NOT_FOUND for someone else's listing.
 */
async function loadWritablePathwayForUpdate(
  transaction: DatabaseTransaction,
  actor: CommercePathwayActor,
  pathwayId: string,
): Promise<PathwayRow | null> {
  const [row] = await transaction
    .select()
    .from(storePathway)
    .where(
      actor.kind === "organization"
        ? and(
            eq(storePathway.id, pathwayId),
            eq(storePathway.ownerOrganizationId, actor.organizationId),
          )
        : eq(storePathway.id, pathwayId),
    )
    .for("update");

  return row ?? null;
}

function isEditableState(state: PathwayRow["state"]): boolean {
  return (EDITABLE_PATHWAY_STATES as readonly string[]).includes(state);
}

async function projectPathway(
  databaseExecutor: DatabaseTransaction | typeof db,
  row: PathwayRow,
): Promise<PathwayAuthoringProjection> {
  const slotRows = await databaseExecutor
    .select()
    .from(storePathwaySlot)
    .where(eq(storePathwaySlot.pathwayId, row.id))
    .orderBy(asc(storePathwaySlot.siblingOrder), asc(storePathwaySlot.id));

  const candidateRows =
    slotRows.length === 0
      ? []
      : await databaseExecutor
          .select()
          .from(storePathwaySlotCandidate)
          .where(
            inArray(
              storePathwaySlotCandidate.slotId,
              slotRows.map((slotRow) => slotRow.id),
            ),
          )
          .orderBy(asc(storePathwaySlotCandidate.rank), asc(storePathwaySlotCandidate.id));

  const candidatesBySlotId = new Map<string, PathwayCandidateAuthoringProjection[]>();
  for (const candidateRow of candidateRows) {
    const candidates = candidatesBySlotId.get(candidateRow.slotId) ?? [];
    candidates.push({
      id: candidateRow.id,
      productId: candidateRow.productId,
      variantId: candidateRow.variantId,
      rank: candidateRow.rank,
    });
    candidatesBySlotId.set(candidateRow.slotId, candidates);
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    accent: row.accent,
    state: row.state,
    anchorProductId: row.anchorProductId,
    heroImageUrl: row.heroImageUrl,
    cardImageUrl: row.cardImageUrl,
    ownerOrganizationId: row.ownerOrganizationId,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    slots: slotRows.map((slotRow) => ({
      id: slotRow.id,
      roleLabel: slotRow.roleLabel,
      isRequired: slotRow.isRequired,
      quantity: slotRow.quantity,
      siblingOrder: slotRow.siblingOrder,
      derivedRelationKind: slotRow.derivedRelationKind,
      startsAt: slotRow.startsAt,
      endsAt: slotRow.endsAt,
      candidates: candidatesBySlotId.get(slotRow.id) ?? [],
    })),
  };
}

/**
 * An anchor must be a product a buyer could reach, and a seller may only anchor a set
 * on its own listing — otherwise one seller could build a "set" around a competitor's
 * flagship product and fill every slot with its own goods.
 */
async function validateAnchorProduct(
  actor: CommercePathwayActor,
  anchorProductId: string,
): Promise<CommercePathwayError | null> {
  const [anchorCard] = await resolveEligibleProductCardsByIds([anchorProductId]);
  if (anchorCard === undefined) return { type: "ANCHOR_NOT_ELIGIBLE" };

  if (actor.kind === "organization") {
    const [anchorRow] = await db
      .select({ sellerOrganizationId: product.sellerOrganizationId })
      .from(product)
      .where(eq(product.id, anchorProductId))
      .limit(1);
    if (anchorRow?.sellerOrganizationId !== actor.organizationId) {
      return { type: "ANCHOR_NOT_OWNED" };
    }
  }
  return null;
}

export async function createPathway(
  actor: CommercePathwayActor,
  input: {
    readonly slug: string;
    readonly title: string;
    readonly summary?: string | undefined;
    readonly accent?: (typeof storePathway.$inferSelect)["accent"] | undefined;
    readonly anchorProductId?: string | undefined;
    readonly startsAt?: Date | undefined;
    readonly endsAt?: Date | undefined;
  },
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  if (input.anchorProductId !== undefined) {
    const anchorError = await validateAnchorProduct(actor, input.anchorProductId);
    if (anchorError !== null) return { success: false, error: anchorError };
  }

  const occurredAt = new Date();
  try {
    const created = await db.transaction(async (transaction) => {
      const [row] = await transaction
        .insert(storePathway)
        .values({
          slug: input.slug,
          title: input.title,
          summary: input.summary ?? null,
          accent: input.accent ?? "slate",
          state: "draft",
          anchorProductId: input.anchorProductId ?? null,
          // Images arrive by upload after creation (`0091`), never as a URL on this body.
          ownerOrganizationId: actor.kind === "organization" ? actor.organizationId : null,
          createdByUserId: actor.actorUserId,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        })
        .returning();
      if (!row) throw new Error("Pathway insert returned no row.");

      await appendPathwayAudit(transaction, {
        organizationId: row.ownerOrganizationId,
        eventKind: "pathway_created",
        actorUserId: actor.actorUserId,
        memberRole: actor.kind === "organization" ? actor.memberRole : null,
        pathwayId: row.id,
        payload: { pathwayId: row.id, slug: row.slug, isAnchored: row.anchorProductId !== null },
        occurredAt,
      });

      return projectPathway(transaction, row);
    });

    return { success: true, value: created };
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { success: false, error: { type: "SLUG_TAKEN" } };
    throw error;
  }
}

export async function updatePathway(
  actor: CommercePathwayActor,
  pathwayId: string,
  input: {
    readonly title?: string | undefined;
    readonly summary?: string | null | undefined;
    readonly accent?: (typeof storePathway.$inferSelect)["accent"] | undefined;
    readonly anchorProductId?: string | null | undefined;
    readonly startsAt?: Date | null | undefined;
    readonly endsAt?: Date | null | undefined;
  },
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  if (typeof input.anchorProductId === "string") {
    const anchorError = await validateAnchorProduct(actor, input.anchorProductId);
    if (anchorError !== null) return { success: false, error: anchorError };
  }

  const occurredAt = new Date();
  const outcome = await db.transaction(async (transaction) => {
    const row = await loadWritablePathwayForUpdate(transaction, actor, pathwayId);
    if (row === null) return { status: "not_found" as const };
    if (!isEditableState(row.state)) {
      return { status: "invalid_state" as const, state: row.state };
    }

    const [updated] = await transaction
      .update(storePathway)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.accent === undefined ? {} : { accent: input.accent }),
        ...(input.anchorProductId === undefined ? {} : { anchorProductId: input.anchorProductId }),
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
      })
      .where(eq(storePathway.id, pathwayId))
      .returning();
    if (!updated) throw new Error("Pathway update returned no row.");

    await appendPathwayAudit(transaction, {
      organizationId: updated.ownerOrganizationId,
      eventKind: "pathway_updated",
      actorUserId: actor.actorUserId,
      memberRole: actor.kind === "organization" ? actor.memberRole : null,
      pathwayId: updated.id,
      payload: { pathwayId: updated.id, changedFields: Object.keys(input).toSorted() },
      occurredAt,
    });

    return { status: "updated" as const, projection: await projectPathway(transaction, updated) };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `A pathway in state ${outcome.state} cannot be edited.`,
        },
      };
    case "updated":
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled pathway update outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Replace one of a pathway's two images with platform-hosted bytes (migration `0091`).
 *
 * THIS IS THE ROUTE THE HOSTING DECISION WAS MADE FOR. `heroImageUrl` and `cardImageUrl`
 * used to be client-supplied https strings on create and update. §15.5 lets a SELLER
 * propose a pathway; a moderator publishes it; `EDITABLE_PATHWAY_STATES` then freezes the
 * row — so the store presents that art as reviewed. Under a URL the moderator reviewed a
 * pointer, and the seller could repoint it the moment the set went live. Approving a
 * pointer is not approving a picture.
 *
 * The editable-state gate is unchanged and deliberate: an image may only be set while the
 * pathway is `draft` or `rejected`, which is exactly the window in which the rest of the
 * proposal can still change. A published set's art is as frozen as its slots.
 */
export async function replacePathwayImage(
  actor: CommercePathwayActor,
  pathwayId: string,
  imageSlot: "hero" | "card",
  imageBytes: Buffer,
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  /**
   * Re-encode BEFORE Cloudinary: proves the bytes are a raster image from their magic
   * bytes rather than the untrusted multipart header, and strips EXIF. Dimensions come
   * from the normalized buffer, never the client (A2).
   */
  const normalized = await validateAndNormalizeImage(imageBytes, {
    outputMaxDimensionPx: PATHWAY_IMAGE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: { type: "IMAGE_REJECTED", imageError: normalized.error } };
  }

  /**
   * Authorize and check the state BEFORE spending a Cloudinary upload. The row is read
   * without a lock here and re-read under one inside the transaction below; this pass
   * exists so an unauthorized caller or a published pathway never reaches the uploader.
   */
  const [preflight] = await db
    .select({ state: storePathway.state, ownerOrganizationId: storePathway.ownerOrganizationId })
    .from(storePathway)
    .where(
      actor.kind === "organization"
        ? and(
            eq(storePathway.id, pathwayId),
            eq(storePathway.ownerOrganizationId, actor.organizationId),
          )
        : eq(storePathway.id, pathwayId),
    )
    .limit(1);
  if (!preflight) return { success: false, error: { type: "NOT_FOUND" } };
  if (!isEditableState(preflight.state)) {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A pathway in state ${preflight.state} cannot be edited.`,
      },
    };
  }

  const uploaded = await uploadStorePathwayImage(pathwayId, imageSlot, normalized.value.buffer);
  if (!uploaded.success) {
    return {
      success: false,
      error: { type: "IMAGE_STORAGE_FAILED", storageError: uploaded.error },
    };
  }

  const occurredAt = new Date();
  let outcome:
    | { readonly status: "not_found" }
    | { readonly status: "invalid_state"; readonly state: PathwayRow["state"] }
    | {
        readonly status: "updated";
        readonly projection: PathwayAuthoringProjection;
        readonly previousPublicId: string | null;
      };
  try {
    outcome = await db.transaction(async (transaction) => {
      const row = await loadWritablePathwayForUpdate(transaction, actor, pathwayId);
      if (row === null) return { status: "not_found" as const };
      if (!isEditableState(row.state)) {
        return { status: "invalid_state" as const, state: row.state };
      }

      const previousPublicId =
        imageSlot === "hero" ? row.heroImageCloudinaryPublicId : row.cardImageCloudinaryPublicId;

      const [updated] = await transaction
        .update(storePathway)
        .set(
          imageSlot === "hero"
            ? {
                heroImageUrl: uploaded.value.secureUrl,
                heroImageCloudinaryPublicId: uploaded.value.publicId,
                heroImageWidthPx: normalized.value.width,
                heroImageHeightPx: normalized.value.height,
              }
            : {
                cardImageUrl: uploaded.value.secureUrl,
                cardImageCloudinaryPublicId: uploaded.value.publicId,
                cardImageWidthPx: normalized.value.width,
                cardImageHeightPx: normalized.value.height,
              },
        )
        .where(eq(storePathway.id, pathwayId))
        .returning();
      if (!updated) throw new Error("Pathway image update returned no row.");

      /**
       * `imageSlot` and dimensions — never the public id. `FORBIDDEN_PAYLOAD_KEY` matches
       * `object.*key` and `filename` and throws, and a storage handle does not belong in
       * an immutable log in any case.
       */
      await appendPathwayAudit(transaction, {
        organizationId: updated.ownerOrganizationId,
        eventKind: "pathway_updated",
        actorUserId: actor.actorUserId,
        memberRole: actor.kind === "organization" ? actor.memberRole : null,
        pathwayId: updated.id,
        payload: {
          pathwayId: updated.id,
          changedFields: [imageSlot === "hero" ? "heroImage" : "cardImage"],
          widthPx: String(normalized.value.width),
          heightPx: String(normalized.value.height),
        },
        occurredAt,
      });

      return {
        status: "updated" as const,
        projection: await projectPathway(transaction, updated),
        previousPublicId,
      };
    });
  } catch (updateError: unknown) {
    // The asset is in Cloudinary and no row points at it. Remove it before surfacing.
    await deleteStorePathwayImage(uploaded.value.publicId);
    throw updateError;
  }

  switch (outcome.status) {
    case "not_found":
      await deleteStorePathwayImage(uploaded.value.publicId);
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      await deleteStorePathwayImage(uploaded.value.publicId);
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `A pathway in state ${outcome.state} cannot be edited.`,
        },
      };
    case "updated":
      if (
        outcome.previousPublicId !== null &&
        outcome.previousPublicId !== uploaded.value.publicId
      ) {
        // Best-effort: the row already names the new asset, so a failure here leaks an
        // orphan rather than breaking the set.
        await deleteStorePathwayImage(outcome.previousPublicId);
      }
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled pathway image outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Replaces the whole slot plan.
 *
 * Slots are deleted and re-inserted rather than diffed because `siblingOrder` is
 * unique per pathway: an in-place reorder collides with itself halfway through, and
 * the candidates of a slot that changed role are not the candidates of the new one.
 * Cascade deletes their candidates with them, which is the honest consequence of
 * rewriting the plan.
 */
export async function replacePathwaySlots(
  actor: CommercePathwayActor,
  pathwayId: string,
  slots: readonly SlotInput[],
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  if (slots.length > MAXIMUM_SLOTS_PER_PATHWAY) {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A pathway may hold at most ${String(MAXIMUM_SLOTS_PER_PATHWAY)} slots.`,
      },
    };
  }

  const occurredAt = new Date();
  const outcome = await db.transaction(async (transaction) => {
    const row = await loadWritablePathwayForUpdate(transaction, actor, pathwayId);
    if (row === null) return { status: "not_found" as const };
    if (!isEditableState(row.state)) {
      return { status: "invalid_state" as const, state: row.state };
    }
    if (row.anchorProductId === null && slots.some((slot) => slot.derivedRelationKind)) {
      return { status: "anchor_missing" as const };
    }

    await transaction.delete(storePathwaySlot).where(eq(storePathwaySlot.pathwayId, pathwayId));

    if (slots.length > 0) {
      await transaction.insert(storePathwaySlot).values(
        slots.map((slot, slotIndex) => ({
          pathwayId,
          roleLabel: slot.roleLabel,
          isRequired: slot.isRequired ?? true,
          quantity: slot.quantity ?? 1,
          siblingOrder: slotIndex,
          derivedRelationKind: slot.derivedRelationKind ?? null,
          startsAt: slot.startsAt ?? null,
          endsAt: slot.endsAt ?? null,
        })),
      );
    }

    await appendPathwayAudit(transaction, {
      organizationId: row.ownerOrganizationId,
      eventKind: "pathway_slots_replaced",
      actorUserId: actor.actorUserId,
      memberRole: actor.kind === "organization" ? actor.memberRole : null,
      pathwayId,
      payload: { pathwayId, slotCount: String(slots.length) },
      occurredAt,
    });

    return { status: "replaced" as const, projection: await projectPathway(transaction, row) };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `A pathway in state ${outcome.state} cannot be edited.`,
        },
      };
    case "anchor_missing":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: "A slot can only derive candidates on a pathway with an anchor product.",
        },
      };
    case "replaced":
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled slot replace outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

interface CandidateValidationFailure {
  readonly error: CommercePathwayError;
}

/**
 * Everything that must be true of a candidate before it can be stored.
 *
 * Eligibility is checked through `resolveEligibleProductCardsByIds` rather than by a
 * bare existence query, because checking mere existence would let an author mine draft
 * or suspended listings by watching which ids are accepted (§15.3's rule, applied here).
 */
async function validateCandidates(
  slotQuantity: number,
  candidates: readonly CandidateInput[],
): Promise<CandidateValidationFailure | null> {
  if (candidates.length === 0) return null;

  const productIds = [...new Set(candidates.map((candidate) => candidate.productId))];
  const eligibleCards = await resolveEligibleProductCardsByIds(productIds);
  const eligibleIds = new Set(eligibleCards.map((card) => card.id));
  const invalidIds = productIds.filter((productId) => !eligibleIds.has(productId));
  if (invalidIds.length > 0) {
    return { error: { type: "INVALID_TARGET", productIds: invalidIds } };
  }

  const activeVariantRows = await db
    .select({
      id: commerceProductVariant.id,
      productId: commerceProductVariant.productId,
      minimumOrderQuantity: commerceProductVariant.minimumOrderQuantity,
    })
    .from(commerceProductVariant)
    .where(
      and(
        inArray(commerceProductVariant.productId, productIds),
        eq(commerceProductVariant.state, "active"),
      ),
    );

  const activeVariantIdsByProductId = new Map<string, Set<string>>();
  const variantMinimumById = new Map<string, number | null>();
  for (const variantRow of activeVariantRows) {
    const variantIds = activeVariantIdsByProductId.get(variantRow.productId) ?? new Set<string>();
    variantIds.add(variantRow.id);
    activeVariantIdsByProductId.set(variantRow.productId, variantIds);
    variantMinimumById.set(variantRow.id, variantRow.minimumOrderQuantity);
  }

  // A1's rule, at authoring time rather than at add-to-cart time: a set must not
  // advertise a piece whose variant nobody chose.
  const missingVariantProductIds = candidates
    .filter(
      (candidate) =>
        candidate.variantId === undefined &&
        (activeVariantIdsByProductId.get(candidate.productId)?.size ?? 0) > 0,
    )
    .map((candidate) => candidate.productId);
  if (missingVariantProductIds.length > 0) {
    return {
      error: { type: "VARIANT_REQUIRED", productIds: [...new Set(missingVariantProductIds)] },
    };
  }

  const inapplicableVariantProductIds = candidates
    .filter(
      (candidate) =>
        candidate.variantId !== undefined &&
        (activeVariantIdsByProductId.get(candidate.productId)?.size ?? 0) === 0,
    )
    .map((candidate) => candidate.productId);
  if (inapplicableVariantProductIds.length > 0) {
    return {
      error: {
        type: "VARIANT_NOT_APPLICABLE",
        productIds: [...new Set(inapplicableVariantProductIds)],
      },
    };
  }

  const unknownVariantIds = candidates
    .filter(
      (candidate) =>
        candidate.variantId !== undefined &&
        !(activeVariantIdsByProductId.get(candidate.productId)?.has(candidate.variantId) ?? false),
    )
    .flatMap((candidate) => (candidate.variantId === undefined ? [] : [candidate.variantId]));
  if (unknownVariantIds.length > 0) {
    return { error: { type: "VARIANT_NOT_FOUND", variantIds: [...new Set(unknownVariantIds)] } };
  }

  return validateSlotQuantityAgainstMinimums(slotQuantity, candidates, variantMinimumById);
}

/**
 * A slot asking for twelve bolts whose candidate has a minimum order quantity of a
 * hundred is a set that cannot be bought. Rejecting it here means the buyer sees an
 * honest set; the read path still degrades if a seller raises an MOQ afterwards.
 */
async function validateSlotQuantityAgainstMinimums(
  slotQuantity: number,
  candidates: readonly CandidateInput[],
  variantMinimumById: ReadonlyMap<string, number | null>,
): Promise<CandidateValidationFailure | null> {
  const productIds = [...new Set(candidates.map((candidate) => candidate.productId))];
  const tierRows = await db
    .select({
      productId: productPricingTier.productId,
      variantId: productPricingTier.variantId,
      unitPriceInCents: productPricingTier.unitPriceInCents,
      minimumOrderQuantity: productPricingTier.minimumOrderQuantity,
    })
    .from(productPricingTier)
    .where(inArray(productPricingTier.productId, productIds));

  for (const candidate of candidates) {
    const applicableTiers = tierRows.filter(
      (tierRow) =>
        tierRow.productId === candidate.productId &&
        (candidate.variantId === undefined
          ? tierRow.variantId === null
          : tierRow.variantId === candidate.variantId || tierRow.variantId === null),
    );
    // Reuses the pricing rule rather than restating it: `resolveUnitPriceInCents`
    // reports the ladder's floor, which is the same number checkout will enforce.
    const laddderMinimum = resolveUnitPriceInCents({
      basePriceInCents: 0,
      quantity: slotQuantity,
      tiers: applicableTiers,
    }).minimumOrderQuantity;
    const variantMinimum =
      candidate.variantId === undefined
        ? null
        : (variantMinimumById.get(candidate.variantId) ?? null);
    const minimumOrderQuantity = Math.max(laddderMinimum, variantMinimum ?? 1);

    if (slotQuantity < minimumOrderQuantity) {
      return {
        error: {
          type: "QUANTITY_BELOW_MINIMUM",
          productId: candidate.productId,
          minimumOrderQuantity,
          quantity: slotQuantity,
        },
      };
    }
  }

  return null;
}

export async function replacePathwaySlotCandidates(
  actor: CommercePathwayActor,
  pathwayId: string,
  slotId: string,
  candidates: readonly CandidateInput[],
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  if (candidates.length > MAXIMUM_CANDIDATES_PER_SLOT) {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `A slot may hold at most ${String(MAXIMUM_CANDIDATES_PER_SLOT)} candidates.`,
      },
    };
  }

  const occurredAt = new Date();
  const outcome = await db.transaction(async (transaction) => {
    const row = await loadWritablePathwayForUpdate(transaction, actor, pathwayId);
    if (row === null) return { status: "not_found" as const };
    if (!isEditableState(row.state)) {
      return { status: "invalid_state" as const, state: row.state };
    }

    const [slotRow] = await transaction
      .select({ id: storePathwaySlot.id, quantity: storePathwaySlot.quantity })
      .from(storePathwaySlot)
      .where(and(eq(storePathwaySlot.id, slotId), eq(storePathwaySlot.pathwayId, pathwayId)))
      .limit(1);
    if (!slotRow) return { status: "not_found" as const };

    const validationFailure = await validateCandidates(slotRow.quantity, candidates);
    if (validationFailure !== null) {
      return { status: "invalid_candidates" as const, error: validationFailure.error };
    }

    await transaction
      .delete(storePathwaySlotCandidate)
      .where(eq(storePathwaySlotCandidate.slotId, slotId));

    if (candidates.length > 0) {
      await transaction.insert(storePathwaySlotCandidate).values(
        candidates.map((candidate, candidateIndex) => ({
          slotId,
          productId: candidate.productId,
          variantId: candidate.variantId ?? null,
          rank: candidate.rank ?? candidateIndex,
          // NOT an input: only the read path produces `derived` candidates (§15.2).
          sourceKind: "curated" as const,
        })),
      );
    }

    await appendPathwayAudit(transaction, {
      organizationId: row.ownerOrganizationId,
      eventKind: "pathway_candidates_replaced",
      actorUserId: actor.actorUserId,
      memberRole: actor.kind === "organization" ? actor.memberRole : null,
      pathwayId,
      payload: { pathwayId, slotId, candidateCount: String(candidates.length) },
      occurredAt,
    });

    return { status: "replaced" as const, projection: await projectPathway(transaction, row) };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `A pathway in state ${outcome.state} cannot be edited.`,
        },
      };
    case "invalid_candidates":
      return { success: false, error: outcome.error };
    case "replaced":
      return { success: true, value: outcome.projection };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled candidate replace outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Submits a set for review.
 *
 * The completeness rule is checked HERE rather than at publication because a reviewer
 * should never be shown a set with an unfillable required slot and asked to judge it:
 * a required slot with no candidate and no derivation is not a set awaiting an opinion,
 * it is an unfinished draft.
 */
export async function submitPathway(
  actor: CommercePathwayActor,
  pathwayId: string,
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  const occurredAt = new Date();
  const outcome = await db.transaction(async (transaction) => {
    const row = await loadWritablePathwayForUpdate(transaction, actor, pathwayId);
    if (row === null) return { status: "not_found" as const };
    if (row.state === "pending_review") {
      // Idempotent replay: a second submit of a set already in review changes nothing.
      return { status: "submitted" as const, row };
    }
    if (!isEditableState(row.state)) {
      return { status: "invalid_state" as const, state: row.state };
    }

    const slotRows = await transaction
      .select({
        id: storePathwaySlot.id,
        isRequired: storePathwaySlot.isRequired,
        derivedRelationKind: storePathwaySlot.derivedRelationKind,
      })
      .from(storePathwaySlot)
      .where(eq(storePathwaySlot.pathwayId, pathwayId));

    if (slotRows.length === 0) {
      return { status: "incomplete" as const, message: "A set needs at least one slot." };
    }

    const candidateCountRows = await transaction
      .select({
        slotId: storePathwaySlotCandidate.slotId,
        candidateCount: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(storePathwaySlotCandidate)
      .where(
        inArray(
          storePathwaySlotCandidate.slotId,
          slotRows.map((slotRow) => slotRow.id),
        ),
      )
      .groupBy(storePathwaySlotCandidate.slotId);
    const candidateCountBySlotId = new Map(
      candidateCountRows.map((countRow) => [countRow.slotId, countRow.candidateCount]),
    );

    const emptyRequiredSlot = slotRows.find(
      (slotRow) =>
        slotRow.isRequired &&
        slotRow.derivedRelationKind === null &&
        (candidateCountBySlotId.get(slotRow.id) ?? 0) === 0,
    );
    if (emptyRequiredSlot !== undefined) {
      return {
        status: "incomplete" as const,
        message: "Every required slot needs a candidate or a relation kind to derive one from.",
      };
    }

    const [updated] = await transaction
      .update(storePathway)
      .set({ state: "pending_review", submittedAt: occurredAt })
      .where(eq(storePathway.id, pathwayId))
      .returning();
    if (!updated) throw new Error("Pathway submit returned no row.");

    await appendPathwayAudit(transaction, {
      organizationId: updated.ownerOrganizationId,
      eventKind: "pathway_submitted",
      actorUserId: actor.actorUserId,
      memberRole: actor.kind === "organization" ? actor.memberRole : null,
      pathwayId,
      payload: { pathwayId, slotCount: String(slotRows.length) },
      occurredAt,
    });

    return { status: "submitted" as const, row: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `A pathway in state ${outcome.state} cannot be submitted.`,
        },
      };
    case "incomplete":
      return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
    case "submitted":
      return { success: true, value: await projectPathway(db, outcome.row) };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled pathway submit outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * Publishes or rejects a proposal (§15.8).
 *
 * Scoped to the USER rather than an organization: a moderator acts for the platform
 * and may not belong to a commerce organization at all. The one thing they may not do
 * is decide their own organization's proposal — the guard
 * `commerce-trust.service.ts` already applies to disputes, for the same reason.
 */
export async function moderatePathway(
  actorUserId: string,
  pathwayId: string,
  decision: "publish" | "reject",
  reviewNote: string | null,
): Promise<Result<PathwayAuthoringProjection, CommercePathwayError>> {
  const capability = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const occurredAt = new Date();
  const outcome = await db.transaction(async (transaction) => {
    const [row] = await transaction
      .select()
      .from(storePathway)
      .where(eq(storePathway.id, pathwayId))
      .for("update");
    if (!row) return { status: "not_found" as const };
    if (row.state !== "pending_review") {
      return { status: "invalid_state" as const, state: row.state };
    }

    if (row.ownerOrganizationId !== null) {
      const [membership] = await transaction
        .select({ id: commerceOrganizationMember.id })
        .from(commerceOrganizationMember)
        .where(
          and(
            eq(commerceOrganizationMember.organizationId, row.ownerOrganizationId),
            eq(commerceOrganizationMember.userId, actorUserId),
            eq(commerceOrganizationMember.state, "active"),
          ),
        )
        .limit(1);
      if (membership) return { status: "self_moderation" as const };
    }

    const [updated] = await transaction
      .update(storePathway)
      .set({
        state: decision === "publish" ? "active" : "rejected",
        reviewedByUserId: actorUserId,
        reviewedAt: occurredAt,
        reviewNote,
      })
      .where(eq(storePathway.id, pathwayId))
      .returning();
    if (!updated) throw new Error("Pathway moderate returned no row.");

    await appendPathwayAudit(transaction, {
      organizationId: updated.ownerOrganizationId,
      eventKind: "pathway_moderated",
      actorUserId,
      memberRole: null,
      pathwayId,
      payload: { pathwayId, decision },
      occurredAt,
    });

    return { status: "moderated" as const, row: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `Only a pathway awaiting review can be moderated; this one is ${outcome.state}.`,
        },
      };
    case "self_moderation":
      return { success: false, error: { type: "SELF_MODERATION_FORBIDDEN" } };
    case "moderated":
      return { success: true, value: await projectPathway(db, outcome.row) };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled pathway moderate outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/**
 * The author's own sets. Without this an author cannot find the draft they need to
 * edit, and the authoring surface is only reachable by remembering an id.
 */
export async function listAuthoredPathways(
  actor: CommercePathwayActor,
  page: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
): Promise<
  Result<
    {
      readonly items: readonly PathwayAuthoringProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommercePathwayError
  >
> {
  const authorized = await authorizeActor(actor);
  if (!authorized.success) return authorized;

  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor = page.cursor === undefined ? null : decodeStoreCursor(page.cursor);
  if (page.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const ownershipPredicate =
    actor.kind === "organization"
      ? eq(storePathway.ownerOrganizationId, actor.organizationId)
      : isNull(storePathway.ownerOrganizationId);

  const rows = await db
    .select()
    .from(storePathway)
    .where(
      and(
        ownershipPredicate,
        decodedCursor === null
          ? undefined
          : or(
              gt(storePathway.title, decodedCursor.sortKey),
              and(
                eq(storePathway.title, decodedCursor.sortKey),
                gt(storePathway.id, decodedCursor.id),
              ),
            ),
      ),
    )
    .orderBy(asc(storePathway.title), asc(storePathway.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.title, id: lastRow.id })
      : null;

  return {
    success: true,
    value: {
      items: await Promise.all(pageRows.map((row) => projectPathway(db, row))),
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/**
 * The moderation queue. `POST /commerce/admin/pathways/:id/moderate` is unreachable
 * without it — a moderator would have to be told an id out of band.
 */
export async function listPathwayModerationQueue(
  actorUserId: string,
  page: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
): Promise<
  Result<
    {
      readonly items: readonly PathwayModerationProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommercePathwayError
  >
> {
  const capability = await requirePlatformCapability(actorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  const decodedCursor = page.cursor === undefined ? null : decodeStoreCursor(page.cursor);
  if (page.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }
  const cursorSubmittedAt = decodedCursor === null ? null : new Date(decodedCursor.sortKey);
  if (cursorSubmittedAt !== null && Number.isNaN(cursorSubmittedAt.getTime())) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const rows = await db
    .select()
    .from(storePathway)
    .where(
      and(
        eq(storePathway.state, "pending_review"),
        cursorSubmittedAt === null || decodedCursor === null
          ? undefined
          : or(
              gt(storePathway.submittedAt, cursorSubmittedAt),
              and(
                eq(storePathway.submittedAt, cursorSubmittedAt),
                gt(storePathway.id, decodedCursor.id),
              ),
            ),
      ),
    )
    .orderBy(asc(storePathway.submittedAt), asc(storePathway.id))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > limit && lastRow && lastRow.submittedAt
      ? encodeStoreCursor({ sortKey: lastRow.submittedAt.toISOString(), id: lastRow.id })
      : null;

  const items = await Promise.all(
    pageRows.map(async (row) => {
      const projection = await projectPathway(db, row);
      const selfDealing = await measureOwnCandidateShare(row.id, row.ownerOrganizationId);
      return { ...projection, ...selfDealing };
    }),
  );

  return {
    success: true,
    value: { items, page: { nextCursor, hasMore: nextCursor !== null } },
  };
}

/**
 * A slot the seeded cart could not fill, and why. Reported rather than skipped: §15.4
 * requires that seeding "reports any slot it could not fill rather than quietly adding
 * fewer lines", because a buyer who asked for a whole kit and silently got five sixths
 * of one has been misled about what they are buying.
 */
export interface UnfilledPathwaySlotProjection {
  readonly slotId: string;
  readonly roleLabel: string;
  readonly reason:
    | "NO_ELIGIBLE_CANDIDATE"
    | "VARIANT_SELECTION_REQUIRED"
    | "SELECTION_NOT_A_CANDIDATE"
    | "NOT_PURCHASABLE";
}

export interface SeedCartFromPathwayResult {
  readonly cart: CommerceCartProjection;
  readonly filledSlotCount: number;
  readonly unfilledSlots: readonly UnfilledPathwaySlotProjection[];
}

export interface PathwayCartSelectionInput {
  readonly slotId: string;
  readonly productId: string;
  readonly variantId?: string | undefined;
}

/**
 * Seeds a buyer's cart from a published set (§15.4).
 *
 * A pathway spanning several sellers is NOT a new order type: it seeds the cart, and
 * the existing cart → prepare → confirm path then produces one order per counterparty
 * (§2.3). Nothing about a pathway reaches an order — an order line snapshots products,
 * quantities and prices, and a set is a browsing construct.
 *
 * Only REQUIRED slots are seeded. An optional slot is an invitation, not part of what
 * the buyer asked for, and adding it would put lines in a cart nobody chose.
 */
export async function seedCartFromPathway(
  actor: {
    readonly organizationId: string;
    readonly memberId: string;
    readonly memberRole: CommerceOrganizationMemberRole;
    readonly actorUserId: string;
  },
  pathwaySlug: string,
  selections: readonly PathwayCartSelectionInput[],
): Promise<Result<SeedCartFromPathwayResult, CommercePathwayError>> {
  const setResult = await getPathwaySetBySlug({
    pathwaySlug,
    // Every slot, not a page: seeding a cart from page one of a kit would fill part of
    // it and call that success.
    limit: MAXIMUM_SLOTS_PER_PATHWAY,
  });
  if (!setResult.success) {
    return {
      success: false,
      error:
        setResult.error.type === "INVALID_CURSOR"
          ? { type: "INVALID_CURSOR" }
          : { type: "NOT_FOUND" },
    };
  }

  const selectionBySlotId = new Map(
    selections.map((selection) => [selection.slotId, selection] as const),
  );
  const unfilledSlots: UnfilledPathwaySlotProjection[] = [];
  const linesToAdd: {
    readonly productId: string;
    readonly variantId: string | null;
    readonly quantity: number;
    readonly slotId: string;
    readonly roleLabel: string;
  }[] = [];

  for (const slot of setResult.value.slots) {
    if (!slot.isRequired) continue;

    const selection = selectionBySlotId.get(slot.id);
    const chosenCandidate =
      selection === undefined
        ? slot.candidates.find((candidate) => candidate.key === slot.chosenCandidateKey)
        : slot.candidates.find(
            (candidate) =>
              candidate.productId === selection.productId &&
              candidate.variantId === (selection.variantId ?? null),
          );

    if (chosenCandidate === undefined) {
      unfilledSlots.push({
        slotId: slot.id,
        roleLabel: slot.roleLabel,
        // A selection naming something the slot does not offer is a different failure
        // from a slot that has nothing to offer, and the buyer should be told which.
        reason: selection === undefined ? "NO_ELIGIBLE_CANDIDATE" : "SELECTION_NOT_A_CANDIDATE",
      });
      continue;
    }
    if (chosenCandidate.pricing.status === "variant_selection_required") {
      unfilledSlots.push({
        slotId: slot.id,
        roleLabel: slot.roleLabel,
        reason: "VARIANT_SELECTION_REQUIRED",
      });
      continue;
    }
    if (chosenCandidate.pricing.status !== "priced") {
      unfilledSlots.push({
        slotId: slot.id,
        roleLabel: slot.roleLabel,
        reason: "NOT_PURCHASABLE",
      });
      continue;
    }

    linesToAdd.push({
      productId: chosenCandidate.productId,
      variantId: chosenCandidate.variantId,
      quantity: slot.quantity,
      slotId: slot.id,
      roleLabel: slot.roleLabel,
    });
  }

  const occurredAt = new Date();
  const failedSlots = await db.transaction(async (transaction) => {
    // ONE transaction under ONE cart lock for the whole set: N calls to `setCartItem`
    // would supersede the buyer's checkout preparation N times, write N audit rows for
    // one action, and leave a half-seeded cart if a later line failed.
    const cart = await getOrCreateCartForUpdate(transaction, actor.organizationId);
    const writeFailures: UnfilledPathwaySlotProjection[] = [];

    for (const line of linesToAdd) {
      const upsertOutcome = await upsertCartProductLine(transaction, {
        cartId: cart.id,
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        now: occurredAt,
      });
      if (upsertOutcome.status !== "upserted") {
        writeFailures.push({
          slotId: line.slotId,
          roleLabel: line.roleLabel,
          reason:
            upsertOutcome.status === "variant_required"
              ? "VARIANT_SELECTION_REQUIRED"
              : "NOT_PURCHASABLE",
        });
      }
    }

    await supersedeActiveCheckoutPrepares(transaction, cart.id, occurredAt);

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "cart_seeded_from_pathway",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "store_pathway",
      targetEntityId: setResult.value.pathway.id,
      payload: {
        cartId: cart.id,
        pathwayId: setResult.value.pathway.id,
        filledSlotCount: String(linesToAdd.length - writeFailures.length),
        unfilledSlotCount: String(unfilledSlots.length + writeFailures.length),
      },
      occurredAt,
    });

    return writeFailures;
  });

  const cartResult = await getCart({
    organizationId: actor.organizationId,
    memberId: actor.memberId,
    memberRole: actor.memberRole,
    actorUserId: actor.actorUserId,
  });
  if (!cartResult.success) {
    // The cart read only fails for reasons the seed already ruled out (the buyer's own
    // organization going inactive mid-request), so treat it as the set being gone
    // rather than inventing a new tag.
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return {
    success: true,
    value: {
      cart: cartResult.value,
      filledSlotCount: linesToAdd.length - failedSlots.length,
      unfilledSlots: [...unfilledSlots, ...failedSlots],
    },
  };
}

async function measureOwnCandidateShare(
  pathwayId: string,
  ownerOrganizationId: string | null,
): Promise<{ readonly ownCandidateShare: number | null; readonly candidateCount: number }> {
  const rows = await db
    .select({
      candidateCount: sql<number>`count(*)::int`.mapWith(Number),
      ownCandidateCount: sql<number>`count(*) FILTER (
        WHERE ${product.sellerOrganizationId} IS NOT DISTINCT FROM ${ownerOrganizationId}
      )::int`.mapWith(Number),
    })
    .from(storePathwaySlotCandidate)
    .innerJoin(storePathwaySlot, eq(storePathwaySlot.id, storePathwaySlotCandidate.slotId))
    .innerJoin(product, eq(product.id, storePathwaySlotCandidate.productId))
    .where(eq(storePathwaySlot.pathwayId, pathwayId));

  const row = rows[0];
  if (!row || row.candidateCount === 0 || ownerOrganizationId === null) {
    return { ownCandidateShare: null, candidateCount: row?.candidateCount ?? 0 };
  }
  return {
    ownCandidateShare: Number((row.ownCandidateCount / row.candidateCount).toFixed(4)),
    candidateCount: row.candidateCount,
  };
}
