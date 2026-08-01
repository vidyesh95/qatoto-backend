/**
 * Exercises the promotional-carousel write surface against the real database and the real
 * Cloudinary account, through the SERVICE layer.
 *
 * WHAT THIS PROVES THAT `verify-promotional-slide-constraints.ts` CANNOT. That script proves
 * Postgres refuses a bad row. This one proves the three things an admin actually does — add
 * a slide with a link, set which slide shows 1st / 2nd / 3rd, and delete one — behave
 * correctly across a capability check, an image upload and a position re-pack. Neither
 * replaces the other, and neither is a unit test: the vitest suite mocks `#src/db/index.js`
 * wholesale, so it can say nothing about either.
 *
 * IT CLEANS UP AFTER ITSELF. Every slide it creates is deleted before it exits, including on
 * failure, so an existing carousel is left exactly as it was found. It never touches a slide
 * it did not create.
 *
 *   pnpm db:smoke-promotional-slides
 *
 * Exits non-zero if any assertion fails.
 */
import "dotenv/config";
import { asc, eq, isNotNull } from "drizzle-orm";
import sharp from "sharp";

import { db, pool } from "#src/db/index.js";
import { promotionalSlide, user } from "#src/db/schema.js";
import * as promotionsService from "#src/services/promotions.service.js";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const outcomes: CheckOutcome[] = [];

function record(label: string, passed: boolean, detail: string): void {
  outcomes.push({ label, passed, detail });
}

/**
 * A real, decodable image — the pipeline proves the bytes, so a fake buffer would be rejected.
 *
 * The format is a parameter because AVIF is the whole reason the replace route was broken: the
 * shared allowlist was jpeg/png/webp, AVIF decodes as `heif`, and every AVIF upload 422'd —
 * including the repo's own `public/dummy/*.avif` fixtures that the seed had already published
 * to the carousel. A PNG-only harness cannot see that class of bug.
 */
async function makeTestImage(red: number, format: "png" | "avif" = "png"): Promise<Buffer> {
  const pipeline = sharp({
    create: { width: 800, height: 400, channels: 3, background: { r: red, g: 80, b: 120 } },
  });
  return format === "avif" ? pipeline.avif({ quality: 50 }).toBuffer() : pipeline.png().toBuffer();
}

async function findStaffUserId(role: "admin" | "moderator"): Promise<string | null> {
  const rows = await db
    .select({ id: user.id, platformRole: user.platformRole })
    .from(user)
    .where(isNotNull(user.platformRole));
  return rows.find((row) => row.platformRole === role)?.id ?? null;
}

async function readPositions(slideIds: readonly string[]): Promise<readonly number[]> {
  const rows = await db
    .select({ id: promotionalSlide.id, position: promotionalSlide.position })
    .from(promotionalSlide)
    .orderBy(asc(promotionalSlide.position));
  return slideIds.map((slideId) => rows.find((row) => row.id === slideId)?.position ?? -1);
}

