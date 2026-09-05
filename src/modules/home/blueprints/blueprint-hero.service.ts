/**
 * The /anime hero carousel — the rotating card at the top of the anime page.
 *
 * PLATFORM-AUTHORED, exactly like `promotional_slide`. A slide has no member owner, so
 * there is nothing to own and nothing to hide: the ENTIRE gate is `manage_promotions`,
 * checked before any id is read. The ordering rule from platform-role.service.ts is not
 * optional — capability first, resource second, in every function below. Reversed, the
 * 404-vs-403 difference turns each route into an id oracle for anyone holding a session.
 *
 * WHY `manage_promotions` AND NOT A NEW CAPABILITY. This is the same staff act with the
 * same blast radius as the front-page carousel and the Spotlight rail: publishing an image
 * that every visitor to a landing surface sees. A fourth admin-only grant for it would be
 * role ceremony, not a real distinction.
 *
 * TWO DIFFERENCES FROM PROMOTIONS, both structural:
 *
 *   1. THE DESTINATION IS INTERNAL-ONLY and NULLABLE. There is no `external_url` arm,
 *      because a link off-site does not belong on a content surface, and a slide with no
 *      link at all is a legitimate decorative slide (`store_hero_slide` already models
 *      one). The parse still runs — see `parseHeroDestination` below.
 *   2. A SLIDE'S IMAGE MAY BE A SITE-RELATIVE PATH. The rows seeded with migration 0149
 *      point at files in the frontend's `public/dummy/`, because a migration cannot upload
 *      to Cloudinary and the alternative — a hardcoded fallback slide in the component —
 *      is a mock fallback on a wired surface. Everything an admin uploads is an https
 *      Cloudinary URL as usual; the two coexist and `deleteAnimeHeroSlide` tells them
 *      apart.
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { animeHeroSlide } from "#src/db/schema.js";
import {
  deleteAnimeHeroSlideImage,
  uploadAnimeHeroSlideImage,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import {
  parsePromotionalDestination,
  type PromotionalDestinationError,
} from "#src/modules/home/promotions/promotional-destination.js";
import { recordPlatformAction } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * How many slides may exist at once, live or retired.
 *
 * A PRODUCT DECISION, enforced here rather than in the database, and the same number the
 * promotional carousel uses: a carousel nobody sits through is a carousel nobody reads.
 */
export const MAX_ANIME_HERO_SLIDES = 12;

/**
 * The output box for a hero image. Smaller than a promotional slide's 2400, because this
 * card renders at 328 CSS px on desktop and full-width on mobile — 1600 covers a 2× phone
 * with room to spare, and the extra megapixels would be bytes nobody sees.
 */
const HERO_OUTPUT_MAX_DIMENSION_PX = 1600;

export type AnimeHeroSlideError =
  | PlatformAccessError
  | { type: "ANIME_HERO_SLIDE_NOT_FOUND"; slideId: string }
  | { type: "ANIME_HERO_DESTINATION_INVALID"; reason: PromotionalDestinationError }
  | { type: "ANIME_HERO_SLIDE_WINDOW_INVALID" }
  | { type: "ANIME_HERO_SLIDE_ORDER_MISMATCH" }
  | { type: "ANIME_HERO_SLIDE_LIMIT_REACHED"; limit: number }
  | ImageValidationError
  | CloudinaryError;

/**
 * What a VISITOR sees.
 *
 * `position` is absent on purpose: the array order IS the contract. Handing a client the
 * integer invites a client that re-sorts, and then the order the admin set is one the
 * frontend can silently disagree with. `isActive`, the schedule window and the audit
 * columns are absent for the same reason they are not the visitor's business.
 *
 * `title` doubles as the image's alt text on the frontend — one field, two uses, which is
 * what the mock this replaces already did.
 */
export interface PublicAnimeHeroSlide {
  readonly id: string;
  readonly imageUrl: string;
  readonly title: string;
  readonly destinationPath: string | null;
}

/** What the admin console sees — everything, including retired and scheduled rows. */
export interface AdminAnimeHeroSlide extends PublicAnimeHeroSlide {
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
  id: animeHeroSlide.id,
  imageUrl: animeHeroSlide.imageUrl,
  title: animeHeroSlide.title,
  destinationPath: animeHeroSlide.destinationPath,
} as const;

