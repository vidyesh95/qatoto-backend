import type { Request, Response } from "express";

import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";
import * as caseStudyModerationService from "#src/modules/home/blueprints/case-study-moderation.service.js";
import * as caseStudyPublicReadService from "#src/modules/home/blueprints/case-study-public-read.service.js";
import {
  CaseStudyCursorPageQuerySchema,
  CaseStudyModerationDecisionSchema,
  PublicCaseStudyIndexQuerySchema,
  PublicCaseStudySlugSchema,
} from "#src/modules/home/blueprints/case-study-public.schemas.js";
import { CaseStudySubmissionSchema } from "#src/modules/home/blueprints/case-study-submission.schemas.js";
import * as caseStudySubmissionService from "#src/modules/home/blueprints/case-study-submission.service.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The eight case-study routes: four public reads, two writer routes, two moderator routes.
 *
 * ⚠️ EXACTLY ONE HANDLER HERE SERVES A WITHHELD COMPANY'S REAL NAME — `listReviewQueue`, behind
 * `moderate_content`. The four public reads go through the read service's one serializer, the
 * submit route answers a three-field receipt, and the writer's own list carries no companies at
 * all. If a fifth handler ever needs a company, it needs a reason in writing first.
 *
 * ⚠️ THE SUBMIT ROUTE MUST NOT ECHO THE SUBMISSION BACK. `idempotency.ts` stores whole 2xx bodies
 * for replay, so a handler that returned what it was sent would put a withheld name in a cache
 * keyed by a header the client chose.
 */

function respondOk(res: Response, message: string, data: unknown): void {
  res.status(200).json({ status: "success", statusCode: 200, message, data } satisfies ApiResponse);
}

function respondAccepted(res: Response, message: string, data: unknown): void {
  res.status(202).json({ status: "success", statusCode: 202, message, data } satisfies ApiResponse);
}

/** A case study that does not exist, or that a reader may not reach. One answer for both. */
function respondCaseStudyNotFound(res: Response): void {
  res.status(404).json({
    status: "error",
    statusCode: 404,
    message: "Case study not found.",
  } satisfies ApiResponse);
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
 * ⚠️ ORDER IS THE SECURITY PROPERTY. Reversed, a 403 that only arrives for case studies that exist
 * turns these routes into an existence oracle over pending submissions — which are other people's
 * unpublished work. The route test proves it by sending a non-moderator a request that is ALSO
 * malformed and requiring 403 rather than 422.
 */
async function resolveModerator(req: Request, res: Response): Promise<PlatformStaffContext | null> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return null;
  }

  const capabilityResult = await requirePlatformCapability(viewerId, "moderate_content");
  if (!capabilityResult.success) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "You do not have permission to moderate case studies.",
    } satisfies ApiResponse);
    return null;
  }
  return capabilityResult.value;
}

/** `GET /blueprints/case-studies` — the index and its one discipline filter. */
export async function listPublicCaseStudies(req: Request, res: Response): Promise<void> {
  const queryParse = PublicCaseStudyIndexQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const indexResult = await caseStudyPublicReadService.listPublicCaseStudies({
    discipline: queryParse.data.discipline,
    limit: queryParse.data.limit,
    cursor: queryParse.data.cursor,
  });

  if (!indexResult.success) {
    // A cursor this server did not mint. Never a silent first page: a list that quietly restarts
    // shows the reader duplicates and reads as a backend bug.
    respondMalformedCursor(res);
    return;
  }

  respondOk(res, "Case studies retrieved successfully", indexResult.value);
}

/** `GET /blueprints/case-studies/options` — slug and title for the composer's related-lesson select. */
export async function listCaseStudyOptions(_req: Request, res: Response): Promise<void> {
  const options = await caseStudyPublicReadService.listCaseStudyOptions();
  respondOk(res, "Case study options retrieved successfully", options);
}

/** `GET /blueprints/case-studies/slugs` — every visible slug, for the prerender step. */
export async function listPublicCaseStudySlugs(_req: Request, res: Response): Promise<void> {
  const slugs = await caseStudyPublicReadService.listPublicCaseStudySlugs();
  respondOk(res, "Case study slugs retrieved successfully", slugs);
}

/**
 * `GET /blueprints/case-studies/:caseStudySlug` — one case study and its related lessons.
 *
 * A MALFORMED SLUG ANSWERS 404, NOT 422, and without touching the database. The parse runs, so the
 * boundary rule holds; only the status differs, because a 422 here beside a 404 for a well-formed
 * miss would together tell a stranger which slug shapes exist, one request at a time.
 */
export async function getPublicCaseStudy(req: Request, res: Response): Promise<void> {
  const slugParse = PublicCaseStudySlugSchema.safeParse(firstParam(req.params.caseStudySlug ?? ""));
  if (!slugParse.success) {
    respondCaseStudyNotFound(res);
    return;
  }

  const detailResult = await caseStudyPublicReadService.getPublicCaseStudyBySlug(slugParse.data);
  if (!detailResult.success) {
    respondCaseStudyNotFound(res);
    return;
  }

  respondOk(res, "Case study retrieved successfully", detailResult.value);
}

/**
 * `POST /blueprints/case-studies` — send a case study for review.
 *
 * ⚠️ A 202 IS NOT A RESULT. The case study lands `pending_review`, appears in no index, and has no
 * public address until a moderator publishes it — so the body is a receipt rather than a row, and
 * deliberately carries no slug and no URL.
 */
