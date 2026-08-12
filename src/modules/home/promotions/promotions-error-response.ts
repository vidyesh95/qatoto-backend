import type { Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { PromotionalDestinationError } from "#src/modules/home/promotions/promotional-destination.js";
import type { PromotionalSlideError } from "#src/modules/home/promotions/promotions.service.js";

/**
 * Error mapping for the promotional-carousel controller.
 *
 * WHY A FOURTH MAPPER FILE rather than extending one that exists. `studio-error-response.ts`
 * declares itself as "every domain error the STUDIO controllers can surface" and
 * `discovery-error-response.ts` scopes itself to §6; folding a fifth domain into either
 * falsifies its own header, which is precisely the argument the discovery mapper makes
 * about not extending the project one. The transport-generic helpers are IMPORTED below,
 * never copied.
 *
 * THE STATUS POLICY, identical to the studio's and restated so this file stands alone:
 *   403 — ONLY the platform-capability refusal, and it is the whole gate for this domain.
 *         That does not break the 404-never-403 rule, it applies it: the refusal is
 *         decided BEFORE any id is read, so a caller without `manage_promotions` receives
 *         a byte-identical 403 for a real slide id and a garbage one. The single fact
 *         disclosed is the caller's own staff status, which they already know.
 *   404 — the slide lookup. Reached only by a caller who ALREADY passed the capability
 *         check, so it discloses nothing to a stranger.
 *   422 — parse failures, the destination rules, and the schedule window.
 *   409 — the slide-count ceiling. A conflict with the current state, not a bad request:
 *         the same payload succeeds once a slide is deleted.
 *   502 — Cloudinary did not answer. Retrying may work.
 *   503 — this deployment has no Cloudinary credentials at all.
 *
 * ONE PAIR THAT LOOKS MERGEABLE AND IS NOT. `PROMOTIONAL_SLIDE_ORDER_MISMATCH` (422) and
 * `PROMOTIONAL_SLIDE_NOT_FOUND` (404) both mean "an id you sent is not one I have", but a
 * reorder sends the WHOLE set and the fix is to re-read the list, whereas a 404 names one
 * path id. Collapsing them would tell an admin to reload when their reorder was fine.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

/**
 * Why one specific destination was refused. Every message names the actual mistake — an
 * admin who typed `//partner.example` needs to be told it leaves the site, not that the
 * value is "invalid".
 */
const DESTINATION_REJECTION_MESSAGES: Readonly<
  Record<PromotionalDestinationError["type"], string>
> = {
  DESTINATION_EMPTY: "Enter where this slide should link to.",
  DESTINATION_TOO_LONG: "That destination is too long.",
  DESTINATION_HAS_ILLEGAL_CHARACTERS: "A destination cannot contain spaces or control characters.",
  INTERNAL_PATH_NOT_RELATIVE: 'A page on Qatoto must start with "/", like "/store".',
  INTERNAL_PATH_LEAVES_SITE:
    'That path leaves Qatoto. Use a single leading slash, or choose "an external website".',
  EXTERNAL_URL_UNPARSEABLE: "That is not a valid web address.",
  EXTERNAL_URL_NOT_HTTPS: "An external destination must use https://.",
  EXTERNAL_URL_HOST_INVALID: "That web address has no valid domain.",
  EXTERNAL_URL_HAS_CREDENTIALS: "Remove the username and password from that web address.",
};

/**
 * Maps a promotional-slide error to its HTTP shape. Does NOT touch `res` — a pure
 * function, so it is testable without a request, mirroring every other mapper here.
 */
export function mapPromotionalSlideErrorToResponse(error: PromotionalSlideError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403: the whole gate. Names no resource, so it cannot be used to probe an id.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "Managing the promotional carousel requires the admin role.",
      };

    // --- 404: reached only after the capability check has already passed.
    case "PROMOTIONAL_SLIDE_NOT_FOUND":
      return { statusCode: 404, message: "Promotional slide not found." };

    // --- 422: the request itself is wrong and the same payload will keep failing.
    case "PROMOTIONAL_DESTINATION_INVALID":
      return {
        statusCode: 422,
        message: "That destination cannot be used.",
        errors: { destinationValue: [DESTINATION_REJECTION_MESSAGES[error.reason.type]] },
      };
    case "PROMOTIONAL_SLIDE_WINDOW_INVALID":
      return {
        statusCode: 422,
        message: "That schedule window is empty.",
        errors: { endsAt: ["The end must be after the start."] },
      };
    case "PROMOTIONAL_SLIDE_ORDER_MISMATCH":
      return {
        statusCode: 422,
        message: "That order does not match the slides that exist.",
        errors: {
          slideIds: ["Send every existing slide id exactly once. Reload and try again."],
        },
      };

    // --- 409: a conflict with the CURRENT state; the same payload succeeds later.
    case "PROMOTIONAL_SLIDE_LIMIT_REACHED":
      return {
        statusCode: 409,
        message: `The carousel holds at most ${String(error.limit)} slides. Delete one first.`,
      };

    // --- Image pipeline, rendered identically to the studio and product mappers.
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "The uploaded file is not a valid image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — six mappers
      // spelling it out themselves is six copies to update, and the one that got missed
      // would be telling users the wrong thing.
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
      // Adding a variant to PromotionalSlideError without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled promotional slide error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondPromotionalSlideError(res: Response, error: PromotionalSlideError): void {
  const { statusCode, message, errors } = mapPromotionalSlideErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
