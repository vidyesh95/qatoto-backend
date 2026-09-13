/**
 * Drives the showcase-launch write path against a REAL database and a REAL Cloudinary.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. Every vitest suite in this repository mocks
 * `#src/db/index.js` wholesale, so no test can prove that the SUBMIT TRANSACTION actually runs:
 * that an image uploaded BEFORE any launch existed is claimed by the submit that references it,
 * that `title_normalized` comes back normalised from the database rather than from a JavaScript
 * copy of the expression, and that the publish mints an address without minting a stats row.
 * `db:verify-showcase-launch-constraints` proves the constraints; this proves the code that has to
 * satisfy them.
 *
 *   uploadShowcaseWriteUpImage → an UNCLAIMED row, launch_id NULL, sized by sharp not by the client
 *   submitShowcaseLaunch       → a `pending_review` row with no slug, and the image now claimed
 *   listMyShowcaseLaunches     → the maker's own row, publicSlug null
 *   a second launch, same name → SHOWCASE_LAUNCH_TITLE_TAKEN, naming nothing
 *   decideShowcaseLaunch       → a slug, and the five decision columns landing together
 *   getPublicShowcaseBySlug    → the write-up and its images, every counter reading 0
 *   listPublicShowcases        → `sort=top` and `sort=newest` agree while nothing writes an upvote
 *   applyShowcaseLaunchModerationVerb → a flag keeps the slug, the page and the feed row; a
 *                                quarantine is refused and writes nothing; a restore undoes it
 *
 *   pnpm db:smoke-showcase-authoring
 *
 * ⚠️ THE STATS ASSERTION IS A TRIPWIRE, NOT A DESCRIPTION. `showcase_launch_stats` has NO ROW after
 * a publish, deliberately — the reads left-join and coalesce, so a launch with no row and a launch
 * with a row of zeroes are the same answer, and `publishUnderFreeSlug`'s savepoint-retry
 * transaction stays out of it. When the engagement write path lands it must mint that row on FIRST
 * ENGAGEMENT and still not on publish. This assertion is what fails if somebody takes the shortcut.
 *
 * REQUIRES CLOUDINARY CREDENTIALS, and refuses up front without them rather than half-running.
 * Cleans up after itself in both stores: the Cloudinary assets are destroyed FIRST (once the rows
 * are gone there is nothing left to derive the public ids from), then deleting the launch cascades
 * its team members, its claimed images and its stats. Audit entries are NOT deleted — that chain
 * rejects DELETE, which is the guarantee rather than a limitation. Run it against a DEVELOPMENT
 * database.
 *
 * Exits non-zero on the first failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import sharp from "sharp";

import { db, pool } from "#src/db/index.js";
import {
  blueprintContentReport,
  blueprintModerationAction,
  platformAuditEntry,
  showcaseLaunch,
  showcaseLaunchStats,
  showcaseLaunchWriteUpImage,
  user,
} from "#src/db/schema.js";
import {
  deleteShowcaseImages,
  showcaseLaunchHeadingImagePublicId,
  showcaseWriteUpImagePublicId,
} from "#src/lib/cloudinary.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { dismissBlueprintContentReport } from "#src/modules/home/blueprints/blueprint-content-report.service.js";
import { applyShowcaseLaunchModerationVerb } from "#src/modules/home/blueprints/blueprint-moderation.service.js";
import { decideShowcaseLaunch } from "#src/modules/home/blueprints/showcase-launch-moderation.service.js";
import {
  getPublicShowcaseBySlug,
  listPublicShowcases,
} from "#src/modules/home/blueprints/showcase-launch-public-read.service.js";
import type { ShowcaseLaunchDraft } from "#src/modules/home/blueprints/showcase-launch.schemas.js";
import {
  listMyShowcaseLaunches,
  submitShowcaseLaunch,
  uploadShowcaseWriteUpImage,
} from "#src/modules/home/blueprints/showcase-launch.service.js";

let failureCount = 0;

function check(label: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!passed) failureCount += 1;
}

/**
 * A real, decodable image — the upload pipeline proves the bytes, so a fake buffer is refused.
 *
 * ⚠️ AVIF IS NOT AN ARBITRARY CHOICE. `smoke-promotional-slides.ts` records that the shared
 * allowlist was jpeg/png/webp, AVIF decodes as `heif`, and every AVIF upload 422'd — including the
 * repo's own `public/dummy/*.avif` fixtures that a seed had already published. A PNG-only harness
 * cannot see that class of bug, so this one sends AVIF for the heading and PNG for the inline
 * image and proves both paths.
 */
