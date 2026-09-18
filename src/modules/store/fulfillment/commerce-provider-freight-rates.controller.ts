import type { Request, Response } from "express";

import { AppendFreightRateBreakSchema } from "#src/modules/store/fulfillment/commerce-freight-rates.schemas.js";
import {
  firstParam,
  optionalBody,
  respondCommerceProviderFreightRateError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/store/fulfillment/commerce-provider-freight-rates-error-response.js";
import {
  ListProviderFreightRateCardsQuerySchema,
  ProviderCreateFreightRateCardSchema,
  ProviderRateCardIdParamsSchema,
  ProviderReplaceFreightRateBreaksSchema,
  ProviderUpdateFreightRateCardSchema,
} from "#src/modules/store/fulfillment/commerce-provider-freight-rates.schemas.js";
import * as commerceProviderFreightRatesService from "#src/modules/store/fulfillment/commerce-provider-freight-rates.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * §19.12's parse-and-dispatch layer.
 *
 * NO APPROVAL CHECK HERE, and that is not an omission. The verified-kind-link assertion is the
 * first statement of every service function, before any id or filter value is read; a second
 * check in this file would be a second place to get the ordering wrong, and the ordering is
 * the whole security property (see the routes file's header).
 *
 * ⚠️ `providerOrganizationId` IS BUILT FROM `req.commerceOrganization` AND FROM NOTHING ELSE.
 * The schemas refuse the field in a body, and there is no code path in this file that would
 * read one. `requireActiveProviderCommerceOrganization` is what put the value on the request,
 * so a handler reached without it has no organization and answers 401 rather than guessing.
 *
 * ISO strings become `Date`s at this boundary and nowhere deeper.
 */

interface ProviderFreightActorContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly memberRole: NonNullable<Request["commerceOrganization"]>["memberRole"];
}

function requireProviderFreightActor(
  req: Request,
  res: Response,
): ProviderFreightActorContext | null {
  const user = req.user;
  const organization = req.commerceOrganization;
  if (!user || !organization) {
    respondUnauthenticated(res);
    return null;
  }
  return {
    userId: user.id,
    organizationId: organization.organizationId,
    memberRole: organization.memberRole,
  };
}

/**
 * `GET /commerce/provider/freight-rate-cards`.
 *
 * `safeParse(req.query)` AGAINST A `.strict()` SCHEMA, so an invented filter key is a 422 that
 * names it rather than a page silently unfiltered — including a `providerOrganizationId` the
 * composer might copy across from the staff console, which here would be a request to read
 * somebody else's lanes.
 *
 * `data` IS THE SERVICE VALUE VERBATIM — `{ items, page }` per §7.
 */
export async function listProviderFreightRateCards(req: Request, res: Response): Promise<void> {
  const actor = requireProviderFreightActor(req, res);
  if (!actor) return;

  const query = ListProviderFreightRateCardsQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const listResult = await commerceProviderFreightRatesService.listProviderFreightRateCards(
    actor,
    query.data,
  );
  if (!listResult.success) {
    respondCommerceProviderFreightRateError(res, listResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Your freight lane rate cards loaded",
    data: listResult.value,
  } satisfies ApiResponse);
}

export async function createProviderFreightRateCard(req: Request, res: Response): Promise<void> {
  const actor = requireProviderFreightActor(req, res);
  if (!actor) return;

  const body = ProviderCreateFreightRateCardSchema.safeParse(optionalBody(req));
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const createResult = await commerceProviderFreightRatesService.createProviderFreightRateCard(
    actor,
    {
      originCountryCode: body.data.originCountryCode,
      destinationCountryCode: body.data.destinationCountryCode,
      mode: body.data.mode,
      currency: body.data.currency,
      validFrom: new Date(body.data.validFrom),
      validUntil: body.data.validUntil === undefined ? null : new Date(body.data.validUntil),
      volumetricDivisorCm3PerKg: body.data.volumetricDivisorCm3PerKg,
      breaks: body.data.breaks,
    },
  );
  if (!createResult.success) {
    respondCommerceProviderFreightRateError(res, createResult.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Freight lane rate card published",
    data: createResult.value,
  } satisfies ApiResponse);
}

export async function updateProviderFreightRateCard(req: Request, res: Response): Promise<void> {
  const actor = requireProviderFreightActor(req, res);
  if (!actor) return;

  const params = ProviderRateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const body = ProviderUpdateFreightRateCardSchema.safeParse(optionalBody(req));
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const updateResult = await commerceProviderFreightRatesService.updateProviderFreightRateCard(
    actor,
    params.data.rateCardId,
    body.data.intent === "shorten_window"
      ? { intent: "shorten_window", validUntil: new Date(body.data.validUntil) }
      : { intent: "withdraw", reasonNote: body.data.reasonNote },
  );
  if (!updateResult.success) {
    respondCommerceProviderFreightRateError(res, updateResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message:
      body.data.intent === "shorten_window"
        ? "Rate card validity shortened"
        : "Rate card withdrawn",
    data: { rateCard: updateResult.value },
  } satisfies ApiResponse);
}

export async function appendProviderFreightRateBreak(req: Request, res: Response): Promise<void> {
  const actor = requireProviderFreightActor(req, res);
  if (!actor) return;

  const params = ProviderRateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  /**
   * THE BAND SHAPE IS THE STAFF SCHEMA'S, imported rather than restated. A band is a band; it
   * is the CARD's create body that differs between the two surfaces, not the ladder's rungs.
   */
  const body = AppendFreightRateBreakSchema.safeParse(optionalBody(req));
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const appendResult = await commerceProviderFreightRatesService.appendProviderFreightRateBreak(
    actor,
    params.data.rateCardId,
    body.data,
  );
  if (!appendResult.success) {
    respondCommerceProviderFreightRateError(res, appendResult.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Freight rate band added",
    data: { rateCard: appendResult.value },
  } satisfies ApiResponse);
}

export async function replaceProviderFreightRateBreaks(req: Request, res: Response): Promise<void> {
  const actor = requireProviderFreightActor(req, res);
  if (!actor) return;

  const params = ProviderRateCardIdParamsSchema.safeParse({
    rateCardId: firstParam(req.params.rateCardId ?? ""),
  });
  if (!params.success) {
    respondValidationFailed(res, params.error);
    return;
  }

  const body = ProviderReplaceFreightRateBreaksSchema.safeParse(optionalBody(req));
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const replaceResult = await commerceProviderFreightRatesService.replaceProviderFreightRateBreaks(
    actor,
    params.data.rateCardId,
    body.data,
  );
  if (!replaceResult.success) {
    respondCommerceProviderFreightRateError(res, replaceResult.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Freight rate bands replaced",
    data: { rateCard: replaceResult.value },
  } satisfies ApiResponse);
}
