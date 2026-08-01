/**
 * Home-page promotional slides — the carousel at the top of the front page.
 *
 * WHAT MAKES THIS DOMAIN DIFFERENT FROM EVERY OTHER WRITE SURFACE HERE. A slide has no
 * member owner. `product` belongs to a seller and `research_project` to a founder, so both
 * answer 404 when a caller asks about a row they do not own — the id must not be probeable.
 * A slide belongs to the platform. There is nothing to own, so there is nothing to hide,
 * and the ENTIRE gate is `manage_promotions`, checked before any id is read.
 *
 * THE ORDERING RULE IS NOT OPTIONAL (platform-role.service.ts). Capability first, resource
 * second, in every function below. Reversed, a 404-vs-403 difference turns each route into
 * an id oracle for anyone holding a session.
 *
 * WHY THE CAPABILITY IS `manage_promotions` AND NOT `moderate_content`. Publishing a
 * front-page placement that may point at an arbitrary external https URL is a different
 * act from deciding whether a user's upload is allowed. Every `moderator` holds
 * `moderate_content`; only `admin` holds this.
 *
 * The image lives at a DETERMINISTIC Cloudinary public id derived from the slide id, so a
 * replace overwrites in place and cannot orphan the previous asset. The returned
 * secure_url must be written back on every upload — its `/v<timestamp>/` segment is the
 * cache bust.
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { promotionalSlide } from "#src/db/schema.js";
import {
  deletePromotionalSlideImage,
  uploadPromotionalSlideImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import {
  parsePromotionalDestination,
  type PromotionalDestinationError,
  type PromotionalDestinationKind,
} from "#src/lib/promotional-destination.js";
import { recordPlatformAction } from "#src/services/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * How many slides may exist at once, live or retired.
 *
 * A PRODUCT DECISION, enforced here rather than in the database: the front page is a
 * finite amount of attention, and a carousel nobody sits through is a carousel nobody
 * reads. Mirrors MAX_PRODUCT_IMAGES.
 */
export const MAX_PROMOTIONAL_SLIDES = 12;

/**
 * The output box for a slide image. Larger than the product-listing box (1600) because a
 * slide renders full-bleed across the feed: at ~1200 CSS px on a 2× display it needs 2400
 * device pixels or it visibly softens.
 */
const SLIDE_OUTPUT_MAX_DIMENSION_PX = 2400;

export type PromotionalSlideError =
  | PlatformAccessError
  | { type: "PROMOTIONAL_SLIDE_NOT_FOUND"; slideId: string }
  | {
      type: "PROMOTIONAL_DESTINATION_INVALID";
      destinationKind: PromotionalDestinationKind;
      reason: PromotionalDestinationError;
    }
  | { type: "PROMOTIONAL_SLIDE_WINDOW_INVALID" }
  | { type: "PROMOTIONAL_SLIDE_ORDER_MISMATCH" }
  | { type: "PROMOTIONAL_SLIDE_LIMIT_REACHED"; limit: number }
  | ImageValidationError
  | CloudinaryError;

/**
 * What a VISITOR sees. Deliberately narrower than the admin view.
 *
 * `position` is absent on purpose: the array order IS the contract. Handing a client the
 * integer invites a client that re-sorts, and then the order the admin set is one the
 * frontend can silently disagree with. `isActive`, the schedule window and the audit
 * columns are absent for the same reason they are not the visitor's business.
 */
export interface PublicPromotionalSlide {
  readonly id: string;
  readonly imageUrl: string;
  readonly imageWidthPx: number;
  readonly imageHeightPx: number;
  readonly altText: string;
  readonly destinationKind: PromotionalDestinationKind;
  readonly destinationValue: string;
}

