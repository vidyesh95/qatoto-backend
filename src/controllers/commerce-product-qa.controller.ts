import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import { resolveActiveCommerceOrganization } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import {
  AnswerProductQuestionSchema,
  AskProductQuestionSchema,
  ProductAnswerIdParamsSchema,
  ProductAnswerListParamsSchema,
  ProductIdParamsSchema,
  ProductQuestionIdParamsSchema,
  ProductQuestionListParamsSchema,
  ProductQuestionListQuerySchema,
  SellerQuestionInboxQuerySchema,
} from "#src/schemas/commerce-product-qa.schemas.js";
import { EmptyObjectSchema } from "#src/schemas/commerce-product-qa.schemas.js";
import * as commerceProductQaService from "#src/services/commerce-product-qa.service.js";
import type { CommerceProductQaError } from "#src/services/commerce-product-qa.service.js";
import {
  resolveEligibleProductRefById,
  resolveEligibleProductRefBySlug,
} from "#src/services/store-catalog.service.js";
import type { ApiResponse } from "#src/types/index.js";

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

function requireUserId(req: Request, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  return req.user.id;
}

function mapQaError(res: Response, error: CommerceProductQaError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "NOT_AUTHORIZED_TO_ANSWER":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Only the seller or a verified buyer of this product may answer.",
      } satisfies ApiResponse);
      return;
    case "ALREADY_ANSWERED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Your organization has already answered this question.",
      } satisfies ApiResponse);
      return;
    case "SELF_VOTE_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "An answer's author cannot endorse it.",
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled product Q&A error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * The authoring routes key on product ID, the public reads on public slug.
 *
 * That split is not an inconsistency: a public URL should carry the stable, immutable
 * slug the catalog already publishes, while an authenticated write already holds the
 * id it is acting on. Both paths run the SAME eligibility rule — a question may not be
 * asked about, or read from, a listing the public cannot see.
 */
/**
 * A24. Who is reading, for `viewer.hasVotedHelpful`.
 *
 * Resolved here rather than by a guard, for the reason `store.controller.getProduct`
 * states: on a public read the organization is descriptive, not required. A visitor with
 * no account, and a signed-in visitor with no active commerce organization, both get
 * `null` — neither can vote, so neither is told anything about a vote.
 */
async function resolveQaViewer(
  req: Request,
): Promise<commerceProductQaService.ProductQaViewerContext> {
  if (!req.user || !req.authSession?.activeOrganizationId) {
    return commerceProductQaService.ANONYMOUS_QA_VIEWER;
  }
  const activeOrganization = await resolveActiveCommerceOrganization({
    userId: req.user.id,
    activeOrganizationId: req.authSession.activeOrganizationId,
  });
  return {
    organizationId: activeOrganization.success ? activeOrganization.value.organizationId : null,
  };
}

/**
 * A24. The vote routes carry `requireActiveCommerceOrganization`, so the membership is
 * already resolved onto the request — this only narrows it for the service.
 */
function requireQaActor(
  req: Request,
  res: Response,
): commerceProductQaService.CommerceProductQaActorContext | null {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  if (!req.commerceOrganization) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active commerce organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    organizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    actorUserId: req.user.id,
  };
}

async function resolveEligibleProductIdBySlug(
  req: Request,
  res: Response,
  productSlug: string,
): Promise<string | null> {
  const productRef = await resolveEligibleProductRefBySlug(productSlug);
  if (!productRef) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return null;
  }
  return productRef.id;
}

export async function askProductQuestion(req: Request, res: Response): Promise<void> {
  const askerUserId = requireUserId(req, res);
  if (!askerUserId) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AskProductQuestionSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  // Even an authenticated author may only ask about a PUBLICLY ELIGIBLE listing.
  // Skipping this would let the route confirm that a draft or suspended product id
  // exists — a quieter version of the enumeration §11 forbids.
  const productRef = await resolveEligibleProductRefById(params.data.productId);
  if (!productRef) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: "Product not found.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceProductQaService.askProductQuestion(
    askerUserId,
    productRef.id,
    body.data,
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Question posted.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function retractProductQuestion(req: Request, res: Response): Promise<void> {
  const askerUserId = requireUserId(req, res);
  if (!askerUserId) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductQuestionIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceProductQaService.retractProductQuestion(
    askerUserId,
    params.data.questionId,
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Question withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function answerProductQuestion(req: Request, res: Response): Promise<void> {
  const answererUserId = requireUserId(req, res);
  if (!answererUserId) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductQuestionIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AnswerProductQuestionSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  /**
   * No organization middleware on this route: it serves two author kinds with two
   * different organization requirements, so the service resolves the caller's context
   * itself and returns NOT_AUTHORIZED_TO_ANSWER for "no organization" alongside every
   * other refusal.
   */
  const result = await commerceProductQaService.answerProductQuestion(
    {
      answererUserId,
      activeOrganizationId: req.authSession?.activeOrganizationId ?? null,
      questionId: params.data.questionId,
    },
    body.data,
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Answer posted.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function retractProductAnswer(req: Request, res: Response): Promise<void> {
  const answererUserId = requireUserId(req, res);
  if (!answererUserId) return;
  if (!parseNoQuery(req, res)) return;

  const params = ProductAnswerIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceProductQaService.retractProductAnswer(
    answererUserId,
    params.data.answerId,
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Answer withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /commerce/seller/questions — the seller's cross-listing question queue (A38).
 *
 * A9 shipped the answer write and only public per-product reads, so a seller could answer any
 * question they were shown and had no way to find one. The viewer context is passed through so
 * a seller's own helpful votes render on their own queue, exactly as on the public read.
 */
export async function listSellerQuestionInbox(req: Request, res: Response): Promise<void> {
  const sellerOrganization = req.commerceOrganization;
  if (!sellerOrganization) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active seller organization membership is required.",
    } satisfies ApiResponse);
    return;
  }

  const query = SellerQuestionInboxQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceProductQaService.listSellerQuestionInbox(
    sellerOrganization.organizationId,
    query.data,
    await resolveQaViewer(req),
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Seller question inbox.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listProductQuestions(req: Request, res: Response): Promise<void> {
  const params = ProductQuestionListParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = ProductQuestionListQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const productId = await resolveEligibleProductIdBySlug(req, res, params.data.productSlug);
  if (productId === null) return;

  const result = await commerceProductQaService.listProductQuestions(
    productId,
    query.data,
    await resolveQaViewer(req),
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Product questions.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listProductQuestionAnswers(req: Request, res: Response): Promise<void> {
  const params = ProductAnswerListParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const query = ProductQuestionListQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const productId = await resolveEligibleProductIdBySlug(req, res, params.data.productSlug);
  if (productId === null) return;

  const result = await commerceProductQaService.listProductQuestionAnswers(
    { productId, questionId: params.data.questionId },
    query.data,
    await resolveQaViewer(req),
  );
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Question answers.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function setAnswerHelpfulVote(req: Request, res: Response): Promise<void> {
  const params = ProductAnswerIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;
  const actor = requireQaActor(req, res);
  if (!actor) return;

  const result = await commerceProductQaService.setAnswerHelpfulVote(actor, params.data.answerId);
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Answer marked helpful.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function clearAnswerHelpfulVote(req: Request, res: Response): Promise<void> {
  const params = ProductAnswerIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  if (!parseNoQuery(req, res)) return;
  const actor = requireQaActor(req, res);
  if (!actor) return;

  const result = await commerceProductQaService.clearAnswerHelpfulVote(actor, params.data.answerId);
  if (!result.success) {
    mapQaError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Helpful vote withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
