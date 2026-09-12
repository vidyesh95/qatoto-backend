import type { Request, Response } from "express";

import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import {
  firstParam,
  respondShowcaseLaunchError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/showcase-launch-error-response.js";
import * as showcaseLaunchModerationService from "#src/modules/home/blueprints/showcase-launch-moderation.service.js";
import * as showcaseLaunchPublicReadService from "#src/modules/home/blueprints/showcase-launch-public-read.service.js";
import {
  ModerateShowcaseLaunchSchema,
  PublicShowcaseFeedQuerySchema,
  PublicShowcaseSlugSchema,
  ShowcaseLaunchDraftSchema,
  ShowcaseReviewQueueQuerySchema,
  SubmitShowcaseLaunchMultipartSchema,
} from "#src/modules/home/blueprints/showcase-launch.schemas.js";
import * as showcaseLaunchService from "#src/modules/home/blueprints/showcase-launch.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import {
  buildValidationFailureBody,
  fieldRefusal,
  respondFieldRefusal,
} from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse, Result } from "#src/types/index.js";

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

function respondCreated(res: Response, message: string, data: unknown): void {
  res.status(201).json({ status: "success", statusCode: 201, message, data } satisfies ApiResponse);
}

const MISSING_HEADING_IMAGE_MESSAGE = "Choose a square heading image.";

/**
 * A 422 for `POST /showcases` that reports the missing heading image ALONGSIDE whatever else was
 * wrong, rather than whichever refusal the controller happened to reach first.
 *
 * WHY EVERY REFUSAL ON THIS ROUTE GOES THROUGH HERE. The image travels as a file part and the rest
 * of the launch as one JSON text part, so the two are checked in different places — and a maker who
 * submits an empty form has both problems at once. Reporting only the first means they fix it,
 * resubmit, and are refused again for something the server already knew. Worse, the earliest
 * refusal is keyed to `draft`, which is not a field their form renders at all, so the one thing
 * they could act on was the one thing they were not told.
 */
function respondSubmitRefusal(
  req: Request,
  res: Response,
  message: string,
  errors: Readonly<Record<string, readonly string[]>>,
): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message,
    errors: req.file ? errors : { ...errors, headingImage: [MISSING_HEADING_IMAGE_MESSAGE] },
  });
}

/**
 * Parses the multipart `draft` text part.
 *
 * ⚠️ A JSON PARSE ON AN UPLOAD ROUTE, WHICH `commerce-categories.schemas.ts` ARGUES AGAINST — and
 * the argument is answered rather than ignored. That route could send flat text parts; this one
 * cannot, because a launch's team rows and tags are nested. What keeps the parse safe:
 *   * multer caps the part at `SHOWCASE_DRAFT_PART_MAXIMUM_BYTES` before this runs, and Zod checks
 *     the string's length again;
 *   * this is the ONE guarded parse, and its failure is a value, not a throw;
 *   * the result is `unknown` and goes straight into a `.strict()` schema, which refuses every key
 *     it does not name — `__proto__` included, since `JSON.parse` makes that an ordinary own key.
 */
function parseDraftJson(rawDraft: string): Result<unknown, "DRAFT_NOT_JSON"> {
  try {
    const parsedDraft: unknown = JSON.parse(rawDraft);
    return { success: true, value: parsedDraft };
  } catch {
    return { success: false, error: "DRAFT_NOT_JSON" };
  }
}

/**
 * `POST /blueprints/showcases/write-up-images` (multipart, field `image`) — one image, unclaimed.
 *
 * Never reads a body: the file is the whole request.
 */
export async function uploadWriteUpImage(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  if (!req.file) {
    respondFieldRefusal(res, "image", "Choose an image to upload.");
    return;
  }

  const uploadResult = await showcaseLaunchService.uploadShowcaseWriteUpImage(
    req.user.id,
    req.file.buffer,
  );
  if (!uploadResult.success) {
    respondShowcaseLaunchError(res, uploadResult.error, "image");
    return;
  }

  respondCreated(res, "Write-up image uploaded", uploadResult.value);
}

/**
 * `POST /blueprints/showcases` (multipart: `draft` JSON text part, `headingImage` file).
 *
 * 201, not 202: the launch row exists when this answers, and its state is in the receipt. What a
 * moderator will decide is not a result this call is waiting on.
 *
 * VALIDATED AS THE PARSED DRAFT, not as a `{ draft }` wrapper, so a field refusal arrives keyed by
 * the draft's own field names (`title`, `team`, …) — the keys the form renders beside its inputs.
 * A missing image is folded into the same 422, so the maker learns everything wrong in one round.
 */
export async function submitLaunch(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const partsParse = SubmitShowcaseLaunchMultipartSchema.safeParse(req.body);
  if (!partsParse.success) {
    const partsFailure = buildValidationFailureBody(partsParse.error);
    respondSubmitRefusal(req, res, partsFailure.message, partsFailure.errors);
    return;
  }

  const draftJson = parseDraftJson(partsParse.data.draft);
  if (!draftJson.success) {
    const unreadableDraft = fieldRefusal(
      "draft",
      "The launch could not be read. Reload the page and try again.",
    );
    respondSubmitRefusal(req, res, unreadableDraft.message, unreadableDraft.errors);
    return;
  }

  const draftParse = ShowcaseLaunchDraftSchema.safeParse(draftJson.value);
  if (!draftParse.success) {
    const draftFailure = buildValidationFailureBody(draftParse.error);
    respondSubmitRefusal(req, res, draftFailure.message, draftFailure.errors);
    return;
  }

  if (!req.file) {
    respondFieldRefusal(res, "headingImage", MISSING_HEADING_IMAGE_MESSAGE);
    return;
  }

  const submitResult = await showcaseLaunchService.submitShowcaseLaunch({
    authorUserId: req.user.id,
    draft: draftParse.data,
    rawHeadingImageBytes: req.file.buffer,
    receivedAt: new Date(),
  });
  if (!submitResult.success) {
    respondShowcaseLaunchError(res, submitResult.error, "headingImage");
    return;
  }

  respondCreated(res, "Launch posted for review", submitResult.value);
}

