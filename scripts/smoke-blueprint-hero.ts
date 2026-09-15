/**
 * Drives the blueprints hero carousel's admin surface against a REAL database and Cloudinary.
 *
 * ⚠️ THE TABLE IS STILL CALLED `blueprint_hero_slide`. The vertical was retired and the router is now
 * `/blueprints`; renaming the table costs a migration and buys a tidier grep. Historical name.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. Every vitest suite mocks `#src/db/index.js` wholesale,
 * so no test can prove that the REORDER TRANSACTION runs — it rewrites every position one row at a
 * time, which is exactly why `db:verify-blueprint-hero-constraints` asserts there is NO unique
 * index on `position`. Nor can a test prove that Cloudinary's `secure_url` is stored as returned,
 * that the public read really drops an out-of-window slide, or that deleting a SEEDED slide works
 * with no credentials in play.
 *
 *   createBlueprintHeroSlide          → an admin row, its image_url Cloudinary's own secure_url
 *   listBlueprintHeroSlidesForStaff   → retired and scheduled rows a reader never sees
 *   listActiveBlueprintHeroSlides     → neither of them, in position order
 *   reorderBlueprintHeroSlides        → a non-permutation refused, then a real reorder applied
 *   replaceBlueprintHeroSlideImage    → a new /v<timestamp>/ segment, same slide
 *   deleteBlueprintHeroSlide          → positions re-packed contiguously
 *
 *   pnpm db:smoke-blueprint-hero
 *
 * ⚠️ AVIF AS WELL AS PNG. `smoke-promotional-slides.ts` records that the shared allowlist was
 * jpeg/png/webp, AVIF decodes as `heif`, and every AVIF upload 422'd — including the repo's own
 * `public/dummy/*.avif` fixtures a seed had already published to this very carousel. A PNG-only
 * harness cannot see that class of bug.
 *
 * ⚠️ AND ONE PATH THAT MUST WORK WITH NO CREDENTIALS AT ALL: deleting a SEEDED slide, whose
 * `image_url` is a site-relative path rather than a Cloudinary asset. Migration 0149 wrote four of
 * them, because a migration cannot upload. If the delete path assumed every slide owns an asset,
 * every seeded row would be undeletable on a box with no Cloudinary configured.
 *
 * CLEANS UP AFTER ITSELF — every slide it creates is deleted before it exits, including on failure,
 * AND the carousel is put back in the order this run found it in. Step 5 has to reorder every
 * slide, seeded rows included, because the service refuses anything that is not a permutation of
 * the whole table; a harness that silently rearranged the data it found would be worse than no
 * harness. Run it against a DEVELOPMENT database.
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";
import sharp from "sharp";

import { db, pool } from "#src/db/index.js";
import { blueprintHeroSlide, user } from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import {
  createBlueprintHeroSlide,
  deleteBlueprintHeroSlide,
  listActiveBlueprintHeroSlides,
  listBlueprintHeroSlidesForStaff,
  reorderBlueprintHeroSlides,
  replaceBlueprintHeroSlideImage,
} from "#src/modules/home/blueprints/blueprint-hero.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/** A real, decodable image — the upload pipeline proves the bytes, so a fake buffer is refused. */
async function makeTestImage(blue: number, format: "png" | "avif"): Promise<Buffer> {
  const pipeline = sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 60, b: blue } },
  });
  return format === "avif" ? pipeline.avif({ quality: 50 }).toBuffer() : pipeline.png().toBuffer();
}

async function findStaffUserId(): Promise<string | null> {
  const rows = await db
    .select({ id: user.id, platformRole: user.platformRole })
    .from(user)
    .where(isNotNull(user.platformRole));
  return rows.find((row) => row.platformRole === "admin")?.id ?? null;
}