/** What the admin console sees — everything, including retired and scheduled rows. */
export interface AdminPromotionalSlide extends PublicPromotionalSlide {
  readonly position: number;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const PUBLIC_VIEW_COLUMNS = {
  id: promotionalSlide.id,
  imageUrl: promotionalSlide.imageUrl,
  imageWidthPx: promotionalSlide.imageWidthPx,
  imageHeightPx: promotionalSlide.imageHeightPx,
  altText: promotionalSlide.altText,
  destinationKind: promotionalSlide.destinationKind,
  destinationValue: promotionalSlide.destinationValue,
} as const;

const ADMIN_VIEW_COLUMNS = {
  ...PUBLIC_VIEW_COLUMNS,
  position: promotionalSlide.position,
  isActive: promotionalSlide.isActive,
  startsAt: promotionalSlide.startsAt,
  endsAt: promotionalSlide.endsAt,
  createdByUserId: promotionalSlide.createdByUserId,
  updatedByUserId: promotionalSlide.updatedByUserId,
  createdAt: promotionalSlide.createdAt,
  updatedAt: promotionalSlide.updatedAt,
} as const;

export interface CreatePromotionalSlideInput {
  readonly altText: string;
  readonly destinationKind: PromotionalDestinationKind;
  readonly destinationValue: string;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export interface UpdatePromotionalSlideInput {
  readonly altText?: string;
  readonly destinationKind?: PromotionalDestinationKind;
  readonly destinationValue?: string;
  readonly isActive?: boolean;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

/**
 * `GET /promotions/slides` — THE ONLY UNAUTHENTICATED FUNCTION IN THIS FILE.
 *
 * Live means active AND inside its schedule window, with a NULL bound meaning unbounded on
 * that side. The `id` tiebreak on the ORDER BY is mandatory, not cosmetic: two slides
 * sharing a position would otherwise come back in whatever order Postgres felt like, and
 * the carousel would reshuffle itself between requests.
 */
export async function listActivePromotionalSlides(): Promise<readonly PublicPromotionalSlide[]> {
  const now = new Date();

  return db
    .select(PUBLIC_VIEW_COLUMNS)
    .from(promotionalSlide)
    .where(
      and(
        eq(promotionalSlide.isActive, true),
        or(isNull(promotionalSlide.startsAt), lte(promotionalSlide.startsAt, now)),
        or(isNull(promotionalSlide.endsAt), gt(promotionalSlide.endsAt, now)),
      ),
    )
    .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id));
}

/** `GET /promotions/admin/slides` — every slide, live or not, in display order. */
export async function listPromotionalSlidesForStaff(
  actorUserId: string,
): Promise<Result<readonly AdminPromotionalSlide[], PromotionalSlideError>> {
  // CAPABILITY FIRST. The admin list is gated too — it exposes retired rows, scheduled
  // campaigns and who authored them.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(promotionalSlide)
    .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id));

  return { success: true, value: rows };
}

/** Both bounds present means the window must be non-empty. Mirrors the DB CHECK. */
function isScheduleWindowValid(startsAt: Date | null, endsAt: Date | null): boolean {
  return startsAt === null || endsAt === null || endsAt.getTime() > startsAt.getTime();
}

/**
 * `POST /promotions/admin/slides` — mints a slide from an uploaded image in ONE call.
 *
 * WHY THE ID IS MINTED BEFORE THE ROW EXISTS. The Cloudinary public id is derived from the
 * slide id, but the insert has not happened yet. `addProductImage` solves this the same
 * way: generate the uuid here, upload to that id, then insert with it. The alternative —
 * insert, then upload, then update — leaves an image-less row visible to the admin list
 * whenever the upload fails.
 *
 * A failed insert after a successful upload leaves ONE orphaned asset. Accepted, and
 * reclaimable precisely because the id is deterministic; every upload path in this
 * codebase makes the same trade.
 */
export async function createPromotionalSlide(
  actorUserId: string,
  input: CreatePromotionalSlideInput,
  rawImageBytes: Buffer,
): Promise<Result<AdminPromotionalSlide, PromotionalSlideError>> {
  // 1. CAPABILITY FIRST — before the body is even looked at.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Cheap validation before the expensive image work.
  const destinationResult = parsePromotionalDestination(
    input.destinationKind,
    input.destinationValue,
  );
  if (!destinationResult.success) {
    return {
      success: false,
      error: {
        type: "PROMOTIONAL_DESTINATION_INVALID",
        destinationKind: input.destinationKind,
        reason: destinationResult.error,
      },
    };
  }

  if (!isScheduleWindowValid(input.startsAt, input.endsAt)) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_WINDOW_INVALID" } };
  }

  const [existingCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(promotionalSlide);
  const slideCount = existingCount?.total ?? 0;
  if (slideCount >= MAX_PROMOTIONAL_SLIDES) {
    return {
      success: false,
      error: { type: "PROMOTIONAL_SLIDE_LIMIT_REACHED", limit: MAX_PROMOTIONAL_SLIDES },
    };
  }

  // 3. Prove the bytes are a real image and re-encode them (strips EXIF, refuses bombs).
  const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: SLIDE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedResult.success) {
    return { success: false, error: normalizedResult.error };
  }

  const slideId = randomUUID();
  const uploadResult = await uploadPromotionalSlideImage(slideId, normalizedResult.value.buffer);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error };
  }

  const [inserted] = await recordPlatformAction(
    async (tx) =>
      tx
        .insert(promotionalSlide)
        .values({
          id: slideId,
          imageUrl: uploadResult.value.secureUrl,
          imageWidthPx: normalizedResult.value.width,
          imageHeightPx: normalizedResult.value.height,
          altText: input.altText,
          destinationKind: destinationResult.value.kind,
          destinationValue: destinationResult.value.normalizedValue,
          // Appends at the end. Order is changed only through the reorder route.
          position: slideCount,
          isActive: input.isActive,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          createdByUserId: actorUserId,
          updatedByUserId: actorUserId,
        })
        .returning(ADMIN_VIEW_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "promotional_slide_created",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Created a promotional slide",
            targetLabel: `promotional slide ${slideId}`,
            payload: {
              destinationKind: destinationResult.value.kind,
              destinationValue: destinationResult.value.normalizedValue,
              isActive: input.isActive,
            },
            occurredAt: new Date(),
          },
  );

  if (!inserted) {
    throw new Error("createPromotionalSlide: insert returned no row");
  }
  return { success: true, value: inserted };
}

