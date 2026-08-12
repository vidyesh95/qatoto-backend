import type { Response } from "express";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { CommerceCategoryError } from "#src/services/commerce-categories.service.js";

/**
 * Error mapping for the commerce-category controller.
 *
 * WHY ITS OWN MAPPER rather than extending one that exists. `promotions-error-response.ts`
 * declares itself as the promotional carousel's and `studio-error-response.ts` as "every
 * domain error the STUDIO controllers can surface"; folding the taxonomy into either
 * falsifies its own header. The transport-generic helpers are IMPORTED below, never copied.
 *
 * THE STATUS POLICY, restated so this file stands alone:
 *   403 — ONLY the platform-capability refusal, and it is the whole gate for the admin
 *         half of this domain. That does not break the 404-never-403 rule, it applies it:
 *         the refusal is decided BEFORE any id is read, so a caller without
 *         `moderate_commerce` receives a byte-identical 403 for a real category id and a
 *         garbage one. The single fact disclosed is the caller's own staff status, which
 *         they already know.
 *   404 — the category and request lookups. Reached only by a caller who ALREADY passed
 *         the capability check, so they disclose nothing to a stranger.
 *   422 — parse failures, a bad parent, a reorder that is not a permutation, and an
 *         assignment naming a category that cannot receive listings.
 *   409 — conflicts with the CURRENT state: a taken slug, a category still holding
 *         children or listings, a request another moderator already decided. Every one of
 *         these succeeds later, or succeeded already for someone else.
 *   502 — Cloudinary did not answer. Retrying may work.
 *   503 — this deployment has no Cloudinary credentials at all.
 *
 * TWO PAIRS THAT LOOK MERGEABLE AND ARE NOT.
 *
 *   `HAS_CHILDREN` and `IN_USE` both block a retire, but the fix differs and the counts
 *   are what make the message actionable: "move 3 listings" and "retire 2 sub-categories"
 *   are different afternoons. Collapsing them into "cannot retire" tells a moderator
 *   nothing they can act on.
 *
 *   `ORDER_MISMATCH` (422) and `NOT_FOUND` (404) both mean "an id you sent is not one I
 *   have", but a reorder sends the WHOLE set and the fix is to re-read the list, whereas a
 *   404 names one path id. Collapsing them would tell an admin to reload when their
 *   reorder was fine.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

/**
 * Maps a commerce-category error to its HTTP shape. Does NOT touch `res` — a pure function,
 * so it is testable without a request, mirroring every other mapper here.
 */
export function mapCommerceCategoryErrorToResponse(error: CommerceCategoryError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403: the whole gate. Names no resource, so it cannot be used to probe an id.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "Managing store categories requires the moderator or admin role.",
      };

    // --- 404: reached only after the capability check has already passed.
    case "COMMERCE_CATEGORY_NOT_FOUND":
      return { statusCode: 404, message: "Store category not found." };
    case "COMMERCE_CATEGORY_REQUEST_NOT_FOUND":
      return { statusCode: 404, message: "That category request does not exist." };

    // --- 422: the request itself is wrong and the same payload will keep failing.
    case "COMMERCE_CATEGORY_PARENT_NOT_FOUND":
      return {
        statusCode: 422,
        message: "That parent category does not exist.",
        errors: { parentCategoryId: ["Choose a category that exists, or leave it as a root."] },
      };
    case "COMMERCE_CATEGORY_PARENT_CYCLE":
      return {
        statusCode: 422,
        message: "A category cannot be moved inside itself.",
        errors: {
          parentCategoryId: ["Pick a parent that is not this category or one of its descendants."],
        },
      };
    case "COMMERCE_CATEGORY_ORDER_MISMATCH":
      return {
        statusCode: 422,
        message: "That order does not match the categories that exist.",
        errors: {
          categoryIds: [
            "Send every category under this parent exactly once. Reload and try again.",
          ],
        },
      };
    case "COMMERCE_CATEGORY_ASSIGNMENT_INVALID":
      return {
        statusCode: 422,
        message: "One of the chosen categories cannot receive listings.",
        errors: {
          productAssignments: [
            `Product ${error.productId} was assigned to a category that is not active.`,
          ],
        },
      };

    // --- 409: a conflict with the CURRENT state; the same payload succeeds later.
    case "COMMERCE_CATEGORY_SLUG_TAKEN":
      return {
        statusCode: 409,
        message: `The slug "${error.slug}" is already used by another category.`,
        errors: { slug: ["Choose a different slug."] },
      };
    case "COMMERCE_CATEGORY_HAS_CHILDREN":
      return {
        statusCode: 409,
        message: `Retire or move the ${String(error.childCount)} sub-categories under this one first.`,
      };
    case "COMMERCE_CATEGORY_IN_USE":
      return {
        statusCode: 409,
        message: `${String(error.productCount)} listings are still in this category. Move them before retiring it.`,
      };
    case "COMMERCE_CATEGORY_PROTECTED":
      return {
        statusCode: 409,
        message:
          "Misc cannot be retired — it is where listings wait while a category request is reviewed.",
      };
    case "COMMERCE_CATEGORY_REQUEST_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message:
          error.state === "approved"
            ? "Another moderator already approved this request."
            : "Another moderator already rejected this request.",
      };

    // --- Image pipeline, rendered identically to the promotions and product mappers.
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "The uploaded file is not a valid image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — every mapper
      // spelling it out itself is another copy to update, and the one that got missed
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
        message: "Could not remove the stored image, so the category was kept. Please try again.",
      };

    default: {
      // Adding a variant to CommerceCategoryError without handling it here breaks the
      // build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce category error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondCommerceCategoryError(res: Response, error: CommerceCategoryError): void {
  const { statusCode, message, errors } = mapCommerceCategoryErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
