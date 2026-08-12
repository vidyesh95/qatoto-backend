import type { Request, Response } from "express";

import {
  AvailabilityQuerySchema,
  UpdateMyHandleSchema,
} from "#src/modules/auth/handles/handle.schemas.js";
import * as handleService from "#src/modules/auth/handles/handle.service.js";
import {
  respondFieldRefusal,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * Human date like "Jul 9" for the rate-limit message. Stable UTC formatting so
 * the wording matches the `cooldownResetAt` instant the client also receives.
 */
function formatResetDate(resetAt: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(resetAt);
}

/**
 * GET /users/me/handle
 * Panel bootstrap: current handle plus rate-limit and revert metadata. The id is
 * taken from the session (req.user), never the body (CLAUDE.md §1.1).
 */
export async function getMyHandle(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
    return;
  }

  const metadataResult = await handleService.getHandleMetadata(req.user.id);

  if (!metadataResult.success) {
    switch (metadataResult.error.type) {
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = metadataResult.error.type;
        throw new Error(`Unhandled handle metadata error: ${String(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse<handleService.HandleMetadata> = {
    status: "success",
    statusCode: 200,
    message: "Handle metadata retrieved successfully",
    data: metadataResult.value,
  };
  res.status(200).json(response);
}

/**
 * GET /handles/availability?handle=<raw>
 * Tier-1 live availability probe. Read-only and rate-limited at the route. The
 * result is a discriminated `data.status` (available | taken | revertable |
 * current | invalid); invalid input is a normal 200 preview, not a 4xx. The id
 * comes from the session so the caller's own current/revertable handle is
 * distinguished from a stranger's taken one.
 */
export async function getHandleAvailability(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
    return;
  }

  const parsedQuery = AvailabilityQuerySchema.safeParse(req.query);

  if (!parsedQuery.success) {
    respondValidationFailed(res, parsedQuery.error);
    return;
  }

  const availability = await handleService.checkHandleAvailability(
    parsedQuery.data.handle,
    req.user.id,
  );

  const response: ApiResponse<handleService.HandleAvailability> = {
    status: "success",
    statusCode: 200,
    message: "Handle availability checked successfully",
    data: availability,
  };
  res.status(200).json(response);
}

/**
 * PATCH /users/me/handle
 * Tier-2 authoritative set/revert (the trust boundary). The body's handle is
 * re-normalized, regex-validated, rate-limited, and availability-re-checked
 * inside an atomic transaction; Case 1 vs Case 2 is decided server-side from
 * ownership. The id is taken from the session, never the body (CLAUDE.md §1.1).
 */
export async function updateMyHandle(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ status: "error", statusCode: 401, message: "Please sign in." });
    return;
  }

  const parsedBody = UpdateMyHandleSchema.safeParse(req.body);

  if (!parsedBody.success) {
    respondValidationFailed(res, parsedBody.error);
    return;
  }

  const setResult = await handleService.setHandle(req.user.id, parsedBody.data.handle);

  if (!setResult.success) {
    switch (setResult.error.type) {
      case "INVALID":
        // The service's reasons are already user-facing sentences ("Handle must be 3–30
        // characters."), so this promotes rather than rewords.
        respondFieldRefusal(res, "handle", setResult.error.reason);
        return;
      case "TAKEN":
        respondFieldRefusal(res, "handle", "Handle is already taken.");
        return;
      case "RATE_LIMITED": {
        const resetAt = setResult.error.cooldownResetAt;
        res.status(429).json({
          status: "error",
          statusCode: 429,
          message: `You've used all ${handleService.MAX_HANDLE_CHANGES_PER_WINDOW} changes. Try again after ${formatResetDate(resetAt)}.`,
          data: { cooldownResetAt: resetAt },
        });
        return;
      }
      case "USER_NOT_FOUND":
        res.status(404).json({
          status: "error",
          statusCode: 404,
          message: "Your account no longer exists.",
        });
        return;
      default: {
        const exhaustiveCheck: never = setResult.error;
        throw new Error(`Unhandled set handle error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  const response: ApiResponse<handleService.SetHandleSuccess> = {
    status: "success",
    statusCode: 200,
    message: "Handle updated successfully",
    data: setResult.value,
  };
  res.status(200).json(response);
}
