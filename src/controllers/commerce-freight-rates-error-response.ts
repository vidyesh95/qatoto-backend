import type { Response } from "express";

import { fieldRefusal } from "#src/controllers/project-error-response.js";
import type { CommerceFreightRateError } from "#src/services/commerce-freight-rates.service.js";

/**
 * The §19 reference data's error→HTTP map — lane rate cards and customs dwell.
 *
 * ITS OWN FILE rather than a wing of `commerce-categories-error-response.ts`, for the reason
 * that file's own header gives: folding a new domain into an existing mapper falsifies that
 * mapper's header. The transport-generic helpers below are imported, never copied.
 *
 * THE POLICY:
 *   403 — the capability, and only the capability. Decided BEFORE any id is read, so the
 *         response is byte-identical for a real id and a garbage one. No oracle.
 *   404 — post-capability lookups. Reachable only by staff, so it leaks nothing.
 *   422 — a body-named resource that does not exist, a widened window, a duplicated floor.
 *         These say "fix a field", and there is a field to fix.
 *
 * THE 422s PUT THE SAME SENTENCE IN `message` AND IN `errors`, DELIBERATELY. Only two client
 * surfaces render `errors`; the rest render `message` alone, so a reason that lived only in
 * `errors` would reach most screens as a bare "please check the fields" and name nothing. The
 * sentence is declared once per case and used twice so the two cannot drift.
 *   409 — a valid request that conflicts with current state.
 *
 * `commerce-categories-error-response.ts` glosses 409 as "every one of these succeeds later".
 * ONE OF THESE DOES NOT, and it is still a 409: `IN_FORCE` means the card has started
 * pricing, and time only moves forward. 422 would tell the console to fix a field, which is
 * the wrong instruction — the fix is a NEW card, not a corrected one. The classification is
 * by the KIND of failure (a conflict with current state), not by retryability.
 */

export {
  fieldRefusal,
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";

interface CommerceFreightRateErrorResponse {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

export function mapCommerceFreightRateErrorToResponse(
  error: CommerceFreightRateError,
): CommerceFreightRateErrorResponse {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "This action requires the moderate_commerce capability.",
      };

    case "COMMERCE_FREIGHT_RATE_CARD_NOT_FOUND":
      return { statusCode: 404, message: "Freight rate card not found." };

    case "COMMERCE_CUSTOMS_DWELL_ESTIMATE_NOT_FOUND":
      return { statusCode: 404, message: "Customs dwell estimate not found." };

    case "COMMERCE_FREIGHT_PROVIDER_NOT_FOUND":
      return fieldRefusal(
        "providerOrganizationId",
        "That organization is not a registered commerce provider, so it cannot sell a lane rate.",
      );

    case "COMMERCE_CUSTOMS_DWELL_COMMODITY_NOT_FOUND":
      return fieldRefusal(
        "commodityScopeCategoryId",
        "That store category does not exist. Send null to scope the estimate to any commodity.",
      );

    case "COMMERCE_FREIGHT_RATE_CARD_WINDOW_EMPTY":
      return fieldRefusal(
        "validUntil",
        `A card's validity must end after it begins; this one begins at ${error.validFrom.toISOString()}.`,
      );

    case "COMMERCE_CUSTOMS_DWELL_WINDOW_EMPTY":
      return fieldRefusal(
        "validUntil",
        `An estimate's validity must end after it begins; this one begins at ${error.validFrom.toISOString()}.`,
      );

    case "COMMERCE_FREIGHT_RATE_CARD_WINDOW_WIDENED":
      return fieldRefusal(
        "validUntil",
        `A card's validity may be shortened, never extended — an expired card is not a price. It currently ends at ${error.currentValidUntil.toISOString()}.`,
      );

    case "COMMERCE_CUSTOMS_DWELL_WINDOW_WIDENED":
      return fieldRefusal(
        "validUntil",
        `An estimate's validity may be shortened, never extended. It currently ends at ${error.currentValidUntil.toISOString()}.`,
      );

    case "COMMERCE_FREIGHT_RATE_CARD_PREDATES_PREDECESSOR":
      return fieldRefusal(
        "validFrom",
        `A successor cannot begin before the card it replaces, which begins at ${error.predecessorValidFrom.toISOString()}.`,
      );

    case "COMMERCE_FREIGHT_RATE_BREAK_FLOOR_DUPLICATED":
      return fieldRefusal(
        "breaks",
        `Two bands share the floor ${error.minBillableWeightGrams}g / ${error.minVolumeCubicCm}cm³. A shared floor makes "the highest band this consignment clears" an arbitrary pick.`,
      );

    case "COMMERCE_FREIGHT_RATE_CARD_NOT_ACTIVE":
      return {
        statusCode: 409,
        message: `This rate card is ${error.state} and no longer accepts writes.`,
      };

    case "COMMERCE_FREIGHT_RATE_CARD_IN_FORCE":
      return {
        statusCode: 409,
        message: `This rate card came into force at ${error.validFrom.toISOString()} and its bands are frozen. Post a new card to correct it.`,
      };

    case "COMMERCE_CUSTOMS_DWELL_OVERLAPS":
      return {
        statusCode: 409,
        message: `Estimate ${error.dwellEstimateId} already covers this scope from ${error.validFrom.toISOString()}. Close it first.`,
      };

    case "COMMERCE_CUSTOMS_DWELL_ALREADY_CLOSED":
      return {
        statusCode: 409,
        message: `This estimate was already retired at ${error.validUntil.toISOString()}.`,
      };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled commerce freight rate error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondCommerceFreightRateError(
  res: Response,
  error: CommerceFreightRateError,
): void {
  const mapped = mapCommerceFreightRateErrorToResponse(error);
  res.status(mapped.statusCode).json({
    status: "error",
    statusCode: mapped.statusCode,
    message: mapped.message,
    ...(mapped.errors === undefined ? {} : { errors: mapped.errors }),
  });
}
