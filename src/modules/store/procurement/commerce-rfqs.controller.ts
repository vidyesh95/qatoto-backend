import type { Request, Response } from "express";
import { z } from "zod";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import {
  CreateDraftRfqSchema,
  EmptyObjectSchema,
  EmptyRequestBodySchema,
  InviteProvidersSchema,
  ListQuerySchema,
  RfqIdParamsSchema,
  UpdateDraftRfqSchema,
} from "#src/modules/store/procurement/commerce-rfqs.schemas.js";
import * as commerceRfqsService from "#src/modules/store/procurement/commerce-rfqs.service.js";
import type { CommerceRfqsError } from "#src/modules/store/procurement/commerce-rfqs.service.js";
import type { ApiResponse } from "#src/types/index.js";

function validationError(res: Response, error: z.ZodError): void {
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

function respondRfqError(
  res: Response,
  error: CommerceRfqsError,
  options?: { prefer404?: boolean },
): void {
  switch (error.type) {
    case "NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "RFQ not found.",
      } satisfies ApiResponse);
      return;
    case "FORBIDDEN":
      if (options?.prefer404 === true) {
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "RFQ not found.",
        } satisfies ApiResponse);
        return;
      }
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "This RFQ action is not permitted.",
      } satisfies ApiResponse);
      return;
    case "ORGANIZATION_NOT_ACTIVE":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "The commerce organization is not active for trade.",
      } satisfies ApiResponse);
      return;
    case "INVALID_STATE":
    case "CONFLICT":
    case "PROVIDER_INELIGIBLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          error.type === "PROVIDER_INELIGIBLE"
            ? "One or more providers are not eligible for invitation."
            : error.type === "INVALID_STATE"
              ? (error.message ?? "RFQ state does not allow this action.")
              : error.message,
      } satisfies ApiResponse);
      return;
    case "VALIDATION_FAILED":
    case "DEADLINE_INVALID":
    case "LINES_REQUIRED":
    case "DOCUMENT_NOT_OWNED":
    case "ADDRESS_NOT_OWNED":
    case "INVALID_CURSOR":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message:
          error.type === "VALIDATION_FAILED"
            ? error.message
            : error.type === "DEADLINE_INVALID"
              ? "RFQ response deadline must be in the future."
              : error.type === "LINES_REQUIRED"
                ? "RFQ requires at least one product or service line."
                : error.type === "DOCUMENT_NOT_OWNED"
                  ? "One or more documents are not owned by the buyer organization."
                  : error.type === "ADDRESS_NOT_OWNED"
                    ? "Destination address is not owned by the buyer organization."
                    : "Invalid cursor.",
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce RFQ error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function requireBuyerCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return null;
  }
  /**
   * §14. Drafting routes arrive with a possibly-`pending` `buyerCommerceWorkspace`;
   * `/open`, `/invitations` and `/close` keep the active guard and arrive with
   * `commerceOrganization`. Both share this context, and WHICH ONE A ROUTE GETS IS THE
   * ROUTER'S DECISION — the broadcast gate is the middleware on those three routes, not a
   * branch in here.
   */
  const buyerActor = req.commerceOrganization ?? req.buyerCommerceWorkspace;
  if (!buyerActor) {
    res.status(403).json({
      status: "error",
      statusCode: 403,
      message: "An active buyer organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    actorUserId: req.user.id,
    buyerOrganizationId: buyerActor.organizationId,
    memberId: buyerActor.memberId,
    memberRole: buyerActor.memberRole,
  };
}

function requireActiveCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
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
    actorUserId: req.user.id,
    organizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function requireProviderCommerceContext(req: Request, res: Response) {
  if (!req.user || !req.authSession) {
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
      message: "An active provider organization membership is required.",
    } satisfies ApiResponse);
    return null;
  }
  return {
    actorUserId: req.user.id,
    providerOrganizationId: req.commerceOrganization.organizationId,
    memberId: req.commerceOrganization.memberId,
    memberRole: req.commerceOrganization.memberRole,
  };
}

