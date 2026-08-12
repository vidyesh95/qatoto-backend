import type { Response } from "express";

import type { SpotlightError } from "#src/modules/home/spotlight/spotlight.service.js";
import { MAX_SPOTLIGHT_SLOTS } from "#src/modules/home/spotlight/spotlight.service.js";

/**
 * Error mapping for the Spotlight controller.
 *
 * STATUS POLICY (same as promotions):
 *   403 — ONLY the platform-capability refusal, decided BEFORE any id is read.
 *   422 — duplicate ids, ineligible videos, more than three slots.
 *
 * There is no 404 on this surface: the only write replaces the whole set and never looks
 * up a slot by id.
 */

export {
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

export function mapSpotlightErrorToResponse(error: SpotlightError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "Managing the home Spotlight requires the admin role.",
      };

    case "SPOTLIGHT_VIDEO_NOT_ELIGIBLE":
      return {
        statusCode: 422,
        message: "That video cannot be placed on Spotlight.",
        errors: {
          videoIds: [
            `Video ${error.videoId} is not a published, verified, publicly listable catalogue video.`,
          ],
        },
      };

    case "SPOTLIGHT_DUPLICATE_VIDEO":
      return {
        statusCode: 422,
        message: "The same video cannot fill two Spotlight slots.",
        errors: {
          videoIds: [`Video ${error.videoId} appears more than once.`],
        },
      };

    case "SPOTLIGHT_TOO_MANY_SLOTS":
      return {
        statusCode: 422,
        message: `Spotlight holds at most ${String(error.limit)} videos.`,
        errors: {
          videoIds: [`Send at most ${String(MAX_SPOTLIGHT_SLOTS)} video ids.`],
        },
      };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled spotlight error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondSpotlightError(res: Response, error: SpotlightError): void {
  const { statusCode, message, errors } = mapSpotlightErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
