import type { Request, Response } from "express";

import {
  firstParam,
  optionalBody,
  respondCommerceFreightRateError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/store/fulfillment/commerce-freight-rates-error-response.js";
import {
  AppendFreightRateBreakSchema,
  CreateCustomsDwellEstimateSchema,
  CreateFreightRateCardSchema,
  DwellEstimateIdParamsSchema,
  ListCustomsDwellEstimatesQuerySchema,
  ListFreightRateCardsQuerySchema,
  RateCardIdParamsSchema,
  ReplaceFreightRateBreaksSchema,
  UpdateCustomsDwellEstimateSchema,
  UpdateFreightRateCardSchema,
} from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";
import * as commerceFreightRatesService from "#src/modules/store/fulfillment/commerce-freight-rates.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The §19 reference data's parse-and-dispatch layer.
 *
 * NO CAPABILITY CHECK HERE, and that is not an omission. `moderate_commerce` is proven inside
 * each service as its first statement, before any id is read; a second check in this file
 * would be a second place to get the ordering wrong, and the ordering is the whole security
 * property (see the routes file's header).
 *
 * ISO strings become `Date`s at this boundary and nowhere deeper. A service that accepted a
 * string would have to decide what an unparseable one meant, which is a parsing decision in a
 * layer that has already been promised parsed input.
 */

function parseOptionalInstant(value: string | undefined, fallback: Date): Date {
  return value === undefined ? fallback : new Date(value);
}

/**
 * §19.10's two reads.
 *
 * `safeParse(req.query)` AGAINST A `.strict()` SCHEMA, so an invented filter key is a 422 that
 * names it rather than a page silently unfiltered. That matters more here than on most lists:
 * a console that thinks it asked for one lane and was answered with every lane will read the
 * wrong price off the top row.
 *
 * `data` IS THE SERVICE VALUE VERBATIM — `{ items, page }`, not wrapped a second time. §7 fixes
 * the list envelope, and the writes above wrap because their payload is a single entity plus a
 * consequence, which is a different shape.
 */
export async function listFreightRateCards(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListFreightRateCardsQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const listResult = await commerceFreightRatesService.listFreightRateCards(
    req.user.id,
    query.data,
  );

  if (!listResult.success) {
    respondCommerceFreightRateError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Freight lane rate cards loaded",
    data: listResult.value,
  };
  res.status(200).json(response);
}

export async function listCustomsDwellEstimates(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const query = ListCustomsDwellEstimatesQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const listResult = await commerceFreightRatesService.listCustomsDwellEstimates(
    req.user.id,
    query.data,
  );

  if (!listResult.success) {
    respondCommerceFreightRateError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Customs dwell estimates loaded",
    data: listResult.value,
  };
  res.status(200).json(response);
}

export async function createFreightRateCard(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = CreateFreightRateCardSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const createResult = await commerceFreightRatesService.createFreightRateCard(req.user.id, {
    providerOrganizationId: parsed.data.providerOrganizationId,
    originCountryCode: parsed.data.originCountryCode,
    destinationCountryCode: parsed.data.destinationCountryCode,
    mode: parsed.data.mode,
    currency: parsed.data.currency,
    // Absent `validFrom` means "this list is live now", which is what an admin keying in
    // today's tariff means and should not have to say.
    validFrom: parseOptionalInstant(parsed.data.validFrom, new Date()),
    validUntil: parsed.data.validUntil === undefined ? null : new Date(parsed.data.validUntil),
    sourceForwarderName: parsed.data.sourceForwarderName,
    volumetricDivisorCm3PerKg: parsed.data.volumetricDivisorCm3PerKg,
    breaks: parsed.data.breaks,
  });

  if (!createResult.success) {
    respondCommerceFreightRateError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Freight lane rate card created successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

export async function updateFreightRateCard(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const params = RateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const parsed = UpdateFreightRateCardSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const updateResult = await commerceFreightRatesService.updateFreightRateCard(
    req.user.id,
    params.data.rateCardId,
    parsed.data.intent === "shorten_window"
      ? { intent: "shorten_window", validUntil: new Date(parsed.data.validUntil) }
      : { intent: "withdraw", reasonNote: parsed.data.reasonNote },
  );

  if (!updateResult.success) {
    respondCommerceFreightRateError(res, updateResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message:
      parsed.data.intent === "shorten_window"
        ? "Freight lane rate card validity shortened"
        : "Freight lane rate card withdrawn",
    data: { rateCard: updateResult.value },
  };
  res.status(200).json(response);
}

export async function appendFreightRateBreak(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const params = RateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const parsed = AppendFreightRateBreakSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const appendResult = await commerceFreightRatesService.appendFreightRateBreak(
    req.user.id,
    params.data.rateCardId,
    parsed.data,
  );

  if (!appendResult.success) {
    respondCommerceFreightRateError(res, appendResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Freight rate band added",
    data: { rateCard: appendResult.value },
  };
  res.status(201).json(response);
}

export async function replaceFreightRateBreaks(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const params = RateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const parsed = ReplaceFreightRateBreaksSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const replaceResult = await commerceFreightRatesService.replaceFreightRateBreaks(
    req.user.id,
    params.data.rateCardId,
    { breaks: parsed.data.breaks },
  );

  if (!replaceResult.success) {
    respondCommerceFreightRateError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Freight rate bands replaced",
    data: { rateCard: replaceResult.value },
  };
  res.status(200).json(response);
}

export async function createCustomsDwellEstimate(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = CreateCustomsDwellEstimateSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const createResult = await commerceFreightRatesService.createCustomsDwellEstimate(req.user.id, {
    destinationCountryCode: parsed.data.destinationCountryCode,
    originCountryCode: parsed.data.originCountryCode,
    commodityScopeCategoryId: parsed.data.commodityScopeCategoryId,
    clearanceDaysMin: parsed.data.clearanceDaysMin,
    clearanceDaysMax: parsed.data.clearanceDaysMax,
    source: parsed.data.source,
    validFrom: parseOptionalInstant(parsed.data.validFrom, new Date()),
    validUntil: parsed.data.validUntil === undefined ? null : new Date(parsed.data.validUntil),
  });

  if (!createResult.success) {
    respondCommerceFreightRateError(res, createResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 201,
    message: "Customs dwell estimate recorded successfully",
    data: createResult.value,
  };
  res.status(201).json(response);
}

export async function retireCustomsDwellEstimate(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const params = DwellEstimateIdParamsSchema.safeParse({
    dwellEstimateId: firstParam(req.params.dwellEstimateId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const parsed = UpdateCustomsDwellEstimateSchema.safeParse(optionalBody(req));
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const retireResult = await commerceFreightRatesService.retireCustomsDwellEstimate(
    req.user.id,
    params.data.dwellEstimateId,
    { validUntil: new Date(parsed.data.validUntil) },
  );

  if (!retireResult.success) {
    respondCommerceFreightRateError(res, retireResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Customs dwell estimate retired",
    data: { dwellEstimate: retireResult.value },
  };
  res.status(200).json(response);
}