/**
 * `PATCH /promotions/admin/slides/:slideId` — alt text, destination, schedule, active flag.
 *
 * `position` is NOT here. Order is changed only through `reorderPromotionalSlides`, which
 * rewrites every row at once; a per-row position write would let two slides claim the same
 * slot with no way to say which the admin meant.
 *
 * `isActive: false` IS the retirement mechanism — the row survives, the public read stops
 * offering it, and DELETE stays the mistake-eraser.
 */
export async function updatePromotionalSlide(
  actorUserId: string,
  slideId: string,
  input: UpdatePromotionalSlideInput,
): Promise<Result<AdminPromotionalSlide, PromotionalSlideError>> {
  // 1. CAPABILITY FIRST — before `slideId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(promotionalSlide)
    .where(eq(promotionalSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }

  // The controller guarantees kind and value arrive together or not at all, so checking
  // one is enough to know whether the destination is being changed.
  let normalizedDestinationValue: string | undefined;
  if (input.destinationKind !== undefined && input.destinationValue !== undefined) {
    const destinationResult = parsePromotionalDestination(
      input.destinationKind,
      input.destinationValue,
    );
    if (!destinationResult.success) {
      return {
        success: false,
        error: {
          type: "PROMOTIONAL_DESTINATION_INVALID",
          destinationKind: input.destinationKind,
          reason: destinationResult.error,
        },
      };
    }
    normalizedDestinationValue = destinationResult.value.normalizedValue;
  }

  // The window is validated against the ROW AS IT WILL BE, not against the patch alone —
  // sending only `endsAt` must still be checked against the stored `startsAt`.
  const nextStartsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt;
  const nextEndsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt;
  if (!isScheduleWindowValid(nextStartsAt, nextEndsAt)) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_WINDOW_INVALID" } };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(promotionalSlide)
        .set({
          ...(input.altText === undefined ? {} : { altText: input.altText }),
          ...(input.destinationKind === undefined || normalizedDestinationValue === undefined
            ? {}
            : {
                destinationKind: input.destinationKind,
                destinationValue: normalizedDestinationValue,
              }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
          ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
          updatedByUserId: actorUserId,
        })
        .where(eq(promotionalSlide.id, slideId))
        .returning(ADMIN_VIEW_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "promotional_slide_updated",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Updated a promotional slide",
            targetLabel: `promotional slide ${slideId}`,
            payload: {
              altText: input.altText ?? null,
              destinationKind: input.destinationKind ?? null,
              destinationValue: normalizedDestinationValue ?? null,
              isActive: input.isActive ?? null,
            },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: updated };
}

/**
 * `PUT /promotions/admin/slides/:slideId/image` — replaces the image, in place.
 *
 * A SEPARATE ROUTE FROM THE METADATA PATCH on purpose. Folding the file into that PATCH
 * would make "leave the image alone" an ABSENT multipart part, which is the ambiguity that
 * quietly clears a column the day someone submits the form without re-picking a file.
 *
 * The returned secure_url is written back because its `/v<timestamp>/` segment changed —
 * that is the cache bust. Reusing the stored URL here would serve the old image forever.
 */
export async function replacePromotionalSlideImage(
  actorUserId: string,
  slideId: string,
  rawImageBytes: Buffer,
): Promise<Result<AdminPromotionalSlide, PromotionalSlideError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second — and before the expensive decode, so a bad id is cheap.
  const [existing] = await db
    .select({ id: promotionalSlide.id })
    .from(promotionalSlide)
    .where(eq(promotionalSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }

  const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: SLIDE_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedResult.success) {
    return { success: false, error: normalizedResult.error };
  }

  const uploadResult = await uploadPromotionalSlideImage(slideId, normalizedResult.value.buffer);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(promotionalSlide)
        .set({
          imageUrl: uploadResult.value.secureUrl,
          imageWidthPx: normalizedResult.value.width,
          imageHeightPx: normalizedResult.value.height,
          updatedByUserId: actorUserId,
        })
        .where(eq(promotionalSlide.id, slideId))
        .returning(ADMIN_VIEW_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "promotional_slide_image_replaced",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Replaced a promotional slide image",
            targetLabel: `promotional slide ${slideId}`,
            payload: { imageUrl: uploadResult.value.secureUrl },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: updated };
}

/**
 * `PATCH /promotions/admin/slides/reorder` — sets the whole display order at once.
 *
 * `slideIds` must be an EXACT PERMUTATION of every existing slide id. Anything else is a
 * mismatch, never a partial apply: a client working from a stale list would otherwise
 * silently drop whichever slide it had not seen yet to the end.
 *
 * The rewrite runs inside one transaction, which is also why `position` carries no UNIQUE
 * index — a non-deferrable one would fire halfway through the loop.
 */
export async function reorderPromotionalSlides(
  actorUserId: string,
  slideIds: readonly string[],
): Promise<Result<readonly AdminPromotionalSlide[], PromotionalSlideError>> {
  // 1. CAPABILITY FIRST — before any id in the body is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const existing = await db.select({ id: promotionalSlide.id }).from(promotionalSlide);
  const existingIds = existing.map((row) => row.id);

  const requestedIds = new Set(slideIds);
  const isPermutation =
    requestedIds.size === slideIds.length &&
    requestedIds.size === existingIds.length &&
    existingIds.every((id) => requestedIds.has(id));

  if (!isPermutation) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_ORDER_MISMATCH" } };
  }

  await recordPlatformAction(
    async (tx) => {
      for (let position = 0; position < slideIds.length; position += 1) {
        await tx
          .update(promotionalSlide)
          .set({ position, updatedByUserId: actorUserId })
          .where(eq(promotionalSlide.id, slideIds[position]));
      }
      return slideIds.length;
    },
    (rewrittenCount) =>
      rewrittenCount === 0
        ? null
        : {
            eventKind: "promotional_slide_reordered",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Reordered the promotional carousel",
            targetLabel: `${String(rewrittenCount)} promotional slides`,
            payload: { slideIds: [...slideIds] },
            occurredAt: new Date(),
          },
  );

  const rows = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(promotionalSlide)
    .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id));

  return { success: true, value: rows };
}