export async function submitCaseStudy(req: Request, res: Response): Promise<void> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return;
  }

  const submissionParse = CaseStudySubmissionSchema.safeParse(req.body);
  if (!submissionParse.success) {
    respondValidationFailed(res, submissionParse.error);
    return;
  }

  const submitResult = await caseStudySubmissionService.submitCaseStudy({
    authorUserId: viewerId,
    submission: submissionParse.data,
  });

  if (!submitResult.success) {
    switch (submitResult.error.type) {
      case "CASE_STUDY_TITLE_TAKEN":
        /*
         * ⚠️ THE FIELD KEY AND NOTHING ELSE. Echoing the clashing row's title, author or slug would
         * make a duplicate-title probe an existence oracle over pending submissions.
         */
        res.status(409).json({
          status: "error",
          statusCode: 409,
          message: "A case study with this lesson already exists.",
          errors: { title: ["Another case study already teaches this lesson. Reword it."] },
        });
        return;
      case "CASE_STUDY_RELATED_LESSON_UNRESOLVABLE":
        /*
         * The slugs ARE echoed here, and that is not the same disclosure: the caller sent them, and
         * every one names something either published or nonexistent — never a pending submission,
         * because a pending case study has no slug to name.
         */
        res.status(422).json({
          status: "error",
          statusCode: 422,
          message: "A related lesson could not be found.",
          errors: {
            relatedLessonSlugs: submitResult.error.slugs.map(
              (slug) => `No published case study answers to "${slug}".`,
            ),
          },
        });
        return;
      default: {
        const exhaustiveCheck: never = submitResult.error;
        throw new Error(`Unhandled case study submit error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  respondAccepted(res, "Case study received for review", {
    submissionId: submitResult.value.submissionId,
    moderationState: submitResult.value.moderationState,
    receivedAt: submitResult.value.receivedAt.toISOString(),
  });
}

/** `GET /blueprints/case-studies/mine` — the writer's own case studies, every state. */
export async function listMyCaseStudies(req: Request, res: Response): Promise<void> {
  const viewerId = req.user?.id;
  if (!viewerId) {
    respondUnauthenticated(res);
    return;
  }

  const queryParse = CaseStudyCursorPageQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  const listResult = await caseStudySubmissionService.listMyCaseStudies({
    authorUserId: viewerId,
    limit: queryParse.data.limit,
    cursor: queryParse.data.cursor,
  });
  if (!listResult.success) {
    respondMalformedCursor(res);
    return;
  }

  respondOk(res, "Your case studies retrieved successfully", listResult.value);
}

/**
 * `GET /blueprints/admin/case-studies/review-queue` — oldest first, keyset-paged.
 *
 * ⚠️ THE ONE ROUTE THAT SERVES A WITHHELD COMPANY'S REAL NAME. It depends entirely on who is asking,
 * so it must never acquire a shared cache header — every other read on this surface is deliberately
 * caller-independent and cacheable, and this is the exception.
 */
export async function listReviewQueue(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const queryParse = CaseStudyCursorPageQuerySchema.safeParse(req.query);
  if (!queryParse.success) {
    respondValidationFailed(res, queryParse.error);
    return;
  }

  // NEVER a silent first page on a bad cursor: a queue that quietly restarts shows a moderator
  // case studies they already decided.
  const cursor =
    queryParse.data.cursor === undefined ? undefined : decodeInstantCursor(queryParse.data.cursor);
  if (cursor === null) {
    respondMalformedCursor(res);
    return;
  }

  const queuePage = await caseStudyModerationService.listCaseStudyReviewQueue({
    staff,
    limit: queryParse.data.limit,
    cursor,
  });
  respondOk(res, "Case study review queue retrieved successfully", queuePage);
}

/** `POST /blueprints/admin/case-studies/:submissionId/moderate` — publish or send back. */
export async function moderateCaseStudy(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const decisionParse = CaseStudyModerationDecisionSchema.safeParse(req.body);
  if (!decisionParse.success) {
    respondValidationFailed(res, decisionParse.error);
    return;
  }

  const decisionResult = await caseStudyModerationService.decideCaseStudy({
    submissionId: firstParam(req.params.submissionId ?? ""),
    decision: decisionParse.data,
    staff,
  });

  if (!decisionResult.success) {
    switch (decisionResult.error.type) {
      case "CASE_STUDY_NOT_FOUND":
        respondCaseStudyNotFound(res);
        return;
      case "CASE_STUDY_SELF_MODERATION_FORBIDDEN":
        res.status(403).json({
          status: "error",
          statusCode: 403,
          message: "You cannot decide your own case study.",
        } satisfies ApiResponse);
        return;
      case "CASE_STUDY_ALREADY_DECIDED":
        res.status(409).json({
          status: "error",
          statusCode: 409,
          message: "This case study has already been decided. Refresh the queue.",
        } satisfies ApiResponse);
        return;
      case "PLATFORM_CAPABILITY_REQUIRED":
        // Unreachable: `resolveModerator` already proved the capability. Handled so the union is
        // exhaustive and a new arm on it is a compile error here.
        res.status(403).json({
          status: "error",
          statusCode: 403,
          message: "You do not have permission to moderate case studies.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustiveCheck: never = decisionResult.error;
        throw new Error(
          `Unhandled case study moderation error: ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  respondOk(res, "Case study decision recorded", {
    submissionId: decisionResult.value.submissionId,
    moderationState: decisionResult.value.moderationState,
    publicSlug: decisionResult.value.publicSlug,
    decidedAt: decisionResult.value.decidedAt.toISOString(),
  });
}