async function makeTestImage(
  widthPx: number,
  heightPx: number,
  format: "png" | "avif",
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width: widthPx, height: heightPx, channels: 3, background: { r: 30, g: 90, b: 140 } },
  });
  return format === "avif" ? pipeline.avif({ quality: 50 }).toBuffer() : pipeline.png().toBuffer();
}

function buildDraft(title: string, writeUp: string | null): ShowcaseLaunchDraft {
  return {
    title,
    tagline: "A bench supply that survives a short",
    summary:
      "A four-channel bench supply with per-channel current limiting, built to prove the constraints and the submit transaction together.",
    writeUp,
    launchedAt: new Date().toISOString(),
    difficulty: "intermediate",
    billOfMaterialsCostRange: { minimumInCents: 4500, maximumInCents: 9900, currency: "USD" },
    tags: ["power", "bench-tools"],
    team: [
      { displayName: "Ada Lovelace", handle: "ada_smoke", role: "Firmware" },
      { displayName: "Grace Hopper", handle: "grace_smoke", role: "Analogue" },
    ],
    builtFromBlueprintSlug: null,
    callToAction: { label: "Order a unit", url: "https://example.test/bench-supply" },
    acceptedLaunchStatementIds: ["built_it_ourselves", "results_are_our_own"],
  };
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

  const runSuffix = randomUUID().slice(0, 8);
  const title = `The four-channel bench supply ${runSuffix}`;
  let launchId: string | undefined;
  let unclaimedImageId: string | undefined;

  try {
    const accounts = await db.select({ id: user.id, name: user.name }).from(user).limit(2);
    const authorRow = accounts[0];
    if (!authorRow) {
      console.error("No user rows exist. Seed an account before running this smoke.");
      process.exit(1);
    }
    const moderatorUserId = accounts[1]?.id ?? authorRow.id;
    const isSelfModerating = moderatorUserId === authorRow.id;

    // --- 1. The write-up image, uploaded BEFORE any launch exists.
    const inlineImageBytes = await makeTestImage(900, 600, "png");
    const imageResult = await uploadShowcaseWriteUpImage(authorRow.id, inlineImageBytes);
    check(
      "a write-up image uploads before any launch exists",
      imageResult.success,
      imageResult.success ? imageResult.value.url : JSON.stringify(imageResult.error),
    );
    if (!imageResult.success) return;
    const inlineImageUrl = imageResult.value.url;

    const [unclaimedRow] = await db
      .select({ id: showcaseLaunchWriteUpImage.id, launchId: showcaseLaunchWriteUpImage.launchId })
      .from(showcaseLaunchWriteUpImage)
      .where(eq(showcaseLaunchWriteUpImage.url, inlineImageUrl));
    unclaimedImageId = unclaimedRow?.id;
    check(
      "and it is UNCLAIMED — launch_id is NULL until a submit references it",
      unclaimedRow?.launchId === null,
      String(unclaimedRow?.launchId),
    );
    /*
     * ⚠️ THE SIZE IS THE SERVER'S, READ FROM SHARP'S RE-ENCODED OUTPUT. The frontend reserves each
     * image's box from these numbers so nothing below it moves as it loads; a client-supplied size
     * would be a layout the page cannot trust.
     */
    check(
      "its dimensions were measured by the server, not supplied by the client",
      imageResult.value.widthPx > 0 && imageResult.value.heightPx > 0,
      `${String(imageResult.value.widthPx)}×${String(imageResult.value.heightPx)}`,
    );
    check(
      "and it carries a real webp blur placeholder",
      imageResult.value.blurDataUrl.startsWith("data:image/webp;base64,"),
      `${imageResult.value.blurDataUrl.slice(0, 32)}…`,
    );

    // --- 2. The submit, which claims that image.
    const writeUp = `A short write-up that references the uploaded image.\n\n![bench](${inlineImageUrl})\n`;
    const headingImageBytes = await makeTestImage(1200, 1200, "avif");
    const submitResult = await submitShowcaseLaunch({
      authorUserId: authorRow.id,
      draft: buildDraft(title, writeUp),
      rawHeadingImageBytes: headingImageBytes,
      receivedAt: new Date(),
    });
    check(
      "a submission lands pending_review",
      submitResult.success && submitResult.value.moderationState === "pending_review",
      submitResult.success ? submitResult.value.submissionId : JSON.stringify(submitResult.error),
    );
    if (!submitResult.success) return;
    const submittedLaunchId = submitResult.value.submissionId;
    launchId = submittedLaunchId;

    const [claimedRow] = await db
      .select({ launchId: showcaseLaunchWriteUpImage.launchId })
      .from(showcaseLaunchWriteUpImage)
      .where(eq(showcaseLaunchWriteUpImage.url, inlineImageUrl));
    check(
      "the submit transaction CLAIMED the image the write-up references",
      claimedRow?.launchId === submittedLaunchId,
      String(claimedRow?.launchId),
    );

    const [submittedRow] = await db
      .select({
        publicSlug: showcaseLaunch.publicSlug,
        titleNormalized: showcaseLaunch.titleNormalized,
      })
      .from(showcaseLaunch)
      .where(eq(showcaseLaunch.id, submittedLaunchId));
    check(
      "a submission carries no public address — a moderator mints one by publishing it",
      submittedRow?.publicSlug === null,
      String(submittedRow?.publicSlug),
    );
    /*
     * ⚠️ READ BACK FROM THE DATABASE, NOT COMPUTED HERE. `title_normalized` is GENERATED ALWAYS from
     * `lower(regexp_replace(btrim(title), '[[:space:]]+', ' ', 'g'))`, and the service's duplicate
     * pre-check runs that SAME expression in SQL because POSIX `[[:space:]]` and `\s` disagree.
     */
    check(
      "title_normalized came back normalised FROM THE DATABASE",
      submittedRow?.titleNormalized === title.toLowerCase(),
      String(submittedRow?.titleNormalized),
    );

    // --- 3. The maker's own list.
    const myLaunches = await listMyShowcaseLaunches(authorRow.id);
    const myRow = myLaunches.find((row) => row.submissionId === submittedLaunchId);
    check(
      "the maker's own list carries the row with no address",
      myRow !== undefined && myRow.publicSlug === null,
      `${String(myRow?.moderationState)}, slug ${String(myRow?.publicSlug)}`,
    );

    // --- 4. The duplicate title, which must name nothing.
    const duplicateHeadingBytes = await makeTestImage(1200, 1200, "avif");
    const duplicate = await submitShowcaseLaunch({
      authorUserId: authorRow.id,
      // Same name, differing only by case and inner spacing — the normalisation is what catches it.
      draft: buildDraft(`  ${title.toUpperCase()}  `, null),
      rawHeadingImageBytes: duplicateHeadingBytes,
      receivedAt: new Date(),
    });
    check(
      "a second launch under the same normalised title is refused",
      !duplicate.success && duplicate.error.type === "SHOWCASE_LAUNCH_TITLE_TAKEN",
      duplicate.success ? "it was ACCEPTED" : duplicate.error.type,
    );
    check(
      "and the refusal names no other row",
      !duplicate.success && Object.keys(duplicate.error).length === 1,
      duplicate.success ? "n/a" : JSON.stringify(duplicate.error),
    );

    if (isSelfModerating) {
      console.log(
        "\n  (only one account exists, so the publish half is skipped — it would be self-moderation)",
      );
      return;
    }

    // --- 5. The publish.
    const decision = await decideShowcaseLaunch({
      submissionId: submittedLaunchId,
      decision: { decision: "published", moderatorNote: null },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a publish mints an address",
      decision.success && decision.value.publicSlug !== null,
      decision.success ? String(decision.value.publicSlug) : JSON.stringify(decision.error),
    );
    if (!decision.success || decision.value.publicSlug === null) return;
    const publicSlug = decision.value.publicSlug;

    const [publishedRow] = await db
      .select({
        moderationState: showcaseLaunch.moderationState,
        reviewedByUserId: showcaseLaunch.reviewedByUserId,
        reviewedAt: showcaseLaunch.reviewedAt,
        moderatorNote: showcaseLaunch.moderatorNote,
      })
      .from(showcaseLaunch)
      .where(eq(showcaseLaunch.id, submittedLaunchId));
    check(
      "the five decision columns landed together",
      publishedRow?.moderationState === "published" &&
        publishedRow.reviewedByUserId === moderatorUserId &&
        publishedRow.reviewedAt !== null &&
        publishedRow.moderatorNote === null,
      `${publishedRow?.moderationState ?? "(absent)"}, reviewed ${publishedRow?.reviewedAt?.toISOString() ?? "(never)"}`,
    );

    // ⚠️ THE TRIPWIRE. See the file docblock.
    const statsRows = await db
      .select({ launchId: showcaseLaunchStats.launchId })
      .from(showcaseLaunchStats)
      .where(eq(showcaseLaunchStats.launchId, submittedLaunchId));
    check(
      "publishing minted NO stats row — the reads coalesce, and first engagement mints it",
      statsRows.length === 0,
      statsRows.length === 0 ? "no row, as designed" : "a row was minted on publish",
    );

    // --- 6. What the reader gets.
    const publicResult = await getPublicShowcaseBySlug(publicSlug);
    check(
      "the published launch is readable at its address",
      publicResult.success,
      publicResult.success ? publicSlug : JSON.stringify(publicResult.error),
    );
    if (!publicResult.success) return;

    const publicLaunch = publicResult.value;
    check(
      "every counter reads 0 through coalesce, with no stats row behind it",
      publicLaunch.viewCount === 0 &&
        publicLaunch.likeCount === 0 &&
        publicLaunch.upvoteCount === 0 &&
        publicLaunch.commentCount === 0,
      `views ${String(publicLaunch.viewCount)}, upvotes ${String(publicLaunch.upvoteCount)}`,
    );
    check(
      "the team survived publication, in position order",
      publicLaunch.team.length === 2 && publicLaunch.team[0]?.displayName === "Ada Lovelace",
      `${String(publicLaunch.team.length)} team members`,
    );
    check(
      "the write-up's inline image came back sized",
      publicLaunch.writeUpImages.some((image) => image.url === inlineImageUrl),
      `${String(publicLaunch.writeUpImages.length)} write-up images`,
    );

    // --- 7. `sort=top` is `sort=newest` until something writes an upvote.
    const topFeed = await listPublicShowcases({
      sort: "top",
      limit: 10,
      tag: undefined,
      cursor: undefined,
    });
    const newestFeed = await listPublicShowcases({
      sort: "newest",
      limit: 10,
      tag: undefined,
      cursor: undefined,
    });
    /*
     * ⚠️ THIS ASSERTION IS EXPECTED TO STOP HOLDING. `showcase_launch_stats_top_idx` already leads
     * on `upvote_count DESC`; nothing writes that column yet, so every row ties at 0 and the
     * tie-break produces the newest order. The day an upvote lands this becomes false, and that is
     * the signal to delete it rather than a regression.
     */
    check(
      "sort=top and sort=newest agree while nothing writes an upvote",
      topFeed.success &&
        newestFeed.success &&
        JSON.stringify(topFeed.value.items.map((item) => item.slug)) ===
          JSON.stringify(newestFeed.value.items.map((item) => item.slug)),
      topFeed.success && newestFeed.success
        ? `${String(topFeed.value.items.length)} rows in the same order`
        : "a feed read failed",
    );

    // --- 8. A decision is taken once.
    const secondDecision = await decideShowcaseLaunch({
      submissionId: submittedLaunchId,
      decision: { decision: "rejected", moderatorNote: "Changed my mind." },
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a decided launch cannot be decided again",
      !secondDecision.success && secondDecision.error.type === "SHOWCASE_LAUNCH_ALREADY_DECIDED",
      secondDecision.success ? "it was ACCEPTED" : secondDecision.error.type,
    );

    /*
     * --- 9. The post-publish verbs.
     *
     * ⚠️ THE TWO TRIPWIRES ABOVE ARE DELIBERATELY UNTOUCHED BY THIS SECTION. Both are about the
     * ENGAGEMENT write path — a stats row minted on first engagement, and an upvote breaking the
     * `top`/`newest` tie — and flagging writes neither. A reader of this diff will reach for them;
     * they are still waiting on the write path that will actually falsify them.
     *
     * ⚠️ THE POINT OF THIS WALK IS THE PAIR NO VITEST CAN PROVE: that a flag moves the state and
     * LEAVES THE PUBLIC SLUG AND THE PAGE ALONE. Under the old `showcase_launch_decision_ck` the
     * flag would have raised 23514 — the constraint bound the slug to `published` alone — so this
     * is the transaction, against a real database, that shows the widened clause is what makes the
     * verb possible at all.
     */
    /*
     * ⚠️ THE FLAG ANSWERS A REAL REPORT, WHICH IS WHAT MAKES `actioned` REACHABLE AT ALL. The
     * column `blueprint_moderation_action.report_id` shipped with the intake and nothing wrote it
     * for two releases; `blueprint_content_report_status` could therefore filter on a label no
     * code could produce. This is the transaction that closes both, and the assertions below are
     * the only proof it runs — vitest mocks the database wholesale.
     */
    const [answeredReport] = await db
      .insert(blueprintContentReport)
      .values({
        targetKind: "showcase",
        showcaseLaunchId: submittedLaunchId,
        reason: "fabricated_measurements",
        reporterUserId: moderatorUserId,
      })
      .returning({ id: blueprintContentReport.id });

    const flagResult = await applyShowcaseLaunchModerationVerb({
      targetId: submittedLaunchId,
      verb: "flag",
      reasonNote: "A reader reported this as not the stated product.",
      reportId: answeredReport?.id ?? null,
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "a published launch can be flagged",
      flagResult.success,
      flagResult.success ? flagResult.value.moderationState : JSON.stringify(flagResult.error),
    );

    if (answeredReport !== undefined) {
      const [resolvedReport] = await db
        .select({
          status: blueprintContentReport.status,
          resolvedByUserId: blueprintContentReport.resolvedByUserId,
          resolvedAt: blueprintContentReport.resolvedAt,
          resolutionNote: blueprintContentReport.resolutionNote,
        })
        .from(blueprintContentReport)
        .where(eq(blueprintContentReport.id, answeredReport.id));
      check(
        "the answered report moved to actioned — a label nothing could produce until now",
        resolvedReport?.status === "actioned" &&
          resolvedReport.resolvedByUserId === moderatorUserId &&
          resolvedReport.resolvedAt !== null,
        `${resolvedReport?.status ?? "(absent)"}, resolved by ${resolvedReport?.resolvedByUserId ?? "(nobody)"}`,
      );
      check(
        "the moderation reason became the resolution note — one decision, one note",
        resolvedReport?.resolutionNote === "A reader reported this as not the stated product.",
        resolvedReport?.resolutionNote ?? "(null)",
      );

      const [actionRow] = await db
        .select({ reportId: blueprintModerationAction.reportId })
        .from(blueprintModerationAction)
        .where(eq(blueprintModerationAction.showcaseLaunchId, submittedLaunchId));
      check(
        "the decision row names the report it answered — report_id is written at last",
        actionRow?.reportId === answeredReport.id,
        actionRow?.reportId ?? "(null)",
      );

      /*
       * ⚠️ A SECOND VERB NAMING THE SAME REPORT IS REFUSED, and it must be refused BEFORE anything
       * moves. Two moderators racing one report cannot both be told they answered it.
       */
      const replayResult = await applyShowcaseLaunchModerationVerb({
        targetId: submittedLaunchId,
        verb: "restore",
        reasonNote: "Trying to answer a report that is already closed.",
        reportId: answeredReport.id,
        staff: { staffUserId: moderatorUserId, platformRole: "admin" },
      });
      check(
        "a report already resolved cannot be answered twice",
        !replayResult.success && replayResult.error.type === "BLUEPRINT_REPORT_ALREADY_RESOLVED",
        replayResult.success ? "it was ACCEPTED" : replayResult.error.type,
      );

      const [stateAfterReplay] = await db
        .select({ moderationState: showcaseLaunch.moderationState })
        .from(showcaseLaunch)
        .where(eq(showcaseLaunch.id, submittedLaunchId));
      check(
        "and that refusal moved NOTHING — the launch is still flagged",
        stateAfterReplay?.moderationState === "flagged",
        stateAfterReplay?.moderationState ?? "(absent)",
      );
    }

    const [flaggedRow] = await db
      .select({
        moderationState: showcaseLaunch.moderationState,
        publicSlug: showcaseLaunch.publicSlug,
      })
      .from(showcaseLaunch)
      .where(eq(showcaseLaunch.id, submittedLaunchId));
    check(
      "the flag KEPT the public slug — a flag must not un-address a live page",
      flaggedRow?.moderationState === "flagged" && flaggedRow.publicSlug === publicSlug,
      `${flaggedRow?.moderationState ?? "(absent)"}, slug ${flaggedRow?.publicSlug ?? "(null)"}`,
    );

    const flaggedRead = await getPublicShowcaseBySlug(publicSlug);
    check(
      "a flagged launch is STILL readable at its address — a flag is not a takedown",
      flaggedRead.success,
      flaggedRead.success ? "the page still answers" : JSON.stringify(flaggedRead.error),
    );

    const flaggedFeed = await listPublicShowcases({
      sort: "newest",
      limit: 50,
      tag: undefined,
      cursor: undefined,
    });
    check(
      "a flagged launch is STILL in the public feed",
      flaggedFeed.success && flaggedFeed.value.items.some((item) => item.slug === publicSlug),
      flaggedFeed.success ? "present in the feed" : "the feed read failed",
    );

    /*
     * ⚠️ A REFUSAL WRITES NOTHING — no action row, no audit entry, no state change. A log that
     * recorded attempts would make "three moderators looked at this" indistinguishable from "three
     * moderators acted".
     */
    const actionsBeforeRefusal = await db
      .select({ id: blueprintModerationAction.id })
      .from(blueprintModerationAction)
      .where(eq(blueprintModerationAction.showcaseLaunchId, submittedLaunchId));

    const quarantineResult = await applyShowcaseLaunchModerationVerb({
      targetId: submittedLaunchId,
      verb: "quarantine",
      reasonNote: "A rights holder emailed about the hero image.",
      // ⚠️ NULL — the emailed rights claim is exactly the case this field must not require.
      reportId: null,
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "quarantine is REFUSED on this arm — a showcase's files are its own maker's",
      !quarantineResult.success &&
        quarantineResult.error.type === "BLUEPRINT_TRANSITION_NOT_AVAILABLE",
      quarantineResult.success ? "it was ACCEPTED" : quarantineResult.error.type,
    );

    const actionsAfterRefusal = await db
      .select({ id: blueprintModerationAction.id })
      .from(blueprintModerationAction)
      .where(eq(blueprintModerationAction.showcaseLaunchId, submittedLaunchId));
    check(
      "the refused quarantine wrote NO action row",
      actionsAfterRefusal.length === actionsBeforeRefusal.length,
      `${String(actionsBeforeRefusal.length)} before, ${String(actionsAfterRefusal.length)} after`,
    );

    /*
     * ⚠️ THE NOTE STAYS OFF THE HASH-LINKED CHAIN. `buildHashDocument` hashes `detailNote` into a
     * chain kept forever, and a moderation note names one party's account of somebody's work. The
     * payload carries `hasReasonNote: true` and nothing else — this is the byte sweep that proves
     * it, mirroring the teardown smoke's.
     */
    const auditRows = await db
      .select({ payloadJson: platformAuditEntry.payloadJson })
      .from(platformAuditEntry)
      .where(eq(platformAuditEntry.eventKind, "blueprint_content_flagged"));
    const noteLeaked = auditRows.some((row) => row.payloadJson.includes("not the stated product"));
    check(
      "the reason note is NOT in the audit chain — only hasReasonNote travels",
      !noteLeaked,
      noteLeaked ? "THE NOTE TEXT LEAKED INTO platform_audit_entry" : "no note text in any payload",
    );

    /*
     * ⚠️ THE ID TRAVELS AND THE NOTE DOES NOT, IN THE SAME PAYLOAD. That is the whole distinction
     * §9.4 draws: the chain is hash-linked and kept forever, so it carries identifiers and flags
     * and never one party's account of somebody's work. Asserting both halves against ONE entry is
     * what makes the rule legible — either alone reads like an accident.
     */
    const answeredIdTravelled =
      answeredReport !== undefined &&
      auditRows.some((row) => row.payloadJson.includes(answeredReport.id));
    check(
      "but the answered report's ID does travel — ids and flags only, and an id is an id",
      answeredIdTravelled,
      answeredIdTravelled ? "answeredReportId is in the payload" : "the report id is absent",
    );

    /*
     * ⚠️ A DISMISSAL'S AUDIT ENTRY MUST NAME ITS TARGET, and this assertion exists because the
     * three-arm version of that payload was written with a two-arm coalesce chain. A chain one
     * column short does not fail — it writes `null` for the missing arm, into a hash-linked chain
     * that is kept forever and cannot be corrected in place. Only a real dismissal of a real
     * showcase report shows it, which is why the proof lives here rather than in a route test.
     */
    const [filedReport] = await db
      .insert(blueprintContentReport)
      .values({
        targetKind: "showcase",
        showcaseLaunchId: submittedLaunchId,
        reason: "not_the_stated_product",
        reporterUserId: authorRow.id,
      })
      .returning({ id: blueprintContentReport.id });

    if (filedReport !== undefined) {
      const dismissal = await dismissBlueprintContentReport({
        reportId: filedReport.id,
        resolutionNote: "Reviewed; the launch is what it says it is.",
        staff: { staffUserId: moderatorUserId, platformRole: "admin" },
      });
      check(
        "a report against a showcase launch can be dismissed",
        dismissal.success,
        dismissal.success ? "dismissed" : JSON.stringify(dismissal.error),
      );

      const [dismissalEntry] = await db
        .select({ payloadJson: platformAuditEntry.payloadJson })
        .from(platformAuditEntry)
        .where(eq(platformAuditEntry.eventKind, "blueprint_content_report_dismissed"))
        .orderBy(desc(platformAuditEntry.occurredAt))
        .limit(1);
      check(
        "the dismissal's audit entry NAMES the showcase launch — not a null target",
        dismissalEntry?.payloadJson.includes(submittedLaunchId) === true,
        dismissalEntry?.payloadJson ?? "(no audit entry)",
      );
    }

    const restoreResult = await applyShowcaseLaunchModerationVerb({
      targetId: submittedLaunchId,
      verb: "restore",
      reasonNote: "Reviewed the report; the build is the makers' own.",
      reportId: null,
      staff: { staffUserId: moderatorUserId, platformRole: "admin" },
    });
    check(
      "restore returns the launch to published",
      restoreResult.success && restoreResult.value.moderationState === "published",
      restoreResult.success
        ? restoreResult.value.moderationState
        : JSON.stringify(restoreResult.error),
    );
  } finally {
    /*
     * ⚠️ THE ROW CASCADE DOES NOT REACH CLOUDINARY, so the assets are destroyed explicitly and
     * FIRST — once the rows are gone there is nothing left to derive the public ids from. In
     * production that job is `purge_showcase_launch_images`; a smoke that leaned on it would leave
     * a developer's account accumulating a heading and a write-up image on every run.
     */
    const publicIdsToDestroy: string[] = [];
    if (launchId !== undefined) {
      publicIdsToDestroy.push(showcaseLaunchHeadingImagePublicId(launchId));
    }
    if (unclaimedImageId !== undefined) {
      publicIdsToDestroy.push(showcaseWriteUpImagePublicId(unclaimedImageId));
    }
    if (publicIdsToDestroy.length > 0) {
      await deleteShowcaseImages(publicIdsToDestroy);
    }

    if (launchId !== undefined) {
      // Cascades the team members, the claimed write-up images and the stats row.
      await db.delete(showcaseLaunch).where(eq(showcaseLaunch.id, launchId));
    } else if (unclaimedImageId !== undefined) {
      // The submit never ran, so the image is still unclaimed and nothing cascades to it.
      await db
        .delete(showcaseLaunchWriteUpImage)
        .where(eq(showcaseLaunchWriteUpImage.id, unclaimedImageId));
    }
    await stopSendOnlyBoss();
    await pool.end();
  }

  console.log(
    failureCount === 0
      ? "\nThe showcase write path works end to end: the publish still mints no stats row, and a flag keeps the page at its address."
      : `\n${String(failureCount)} assertion(s) FAILED.`,
  );
  process.exit(failureCount === 0 ? 0 : 1);
}

void main();