const ADMIN_VIEW_COLUMNS = {
  ...PUBLIC_VIEW_COLUMNS,
  position: animeHeroSlide.position,
  isActive: animeHeroSlide.isActive,
  startsAt: animeHeroSlide.startsAt,
  endsAt: animeHeroSlide.endsAt,
  createdByUserId: animeHeroSlide.createdByUserId,
  updatedByUserId: animeHeroSlide.updatedByUserId,
  createdAt: animeHeroSlide.createdAt,
  updatedAt: animeHeroSlide.updatedAt,
} as const;

export interface CreateAnimeHeroSlideInput {
  readonly title: string;
  readonly destinationPath: string | null;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export interface UpdateAnimeHeroSlideInput {
  readonly title?: string;
  /** `null` CLEARS the link and makes the slide decorative; omitting the key leaves it. */
  readonly destinationPath?: string | null;
  readonly isActive?: boolean;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}

/**
 * Parses a slide's link, or accepts its absence.
 *
 * REUSES `parsePromotionalDestination`'s internal arm rather than reimplementing it. That
 * function is pure and dependency-free, and its internal branch is the open-redirect
 * defence this surface needs verbatim — `//evil.tld/x` starts with "/" and navigates
 * off-site, `/\evil.tld` is the same attack spelled with a backslash, and the round-trip
 * re-serialization check catches the spellings nobody enumerated. Copying that logic here
 * would mean two implementations of one security rule, and the second one would rot.
 *
 * The `promotional` name is the only thing that does not fit; the policy is exactly right.
 */
function parseHeroDestination(
  rawDestinationPath: string | null,
): Result<string | null, PromotionalDestinationError> {
  if (rawDestinationPath === null) {
    return { success: true, value: null };
  }

  const parsed = parsePromotionalDestination("internal_path", rawDestinationPath);
  return parsed.success
    ? { success: true, value: parsed.value.normalizedValue }
    : { success: false, error: parsed.error };
}

/** Both bounds present means the window must be non-empty. Mirrors the DB CHECK. */
function isScheduleWindowValid(startsAt: Date | null, endsAt: Date | null): boolean {
  return startsAt === null || endsAt === null || endsAt.getTime() > startsAt.getTime();
}

/**
 * A seeded slide's art lives in the frontend's `public/` directory, not in Cloudinary.
 *
 * Deleting such a row must not try to destroy an asset that was never uploaded — and more
 * importantly must not FAIL when Cloudinary is unconfigured, which is exactly the state a
 * developer running this locally without credentials is in.
 */
function isCloudinaryHostedImage(imageUrl: string): boolean {
  return imageUrl.startsWith("https://");
}

/**
 * `GET /anime/hero-slides` — THE ONLY UNAUTHENTICATED FUNCTION IN THIS FILE.
 *
 * Live means active AND inside its schedule window, with a NULL bound meaning unbounded on
 * that side. The `id` tiebreak on the ORDER BY is mandatory, not cosmetic: two slides
 * sharing a position would otherwise come back in whatever order Postgres felt like, and
 * the carousel would reshuffle itself between requests.
 */
export async function listActiveAnimeHeroSlides(): Promise<readonly PublicAnimeHeroSlide[]> {
  const now = new Date();

  return db
    .select(PUBLIC_VIEW_COLUMNS)
    .from(animeHeroSlide)
    .where(
      and(
        eq(animeHeroSlide.isActive, true),
        or(isNull(animeHeroSlide.startsAt), lte(animeHeroSlide.startsAt, now)),
        or(isNull(animeHeroSlide.endsAt), gt(animeHeroSlide.endsAt, now)),
      ),
    )
    .orderBy(asc(animeHeroSlide.position), asc(animeHeroSlide.id));
}

/** `GET /anime/admin/hero-slides` — every slide, live or not, in display order. */
export async function listAnimeHeroSlidesForStaff(
  actorUserId: string,
): Promise<Result<readonly AdminAnimeHeroSlide[], AnimeHeroSlideError>> {
  // CAPABILITY FIRST. The admin list is gated too — it exposes retired rows, scheduled
  // slides and who authored them.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const rows = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(animeHeroSlide)
    .orderBy(asc(animeHeroSlide.position), asc(animeHeroSlide.id));

  return { success: true, value: rows };
}

/**
 * `POST /anime/admin/hero-slides` — mints a slide from an uploaded image in ONE call.
 *
 * WHY THE ID IS MINTED BEFORE THE ROW EXISTS. The Cloudinary public id is derived from the
 * slide id, but the insert has not happened yet. Generate the uuid here, upload to that id,
 * then insert with it. The alternative — insert, then upload, then update — leaves an
 * image-less row visible to the admin list whenever the upload fails.
 *
 * A failed insert after a successful upload leaves ONE orphaned asset. Accepted, and
 * reclaimable precisely because the id is deterministic; every upload path here makes the
 * same trade.
 */
export async function createAnimeHeroSlide(
  actorUserId: string,
  input: CreateAnimeHeroSlideInput,
  rawImageBytes: Buffer,
): Promise<Result<AdminAnimeHeroSlide, AnimeHeroSlideError>> {
  // 1. CAPABILITY FIRST — before the body is even looked at.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Cheap validation before the expensive image work.
  const destinationResult = parseHeroDestination(input.destinationPath);
  if (!destinationResult.success) {
    return {
      success: false,
      error: { type: "ANIME_HERO_DESTINATION_INVALID", reason: destinationResult.error },
    };
  }

  if (!isScheduleWindowValid(input.startsAt, input.endsAt)) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_WINDOW_INVALID" } };
  }

