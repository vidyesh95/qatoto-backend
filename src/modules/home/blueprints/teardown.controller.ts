import type { Request, Response } from "express";

import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import {
  firstParam,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";
import { respondUnauthenticated } from "#src/modules/home/blueprints/blueprint-error-response.js";
import * as teardownModerationService from "#src/modules/home/blueprints/teardown-moderation.service.js";
import * as teardownPublicReadService from "#src/modules/home/blueprints/teardown-public-read.service.js";
import {
  PublicTeardownIndexQuerySchema,
  PublicTeardownSlugSchema,
} from "#src/modules/home/blueprints/teardown-public.schemas.js";
import {
  MyTeardownsQuerySchema,
  TeardownModerationDecisionSchema,
  TeardownReviewQueueQuerySchema,
  TeardownSubmissionSchema,
} from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import * as teardownSubmissionService from "#src/modules/home/blueprints/teardown-submission.service.js";
import { respondTeardownWriteError } from "#src/modules/home/blueprints/teardown-write-error-response.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The nine teardown routes: five public reads, two author routes, two moderator routes.
 *
 * NO SESSION IS READ ON ANY OF THE FIVE READS, and that is deliberate rather than an omission: the
 * payload is identical for every visitor, so there is nothing to personalise and nothing to leak.
 * What a quarantine withholds is decided by the teardown's own state, never by who is asking —
 * `teardown-public-read.service.ts` holds that decision, and no handler here may reach around it.
 *
 * ⚠️ THE SUBMIT ROUTE MUST NOT ECHO THE SUBMISSION BACK. `idempotency.ts` stores whole 2xx bodies
 * for replay, so a handler that returned what it was sent would put one party's account of a private
 * permission into a cache keyed by a header the client chose. Three scalars, which is also exactly
 * what the frontend's receipt schema asks for.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

/** A teardown that does not exist, or that a reader may not reach. Both get the same answer. */
function respondTeardownNotFound(res: Response): void {
  res.status(404).json({
    status: "error",
    statusCode: 404,
    message: "Teardown not found.",
  } satisfies ApiResponse);
}

/**
 * `GET /blueprints/teardowns` — the index, its filters and the tag counts beside it.
 *
 * THE FACETS RIDE ALONG rather than living on their own route, for the reason the showcase feed
 * gives: they are counted over the same population the list filters, and a second route could
 * answer 200 while this one failed — leaving chips that promise teardowns the list never shows.
 * It also collapses the frontend's two-call `Promise.all` into one request.
 */
export async function listPublicTeardowns(req: Request, res: Response): Promise<void> {
  const queryParse = PublicTeardownIndexQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const indexResult = await teardownPublicReadService.listPublicTeardowns({
    difficulty: queryParse.data.difficulty,
    media: queryParse.data.media,
    tag: queryParse.data.tag,
    limit: queryParse.data.limit,
    cursor: queryParse.data.cursor,
  });

  if (!indexResult.success) {
    // A cursor this server did not mint. Never a silent first page: a list that quietly restarts
    // shows the reader duplicates and reads as a backend bug.
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Malformed cursor.",
    } satisfies ApiResponse);
    return;
  }

  respondOk(res, "Teardowns retrieved successfully", indexResult.value);
}

/**
 * `GET /blueprints/teardowns/options` — slug and title for the launch composer's select.
 *
 * The LIST gate, so the select cannot steer a maker toward a teardown under an open rights claim.
 */
export async function listTeardownOptions(_req: Request, res: Response): Promise<void> {
  const options = await teardownPublicReadService.listTeardownOptions();
  respondOk(res, "Teardown options retrieved successfully", options);
}

/**
 * `GET /blueprints/teardowns/slugs` — every readable slug, for the frontend's prerender step.
 *
 * ⚠️ THE READABLE GATE, so a quarantined teardown's slug IS here. Leaving it out would un-prerender
 * a page whose whole design is that the address keeps working while the files are withheld.
 */
export async function listPublicTeardownSlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await teardownPublicReadService.listPublicTeardownSlugs();
  respondOk(res, "Teardown slugs retrieved successfully", slugs);
}

/**
 * `GET /blueprints/teardowns/:teardownSlug` — one readable teardown.
 *
 * A MALFORMED SLUG ANSWERS 404, NOT 422, and without touching the database. The parse runs, so the
 * boundary rule holds; only the status differs, because a 422 here beside a 404 for a well-formed
 * miss would together tell a stranger which slug shapes exist, one request at a time.
 *
 * A quarantined teardown answers 200 with its payload withheld — that is the design, not a
 * degradation, and the service decides it.
 */
export async function getPublicTeardown(req: Request, res: Response): Promise<void> {
  const slugParse = PublicTeardownSlugSchema.safeParse(firstParam(req.params.teardownSlug ?? ""));
  if (!slugParse.success) {
    respondTeardownNotFound(res);
    return;
  }

  const teardownResult = await teardownPublicReadService.getPublicTeardownBySlug(slugParse.data);
  if (!teardownResult.success) {
    respondTeardownNotFound(res);
    return;
  }

  respondOk(res, "Teardown retrieved successfully", teardownResult.value);
}