/** `GET /blueprints/showcases/mine` — the maker's own launches, newest first. */
export async function listMyLaunches(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const launches = await showcaseLaunchService.listMyShowcaseLaunches(req.user.id);
  respondOk(res, "Launches retrieved successfully", launches);
}

/**
 * Proves `moderate_content` BEFORE any id or query is read — reversed, a 403 becomes an oracle
 * for which launch ids exist.
 */
async function resolveModerator(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  if (!req.user) {
    respondUnauthenticated(res);
    return null;
  }
  const capabilityResult = await requirePlatformCapability(req.user.id, "moderate_content");
  if (!capabilityResult.success) {
    respondShowcaseLaunchError(res, capabilityResult.error);
    return null;
  }
  return capabilityResult.value;
}

/** `GET /blueprints/admin/showcases/review-queue` — oldest first, keyset-paged. */
export async function listReviewQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const queryParse = ShowcaseReviewQueueQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  // NEVER a silent first page on a bad cursor: a client that silently restarts a queue shows a
  // moderator launches they already decided.
  const cursor =
    queryParse.data.cursor === undefined ? undefined : decodeInstantCursor(queryParse.data.cursor);
  if (cursor === null) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  const queuePage = await showcaseLaunchModerationService.listShowcaseReviewQueue({
    staff,
    limit: queryParse.data.limit,
    cursor,
  });
  respondOk(res, "Launch review queue retrieved successfully", queuePage);
}

/** `POST /blueprints/admin/showcases/:submissionId/moderate` — publish or send back. */
export async function moderateLaunch(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const decisionParse = ModerateShowcaseLaunchSchema.safeParse(req.body);
  if (!decisionParse.success) {
    respondValidationFailed(res, decisionParse.error);
    return;
  }

  const decisionResult = await showcaseLaunchModerationService.decideShowcaseLaunch({
    submissionId: firstParam(req.params.submissionId ?? ""),
    decision: decisionParse.data,
    staff,
  });
  if (!decisionResult.success) {
    respondShowcaseLaunchError(res, decisionResult.error);
    return;
  }

  respondOk(res, "Launch decision recorded", decisionResult.value);
}

/**
 * `GET /blueprints/showcases` — the public feed, plus the tag counts that sit beside it.
 *
 * NO SESSION IS READ, and that is deliberate rather than an omission: the payload is identical for
 * every visitor, so there is nothing to personalise and nothing to leak.
 *
 * THE FACETS RIDE ALONG rather than living on their own route, because they are counted over the
 * same population the list filters and a second route could answer 200 while this one failed —
 * leaving chips that promise launches the list never shows.
 */
export async function listPublicShowcaseFeed(req: Request, res: Response): Promise<void> {
  const queryParse = PublicShowcaseFeedQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const feedResult = await showcaseLaunchPublicReadService.listPublicShowcases({
    sort: queryParse.data.sort,
    limit: queryParse.data.limit,
    tag: queryParse.data.tag,
    cursor: queryParse.data.cursor,
  });

  if (!feedResult.success) {
    // A cursor this server did not mint, or one minted under the other sort. Never a silent first
    // page: a feed that quietly restarts shows the reader duplicates.
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  respondOk(res, "Showcase launches retrieved successfully", feedResult.value);
}

/** `GET /blueprints/showcases/slugs` — every published slug, for the frontend's prerender step. */
export async function listPublicShowcaseSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await showcaseLaunchPublicReadService.listPublicShowcaseSlugs();
  respondOk(res, "Showcase launch slugs retrieved successfully", slugs);
}

/**
 * `GET /blueprints/showcases/:launchSlug` — one published launch.
 *
 * A MALFORMED SLUG ANSWERS 404, NOT 422. The parse runs, so the boundary rule holds; only the status
 * differs, because a 422 here and a 404 for a well-formed miss would together tell a stranger which
 * slug shapes exist. Both answers mean the same thing to an honest caller: there is nothing here.
 */
export async function getPublicShowcaseLaunch(req: Request, res: Response): Promise<void> {
  const slugParse = PublicShowcaseSlugSchema.safeParse(firstParam(req.params.launchSlug ?? ""));
  if (!slugParse.success) {
    respondShowcaseLaunchError(res, { type: "SHOWCASE_LAUNCH_NOT_FOUND" });
    return;
  }

  const launchResult = await showcaseLaunchPublicReadService.getPublicShowcaseBySlug(
    slugParse.data,
  );
  if (!launchResult.success) {
    respondShowcaseLaunchError(res, launchResult.error);
    return;
  }

  respondOk(res, "Showcase launch retrieved successfully", launchResult.value);
}