async function main(): Promise<void> {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    console.error(
      "Cloudinary credentials are not configured. This smoke uploads real images; set them and re-run.",
    );
    process.exit(1);
  }

  const adminUserId = await findStaffUserId();
  if (!adminUserId) {
    console.error("No account holds platformRole 'admin'. Grant one and re-run.");
    process.exit(1);
  }

  const runSuffix = randomUUID().slice(0, 8);
  const createdSlideIds: string[] = [];
  let seededProbeSlideId: string | undefined;

  /*
   * ⚠️ THE ORDER OF THE SLIDES THAT WERE ALREADY THERE, CAPTURED BEFORE ANYTHING IS CREATED.
   *
   * Step 5 reorders EVERY slide, seeded rows included — it has to, because `reorderBlueprintHeroSlides`
   * refuses anything that is not a permutation of the whole table, which is the property being
   * proven. Without this the smoke would leave a developer's carousel permanently reversed, and a
   * harness that silently rearranges the data it found is worse than no harness.
   */
  const preExistingOrder = await db
    .select({ id: blueprintHeroSlide.id })
    .from(blueprintHeroSlide)
    .orderBy(blueprintHeroSlide.position);

  try {
    // --- 1. Create, with AVIF — the format that used to 422.
    const avifBytes = await makeTestImage(140, "avif");
    const firstResult = await createBlueprintHeroSlide(
      adminUserId,
      {
        title: `Smoke slide one ${runSuffix}`,
        destinationPath: "/blueprints/teardowns",
        isActive: true,
        startsAt: null,
        endsAt: null,
      },
      avifBytes,
    );
    check(
      "an AVIF slide is created — the format the shared allowlist used to refuse",
      firstResult.success,
      firstResult.success ? firstResult.value.id : JSON.stringify(firstResult.error),
    );
    if (!firstResult.success) return;
    createdSlideIds.push(firstResult.value.id);
    const firstSlideId = firstResult.value.id;

    /*
     * ⚠️ STORE WHAT CLOUDINARY RETURNED; NEVER RECONSTRUCT IT FROM THE PUBLIC ID. The
     * `/v<timestamp>/` segment changes on every overwrite, and that segment is exactly what busts
     * the browser cache when an image is replaced in place.
     */
    check(
      "its image_url is Cloudinary's own secure_url, version segment intact",
      /^https:\/\/res\.cloudinary\.com\/.+\/v\d+\//.test(firstResult.value.imageUrl),
      firstResult.value.imageUrl,
    );

    // --- 2. A PNG one, retired, so the staff and public reads can disagree.
    const pngBytes = await makeTestImage(200, "png");
    const retiredResult = await createBlueprintHeroSlide(
      adminUserId,
      {
        title: `Smoke slide two, retired ${runSuffix}`,
        destinationPath: null,
        isActive: false,
        startsAt: null,
        endsAt: null,
      },
      pngBytes,
    );
    check(
      "a PNG slide is created, retired and with no link (a decorative slide)",
      retiredResult.success,
      retiredResult.success ? retiredResult.value.id : JSON.stringify(retiredResult.error),
    );
    if (!retiredResult.success) return;
    createdSlideIds.push(retiredResult.value.id);

    // --- 3. And one whose window has already closed.
    const closedWindowBytes = await makeTestImage(240, "png");
    const expiredResult = await createBlueprintHeroSlide(
      adminUserId,
      {
        title: `Smoke slide three, expired ${runSuffix}`,
        destinationPath: "/blueprints/showcase",
        isActive: true,
        startsAt: new Date("2020-01-01T00:00:00Z"),
        endsAt: new Date("2020-02-01T00:00:00Z"),
      },
      closedWindowBytes,
    );
    check(
      "a slide with a closed window is created",
      expiredResult.success,
      expiredResult.success ? expiredResult.value.id : JSON.stringify(expiredResult.error),
    );
    if (!expiredResult.success) return;
    createdSlideIds.push(expiredResult.value.id);
    const expiredSlideId = expiredResult.value.id;

    // --- 4. The two reads disagree, and that is the whole point of `is_active` plus the window.
    const staffList = await listBlueprintHeroSlidesForStaff(adminUserId);
    check(
      "the staff read carries all three, including the retired and expired ones",
      staffList.success &&
        createdSlideIds.every((slideId) => staffList.value.some((slide) => slide.id === slideId)),
      staffList.success
        ? `${String(staffList.value.length)} slides`
        : JSON.stringify(staffList.error),
    );

    const publicList = await listActiveBlueprintHeroSlides();
    check(
      "the public read drops the retired slide",
      !publicList.some((slide) => slide.id === retiredResult.value.id),
      `${String(publicList.length)} live slides`,
    );
    check(
      "the public read drops the slide whose window has closed",
      !publicList.some((slide) => slide.id === expiredSlideId),
      "an expired slide is not live",
    );
    check(
      "and it carries the live one",
      publicList.some((slide) => slide.id === firstSlideId),
      firstSlideId,
    );

    // --- 5. Reorder. A non-permutation writes NOTHING.
    const positionsBefore = await db
      .select({ id: blueprintHeroSlide.id, position: blueprintHeroSlide.position })
      .from(blueprintHeroSlide)
      .orderBy(blueprintHeroSlide.position);
    const everySlideId = positionsBefore.map((row) => row.id);

    const badReorder = await reorderBlueprintHeroSlides(adminUserId, everySlideId.slice(1));
    check(
      "a reorder that is not a permutation of every slide is refused",
      !badReorder.success && badReorder.error.type === "BLUEPRINT_HERO_SLIDE_ORDER_MISMATCH",
      badReorder.success ? "it was ACCEPTED" : badReorder.error.type,
    );
    const positionsAfterBadReorder = await db
      .select({ id: blueprintHeroSlide.id, position: blueprintHeroSlide.position })
      .from(blueprintHeroSlide)
      .orderBy(blueprintHeroSlide.position);
    check(
      "and it wrote nothing — a refused reorder leaves every position untouched",
      JSON.stringify(positionsBefore) === JSON.stringify(positionsAfterBadReorder),
      `${String(positionsAfterBadReorder.length)} positions unchanged`,
    );

    /*
     * ⚠️ THE ASSERTION THE MISSING UNIQUE INDEX EXISTS FOR. This rewrites every position inside one
     * transaction, one row at a time, so two rows transiently share a position mid-loop. A
     * `uniqueIndex` on `position` would fire there — which is why the constraint script asserts its
     * ABSENCE rather than leaving it implicit.
     */
    const reversedOrder = everySlideId.toReversed();
    const goodReorder = await reorderBlueprintHeroSlides(adminUserId, reversedOrder);
    check(
      "a real reorder rewrites every position inside one transaction",
      goodReorder.success,
      goodReorder.success
        ? `${String(goodReorder.value.length)} slides`
        : JSON.stringify(goodReorder.error),
    );
    const positionsAfterReorder = await db
      .select({ id: blueprintHeroSlide.id, position: blueprintHeroSlide.position })
      .from(blueprintHeroSlide)
      .orderBy(blueprintHeroSlide.position);
    check(
      "and the stored order now matches what was asked for",
      JSON.stringify(positionsAfterReorder.map((row) => row.id)) === JSON.stringify(reversedOrder),
      positionsAfterReorder.map((row) => String(row.position)).join(","),
    );
    check(
      "positions are contiguous from zero",
      positionsAfterReorder.every((row, index) => row.position === index),
      positionsAfterReorder.map((row) => String(row.position)).join(","),
    );

    // --- 6. Replace the image in place. A NEW version segment, the SAME slide id.
    const replacementBytes = await makeTestImage(90, "avif");
    const replaced = await replaceBlueprintHeroSlideImage(
      adminUserId,
      firstSlideId,
      replacementBytes,
    );
    check(
      "an image is replaced in place",
      replaced.success && replaced.value.id === firstSlideId,
      replaced.success ? replaced.value.imageUrl : JSON.stringify(replaced.error),
    );
    check(
      "and the URL changed — the version segment is what busts the browser cache",
      replaced.success && replaced.value.imageUrl !== firstResult.value.imageUrl,
      replaced.success ? "a new /v<timestamp>/ segment" : "n/a",
    );

    /*
     * --- 7. ⚠️ THE SEEDED ARM: a site-relative slide, which owns no Cloudinary asset.
     *
     * Inserted directly rather than through the service, because the service only ever mints
     * Cloudinary rows — which is exactly why this path is otherwise untested. Migration 0149 wrote
     * four rows in this shape. If delete assumed every slide owns an asset, every seeded row would
     * be undeletable on a box with no Cloudinary configured.
     */
    seededProbeSlideId = randomUUID();
    const [maxPositionRow] = await db
      .select({ position: blueprintHeroSlide.position })
      .from(blueprintHeroSlide)
      .orderBy(blueprintHeroSlide.position);
    await db.insert(blueprintHeroSlide).values({
      id: seededProbeSlideId,
      title: `Smoke seeded slide ${runSuffix}`,
      imageUrl: "/dummy/blueprint-hero-smoke.avif",
      destinationPath: null,
      position: (maxPositionRow?.position ?? 0) + 900,
      isActive: true,
    });
    const seededDelete = await deleteBlueprintHeroSlide(adminUserId, seededProbeSlideId);
    check(
      "a SEEDED, site-relative slide deletes without calling Cloudinary",
      seededDelete.success,
      seededDelete.success ? seededDelete.value.deletedSlideId : JSON.stringify(seededDelete.error),
    );
    if (seededDelete.success) seededProbeSlideId = undefined;

    // --- 8. Delete a real one, and the positions re-pack.
    const deleted = await deleteBlueprintHeroSlide(adminUserId, expiredSlideId);
    check(
      "a Cloudinary-backed slide deletes, asset and row",
      deleted.success,
      deleted.success ? deleted.value.deletedSlideId : JSON.stringify(deleted.error),
    );
    if (deleted.success) {
      createdSlideIds.splice(createdSlideIds.indexOf(expiredSlideId), 1);
    }
    const positionsAfterDelete = await db
      .select({ position: blueprintHeroSlide.position })
      .from(blueprintHeroSlide)
      .orderBy(blueprintHeroSlide.position);
    check(
      "and the remaining positions are still contiguous from zero",
      positionsAfterDelete.every((row, index) => row.position === index),
      positionsAfterDelete.map((row) => String(row.position)).join(","),
    );

    // --- 9. Deleting something that is already gone.
    const deleteAgain = await deleteBlueprintHeroSlide(adminUserId, expiredSlideId);
    check(
      "deleting an absent slide is a clean not-found, never a crash",
      !deleteAgain.success && deleteAgain.error.type === "BLUEPRINT_HERO_SLIDE_NOT_FOUND",
      deleteAgain.success ? "it was ACCEPTED" : deleteAgain.error.type,
    );
  } finally {
    for (const slideId of createdSlideIds) {
      await deleteBlueprintHeroSlide(adminUserId, slideId);
    }
    if (seededProbeSlideId !== undefined) {
      await db.delete(blueprintHeroSlide).where(eq(blueprintHeroSlide.id, seededProbeSlideId));
    }

    // Put the carousel back in the order this run found it in. Only the rows that still exist
    // are named, so a partially-failed run restores what it can rather than refusing outright.
    const survivingIds = new Set(
      (await db.select({ id: blueprintHeroSlide.id }).from(blueprintHeroSlide)).map(
        (row) => row.id,
      ),
    );
    const restoredOrder = preExistingOrder
      .map((row) => row.id)
      .filter((slideId) => survivingIds.has(slideId));
    if (restoredOrder.length === survivingIds.size && restoredOrder.length > 0) {
      const restoreResult = await reorderBlueprintHeroSlides(adminUserId, restoredOrder);
      console.log(
        restoreResult.success
          ? "\n  (the carousel was restored to the order this run found it in)"
          : `\n  ⚠️ THE CAROUSEL WAS LEFT REORDERED — ${restoreResult.error.type}`,
      );
    }

    await stopSendOnlyBoss();
    await pool.end();
  }

  console.log(
    failureCount === 0
      ? "\nThe hero carousel's admin surface works end to end, seeded slides included."
      : `\n${String(failureCount)} assertion(s) FAILED.`,
  );
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