/**
 * `GET /blueprints/teardowns/:teardownSlug/claim-targets` — what a rights claim can name.
 *
 * ⚠️ IDS AND TITLES ONLY. This route exists because the detail read withholds a quarantined
 * teardown's files, and the report page builds its radio list out of them — a second rights holder
 * would otherwise be able to claim nothing narrower than "the whole teardown", which would use one
 * quarantine to blunt the control that produced it. The service's select lists carry no column that
 * could hold a URL, so this cannot become a way around the withholding.
 */
export async function getTeardownClaimTargets(req: Request, res: Response): Promise<void> {
  const slugParse = PublicTeardownSlugSchema.safeParse(firstParam(req.params.teardownSlug ?? ""));
  if (!slugParse.success) {
    respondTeardownNotFound(res);
    return;
  }

  const claimTargetsResult = await teardownPublicReadService.getTeardownClaimTargets(
    slugParse.data,
  );
  if (!claimTargetsResult.success) {
    respondTeardownNotFound(res);
    return;
  }

  respondOk(res, "Teardown claim targets retrieved successfully", claimTargetsResult.value);
}

function respondAccepted(res: Response, message: string, data: unknown): void {
  res.status(202).json({ status: "success", statusCode: 202, message, data } satisfies ApiResponse);
}

function respondMalformedCursor(res: Response): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Malformed cursor.",
  } satisfies ApiResponse);
}

/**
 * Proves `moderate_content` BEFORE any submission id or query is read.
 *
 * ⚠️ ORDER IS THE SECURITY PROPERTY. Reversed, a 403 that only arrives for submissions that exist
 * turns these routes into an existence oracle over other people's unpublished work. The route test
 * proves it by sending a non-moderator a request that is ALSO malformed and requiring 403, not 422.
 */
async function resolveModerator(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return null;
  }

  const capabilityResult = await requirePlatformCapability(viewerId, "moderate_content");
  if (!capabilityResult.success) {
    respondTeardownWriteError(res, capabilityResult.error);
    return null;
  }
  return capabilityResult.value;
}

/** `POST /blueprints/teardowns` — the wizard's one submit. Answers 202 and a three-field receipt. */
export async function submitTeardown(req: Request, res: Response): Promise<void> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return;
  }

  const submissionParse = TeardownSubmissionSchema.safeParse(req.body);
  if (!submissionParse.success) {
    respondValidationFailed(res, submissionParse.error);
    return;
  }

  const submitResult = await teardownSubmissionService.submitTeardown({
    authorUserId: viewerId,
    submission: submissionParse.data,
  });

  if (!submitResult.success) {
    respondTeardownWriteError(res, submitResult.error);
    return;
  }

  respondAccepted(res, "Teardown received for review", {
    submissionId: submitResult.value.submissionId,
    moderationState: submitResult.value.moderationState,
    receivedAt: submitResult.value.receivedAt.toISOString(),
  });
}

/**
 * `GET /blueprints/teardowns/mine` — the author's own submissions, every state.
 *
 * A FLAT ARRAY, NOT A PAGE. See `MY_TEARDOWN_LIST_LIMIT` for why, and for what would have to change
 * on both sides of the wire the day that stops being true.
 */
export async function listMyTeardowns(req: Request, res: Response): Promise<void> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return;
  }

  const queryParse = MyTeardownsQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const submissions = await teardownSubmissionService.listMyTeardowns({ authorUserId: viewerId });

  respondOk(
    res,
    "Your teardowns retrieved successfully",
    submissions.map((submission) => ({
      submissionId: submission.submissionId,
      title: submission.title,
      subjectProductName: submission.subjectProductName,
      submittedAt: submission.submittedAt.toISOString(),
      moderationState: submission.moderationState,
      publicSlug: submission.publicSlug,
      moderatorNote: submission.moderatorNote,
    })),
  );
}

/** `GET /blueprints/admin/teardowns/review-queue` — `moderate_content`, oldest first, keyset-paged. */
export async function listTeardownReviewQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const queryParse = TeardownReviewQueueQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  // NEVER a silent first page on a bad cursor: a queue that quietly restarts shows a moderator
  // submissions they already decided.
  const cursor =
    queryParse.data.cursor === undefined ? undefined : decodeInstantCursor(queryParse.data.cursor);
  if (cursor === null) {
    respondMalformedCursor(res);
    return;
  }

  const queuePage = await teardownModerationService.listTeardownReviewQueue({
    staff,
    limit: queryParse.data.limit,
    cursor,
  });
  respondOk(res, "Teardown review queue retrieved successfully", queuePage);
}

/** `POST /blueprints/admin/teardowns/:submissionId/moderate` — publish or send back. */
export async function moderateTeardown(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const decisionParse = TeardownModerationDecisionSchema.safeParse(req.body);
  if (!decisionParse.success) {
    respondValidationFailed(res, decisionParse.error);
    return;
  }

  const decisionResult = await teardownModerationService.decideTeardown({
    submissionId: firstParam(req.params.submissionId ?? ""),
    decision: decisionParse.data,
    staff,
  });

  if (!decisionResult.success) {
    respondTeardownWriteError(res, decisionResult.error);
    return;
  }

  respondOk(res, "Teardown decision recorded", {
    submissionId: decisionResult.value.submissionId,
    moderationState: decisionResult.value.moderationState,
    publicSlug: decisionResult.value.publicSlug,
    decidedAt: decisionResult.value.decidedAt.toISOString(),
  });
}
