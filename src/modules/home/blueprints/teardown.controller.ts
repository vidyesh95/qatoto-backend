import type { Request, Response } from "express";

import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import { presignTeardownFileDownload } from "#src/lib/object-storage.js";
import {
  firstParam,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";
import { respondUnauthenticated } from "#src/modules/home/blueprints/blueprint-error-response.js";
import { respondBlueprintModerationError } from "#src/modules/home/blueprints/blueprint-moderation-error-response.js";
import { BlueprintModerationCommandSchema } from "#src/modules/home/blueprints/blueprint-moderation.schemas.js";
import * as blueprintModerationService from "#src/modules/home/blueprints/blueprint-moderation.service.js";
import * as teardownMarketSignalService from "#src/modules/home/blueprints/teardown-market-signal.service.js";
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
  TeardownUploadFormatSchema,
} from "#src/modules/home/blueprints/teardown-submission.schemas.js";
import * as teardownSubmissionService from "#src/modules/home/blueprints/teardown-submission.service.js";
import {
  respondTeardownFileNotFound,
  respondTeardownUploadError,
} from "#src/modules/home/blueprints/teardown-upload-error-response.js";
import * as teardownUploadService from "#src/modules/home/blueprints/teardown-upload.service.js";
import { respondTeardownWriteError } from "#src/modules/home/blueprints/teardown-write-error-response.js";
import {
  requirePlatformCapability,
  type PlatformStaffContext,
} from "#src/modules/platform/roles/platform-role.service.js";
import { respondFieldRefusal } from "#src/modules/rnd/projects/project-error-response.js";
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

/**
 * `POST /blueprints/admin/teardowns/:teardownId/moderation-state` — flag, quarantine or restore.
 *
 * ⚠️ THE CAPABILITY IS RESOLVED BEFORE `req.params` IS READ AND BEFORE THE BODY IS PARSED, and the
 * ordering is the security property rather than a style choice. Reversed, a 403 that only arrives
 * for teardowns that EXIST is an existence oracle over other people's work — blueprints doc §3.6,
 * and `blueprints.routes.blueprint-moderation.test.ts` proves it by sending a non-moderator a
 * request that is ALSO malformed and requiring 403, not 422.
 *
 * ⚠️ ADDRESSED BY THE TEARDOWN'S ID, NOT ITS SLUG, and the param is named `teardownId` rather than
 * `submissionId` so it cannot be confused with the sibling route that decides a submission. These
 * two act on different objects: `/:submissionId/moderate` decides paperwork, this moves a row that
 * is already public.
 */
export async function setTeardownModerationState(req: Request, res: Response): Promise<void> {
  const staff = await resolveModerator(req, res);
  if (!staff) return;

  const parsedCommand = BlueprintModerationCommandSchema.safeParse(req.body);
  if (!parsedCommand.success) {
    respondValidationFailed(res, parsedCommand.error);
    return;
  }

  const result = await blueprintModerationService.applyTeardownModerationVerb({
    targetId: firstParam(req.params.teardownId ?? ""),
    verb: parsedCommand.data.verb,
    reasonNote: parsedCommand.data.reasonNote,
    reportId: parsedCommand.data.reportId,
    staff,
  });

  if (!result.success) {
    respondBlueprintModerationError(res, result.error);
    return;
  }

  respondOk(res, "The teardown's state was changed.", result.value);
}

/**
 * `GET /blueprints/teardowns/:teardownSlug/market-signal` — is anybody selling this, and has
 * anybody built one?
 *
 * ⚠️ BARE-PUBLIC, like the five reads above it. The payload is a list of public store listings and
 * published launches with nothing keyed to a session, so there is nothing to personalise and
 * nothing to leak — and an IP-keyed limiter on a detail-page element behind a CDN or a corporate
 * NAT is a self-inflicted outage. A cache belongs in front of this, not a limiter inside it.
 *
 * ⚠️ A MALFORMED SLUG ANSWERS 404, NOT 422. The parse still runs — the boundary rule holds — but a
 * 422 sitting beside a 404 would together tell a stranger which slug SHAPES exist, one request at
 * a time. The five reads above answer the same way for the same reason.
 */
export async function getTeardownMarketSignal(req: Request, res: Response): Promise<void> {
  const slugParse = PublicTeardownSlugSchema.safeParse(firstParam(req.params.teardownSlug ?? ""));
  if (!slugParse.success) {
    respondTeardownNotFound(res);
    return;
  }

  const result = await teardownMarketSignalService.getTeardownMarketSignal(slugParse.data);
  if (!result.success) {
    respondTeardownNotFound(res);
    return;
  }

  respondOk(res, "What the market is doing around this teardown.", result.value);
}

/**
 * `POST /blueprints/teardowns/uploads` — one CAD file or PDF, staged for a later submission.
 *
 * The receipt carries an id, the validated format, the MEASURED size and the author's own filename
 * — and NO address. A staged file has no public address yet: one exists only once a moderator
 * publishes the submission that claims it, which is the same rule the submit receipt follows in
 * carrying no slug.
 */