  const [existingCount] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(animeHeroSlide);
  const slideCount = existingCount?.total ?? 0;
  if (slideCount >= MAX_ANIME_HERO_SLIDES) {
    return {
      success: false,
      error: { type: "ANIME_HERO_SLIDE_LIMIT_REACHED", limit: MAX_ANIME_HERO_SLIDES },
    };
  }

  // 3. Prove the bytes are a real image and re-encode them (strips EXIF, refuses bombs).
  const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: HERO_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedResult.success) {
    return { success: false, error: normalizedResult.error };
  }

  const slideId = randomUUID();
  const uploadResult = await uploadAnimeHeroSlideImage(slideId, normalizedResult.value.buffer);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error };
  }

  const [inserted] = await recordPlatformAction(
    async (tx) =>
      tx
        .insert(animeHeroSlide)
        .values({
          id: slideId,
          imageUrl: uploadResult.value.secureUrl,
          title: input.title,
          destinationPath: destinationResult.value,
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
            eventKind: "anime_hero_slide_created",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Created an anime hero slide",
            targetLabel: `anime hero slide ${slideId}`,
            payload: {
              title: input.title,
              destinationPath: destinationResult.value,
              isActive: input.isActive,
            },
            occurredAt: new Date(),
          },
  );

  if (!inserted) {
    throw new Error("createAnimeHeroSlide: insert returned no row");
  }
  return { success: true, value: inserted };
}

/**
 * `PATCH /anime/admin/hero-slides/:slideId` — title, destination, schedule, active flag.
 *
 * `position` is NOT here. Order is changed only through `reorderAnimeHeroSlides`, which
 * rewrites every row at once; a per-row position write would let two slides claim the same
 * slot with no way to say which the admin meant.
 *
 * `isActive: false` IS the retirement mechanism — the row survives, the public read stops
 * offering it, and DELETE stays the mistake-eraser.
 */
