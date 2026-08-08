import type { Request, Response } from "express";
import { z } from "zod";

import * as commerceSettlementService from "#src/services/commerce-settlement.service.js";
import type {
  CommerceSettlementError,
  SettlementActorContext,
} from "#src/services/commerce-settlement.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * HTTP mapping for negotiated settlement agreements (STORE Phase 14).
 *
 * No domain decision lives here. In particular the PROPOSER is taken from the authenticated
 * organization context and is deliberately absent from every schema below — a body naming
 * its own proposer would let one party fabricate an offer in the other's name, which is
 * exactly what §0 says a hostile client will try.
 */

const EmptyObjectSchema = z.object({}).strict();

const IdentifierSchema = z.string().trim().min(1).max(200);

const ThreadIdParamsSchema = z.object({ threadId: IdentifierSchema }).strict();
const AgreementIdParamsSchema = z.object({ agreementId: IdentifierSchema }).strict();

const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "Currency must be an ISO-4217 alpha-3 code");

/**
 * A milestone plan is capped at twenty. An escrow with a hundred tranches is not a payment
 * schedule anyone administers; it is a way to make a release queue unreviewable.
 */
const MilestoneSchema = z
  .object({
    sequence: z.number().int().positive().max(20),
    milestoneKind: z.enum(["deposit", "shipment", "inspection", "delivery", "final"]),
    amountInCents: z.number().int().positive(),
    releaseConditionNote: z.string().trim().min(1).max(2000).nullable().default(null),
  })
  .strict();

const ProposeAgreementBodySchema = z
  .object({
    buyerOrganizationId: IdentifierSchema,
    sellerOrganizationId: IdentifierSchema,
    externalProviderId: IdentifierSchema,
    escrowFeeBearer: z.enum(["buyer", "seller", "split"]),
    currency: CurrencySchema,
    totalInCents: z.number().int().positive(),
    expiresAt: z.coerce.date(),
    milestones: z.array(MilestoneSchema).min(1).max(20),
  })
  .strict();

const RespondBodySchema = z
  .object({ response: z.enum(["accept", "decline", "withdraw"]) })
  .strict();

const EligibleProvidersQuerySchema = z
  .object({
    buyerCountryCode: z.string().trim().regex(/^[A-Z]{2}$/),
    sellerCountryCode: z.string().trim().regex(/^[A-Z]{2}$/),
    currency: CurrencySchema,
    totalInCents: z.coerce.number().int().positive(),
  })
  .strict();

function sendZodError(res: Response, error: z.ZodError): void {
  res.status(422).json({
    status: "error",
    statusCode: 422,
    message: "Validation failed.",
    data: error.flatten().fieldErrors,
  } satisfies ApiResponse);
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    sendZodError(res, parsed.error);
    return false;
  }
  return true;
}

function requireSettlementActor(req: Request, res: Response): SettlementActorContext | null {
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
    actorUserId: req.user.id,
  };
}

/**
 * One place maps domain failures to status codes, exhaustively.
 *
 * NOT_FOUND covers both "no such agreement" and "not your agreement" — a distinguishable
 * 403 would confirm that an agreement with this id exists between two organizations, which
 * is the participant enumeration §11 forbids.
 */
function sendSettlementError(res: Response, error: CommerceSettlementError): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "Settlement agreement not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "Your organization cannot act on this agreement.",
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    case "PROVIDER_INELIGIBLE":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That escrow provider cannot serve this trade.",
        data: { reason: error.reason },
      } satisfies ApiResponse);
      return;
    case "AGREEMENT_NOT_OPEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This proposal is no longer open.",
        data: { state: error.state },
      } satisfies ApiResponse);
      return;
    case "SELF_ACCEPTANCE_FORBIDDEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "The counterparty must accept a proposal; a proposer cannot accept its own.",
      } satisfies ApiResponse);
      return;
    case "AGREEMENT_EXPIRED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This proposal expired.",
        data: { expiredAt: error.expiredAt.toISOString() },
      } satisfies ApiResponse);
      return;
    case "CONFLICT":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: error.message,
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveError: never = error;
      throw new Error(`Unhandled settlement error: ${JSON.stringify(exhaustiveError)}`);
    }
  }
}

export async function listEligibleEscrowProviders(req: Request, res: Response): Promise<void> {
  const actor = requireSettlementActor(req, res);
  if (!actor) return;

  const parsedQuery = EligibleProvidersQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    sendZodError(res, parsedQuery.error);
    return;
  }

  const providers = await commerceSettlementService.listEligibleProviders(parsedQuery.data);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Eligible escrow providers.",
    data: {
      items: providers.map((provider) => ({
        id: provider.id,
        slug: provider.providerSlug,
        displayName: provider.displayName,
      })),
      /**
       * Stated on the wire, every time. A client rendering this list must be able to say
       * that Qatoto is not the holder and that choosing nothing is a real choice, not a
       * failure to configure something.
       */
      settlementNotice: "qatoto_does_not_hold_funds",
    },
  } satisfies ApiResponse);
}

export async function proposeAgreement(req: Request, res: Response): Promise<void> {
  const actor = requireSettlementActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const parsedParams = ThreadIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    sendZodError(res, parsedParams.error);
    return;
  }
  const parsedBody = ProposeAgreementBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendZodError(res, parsedBody.error);
    return;
  }

  const proposed = await commerceSettlementService.proposeSettlementAgreement(actor, {
    threadId: parsedParams.data.threadId,
    ...parsedBody.data,
  });
  if (!proposed.success) {
    sendSettlementError(res, proposed.error);
    return;
  }

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Settlement proposed.",
    data: proposed.value,
  } satisfies ApiResponse);
}

export async function respondToAgreement(req: Request, res: Response): Promise<void> {
  const actor = requireSettlementActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const parsedParams = AgreementIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    sendZodError(res, parsedParams.error);
    return;
  }
  const parsedBody = RespondBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendZodError(res, parsedBody.error);
    return;
  }

  const responded = await commerceSettlementService.respondToSettlementAgreement(
    actor,
    parsedParams.data.agreementId,
    parsedBody.data.response,
  );
  if (!responded.success) {
    sendSettlementError(res, responded.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Settlement proposal updated.",
    data: responded.value,
  } satisfies ApiResponse);
}

export async function listThreadAgreements(req: Request, res: Response): Promise<void> {
  const actor = requireSettlementActor(req, res);
  if (!actor) return;
  if (!parseNoQuery(req, res)) return;

  const parsedParams = ThreadIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    sendZodError(res, parsedParams.error);
    return;
  }

  const listed = await commerceSettlementService.listThreadSettlementAgreements(
    actor,
    parsedParams.data.threadId,
  );
  if (!listed.success) {
    sendSettlementError(res, listed.error);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Settlement agreements.",
    data: { items: listed.value },
  } satisfies ApiResponse);
}
