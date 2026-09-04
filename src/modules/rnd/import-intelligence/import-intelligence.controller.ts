import type { Request, Response } from "express";

import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import {
  firstParam,
  respondImportIntelligenceError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/import-intelligence/import-intelligence-error-response.js";
import {
  AssessmentIdSchema,
  CreateDomesticSubstituteSchema,
  DecidePathwaySuggestionSchema,
  HsCodeSchema,
  IMPORT_COMMODITY_KINDS,
  ListImportCommoditiesQuerySchema,
  ListLocalizationAssessmentGridQuerySchema,
  ListLocalizationAssessmentsQuerySchema,
  ListSubstitutesQuerySchema,
  ListTradeFlowsQuerySchema,
  UpdateDomesticSubstituteSchema,
} from "#src/modules/rnd/import-intelligence/import-intelligence.schemas.js";
import * as importIntelligenceService from "#src/modules/rnd/import-intelligence/import-intelligence.service.js";
import type { ApiResponse, PaginatedResponse } from "#src/types/index.js";

function paginationFor(
  page: number,
  limit: number,
  total: number,
): PaginatedResponse["pagination"] {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** `GET /import-commodity-kinds` — the chip vocabulary. Not paginated. */
export async function listImportCommodityKinds(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Import commodity kinds retrieved successfully",
    data: IMPORT_COMMODITY_KINDS.map((kind) => ({ kind })),
  } satisfies ApiResponse);
}

/**
 * `GET /import-reporters` — the countries that actually have trade data.
 *
 * Not paginated: the ceiling is the number of countries ingested. An EMPTY array means
 * nothing has been synced yet, which a picker should say plainly rather than rendering
 * eighteen seeded countries as if they were choices.
 */
export async function listImportReporters(_req: Request, res: Response): Promise<void> {
  const reporters = await importIntelligenceService.listImportReporters();

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Import reporters retrieved successfully",
    data: reporters,
  } satisfies ApiResponse);
}

/** `GET /import-commodities` — the HS6 directory. Public, server-side filtering (§6). */
export async function listImportCommodities(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListImportCommoditiesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await importIntelligenceService.listImportCommodities(parsedQuery.data);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Import commodities retrieved successfully",
    data: [...page.rows],
    pagination: paginationFor(parsedQuery.data.page, parsedQuery.data.limit, page.total),
  } satisfies PaginatedResponse);
}

/**
 * `GET /import-commodities/:hsCode` — one commodity, plus its newest assessment and that
 * assessment's pathway suggestions.
 *
 * The COMMODITY read decides whether the page exists; a missing assessment is `null` and
 * NOT a 404. "Not scored yet" and "no such commodity" are different facts and a founder
 * needs to be able to tell them apart.
 */
export async function getImportCommodity(req: Request, res: Response): Promise<void> {
  const parsedHsCode = HsCodeSchema.safeParse(firstParam(req.params.hsCode));
  if (!parsedHsCode.success) {
    respondValidationFailed(res, parsedHsCode.error);
    return;
  }

  const commodityResult = await importIntelligenceService.getImportCommodityByHsCode(
    parsedHsCode.data,
  );
  if (!commodityResult.success) {
    respondImportIntelligenceError(res, commodityResult.error);
    return;
  }

  // A malformed or absent country code narrows to "any country" rather than 422ing: this
  // is a detail page, and the commodity read has already succeeded.
  const rawCountryCode = req.query.reporterCountryCode;
  const reporterCountryCode =
    typeof rawCountryCode === "string" && /^[A-Z]{2}$/.test(rawCountryCode)
      ? rawCountryCode
      : undefined;
  const { assessment, suggestions } = await importIntelligenceService.getCommodityAssessment(
    parsedHsCode.data,
    reporterCountryCode,
  );

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Import commodity retrieved successfully",
    data: {
      commodity: commodityResult.value,
      assessment,
      pathwaySuggestions: suggestions,
    },
  } satisfies ApiResponse);
}

/** `GET /import-commodities/:hsCode/trade-flows` — the all-partners aggregate per period. */
export async function listTradeFlows(req: Request, res: Response): Promise<void> {
  const parsedHsCode = HsCodeSchema.safeParse(firstParam(req.params.hsCode));
  if (!parsedHsCode.success) {
    respondValidationFailed(res, parsedHsCode.error);
    return;
  }
  const parsedQuery = ListTradeFlowsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const result = await importIntelligenceService.listTradeFlowsForCommodity(
    parsedHsCode.data,
    parsedQuery.data,
  );
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Trade flows retrieved successfully",
    data: [...result.value.rows],
    pagination: paginationFor(parsedQuery.data.page, parsedQuery.data.limit, result.value.total),
  } satisfies PaginatedResponse);
}

/**
 * `GET /import-commodities/:hsCode/substitutes`.
 *
 * A MODERATOR SEES DRAFTS; nobody else does. The capability is resolved here rather than
 * in the service because it WIDENS a read rather than gating one — there is no id to
 * disclose and no refusal to make, so the "check before any id is read" rule does not
 * apply and a failed check simply means the public view.
 */