export async function updateAnimeHeroSlide(
  actorUserId: string,
  slideId: string,
  input: UpdateAnimeHeroSlideInput,
): Promise<Result<AdminAnimeHeroSlide, AnimeHeroSlideError>> {
  // 1. CAPABILITY FIRST — before `slideId` is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(animeHeroSlide)
    .where(eq(animeHeroSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }

  // `undefined` means "leave it alone"; an explicit `null` means "clear the link". Those
  // are different edits, which is why the key's presence is tested rather than its value.
  let nextDestinationPath: string | null | undefined;
  if (input.destinationPath !== undefined) {
    const destinationResult = parseHeroDestination(input.destinationPath);
    if (!destinationResult.success) {
      return {
        success: false,
        error: { type: "ANIME_HERO_DESTINATION_INVALID", reason: destinationResult.error },
      };
    }
    nextDestinationPath = destinationResult.value;
  }

  // The window is validated against the ROW AS IT WILL BE, not against the patch alone —
  // sending only `endsAt` must still be checked against the stored `startsAt`.
  const nextStartsAt = input.startsAt === undefined ? existing.startsAt : input.startsAt;
  const nextEndsAt = input.endsAt === undefined ? existing.endsAt : input.endsAt;
  if (!isScheduleWindowValid(nextStartsAt, nextEndsAt)) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_WINDOW_INVALID" } };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(animeHeroSlide)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(nextDestinationPath === undefined ? {} : { destinationPath: nextDestinationPath }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
          ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
          updatedByUserId: actorUserId,
        })
        .where(eq(animeHeroSlide.id, slideId))
        .returning(ADMIN_VIEW_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "anime_hero_slide_updated",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Updated an anime hero slide",
            targetLabel: `anime hero slide ${slideId}`,
            payload: {
              title: input.title ?? null,
              destinationPath: nextDestinationPath ?? null,
              isActive: input.isActive ?? null,
            },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: updated };
}

/**
 * `PATCH /anime/admin/hero-slides/:slideId/image` — replaces the image, in place.
 *
 * A SEPARATE ROUTE FROM THE METADATA PATCH on purpose. Folding the file into that PATCH
 * would make "leave the image alone" an ABSENT multipart part, which is the ambiguity that
 * quietly clears a column the day someone submits the form without re-picking a file.
 *
 * The returned secure_url is written back because its `/v<timestamp>/` segment changed —
 * that is the cache bust. Reusing the stored URL here would serve the old image forever.
 * Replacing a SEEDED slide's image is how a relative path becomes an uploaded asset, which
 * is the intended migration path off the seed rows.
 */
export async function replaceAnimeHeroSlideImage(
  actorUserId: string,
  slideId: string,
  rawImageBytes: Buffer,
): Promise<Result<AdminAnimeHeroSlide, AnimeHeroSlideError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second — and before the expensive decode, so a bad id is cheap.
  const [existing] = await db
    .select({ id: animeHeroSlide.id })
    .from(animeHeroSlide)
    .where(eq(animeHeroSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }

  const normalizedResult = await validateAndNormalizeImage(rawImageBytes, {
    outputMaxDimensionPx: HERO_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalizedResult.success) {
    return { success: false, error: normalizedResult.error };
  }

  const uploadResult = await uploadAnimeHeroSlideImage(slideId, normalizedResult.value.buffer);
  if (!uploadResult.success) {
    return { success: false, error: uploadResult.error };
  }

  const [updated] = await recordPlatformAction(
    async (tx) =>
      tx
        .update(animeHeroSlide)
        .set({ imageUrl: uploadResult.value.secureUrl, updatedByUserId: actorUserId })
        .where(eq(animeHeroSlide.id, slideId))
        .returning(ADMIN_VIEW_COLUMNS),
    (rows) =>
      rows[0] === undefined
        ? null
        : {
            eventKind: "anime_hero_slide_image_replaced",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Replaced an anime hero slide image",
            targetLabel: `anime hero slide ${slideId}`,
            payload: { imageUrl: uploadResult.value.secureUrl },
            occurredAt: new Date(),
          },
  );

  if (!updated) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: updated };
}

/**
 * `PATCH /anime/admin/hero-slides/reorder` — sets the whole display order at once.
 *
 * `slideIds` must be an EXACT PERMUTATION of every existing slide id. Anything else is a
 * mismatch, never a partial apply: a client working from a stale list would otherwise
 * silently drop whichever slide it had not seen yet to the end.
 *
 * The rewrite runs inside one transaction, which is also why `position` carries no UNIQUE
 * index — a non-deferrable one would fire halfway through the loop.
 */
