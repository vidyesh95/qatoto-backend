import type { Request, Response } from "express";

import { AcceptTermsBodySchema } from "#src/modules/auth/terms/terms-acceptance.schemas.js";
import { acceptCurrentTerms } from "#src/modules/auth/terms/terms-acceptance.service.js";
import { respondValidationFailed } from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * POST /users/me/terms-acceptance — the in-app banner's Accept.
 *
 * 200 whether this recorded a new acceptance or found the existing one for this version: the
 * client's next state is the same either way, and the body says which version is on record.
 */
export async function acceptTerms(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      status: "error",
      statusCode: 401,
      message: "Please sign in.",
    } satisfies ApiResponse);
    return;
  }

  const body = AcceptTermsBodySchema.safeParse(req.body);
  if (!body.success) {
    respondValidationFailed(res, body.error);
    return;
  }

  const result = await acceptCurrentTerms(req.user.id, body.data.acceptedTermsVersion);
  if (!result.success) {
    res.status(409).json({
      status: "error",
      statusCode: 409,
      message:
        "The Terms have been updated since this page loaded. Reload, read the current Terms and accept again.",
      data: { currentTermsVersion: result.error.currentVersion },
    } satisfies ApiResponse);
    return;
  }

  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "Terms accepted.",
    data: result.value,
  } satisfies ApiResponse);
}
