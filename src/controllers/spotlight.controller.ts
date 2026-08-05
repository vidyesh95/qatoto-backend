import type { Request, Response } from "express";
import { z } from "zod";

import {
  respondSpotlightError,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/spotlight-error-response.js";
import * as spotlightService from "#src/services/spotlight.service.js";
import { MAX_SPOTLIGHT_SLOTS } from "#src/services/spotlight.service.js";
import type { ApiResponse } from "#src/types/index.js";

/**
 * The home-page Spotlight rail — up to three admin-picked catalogue videos.
 *
 * ONE PUBLIC READ AND TWO ADMIN ROUTES. The public read takes no session. Admin routes
 * are gated by `manage_promotions` inside the service, before any id is read.
 */

/**
 * The whole ordered set. Empty clears the rail. Max three; uniqueness is enforced in the
 * service so the Zod message stays about shape, not catalogue membership.
 */
export const ReplaceSpotlightSlotsSchema = z
  .object({
    videoIds: z.array(z.string().min(1).max(64)).max(MAX_SPOTLIGHT_SLOTS),
  })
  .strict();

/** `GET /spotlight/videos` — PUBLIC. Live, eligible slots only, already ordered. */
export async function listActiveSpotlightVideos(_req: Request, res: Response): Promise<void> {
  const videos = await spotlightService.listActiveSpotlightVideos();

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Spotlight videos retrieved successfully",
    data: { videos },
  };
  res.status(200).json(response);
}

/** `GET /spotlight/admin/slots` — every stored slot. */
export async function listSpotlightSlotsForStaff(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const listResult = await spotlightService.listSpotlightSlotsForStaff(req.user.id);
  if (!listResult.success) {
    respondSpotlightError(res, listResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Spotlight slots retrieved successfully",
    data: { slots: listResult.value },
  };
  res.status(200).json(response);
}

/** `PUT /spotlight/admin/slots` — replace the whole ordered set. */
export async function replaceSpotlightSlots(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    respondUnauthenticated(res);
    return;
  }

  const parsed = ReplaceSpotlightSlotsSchema.safeParse(req.body);
  if (!parsed.success) {
    respondValidationFailed(res, parsed.error);
    return;
  }

  const replaceResult = await spotlightService.replaceSpotlightSlots(
    req.user.id,
    parsed.data.videoIds,
  );
  if (!replaceResult.success) {
    respondSpotlightError(res, replaceResult.error);
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Spotlight slots replaced successfully",
    data: { slots: replaceResult.value },
  };
  res.status(200).json(response);
}
