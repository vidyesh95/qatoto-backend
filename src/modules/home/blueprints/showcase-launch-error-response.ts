import type { Response } from "express";

import type { ExternalUrlError } from "#src/lib/external-url.js";
import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { ShowcaseLaunchModerationError } from "#src/modules/home/blueprints/showcase-launch-moderation.service.js";
import type {
  ShowcaseLaunchSubmitError,
  ShowcaseWriteUpImageError,
} from "#src/modules/home/blueprints/showcase-launch.service.js";

/**
 * Error mapping for showcase launches — posting, write-up images, and moderation.
 *
 * A SEPARATE FILE FROM `blueprint-error-response.ts`, whose 403 says "requires the admin role":
 * the hero carousel is gated on `manage_promotions`, and this surface's staff gate is
 * `moderate_content`. One mapper would have to tell a moderator they need the wrong role.
 *
 * THE STATUS POLICY:
 *   403 — the capability refusal (decided before any id is read, so it probes nothing), and a
 *         moderator deciding their own launch.
 *   404 — no launch with that id, reached only by a caller who already holds the capability.
 *   409 — a conflict with current state: the name is taken (carries `errors.title`), the launch is
 *         already decided, or the maker has too many unused uploads. The frontend tells the first
 *         apart from the idempotency middleware's bare 409 BY THAT KEY, so it is load-bearing.
 *   422 — the request itself is wrong, every one keyed to the field that is wrong.
 *   502 / 503 — Cloudinary failed / is not configured.
 *
 * NO MESSAGE ECHOES A URL THE MAKER SENT. A refused image address is told as "an image in the
 * write-up", not repeated back — a value from the request is not something to reflect.
 */

/** The field a refused image is reported under — the part name of the route that carried it. */
export type ShowcaseImageFieldKey = "headingImage" | "image";

export type ShowcaseLaunchError =
  | ShowcaseLaunchSubmitError
  | ShowcaseWriteUpImageError
  | ShowcaseLaunchModerationError;

export {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";

const CALL_TO_ACTION_REJECTION_MESSAGES: Readonly<Record<ExternalUrlError["type"], string>> = {
  EXTERNAL_URL_EMPTY: "Give the link an address, or remove the link.",
  EXTERNAL_URL_TOO_LONG: "That link is too long.",
  EXTERNAL_URL_HAS_ILLEGAL_CHARACTERS: "A link cannot contain spaces or control characters.",
  EXTERNAL_URL_UNPARSEABLE: "That is not a valid web address.",
  EXTERNAL_URL_NOT_HTTPS: "The link must start with https://.",
  EXTERNAL_URL_HOST_INVALID: "That web address has no valid domain.",
  EXTERNAL_URL_HAS_CREDENTIALS: "Remove the username and password from that web address.",
};

function imageRefusal(
  imageFieldKey: ShowcaseImageFieldKey,
  message: string,
): {
  readonly statusCode: 422;
  readonly message: string;
  readonly errors: Readonly<Record<string, readonly string[]>>;
} {
  return { statusCode: 422, message, errors: { [imageFieldKey]: [message] } };
}

export function mapShowcaseLaunchErrorToResponse(
  error: ShowcaseLaunchError,
  imageFieldKey: ShowcaseImageFieldKey,
): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403
    case "PLATFORM_CAPABILITY_REQUIRED":
      return { statusCode: 403, message: "Reviewing launches requires the moderator role." };
    case "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN":
      return {
        statusCode: 403,
        message: "You posted this launch, so another moderator has to decide it.",
      };

    // --- 404
    case "SHOWCASE_LAUNCH_NOT_FOUND":
      return { statusCode: 404, message: "Launch not found." };

    // --- 409
    case "SHOWCASE_LAUNCH_TITLE_TAKEN": {
      const message =
        "A launch with this name is already posted or in review. Choose a different name.";
      return { statusCode: 409, message, errors: { title: [message] } };
    }
    case "SHOWCASE_LAUNCH_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message:
          error.moderationState === "published"
            ? "This launch was already published. Refresh the queue."
            : "This launch was already decided. Refresh the queue.",
      };
    case "SHOWCASE_WRITE_UP_IMAGE_STAGING_LIMIT_REACHED":
      return {
        statusCode: 409,
        message: `You have ${String(error.limit)} uploaded images no launch uses yet. Post your launch, or wait a day for unused uploads to clear.`,
      };

    // --- 422, each keyed to its field.
    case "SHOWCASE_LAUNCH_LINK_INVALID": {
      const message = CALL_TO_ACTION_REJECTION_MESSAGES[error.reason.type];
      return { statusCode: 422, message, errors: { callToAction: [message] } };
    }
    case "SHOWCASE_LAUNCH_DATE_IN_FUTURE": {
      const message = "A launch date can't be in the future. Pick the day it went out.";
      return { statusCode: 422, message, errors: { launchedAt: [message] } };
    }
    case "SHOWCASE_LAUNCH_WRITE_UP_TOO_MANY_IMAGES": {
      const message = `A write-up can hold at most ${String(error.limit)} images.`;
      return { statusCode: 422, message, errors: { writeUp: [message] } };
    }
    case "SHOWCASE_LAUNCH_WRITE_UP_IMAGE_NOT_AVAILABLE": {
      const message =
        "An image in the write-up is not one you uploaded here. Add images with Add an image, remove any from other sites, and upload again anything older than a day.";
      return { statusCode: 422, message, errors: { writeUp: [message] } };
    }
    case "SHOWCASE_HEADING_IMAGE_NOT_SQUARE":
      return imageRefusal(
        imageFieldKey,
        `The heading image must be square (received ${String(error.width)}x${String(error.height)}).`,
      );
    case "SHOWCASE_HEADING_IMAGE_TOO_SMALL":
      return imageRefusal(
        imageFieldKey,
        `The heading image must be at least ${String(error.minimum)}x${String(error.minimum)} pixels (received ${String(error.width)}x${String(error.height)}).`,
      );
    case "NOT_AN_IMAGE":
      return imageRefusal(imageFieldKey, "The uploaded file is not a valid image.");
    case "UNSUPPORTED_FORMAT":
      return imageRefusal(imageFieldKey, describeUnsupportedImageFormat(error.detected));
    case "DIMENSIONS_TOO_SMALL":
      return imageRefusal(
        imageFieldKey,
        `Image must be at least 64x64 pixels (received ${String(error.width)}x${String(error.height)}).`,
      );
    case "DIMENSIONS_TOO_LARGE":
      return imageRefusal(
        imageFieldKey,
        `Image dimensions are too large (received ${String(error.width)}x${String(error.height)}).`,
      );

    // --- Storage.
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Image uploads are not configured on this server." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Could not store the image. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Could not remove a stored image. Please try again." };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled showcase launch error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondShowcaseLaunchError(
  res: Response,
  error: ShowcaseLaunchError,
  imageFieldKey: ShowcaseImageFieldKey = "headingImage",
): void {
  const { statusCode, message, errors } = mapShowcaseLaunchErrorToResponse(error, imageFieldKey);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