export async function reorderAnimeHeroSlides(
  actorUserId: string,
  slideIds: readonly string[],
): Promise<Result<readonly AdminAnimeHeroSlide[], AnimeHeroSlideError>> {
  // 1. CAPABILITY FIRST — before any id in the body is read.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const existing = await db.select({ id: animeHeroSlide.id }).from(animeHeroSlide);
  const existingIds = existing.map((row) => row.id);

  const requestedIds = new Set(slideIds);
  const isPermutation =
    requestedIds.size === slideIds.length &&
    requestedIds.size === existingIds.length &&
    existingIds.every((id) => requestedIds.has(id));

  if (!isPermutation) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_ORDER_MISMATCH" } };
  }

  await recordPlatformAction(
    async (tx) => {
      for (let position = 0; position < slideIds.length; position += 1) {
        await tx
          .update(animeHeroSlide)
          .set({ position, updatedByUserId: actorUserId })
          .where(eq(animeHeroSlide.id, slideIds[position]));
      }
      return slideIds.length;
    },
    (rewrittenCount) =>
      rewrittenCount === 0
        ? null
        : {
            eventKind: "anime_hero_slide_reordered",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Reordered the anime hero carousel",
            targetLabel: `${String(rewrittenCount)} anime hero slides`,
            payload: { slideIds: [...slideIds] },
            occurredAt: new Date(),
          },
  );

  const rows = await db
    .select(ADMIN_VIEW_COLUMNS)
    .from(animeHeroSlide)
    .orderBy(asc(animeHeroSlide.position), asc(animeHeroSlide.id));

  return { success: true, value: rows };
}

/**
 * `DELETE /anime/admin/hero-slides/:slideId` — removes the slide and its image.
 *
 * THE ASSET IS DESTROYED FIRST, and a failure there returns without touching the row: for
 * a hero slide the image IS the content, so a surviving row pointing at a destroyed asset
 * renders as a broken carousel. Better to keep both and let the admin retry.
 *
 * A SEEDED SLIDE HAS NO CLOUDINARY ASSET — its `image_url` is a site-relative path into the
 * frontend's `public/`. Calling the destroy for one would be a pointless round trip, and
 * would make deleting a seed row impossible on any environment without Cloudinary
 * credentials, since `NOT_CONFIGURED` is an error rather than a no-op.
 *
 * Positions are re-packed afterwards so the order stays contiguous: delete the 2nd of four
 * and the old 3rd and 4th become 2nd and 3rd, with no gap for the admin to puzzle over.
 */
export async function deleteAnimeHeroSlide(
  actorUserId: string,
  slideId: string,
): Promise<Result<{ deletedSlideId: string }, AnimeHeroSlideError>> {
  // 1. CAPABILITY FIRST.
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_promotions");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // 2. Resources second.
  const [existing] = await db
    .select({ id: animeHeroSlide.id, imageUrl: animeHeroSlide.imageUrl })
    .from(animeHeroSlide)
    .where(eq(animeHeroSlide.id, slideId))
    .limit(1);

  if (!existing) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }

  if (isCloudinaryHostedImage(existing.imageUrl)) {
    const assetDeletion = await deleteAnimeHeroSlideImage(slideId);
    if (!assetDeletion.success) {
      return { success: false, error: assetDeletion.error };
    }
  }

  const deletedCount = await recordPlatformAction(
    async (tx) => {
      const deleted = await tx
        .delete(animeHeroSlide)
        .where(eq(animeHeroSlide.id, slideId))
        .returning({ id: animeHeroSlide.id });

      if (deleted.length === 0) {
        return 0;
      }

      // Re-pack so positions stay 0-based and contiguous.
      const remaining = await tx
        .select({ id: animeHeroSlide.id })
        .from(animeHeroSlide)
        .orderBy(asc(animeHeroSlide.position), asc(animeHeroSlide.id));

      for (let position = 0; position < remaining.length; position += 1) {
        await tx
          .update(animeHeroSlide)
          .set({ position })
          .where(eq(animeHeroSlide.id, remaining[position].id));
      }

      return deleted.length;
    },
    (count) =>
      count === 0
        ? null
        : {
            eventKind: "anime_hero_slide_deleted",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Deleted an anime hero slide",
            targetLabel: `anime hero slide ${slideId}`,
            payload: { slideId },
            occurredAt: new Date(),
          },
  );

  if (deletedCount === 0) {
    return { success: false, error: { type: "ANIME_HERO_SLIDE_NOT_FOUND", slideId } };
  }
  return { success: true, value: { deletedSlideId: slideId } };
}