/**
 * `DELETE /promotions/admin/slides/:slideId` — removes the slide and its image.
 *
 * THE ASSET IS DESTROYED FIRST, and a failure there returns without touching the row. That
 * is the opposite order from `deletePhysicalReceipt`, whose comment says "the row is the
 * record; the bytes are a copy" — true for a receipt, false here. For a slide the image IS
 * the content, so a surviving row pointing at a destroyed asset renders as a broken
 * carousel on the front page. Better to keep both and let the admin retry.
 *
 * Positions are re-packed afterwards so the order stays contiguous: delete the 2nd of four
 * and the old 3rd and 4th become 2nd and 3rd, with no gap for the admin to puzzle over.
 */
export async function deletePromotionalSlide(
  actorUserId: string,
  slideId: string,
): Promise<Result<{ deletedSlideId: string }, PromotionalSlideError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select({ id: promotionalSlide.id })
    .from(promotionalSlide)
    .where(eq(promotionalSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }

  const assetDeletion = await deletePromotionalSlideImage(slideId);
  if (!assetDeletion.success) {
    return { success: false, error: assetDeletion.error };
  }

  const deletedCount = await recordPlatformAction(
    async (tx) => {
      const deleted = await tx
        .delete(promotionalSlide)
        .where(eq(promotionalSlide.id, slideId))
        .returning({ id: promotionalSlide.id });

      if (deleted.length === 0) {
        return 0;
      }

      // Re-pack so positions stay 0-based and contiguous.
      const remaining = await tx
        .select({ id: promotionalSlide.id })
        .from(promotionalSlide)
        .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id));

      for (let position = 0; position < remaining.length; position += 1) {
        await tx
          .update(promotionalSlide)
          .set({ position })
          .where(eq(promotionalSlide.id, remaining[position].id));
      }

      return deleted.length;
    },
    (count) =>
      count === 0
        ? null
        : {
            eventKind: "promotional_slide_deleted",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Deleted a promotional slide",
            targetLabel: `promotional slide ${slideId}`,
            payload: { slideId },
            occurredAt: new Date(),
          },
  );

  if (deletedCount === 0) {
    return { success: false, error: { type: "PROMOTIONAL_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: { deletedSlideId: slideId } };
}
