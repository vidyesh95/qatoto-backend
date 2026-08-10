import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceRankingService from "#src/services/commerce-ranking.service.js";
import type { ApiResponse } from "#src/types/index.js";
import { respondValidationFailed } from "#src/controllers/project-error-response.js";

/**
 * The ranking engine's two authenticated surfaces (STORE Phase 13, stage 5).
 *
 * A seller reading its own product's standing, and a moderator deciding an appeal. There is
 * deliberately no route that exposes the component breakdown or the category statistics:
 * publishing those would hand anyone with a seller account a specification of what to forge.
 */

const EmptyObjectSchema = z.object({}).strict();

const ProductIdParamsSchema = z.object({ productId: z.string().trim().min(1).max(200) }).strict();

/**
 * `none` is a legal action and is how an appeal is GRANTED — it lifts a suppression while
 * leaving the decision, its author and its reason in the event log. Deleting the row instead
 * would erase the fact that a suppression ever happened.
 */
const ModerateRankingBodySchema = z
  .object({
    action: z.enum(["none", "weight_reduced", "capped", "quarantined", "review_queued"]),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

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

/** `GET /commerce/products/:productId/ranking-status` */
export async function getProductRankingStatus(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = EmptyObjectSchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }
  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const organizationId = req.commerceOrganization?.organizationId;
  if (organizationId === undefined) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active commerce organization is required.",
    } satisfies ApiResponse);
    return;
  }

  const result = await commerceRankingService.getProductRankingStatus({
    productId: params.data.productId,
    callerOrganizationId: organizationId,
  });

  if (!result.success) {
    switch (result.error.type) {
      case "NOT_FOUND":
      case "NOT_AUTHORIZED":
        // Both map to 404: a product owned by someone else must be indistinguishable from
        // one that does not exist (§11 anti-enumeration).
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Product not found.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustive: never = result.error;
        throw new Error(`Unhandled ranking status error: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Ranking status.",
    data: result.value,
  } satisfies ApiResponse);
}

/** `POST /commerce/admin/products/:productId/ranking-enforcement` */
export async function moderateProductRanking(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const params = ProductIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = ModerateRankingBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceRankingService.moderateProductRanking({
    productId: params.data.productId,
    moderatorUserId: req.user.id,
    action: body.data.action,
    reason: body.data.reason,
  });

  if (!result.success) {
    switch (result.error.type) {
      case "NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Product not found.",
        } satisfies ApiResponse);
        return;
      case "PLATFORM_CAPABILITY_REQUIRED":
        res.status(403).json({
          status: "error",
          statusCode: 403,
          message: "Moderator capability required.",
        } satisfies ApiResponse);
        return;
      default: {
        const exhaustive: never = result.error;
        throw new Error(`Unhandled moderation error: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Ranking enforcement recorded.",
    data: result.value,
  } satisfies ApiResponse);
}
