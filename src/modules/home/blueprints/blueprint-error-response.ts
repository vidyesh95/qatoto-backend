import type { Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { BlueprintHeroSlideError } from "#src/modules/home/blueprints/blueprint-hero.service.js";
import type { PromotionalDestinationError } from "#src/modules/home/promotions/promotional-destination.js";

/**
 * Error mapping for the `/blueprints` controllers.
 *
 * THE STATUS POLICY, restated so this file stands alone:
 *   403 — ONLY the platform-capability refusal, and it is the whole gate for this domain.
 *         That does not break the 404-never-403 rule, it applies it: the refusal is decided
 *         BEFORE any id is read, so a caller without `manage_promotions` receives a
 *         byte-identical 403 for a real slide id and a garbage one.
 *   404 — the slide lookup. Reached only by a caller who ALREADY passed the capability
 *         check, so it discloses nothing to a stranger.
 *   422 — parse failures, the destination rule, and the schedule window.
 *   409 — the slide-count ceiling. A conflict with the current state, not a bad request:
 *         the same payload succeeds once a slide is deleted.
 *   502 — Cloudinary did not answer. Retrying may work.
 *   503 — this deployment has no Cloudinary credentials at all.
 *
 * THE PUBLIC SERIES READ HAS NO ENTRY HERE, on purpose. Its only failure is "no such
 * series", which the controller answers with a bare 404 — there is no domain error type to
 * map because a stranger asking for a series that is not public and a stranger asking for
 * one that does not exist must receive the same bytes.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

/**
 * Why one specific link was refused. Every message names the actual mistake — an admin who
 * typed `//partner.example` needs to be told it leaves the site, not that it is "invalid".
 *
 * The external-URL variants are unreachable on this surface (the parser is only ever called
 * with `internal_path`) but are still spelled out, because the record type is keyed by the
 * shared error union and a missing key is a compile error the day that union grows.
 */
const DESTINATION_REJECTION_MESSAGES: Readonly<
  Record<PromotionalDestinationError["type"], string>
> = {
  DESTINATION_EMPTY: "Enter the page this slide should link to, or leave it blank.",
  DESTINATION_TOO_LONG: "That link is too long.",
  DESTINATION_HAS_ILLEGAL_CHARACTERS: "A link cannot contain spaces or control characters.",
  INTERNAL_PATH_NOT_RELATIVE:
    'A slide links to a page on Qatoto, so it must start with "/", like "/blueprints/solar-cold-storage-controller-teardown".',
  INTERNAL_PATH_LEAVES_SITE:
    "That path leaves Qatoto. Use a single leading slash. The Blueprints hero cannot link off-site.",
  EXTERNAL_URL_UNPARSEABLE: "That is not a valid web address.",
  EXTERNAL_URL_NOT_HTTPS: "An external destination must use https://.",
  EXTERNAL_URL_HOST_INVALID: "That web address has no valid domain.",
  EXTERNAL_URL_HAS_CREDENTIALS: "Remove the username and password from that web address.",
};

/**
 * Maps a blueprint hero slide error to its HTTP shape. Does NOT touch `res` — a pure
 * function, so it is testable without a request, mirroring every other mapper here.
 */
export function mapBlueprintHeroSlideErrorToResponse(error: BlueprintHeroSlideError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403: the whole gate. Names no resource, so it cannot be used to probe an id.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "Managing the Blueprints hero carousel requires the admin role.",
      };

    // --- 404: reached only after the capability check has already passed.
    case "ANIME_HERO_SLIDE_NOT_FOUND":
      return { statusCode: 404, message: "Blueprint hero slide not found." };

    // --- 422: the request itself is wrong and the same payload will keep failing.
    case "ANIME_HERO_DESTINATION_INVALID":
      return {
        statusCode: 422,
        message: "That link cannot be used.",
        errors: { destinationPath: [DESTINATION_REJECTION_MESSAGES[error.reason.type]] },
      };
    case "ANIME_HERO_SLIDE_WINDOW_INVALID":
      return {
        statusCode: 422,
        message: "That schedule window is empty.",
        errors: { endsAt: ["The end must be after the start."] },
      };
    case "ANIME_HERO_SLIDE_ORDER_MISMATCH":
      // NOT merged with the 404 above, though both mean "an id you sent is not one I have":
      // a reorder sends the WHOLE set and the fix is to re-read the list, whereas a 404
      // names one path id. Collapsing them would tell an admin to reload when their reorder
      // was fine.
      return {
        statusCode: 422,
        message: "That order does not match the slides that exist.",
        errors: { slideIds: ["Send every existing slide id exactly once. Reload and try again."] },
      };

    // --- 409: a conflict with the CURRENT state; the same payload succeeds later.
    case "ANIME_HERO_SLIDE_LIMIT_REACHED":
      return {
        statusCode: 409,
        message: `The Blueprints hero holds at most ${String(error.limit)} slides. Delete one first.`,
      };

    // --- Image pipeline, rendered identically to the promotions and product mappers.
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "The uploaded file is not a valid image." };
    case "UNSUPPORTED_FORMAT":
      return { statusCode: 422, message: describeUnsupportedImageFormat(error.detected) };
    case "DIMENSIONS_TOO_SMALL":
      return {
        statusCode: 422,
        message: `Image must be at least 64x64 pixels (received ${error.width}x${error.height}).`,
      };
    case "DIMENSIONS_TOO_LARGE":
      return {
        statusCode: 422,
        message: `Image dimensions are too large (received ${error.width}x${error.height}).`,
      };

    // --- Storage. 503 is "this deployment has no credentials", 502 is "the call failed".
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Image uploads are not configured on this server." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Could not store the image. Please try again." };
    case "DELETE_FAILED":
      return {
        statusCode: 502,
        message: "Could not remove the stored image, so the slide was kept. Please try again.",
      };

    default: {
      // Adding a variant to BlueprintHeroSlideError without handling it here breaks the build,
      // which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint hero slide error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondBlueprintHeroSlideError(res: Response, error: BlueprintHeroSlideError): void {
  const { statusCode, message, errors } = mapBlueprintHeroSlideErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
