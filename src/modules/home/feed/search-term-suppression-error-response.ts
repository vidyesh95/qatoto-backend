import type { Response } from "express";

import type { SearchTermSuppressionError } from "#src/modules/home/feed/search-term-suppression.service.js";

export {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/engagement/engagement-error-response.js";

/**
 * STATUS POLICY: 403 only for the capability refusal, decided before anything is read; 422 for a
 * term the search log would never store; 404 for lifting a suppression that does not exist.
 */
function mapSearchTermSuppressionErrorToResponse(error: SearchTermSuppressionError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    case "PLATFORM_CAPABILITY_REQUIRED":
      return { statusCode: 403, message: "Suppressing search terms requires moderator access." };
    case "SEARCH_TERM_NOT_STORABLE":
      return {
        statusCode: 422,
        message: "That term is never stored, so it can never trend.",
        errors: {
          term: [
            "Terms under 2 or over 80 characters, or holding an email address, a web address or seven or more digits, are not kept.",
          ],
        },
      };
    case "SEARCH_TERM_NOT_SUPPRESSED":
      return { statusCode: 404, message: `"${error.term}" is not suppressed.` };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled search-term error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondSearchTermSuppressionError(
  res: Response,
  error: SearchTermSuppressionError,
): void {
  const { statusCode, message, errors } = mapSearchTermSuppressionErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
