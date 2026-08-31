import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { CommerceOrganizationMemberRole } from "#src/modules/store/organizations/commerce-organization-access.service.js";
import {
  AcceptQuoteSchema,
  AppendQuoteRevisionSchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  ListProviderQuotesQuerySchema,
  ListSourcingQuoteLinesQuerySchema,
  QuoteIdParamsSchema,
  QuoteRevisionParamsSchema,
  RfqIdParamsSchema,
} from "#src/modules/store/procurement/commerce-quotes.schemas.js";
import * as commerceQuotesService from "#src/modules/store/procurement/commerce-quotes.service.js";
import type { CommerceQuotesError } from "#src/modules/store/procurement/commerce-quotes.service.js";
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

function mapQuotesError(res: Response, error: CommerceQuotesError): void {
  switch (error.type) {
    case "NOT_FOUND":
    case "FORBIDDEN":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Not found.",
      } satisfies ApiResponse);
      return;
    case "ORGANIZATION_NOT_ACTIVE":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Commerce organization is not active for trade.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "QUOTE_EXPIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Quote revision has expired.",
        data: { expiredAt: error.expiredAt.toISOString() },
      } satisfies ApiResponse);
      return;
    case "REVISION_CHANGED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Quote revision changed.",
        data: { currentRevision: error.currentRevision },
      } satisfies ApiResponse);
      return;
    case "RFQ_NOT_OPEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "RFQ is not open for this action.",
      } satisfies ApiResponse);
      return;
    case "CONFLICTING_ACCEPTANCE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Another quote was already accepted for this RFQ.",
        data: { orderId: error.orderId },
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This action conflicts with the current quote state.",
      } satisfies ApiResponse);
      return;
    case "INSUFFICIENT_STOCK":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "Insufficient stock to accept this quote.",
        data: {
          productId: error.productId,
          availableQuantity: error.availableQuantity,
        },
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    /**
     * STORE Phase 14. 409 rather than 422: the request was well-formed and was true when
     * the buyer made it — the agreed escrow terms lapsed underneath it. Nothing was
     * accepted, so the quote is still there to accept once the terms are re-agreed.
     */
    case "SETTLEMENT_UNAVAILABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "The agreed escrow terms are no longer usable, so the quote was not accepted and no order exists.",
        data: { reason: error.reason },
      } satisfies ApiResponse);
      return;
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    // 422 naming the field, not 404: the caller sent ids in a body we are refusing, and the
    // message must not say WHICH id failed or why — see the error's own note on the collapse.
    case "DOCUMENT_NOT_OWNED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          "Every attached document must be one your organization uploaded and finished processing.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce quotes error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function createQuoteShell(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = RfqIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.createQuoteShell(actor, params.data.rfqId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote shell created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function appendRevision(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AppendQuoteRevisionSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.appendRevision(actor, params.data.quoteId, body.data);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote revision appended.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function submitRevision(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteRevisionParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.submitRevision(
    actor,
    params.data.quoteId,
    params.data.revision,
  );
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote revision submitted.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * `DELETE /commerce/quotes/:quoteId/revisions/:revision` — discards an unsubmitted revision.
 *
 * **IT DOES NOT READ `req.body`, AND THAT IS LOAD-BEARING RATHER THAN AN OMISSION.** Unlike
 * `submitRevision` above, there is no `EmptyRequestBodySchema.safeParse` here and no `compactBody`
 * on the route. `json-body-budget.test.ts` walks the built app and fails the build in BOTH
 * directions — a body-reading route with no declared cap, and a declared cap on a route that reads
 * no body — so these two decisions have to agree. `detachReviewMedia` is the precedent.
 *
 * Answers `200` with the updated quote shell rather than `204`, so the caller can see the rolled-back
 * `latestRevisionNumber` without a second read. Same choice `detachReviewMedia` makes in returning
 * the surviving count.
 */
export async function abandonRevision(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteRevisionParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceQuotesService.abandonRevision(
    actor,
    params.data.quoteId,
    params.data.revision,
  );
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote revision discarded.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * GET /commerce/provider/quotes — a provider's own bids, across every RFQ (Appendix A38).
 *
 * The twin of `GET /commerce/provider/rfqs`, which lists the WORK. An RFQ leaves that queue
 * when it closes and takes any quote on it out of reach, so before this the only way to
 * enumerate one's own bids was to fan out per RFQ from the browser.
 */
export async function listProviderQuotes(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListProviderQuotesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceQuotesService.listProviderQuotes(actor, {
    status: query.data.status,
    cursor: query.data.cursor,
    limit: query.data.limit,
  });
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider quotes listed.",
    data: result.value,
  } satisfies ApiResponse);
}

/**
 * `GET /commerce/sourcing/quote-lines` — the caller's accepted quote product lines.
 *
 * Named for what it is FOR rather than where it comes from: a seller reaches this while writing a
 * listing, not while reading a quote. It sits on the quotes router because that is the data it
 * reads.
 */
export async function listSourcingQuoteLines(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;

  const query = ListSourcingQuoteLinesQuerySchema.safeParse(req.query);
  if (!query.success) {
    sendZodError(res, query.error);
    return;
  }

  const result = await commerceQuotesService.listSourcingQuoteLines(actor, {
    cursor: query.data.cursor,
    limit: query.data.limit,
  });
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Sourcing quote lines listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function listQuotesForRfq(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = RfqIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceQuotesService.listQuotesForRfq(actor, params.data.rfqId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quotes listed.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function getQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }

  const result = await commerceQuotesService.getQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote retrieved.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function acceptQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = AcceptQuoteSchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.acceptQuote(
    actor,
    params.data.quoteId,
    body.data.expectedRevision,
    body.data.settlementAgreementId ?? null,
  );
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Quote accepted and order created.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function declineQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.declineQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote declined.",
    data: result.value,
  } satisfies ApiResponse);
}

export async function withdrawQuote(req: Request, res: Response): Promise<void> {
  const actor = requireCommerceActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const params = QuoteIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    sendZodError(res, params.error);
    return;
  }
  const body = EmptyRequestBodySchema.safeParse(req.body);
  if (!body.success) {
    sendZodError(res, body.error);
    return;
  }

  const result = await commerceQuotesService.withdrawQuote(actor, params.data.quoteId);
  if (!result.success) {
    mapQuotesError(res, result.error);
    return;
  }
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Quote withdrawn.",
    data: result.value,
  } satisfies ApiResponse);
}
