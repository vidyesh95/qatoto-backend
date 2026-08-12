import type { Request, Response } from "express";

import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import { SellerEarningsQuerySchema } from "#src/modules/store/orders/commerce-earnings.schemas.js";
import * as commerceEarningsService from "#src/modules/store/orders/commerce-earnings.service.js";
import type { CommerceEarningsError } from "#src/modules/store/orders/commerce-earnings.service.js";
import type { ApiResponse } from "#src/types/index.js";

function mapEarningsError(res: Response, error: CommerceEarningsError): void {
  switch (error.type) {
    case "INVALID_WINDOW":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: error.message,
      } satisfies ApiResponse);
      return;
    default: {
      const exhaustiveCheck: never = error.type;
      throw new Error(`Unhandled commerce earnings error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * GET /commerce/provider/earnings
 *
 * The seller is `req.commerceOrganization`, never a query parameter — see the schema.
 */
export async function getSellerEarnings(req: Request, res: Response): Promise<void> {
  if (!req.user || !req.commerceOrganization) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const query = SellerEarningsQuerySchema.safeParse(req.query);
  if (!query.success) {
    respondValidationFailed(res, query.error);
    return;
  }

  const result = await commerceEarningsService.getSellerEarnings(
    { organizationId: req.commerceOrganization.organizationId },
    { from: query.data.from, to: query.data.to },
  );
  if (!result.success) {
    mapEarningsError(res, result.error);
    return;
  }

  /**
   * `no-store`. This is one organization's revenue, and it is the kind of thing that must not
   * sit in a shared proxy cache or survive on disk after the tab closes — the same call the
   * delivery-address reveal makes, for the same reason.
   */
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Seller earnings loaded.",
    data: result.value,
  } satisfies ApiResponse);
}