export async function listSubstitutes(req: Request, res: Response): Promise<void> {
  const parsedHsCode = HsCodeSchema.safeParse(firstParam(req.params.hsCode));
  if (!parsedHsCode.success) {
    respondValidationFailed(res, parsedHsCode.error);
    return;
  }
  const parsedQuery = ListSubstitutesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  let includeDrafts = false;
  if (req.user !== undefined) {
    const capabilityResult = await requirePlatformCapability(req.user.id, "moderate_taxonomy");
    includeDrafts = capabilityResult.success;
  }

  const result = await importIntelligenceService.listSubstitutesForCommodity(
    parsedHsCode.data,
    parsedQuery.data,
    { includeDrafts },
  );
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Domestic substitutes retrieved successfully",
    data: [...result.value.rows],
    pagination: paginationFor(parsedQuery.data.page, parsedQuery.data.limit, result.value.total),
  } satisfies PaginatedResponse);
}

/** `GET /localization-assessments` — the rank-ordered leaderboard for the newest `asOf`. */
export async function listLocalizationAssessments(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListLocalizationAssessmentsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const page = await importIntelligenceService.listLocalizationAssessments(parsedQuery.data);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Localization assessments retrieved successfully",
    data: [...page.rows],
    pagination: paginationFor(parsedQuery.data.page, parsedQuery.data.limit, page.total),
  } satisfies PaginatedResponse);
}

/**
 * `GET /localization-assessment-grid` — the same population as the leaderboard, counted per
 * score cell.
 *
 * UNPAGINATED, like `/import-reporters`: the two grouping keys are nine-rung ladders, so 81
 * rows is the ceiling no matter how many commodities are scored. Handing back a page of a
 * distribution invites a caller to draw a partial one as if it were whole.
 */
export async function listLocalizationAssessmentGrid(req: Request, res: Response): Promise<void> {
  const parsedQuery = ListLocalizationAssessmentGridQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const cells = await importIntelligenceService.listLocalizationAssessmentGrid(parsedQuery.data);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Localization assessment grid retrieved successfully",
    data: [...cells],
  } satisfies ApiResponse);
}

/**
 * `POST /localization-assessments/:assessmentId/pathway` — ask for one product's pathway
 * narrative and capital band.
 *
 * ⚠️ **202 IS NOT A RESULT.** A queued job means the row exists to be written, not that a
 * verdict exists — and the verdict here includes a capital figure somebody may borrow
 * against. The body carries `narrativeStatus` and NOTHING resembling an answer, so a client
 * cannot mistake acceptance for output. It polls the commodity read.
 *
 * 200 when the narrative is already written: re-asking would spend a metered model call to
 * restate the same thing at the same `asOf`.
 *
 * ⚠️ THE ONLY AUTHENTICATED ENDPOINT IN §11m. Every read here is public; this one bills. The
 * route chain is `requireAuth -> limiter -> requireIdentifiedUser`, the same order the three
 * substitute writes use.
 */
export async function requestPathwayNarrative(req: Request, res: Response): Promise<void> {
  if (req.user === undefined) {
    respondUnauthenticated(res);
    return;
  }

  const parsedAssessmentId = AssessmentIdSchema.safeParse(firstParam(req.params.assessmentId));
  if (!parsedAssessmentId.success) {
    respondValidationFailed(res, parsedAssessmentId.error);
    return;
  }

  const result = await importIntelligenceService.requestPathwayNarrative(parsedAssessmentId.data);
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  const isAlreadyGenerated = result.value.kind === "already_generated";
  res.status(isAlreadyGenerated ? 200 : 202).json({
    status: "success",
    statusCode: isAlreadyGenerated ? 200 : 202,
    message: isAlreadyGenerated
      ? "Pathway narrative already written."
      : "Pathway narrative queued. Nothing has been written yet.",
    data: { narrativeStatus: isAlreadyGenerated ? "generated" : "pending" },
  } satisfies ApiResponse);
}

/** `POST /domestic-substitutes` — moderator only, checked inside the service. */
export async function createDomesticSubstitute(req: Request, res: Response): Promise<void> {
  if (req.user === undefined) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = CreateDomesticSubstituteSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await importIntelligenceService.createDomesticSubstitute(
    req.user.id,
    parsedBody.data,
  );
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Domestic substitute created successfully",
    data: result.value,
  } satisfies ApiResponse);
}

/** `PATCH /domestic-substitutes/:substituteId`. */
export async function updateDomesticSubstitute(req: Request, res: Response): Promise<void> {
  if (req.user === undefined) {
    respondUnauthenticated(res);
    return;
  }
  const substituteId = firstParam(req.params.substituteId);
  if (substituteId === undefined) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = UpdateDomesticSubstituteSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await importIntelligenceService.updateDomesticSubstitute(
    req.user.id,
    substituteId,
    parsedBody.data,
  );
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Domestic substitute updated successfully",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * `POST /localization-pathway-suggestions/:suggestionId/decision`.
 *
 * ADVISORY. It records that a human read a machine opinion; it moves no score and no rank.
 */
export async function decidePathwaySuggestion(req: Request, res: Response): Promise<void> {
  if (req.user === undefined) {
    respondUnauthenticated(res);
    return;
  }
  const suggestionId = firstParam(req.params.suggestionId);
  if (suggestionId === undefined) {
    respondUnauthenticated(res);
    return;
  }
  const parsedBody = DecidePathwaySuggestionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const result = await importIntelligenceService.decidePathwaySuggestion(
    req.user.id,
    suggestionId,
    parsedBody.data,
  );
  if (!result.success) {
    respondImportIntelligenceError(res, result.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Pathway suggestion decision recorded successfully",
    data: result.value,
  } satisfies ApiResponse);
}