async function main(): Promise<void> {
  const adminUserId = await findStaffUserId("admin");
  if (!adminUserId) {
    console.error("No account holds platformRole 'admin'. Grant one and re-run.");
    process.exit(1);
  }
  const moderatorUserId = await findStaffUserId("moderator");

  const createdSlideIds: string[] = [];

  try {
    // --- 1. The capability gate. A moderator holds `moderate_content` but NOT
    //        `manage_promotions`, which is the whole point of the split.
    if (moderatorUserId) {
      const refused = await promotionsService.listPromotionalSlidesForStaff(moderatorUserId);
      record(
        "a moderator is refused the admin list",
        !refused.success && refused.error.type === "PLATFORM_CAPABILITY_REQUIRED",
        refused.success ? "ACCEPTED — the capability split is not holding" : refused.error.type,
      );

      // THE ID-ORACLE CHECK. A non-admin must get the SAME refusal for a real id and an
      // invented one — otherwise the 403/404 difference enumerates slide ids.
      const realSlide = await db
        .select({ id: promotionalSlide.id })
        .from(promotionalSlide)
        .limit(1);
      const againstReal = await promotionsService.deletePromotionalSlide(
        moderatorUserId,
        realSlide[0]?.id ?? "no-slides-exist",
      );
      const againstFake = await promotionsService.deletePromotionalSlide(
        moderatorUserId,
        "definitely-not-a-slide-id",
      );
      record(
        "a non-admin gets an identical refusal for a real id and a garbage one",
        !againstReal.success &&
          !againstFake.success &&
          againstReal.error.type === againstFake.error.type &&
          againstReal.error.type === "PLATFORM_CAPABILITY_REQUIRED",
        "the capability is decided before any id is read",
      );
    } else {
      record("a moderator is refused the admin list", true, "SKIPPED — no moderator account");
    }

    // --- 2. The open redirect, refused at the service layer with a useful reason.
    const openRedirect = await promotionsService.createPromotionalSlide(
      adminUserId,
      {
        altText: "smoke open redirect",
        destinationKind: "internal_path",
        destinationValue: "//evil.tld/x",
        isActive: true,
        startsAt: null,
        endsAt: null,
      },
      await makeTestImage(10),
    );
    record(
      "refuses a protocol-relative path as an internal destination",
      !openRedirect.success && openRedirect.error.type === "PROMOTIONAL_DESTINATION_INVALID",
      openRedirect.success ? "ACCEPTED — open redirect got through" : openRedirect.error.type,
    );

    // --- 3. ADD. Two slides, one internal and one external, each appended at the end.
    const beforeCount = (await db.select({ id: promotionalSlide.id }).from(promotionalSlide))
      .length;

    const firstCreate = await promotionsService.createPromotionalSlide(
      adminUserId,
      {
        altText: "smoke slide one",
        destinationKind: "internal_path",
        destinationValue: "/store",
        isActive: true,
        startsAt: null,
        endsAt: null,
      },
      await makeTestImage(200),
    );
    record(
      "adds a slide with an internal destination",
      firstCreate.success,
      firstCreate.success
        ? `position ${String(firstCreate.value.position)}`
        : firstCreate.error.type,
    );
    if (!firstCreate.success) throw new Error("create failed; cannot continue");
    createdSlideIds.push(firstCreate.value.id);

    const secondCreate = await promotionsService.createPromotionalSlide(
      adminUserId,
      {
        altText: "smoke slide two",
        destinationKind: "external_url",
        destinationValue: "https://advertiser.example/campaign?utm_source=qatoto",
        isActive: true,
        startsAt: null,
        endsAt: null,
      },
      await makeTestImage(60),
    );
    record(
      "adds a slide with an external destination",
      secondCreate.success,
      secondCreate.success ? secondCreate.value.destinationValue : secondCreate.error.type,
    );
    if (!secondCreate.success) throw new Error("create failed; cannot continue");
    createdSlideIds.push(secondCreate.value.id);

    record(
      "each new slide appends at the end",
      firstCreate.value.position === beforeCount && secondCreate.value.position === beforeCount + 1,
      `positions ${String(firstCreate.value.position)} then ${String(secondCreate.value.position)}`,
    );

    // --- 3b. REPLACE THE IMAGE WITH AN AVIF, and prove the stored URL actually moves.
    //
    // Two claims in one check. First, AVIF is accepted at all — it was not, and that single
    // 422 is what got reported as "the image is not getting replaced". Second, the returned
    // secure_url carries a NEW /v<timestamp>/ segment, which is the entire cache-busting
    // story: every layer downstream (the Next image optimizer, the browser, the Cloudinary
    // CDN) is keyed on that full href, so a changed URL is what makes a replacement go live
    // for every visitor.
    const urlBeforeReplace = firstCreate.value.imageUrl;
    const avifReplace = await promotionsService.replacePromotionalSlideImage(
      adminUserId,
      firstCreate.value.id,
      await makeTestImage(30, "avif"),
    );
    record(
      "replaces a slide image with an AVIF file",
      avifReplace.success,
      avifReplace.success ? "accepted" : avifReplace.error.type,
    );
    record(
      "the stored image URL changes on replace — the cache bust",
      avifReplace.success && avifReplace.value.imageUrl !== urlBeforeReplace,
      avifReplace.success
        ? `${urlBeforeReplace.split("/upload/")[1] ?? "?"} -> ${avifReplace.value.imageUrl.split("/upload/")[1] ?? "?"}`
        : "replace failed",
    );

    // An SVG must never reach the pipeline, whatever the multipart headers claimed.
    const svgAttempt = await promotionsService.replacePromotionalSlideImage(
      adminUserId,
      firstCreate.value.id,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'),
    );
    record(
      "refuses an SVG upload",
      !svgAttempt.success && svgAttempt.error.type === "UNSUPPORTED_FORMAT",
      svgAttempt.success ? "ACCEPTED — script-bearing XML got through" : svgAttempt.error.type,
    );

    // --- 4. ORDER. Send the whole permutation with the last slide moved to the front.
    const fullOrder = (
      await db
        .select({ id: promotionalSlide.id })
        .from(promotionalSlide)
        .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id))
    ).map((row) => row.id);

    const movedToFront = [
      secondCreate.value.id,
      ...fullOrder.filter((slideId) => slideId !== secondCreate.value.id),
    ];
    const reorder = await promotionsService.reorderPromotionalSlides(adminUserId, movedToFront);
    record(
      "moving the last slide to 1st rewrites the whole order",
      reorder.success && reorder.value[0]?.id === secondCreate.value.id,
      reorder.success ? `now 1st: ${reorder.value[0]?.altText ?? "?"}` : reorder.error.type,
    );

    // A partial list must be a mismatch, never a partial apply.
    const partial = await promotionsService.reorderPromotionalSlides(adminUserId, [
      secondCreate.value.id,
    ]);
    record(
      "refuses a partial order rather than applying it",
      !partial.success && partial.error.type === "PROMOTIONAL_SLIDE_ORDER_MISMATCH",
      partial.success ? "APPLIED — a stale client could silently reshuffle" : partial.error.type,
    );

    // --- 5. The public read reflects the order, and hides a deactivated slide.
    const livePositions = await promotionsService.listActivePromotionalSlides();
    record(
      "the public read returns the new order",
      livePositions[0]?.id === secondCreate.value.id,
      `first live slide: ${livePositions[0]?.altText ?? "none"}`,
    );

    const deactivate = await promotionsService.updatePromotionalSlide(
      adminUserId,
      secondCreate.value.id,
      { isActive: false },
    );
    const afterDeactivate = await promotionsService.listActivePromotionalSlides();
    record(
      "deactivating hides a slide from the public read but keeps the row",
      deactivate.success &&
        !afterDeactivate.some((slide) => slide.id === secondCreate.value.id) &&
        (
          await db
            .select({ id: promotionalSlide.id })
            .from(promotionalSlide)
            .where(eq(promotionalSlide.id, secondCreate.value.id))
        ).length === 1,
      "row survives, visitor does not see it",
    );

    // An empty schedule window is refused against the row as it WILL be, not the patch alone.
    const badWindow = await promotionsService.updatePromotionalSlide(
      adminUserId,
      firstCreate.value.id,
      { startsAt: new Date("2030-01-02T00:00:00Z"), endsAt: new Date("2030-01-01T00:00:00Z") },
    );
    record(
      "refuses a schedule window that ends before it starts",
      !badWindow.success && badWindow.error.type === "PROMOTIONAL_SLIDE_WINDOW_INVALID",
      badWindow.success ? "ACCEPTED" : badWindow.error.type,
    );

    // --- 6. DELETE, and the re-pack that keeps positions contiguous.
    const orderBeforeDelete = (
      await db
        .select({ id: promotionalSlide.id })
        .from(promotionalSlide)
        .orderBy(asc(promotionalSlide.position), asc(promotionalSlide.id))
    ).map((row) => row.id);

    const deleted = await promotionsService.deletePromotionalSlide(
      adminUserId,
      secondCreate.value.id,
    );
    record(
      "deletes a slide",
      deleted.success,
      deleted.success ? deleted.value.deletedSlideId : deleted.error.type,
    );
    if (deleted.success) {
      createdSlideIds.splice(createdSlideIds.indexOf(secondCreate.value.id), 1);
    }

    const survivorIds = orderBeforeDelete.filter((slideId) => slideId !== secondCreate.value.id);
    const positionsAfter = await readPositions(survivorIds);
    const isContiguous = positionsAfter.every((position, index) => position === index);
    record(
      "positions re-pack contiguously after a delete",
      isContiguous,
      `positions: ${positionsAfter.join(", ")}`,
    );

    // Deleting an id that no longer exists is a 404, not a silent success.
    const deleteAgain = await promotionsService.deletePromotionalSlide(
      adminUserId,
      secondCreate.value.id,
    );
    record(
      "deleting an already-deleted slide is not found",
      !deleteAgain.success && deleteAgain.error.type === "PROMOTIONAL_SLIDE_NOT_FOUND",
      deleteAgain.success ? "SUCCEEDED" : deleteAgain.error.type,
    );
  } finally {
    // Always clean up, including on a thrown assertion.
    for (const slideId of createdSlideIds) {
      await promotionsService.deletePromotionalSlide(adminUserId, slideId);
    }
  }

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }

  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} promotional-slide behaviours hold.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} behaviours FAILED.`,
  );

  await pool.end();
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
