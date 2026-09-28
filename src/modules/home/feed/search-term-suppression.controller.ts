import type { Request, Response } from "express";

import {
  firstParam,
  respondSearchTermSuppressionError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/feed/search-term-suppression-error-response.js";
import {
  SuppressedSearchTermParamSchema,
  SuppressSearchTermSchema,
} from "#src/modules/home/feed/search-term-suppression.schemas.js";
import * as suppressionService from "#src/modules/home/feed/search-term-suppression.service.js";
import type { ApiResponse } from "#src/types/index.js";

/** POST /feed/admin/search-terms/suppressions — `moderate_content`. Idempotent. */
export async function suppressSearchTerm(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = SuppressSearchTermSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }
  const suppressResult = await suppressionService.suppressSearchTerm(req.user.id, parsedBody.data);
  if (!suppressResult.success) {
    respondSearchTermSuppressionError(res, suppressResult.error);
    return;
  }
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Search term suppressed",
    data: suppressResult.value,
  };
  res.status(200).json(response);
}

/** DELETE /feed/admin/search-terms/suppressions/:term — `moderate_content`. 404 if not suppressed. */
export async function unsuppressSearchTerm(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedParams = SuppressedSearchTermParamSchema.safeParse({
    term: firstParam(req.params.term ?? ""),
  });
  if (!parsedParams.success) {
    respondValidationFailed(res, parsedParams.error);
    return;
  }
  const unsuppressResult = await suppressionService.unsuppressSearchTerm(
    req.user.id,
    parsedParams.data.term,
  );
  if (!unsuppressResult.success) {
    respondSearchTermSuppressionError(res, unsuppressResult.error);
    return;
  }
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Search term suppression lifted",
    data: unsuppressResult.value,
  };
  res.status(200).json(response);
}
