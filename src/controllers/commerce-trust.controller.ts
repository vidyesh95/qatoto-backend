import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/controllers/project-error-response.js";
import { ACCEPTED_IMAGE_FORMATS_SENTENCE, describeUnsupportedImageFormat } from "#src/lib/image.js";
import {
  AttachReviewPhotoFieldsSchema,
  AttachReviewVideoSchema,
  CompletionIdParamsSchema,
  CreateDisputeSchema,
  CreateReviewSchema,
  DecideDisputeSchema,
  DisputeIdParamsSchema,
  ListBuyerCompletionsQuerySchema,
  ListDisputesQuerySchema,
  OrderIdParamsSchema,
  ReviewIdParamsSchema,
  ReviewMediaParamsSchema,
  UpsertReviewReplySchema,
} from "#src/schemas/commerce-trust.schemas.js";
import * as commerceCompletionService from "#src/services/commerce-completion.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import * as commerceTrustService from "#src/services/commerce-trust.service.js";
import type {
  CommerceReviewMediaError,
  CommerceTrustError,
} from "#src/services/commerce-trust.service.js";
import type { ApiResponse } from "#src/types/index.js";

const EmptyObjectSchema = z.object({}).strict();

function sendZodError(res: Response, error: z.ZodError): void {
  /**
   * Delegates to the ONE shared responder (§0).
   *
   * This used to build its own body, and got two things wrong that only showed up in the browser:
   * it forwarded `fieldErrors` alone, so `.strict()`'s `unrecognized_keys` — the way EVERY rejected
   * server-owned field arrives — vanished into an empty object; and it put the payload under `data`,
   * which the client's envelope reader never looks at. The result was a 422 that said "Validation
   * failed." and named nothing.
   */
  respondValidationFailed(res, error);
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

function requireCommerceActor(
  req: Request,
  res: Response,
): {
  organizationId: string;
  memberId: string;
  memberRole: CommerceOrganizationMemberRole;
  actorUserId: string;
} | null {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
    actorUserId: req.user.id,
  };
}

function mapTrustError(res: Response, error: CommerceTrustError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You are not allowed to perform this action.",
      } satisfies ApiResponse);
      return;
    case "SELF_REVIEW_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Self-review is not allowed.",
      } satisfies ApiResponse);
      return;
    case "DISPUTE_PARTY_MODERATION_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "A member of a dispute party cannot decide that dispute.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    case "PLATFORM_CAPABILITY_REQUIRED":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Platform capability required.",
        data: { capability: error.capability },
      } satisfies ApiResponse);
      return;
    case "MEDIA_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `A review may carry at most ${error.limit} media items.`,
      } satisfies ApiResponse);
      return;
    case "SELF_VOTE_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "A party to a review cannot vote on it.",
      } satisfies ApiResponse);
      return;
    case "UNSUPPORTED_SCORE_AXIS":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: `The "${error.axis}" score does not apply to this completion.`,
      } satisfies ApiResponse);
      return;
    case "INVALID_YOUTUBE_URL":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Provide a YouTube video link.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce trust error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Media upload adds two more failure families — sharp's verdict on the bytes and
 * Cloudinary's on the network. They are handled here and everything else DELEGATES to
 * `mapTrustError`, which TypeScript narrows to `CommerceTrustError` in the default
 * branch. That is why the service composes three unions instead of merging them: no
 * assertion is needed to get back to the narrower mapper.
 */
function mapReviewMediaError(res: Response, error: CommerceReviewMediaError): void {
  switch (error.type) {
    case "NOT_AN_IMAGE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: `That file isn't an image. ${ACCEPTED_IMAGE_FORMATS_SENTENCE}`,
      } satisfies ApiResponse);
      return;
    case "UNSUPPORTED_FORMAT":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: describeUnsupportedImageFormat(error.detected),
      } satisfies ApiResponse);
      return;
    case "DIMENSIONS_TOO_SMALL":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: `That image is too small (${error.width}×${error.height}).`,
      } satisfies ApiResponse);
      return;
    case "DIMENSIONS_TOO_LARGE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: `That image is too large (${error.width}×${error.height}).`,
      } satisfies ApiResponse);
      return;
    case "NOT_CONFIGURED":
      res.status(503).json({
        status: "error",
        statusCode: 503,
        message: "Image uploads are not available right now.",
      } satisfies ApiResponse);
      return;
    case "UPLOAD_FAILED":
    case "DELETE_FAILED":
      res.status(502).json({
        status: "error",
        statusCode: 502,
        message: "The image service did not complete the request.",
      } satisfies ApiResponse);
      return;
    default:
      mapTrustError(res, error);
      return;
  }
}