function parseRfqId(req: Request, res: Response): string | null {
  const parsed = RfqIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data.rfqId;
}

function parseNoQuery(req: Request, res: Response): boolean {
  const parsed = EmptyObjectSchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return false;
  }
  return true;
}

function parseListQuery(req: Request, res: Response): z.infer<typeof ListQuerySchema> | null {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}

export async function createDraftRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const parsedBody = CreateDraftRfqSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const created = await commerceRfqsService.createDraftRfq({
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    body: parsedBody.data,
  });
  if (!created.success) return respondRfqError(res, created.error);

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "RFQ draft created.",
    data: created.value,
  } satisfies ApiResponse);
}

export async function listMyRfqs(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const listed = await commerceRfqsService.listMyRfqs({
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    limit: listQuery.limit,
    cursor: listQuery.cursor,
  });
  if (!listed.success) return respondRfqError(res, listed.error);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Buyer RFQs loaded.",
    data: listed.value,
  } satisfies ApiResponse);
}

export async function getRfq(req: Request, res: Response): Promise<void> {
  const commerceContext = requireActiveCommerceContext(req, res);
  if (!commerceContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;

  const loaded = await commerceRfqsService.getRfq({
    rfqId,
    callerOrganizationId: commerceContext.organizationId,
  });
  if (!loaded.success) return respondRfqError(res, loaded.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ loaded.",
    data: loaded.value,
  } satisfies ApiResponse);
}

export async function updateDraftRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = UpdateDraftRfqSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const updated = await commerceRfqsService.updateDraftRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    patch: parsedBody.data,
  });
  if (!updated.success) return respondRfqError(res, updated.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ draft updated.",
    data: updated.value,
  } satisfies ApiResponse);
}

export async function openRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = EmptyRequestBodySchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const opened = await commerceRfqsService.openRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
  });
  if (!opened.success) return respondRfqError(res, opened.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ opened.",
    data: opened.value,
  } satisfies ApiResponse);
}

export async function inviteProviders(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = InviteProvidersSchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const invited = await commerceRfqsService.inviteProviders({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
    providerOrganizationIds: parsedBody.data.providerOrganizationIds,
  });
  if (!invited.success) return respondRfqError(res, invited.error, { prefer404: true });

  res.status(201).json({
    status: "success",
    statusCode: 201,
    message: "Providers invited.",
    data: invited.value,
  } satisfies ApiResponse);
}

export async function closeRfq(req: Request, res: Response): Promise<void> {
  const buyerContext = requireBuyerCommerceContext(req, res);
  if (!buyerContext) return;
  if (!parseNoQuery(req, res)) return;
  const rfqId = parseRfqId(req, res);
  if (!rfqId) return;
  const parsedBody = EmptyRequestBodySchema.safeParse(req.body);
  if (!parsedBody.success) return validationError(res, parsedBody.error);

  const closed = await commerceRfqsService.closeRfq({
    rfqId,
    buyerOrganizationId: buyerContext.buyerOrganizationId,
    memberId: buyerContext.memberId,
    actorUserId: buyerContext.actorUserId,
    memberRole: buyerContext.memberRole,
  });
  if (!closed.success) return respondRfqError(res, closed.error, { prefer404: true });

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "RFQ closed.",
    data: closed.value,
  } satisfies ApiResponse);
}

export async function listProviderRfqs(req: Request, res: Response): Promise<void> {
  const providerContext = requireProviderCommerceContext(req, res);
  if (!providerContext) return;
  const listQuery = parseListQuery(req, res);
  if (!listQuery) return;

  const listed = await commerceRfqsService.listProviderRfqs({
    providerOrganizationId: providerContext.providerOrganizationId,
    limit: listQuery.limit,
    cursor: listQuery.cursor,
  });
  if (!listed.success) return respondRfqError(res, listed.error);

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Provider RFQs loaded.",
    data: listed.value,
  } satisfies ApiResponse);
}
