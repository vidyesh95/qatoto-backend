import type { Response } from "express";

import { fieldRefusal } from "#src/modules/rnd/projects/project-error-response.js";
import type { CommerceProviderFreightRateError } from "#src/modules/store/fulfillment/commerce-provider-freight-rates.service.js";

/**
 * §19.12's error→HTTP map — the lanes a provider authors for itself.
 *
 * ITS OWN FILE rather than a wing of `commerce-freight-rates-error-response.ts`, on that
 * file's own reasoning: folding a second domain into an existing mapper falsifies the
 * existing mapper's header, and this domain's policy genuinely differs on the point that
 * matters most. The transport-generic helpers below are imported, never copied.
 *
 * THE POLICY, and where it departs from the staff mapper:
 *   403 — NOT APPROVED, and only that. It is decided before any id is read, so the answer is
 *         byte-identical for a real card id and a garbage one. The staff mapper's 403 is a
 *         platform capability; this one is a provider profile, and neither is ever a 404.
 *   404 — the card. ⚠️ AND IT IS ALSO WHAT ANOTHER PROVIDER'S CARD ANSWERS. The staff mapper
 *         can afford to say "not found" only for rows that truly do not exist, because its
 *         callers are staff and may see everything. Here a 403 on somebody else's card would
 *         confirm that card exists, which turns this surface into an id oracle for a rival's
 *         lane portfolio. The service does this by predicating the lookup on ownership rather
 *         than comparing after the load, so there is no branch to forget.
 *   422 — a field to fix: a past `validFrom`, a missing floor band, a duplicated floor, a
 *         widened or empty window, a malformed cursor.
 *   409 — a valid request conflicting with current state: the card is no longer active, or it
 *         is already in force.
 *
 * `IN_FORCE` IS A 409 THAT NEVER SUCCEEDS LATER, and it stays a 409 for the staff mapper's
 * reason: the classification is by the KIND of failure, not by retryability. On THIS surface
 * it should also be nearly unreachable — the create route refuses a non-future `validFrom`
 * outright, so a provider cannot mint the in-force card §19.11 warns an operator about. It
 * remains mapped because a card staged for Monday is in force on Tuesday, and a composer left
 * open across the weekend will meet it.
 *
 * THE 422s PUT THE SAME SENTENCE IN `message` AND IN `errors`, DELIBERATELY. Most client
 * surfaces render `message` alone, so a reason that lived only in `errors` would reach them as
 * a bare "please check the fields" and name nothing.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

interface CommerceProviderFreightRateErrorResponse {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

function mapCommerceProviderFreightRateErrorToResponse(
  error: CommerceProviderFreightRateError,
): CommerceProviderFreightRateErrorResponse {
  switch (error.type) {
    case "COMMERCE_PROVIDER_FREIGHT_NOT_APPROVED":
      return {
        statusCode: 403,
        message:
          "Publishing freight rates requires a verified freight forwarder or logistics operator profile.",
      };

    case "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND":
      return { statusCode: 404, message: "That rate card was not found." };

    case "COMMERCE_FREIGHT_RATE_CARD_VALID_FROM_NOT_FUTURE": {
      const reason =
        "validFrom must be in the future. A card that is already in force can never have its bands edited, and no update can correct that.";
      return fieldRefusal("validFrom", reason);
    }

    case "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_MISSING": {
      const reason =
        "One band must start at 0 g. Without it every lighter consignment prices nothing and the lane publishes no option at all.";
      return fieldRefusal("breaks", reason);
    }

    case "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED": {
      const reason = `Two bands share the floor ${String(error.minBillableWeightGrams)} g / ${String(error.minVolumeCubicCm)} cm³. Each band needs its own.`;
      return fieldRefusal("breaks", reason);
    }

    case "COMMERCE_FREIGHT_RATE_CARD_PREDATES_PREDECESSOR": {
      const reason = `This lane already has a card starting ${error.predecessorValidFrom.toISOString()}. A replacement must start after the card it supersedes.`;
      return fieldRefusal("validFrom", reason);
    }

    case "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY": {
      const reason = "validUntil must be after validFrom — this window covers no time at all.";
      return fieldRefusal("validUntil", reason);
    }

    case "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED": {
      const reason =
        error.currentValidUntil === null
          ? "This card's window can only be narrowed."
          : `This card already ends ${error.currentValidUntil.toISOString()}; a window can only be narrowed.`;
      return fieldRefusal("validUntil", reason);
    }

    case "INVALID_CURSOR": {
      const reason = "That page cursor is not valid. Start from the first page.";
      return fieldRefusal("cursor", reason);
    }

    case "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE":
      return {
        statusCode: 409,
        message: `This rate card is ${error.state} and can no longer be changed. Publish a new card for this lane instead.`,
      };

    case "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE":
      return {
        statusCode: 409,
        message: `This card started pricing on ${error.validFrom.toISOString()} and its bands are frozen. Publish a new card for this lane instead.`,
      };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(
        `Unhandled commerce provider freight rate error: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

export function respondCommerceProviderFreightRateError(
  res: Response,
  error: CommerceProviderFreightRateError,
): void {
  const mapped = mapCommerceProviderFreightRateErrorToResponse(error);
  res.status(mapped.statusCode).json({
    status: "error",
    statusCode: mapped.statusCode,
    message: mapped.message,
    ...(mapped.errors === undefined ? {} : { errors: mapped.errors }),
  });
}
