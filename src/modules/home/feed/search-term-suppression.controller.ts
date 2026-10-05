import type { Request, Response } from "express";

import {
  firstParam,
  respondSearchTermSuppressionError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/feed/search-term-suppression-error-response.js";
import {
  ListSearchTermSuppressionsQuerySchema,
  SuppressedSearchTermParamSchema,
  SuppressSearchTermSchema,
} from "#src/modules/home/feed/search-term-suppression.schemas.js";
import * as suppressionService from "#src/modules/home/feed/search-term-suppression.service.js";
import type { ApiResponse } from "#src/types/index.js";

const DEFAULT_SUPPRESSION_PAGE_SIZE = 20;

/** GET /feed/admin/search-terms/suppressions — `moderate_content`. Keyset-paged, newest first. */
export async function listSearchTermSuppressions(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }
  const parsedQuery = ListSearchTermSuppressionsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }
  const listResult = await suppressionService.listSearchTermSuppressions(req.user.id, {
    limit: parsedQuery.data.limit ?? DEFAULT_SUPPRESSION_PAGE_SIZE,
    ...(parsedQuery.data.cursor === undefined ? {} : { cursor: parsedQuery.data.cursor }),
  });
  if (!listResult.success) {
    respondSearchTermSuppressionError(res, listResult.error);
    return;
  }
  // `nextCursor` as a SIBLING of `data`, the shape every keyset staff queue here answers with.
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Suppressed search terms",
    data: listResult.value.items,
    nextCursor: listResult.value.nextCursor,
  });
}

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