/**
 * GET /commerce/completions
 *
 * The buyer's completions, and whether they have already reviewed each one. This exists
 * because `POST /commerce/completions/:completionId/reviews` is keyed on an id that was
 * projected nowhere — ratings, review photos and review videos were all reachable only by
 * guessing a UUID.
 *
 * The organization comes from `requireActiveBuyerCommerceOrganization`, never from the
 * query string (§0).
 */
export async function listBuyerCompletions(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListBuyerCompletionsQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceCompletionService.listBuyerCompletions({
    buyerOrganizationId: actor.organizationId,
    reviewable: query.data.reviewable,
    limit: query.data.limit,
    cursor: query.data.cursor,
  });
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Completions retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = CompletionIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateReviewSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.createReview(
    actor,
    params.data.completionId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Review created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function openDispute(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = OrderIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = CreateDisputeSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.openDispute(actor, params.data.orderId, body.data);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Dispute opened.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listModeratorDisputes(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = ListDisputesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceTrustService.listDisputesForModerator(req.user.id, query.data);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Disputes loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * A28. A participant reads a dispute they are a party to.
 *
 * `requireCommerceActor` is the same gate every other participant-scoped read uses; the
 * service refuses a non-party with `NOT_FOUND`, never `FORBIDDEN`, so the route cannot
 * be used to discover which dispute ids exist.
 */
export async function getDispute(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const params = DisputeIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const result = await commerceTrustService.getDisputeForParticipant(actor, params.data.disputeId);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Dispute loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listParticipantDisputes(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListDisputesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceTrustService.listDisputesForParticipant(actor, query.data);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Disputes loaded.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function decideDispute(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }
  if (!parseNoQuery(req, res)) return;

  const params = DisputeIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = DecideDisputeSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.decideDispute(
    req.user.id,
    params.data.disputeId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Dispute decided.",
    data: result.value,
  } satisfies ApiResponse);
}

// ---------------------------------------------------------------------------
// Appendix A8 — review depth handlers.
// ---------------------------------------------------------------------------

export async function attachReviewPhoto(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  // Multipart carries no body schema of its own, but stray text fields must still be
  // refused rather than silently dropped.
  const fields = AttachReviewPhotoFieldsSchema.safeParse(req.body ?? {});
  if (!fields.success) {
    sendZodError(res, fields.error);
    return;
  }
  if (!req.file) {
    res.status(422).json({
      status: "error",
      statusCode: 422,
      message: "Attach one image in the `image` field.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceTrustService.attachReviewPhoto(
    actor,
    params.data.reviewId,
    req.file.buffer,
  );
  if (!result.success) {
    mapReviewMediaError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Review photo attached.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function attachReviewVideo(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AttachReviewVideoSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.attachReviewVideo(
    actor,
    params.data.reviewId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Review video attached.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function detachReviewMedia(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewMediaParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceTrustService.detachReviewMedia(
    actor,
    params.data.reviewId,
    params.data.mediaId,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Review media removed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setReviewHelpfulVote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceTrustService.setReviewHelpfulVote(actor, params.data.reviewId);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Marked helpful.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function clearReviewHelpfulVote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceTrustService.clearReviewHelpfulVote(actor, params.data.reviewId);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Helpful vote withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function upsertReviewReply(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = UpsertReviewReplySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceTrustService.upsertReviewReply(
    actor,
    params.data.reviewId,
    body.data,
  );
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reply saved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function deleteReviewReply(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = ReviewIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceTrustService.deleteReviewReply(actor, params.data.reviewId);
  if (!result.success) {
    mapTrustError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Reply withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