export async function uploadSubmissionFile(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  if (!req.file) {
    respondFieldRefusal(res, "file", "Choose a file to upload.");
    return;
  }

  const parsedFormat = TeardownUploadFormatSchema.safeParse(req.body);
  if (!parsedFormat.success) {
    respondValidationFailed(res, parsedFormat.error);
    return;
  }

  const uploadResult = await teardownUploadService.uploadTeardownSubmissionFile({
    uploaderUserId: req.user.id,
    declaredFormat: parsedFormat.data.format,
    fileBytes: req.file.buffer,
    // Multer gives the client's own filename. It reaches storage as a download disposition only,
    // sanitized there, and never as any part of an object key.
    originalFileName: req.file.originalname,
  });
  if (!uploadResult.success) {
    respondTeardownUploadError(res, uploadResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "File uploaded successfully",
    data: uploadResult.value,
  };
  res.status(201).json(response);
}

/**
 * The two download routes: `.../documents/:fileId` and `.../fabrication-files/:fileId`.
 *
 * ⚠️ NOT BARE READS, AND THEY DO NOT BREAK THE BARE-READ RULE — they fail both of its own clauses.
 * That rule is about reads whose payload is IDENTICAL FOR EVERY VISITOR and which a cache belongs
 * in front of. This answers a 302 to a 300-second bearer capability minted per request, and sets
 * `Cache-Control: no-store`. `GET /videos/:videoId/documents/:documentId/file` is the shipped
 * precedent: anonymous-reachable, private bucket, same shape.
 *
 * ⚠️ THE GATE IS RE-CHECKED HERE, ON EVERY REQUEST, WHICH IS THE POINT OF THE WHOLE DESIGN. A
 * presigned URL is a bearer capability that knows nothing about moderation state — so the moment a
 * teardown is quarantined this route stops minting one, and a link somebody saved yesterday is
 * dead. That is a quarantine actually withholding files rather than merely stopping advertising
 * them, which is all it could do while every file was a link to someone else's host.
 */
function makeTeardownFileDownloadHandler(segment: "documents" | "fabrication-files") {
  return async function downloadTeardownFile(req: Request, res: Response): Promise<void> {
    const teardownSlug = firstParam(req.params.teardownSlug ?? "");
    const fileId = firstParam(req.params.fileId ?? "");

    const resolved = await teardownPublicReadService.resolveDownloadableTeardownFile({
      teardownSlug,
      fileId,
      segment,
    });
    // One answer for every reason — see `respondTeardownFileNotFound`.
    if (resolved === null) {
      respondTeardownFileNotFound(res);
      return;
    }

    const presigned = await presignTeardownFileDownload(resolved.objectStorageKey);
    if (!presigned.success) {
      res.status(presigned.error.type === "NOT_CONFIGURED" ? 503 : 502).json({
        status: "error",
        statusCode: presigned.error.type === "NOT_CONFIGURED" ? 503 : 502,
        message: "That file could not be fetched right now.",
      });
      return;
    }

    // ⚠️ `no-store`, ALWAYS. The redirect target is a credential with a 300-second life; a cache or
    // a CDN holding this response would hand that credential to somebody the gate never saw.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, presigned.value.downloadUrl);
  };
}

export const downloadTeardownDocument = makeTeardownFileDownloadHandler("documents");
export const downloadTeardownManufacturingFile =
  makeTeardownFileDownloadHandler("fabrication-files");

/**
 * `GET /blueprints/teardowns/:teardownSlug/assembly-model` and `.../part-models/:partId`.
 *
 * The same shape as the two file downloads beside them, gated the same way and for the same reason.
 * A `.glb` is fetched by a WebGL viewer rather than saved by a person, which changes nothing about
 * the gate: a quarantine withholds the geometry, and the only address the viewer has is this route.
 */
function makeTeardownModelDownloadHandler(scope: "assembly" | "part") {
  return async function downloadTeardownModel(req: Request, res: Response): Promise<void> {
    const resolved = await teardownPublicReadService.resolveDownloadableTeardownModel({
      teardownSlug: firstParam(req.params.teardownSlug ?? ""),
      partId: scope === "part" ? firstParam(req.params.partId ?? "") : null,
    });
    if (resolved === null) {
      respondTeardownFileNotFound(res);
      return;
    }

    const presigned = await presignTeardownFileDownload(resolved.objectStorageKey);
    if (!presigned.success) {
      res.status(presigned.error.type === "NOT_CONFIGURED" ? 503 : 502).json({
        status: "error",
        statusCode: presigned.error.type === "NOT_CONFIGURED" ? 503 : 502,
        message: "That model could not be fetched right now.",
      });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, presigned.value.downloadUrl);
  };
}

export const downloadTeardownAssemblyModel = makeTeardownModelDownloadHandler("assembly");
export const downloadTeardownPartModel = makeTeardownModelDownloadHandler("part");
