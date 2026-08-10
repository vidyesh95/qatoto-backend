import type { Response } from "express";

import type { CommerceManufacturingInquiryError } from "#src/services/commerce-manufacturing-inquiry.service.js";
import type { StoreFactoriesError } from "#src/services/store-factories.service.js";

/**
 * Error mapping for the manufacturer directory and its inquiry (§16).
 *
 * WHY ITS OWN MAPPER. `commerce-categories-error-response.ts` declares itself the
 * taxonomy's; folding a second domain into it falsifies its own header. The
 * transport-generic helpers are IMPORTED below, never copied.
 *
 * THE STATUS POLICY, restated so this file stands alone:
 *   404 — a slug or id outside the directory predicate, AND a caller who is not a party to
 *         an inquiry. The second case is the §11 anti-enumeration rule: a distinguishable
 *         403 would make this route an oracle for which inquiry ids exist.
 *   409 — conflicts with the CURRENT state: sending an inquiry twice, answering one that
 *         was never sent, closing a closed one, writing to a factory whose inbox is shut.
 *         Every one of these either succeeded already or could succeed later.
 *   422 — parse failures and an undecodable cursor.
 *
 * `NOT_ACCEPTING_INQUIRIES` IS 409 AND NOT 403, and the distinction matters to a renderer:
 * the caller is perfectly entitled to write to this factory, the factory has closed its
 * inbox. A 403 would read as "you may not", which invites a support ticket rather than a
 * different factory.
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";

export function mapStoreFactoriesErrorToResponse(error: StoreFactoriesError): {
  readonly statusCode: number;
  readonly message: string;
} {
  switch (error.type) {
    case "NOT_FOUND":
      return { statusCode: 404, message: "Factory not found." };
    case "INVALID_CURSOR":
      return { statusCode: 422, message: "The pagination cursor could not be read." };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled store factories error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondStoreFactoriesError(res: Response, error: StoreFactoriesError): void {
  const { statusCode, message } = mapStoreFactoriesErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message });
}

export function mapManufacturingInquiryErrorToResponse(
  error: CommerceManufacturingInquiryError,
): { readonly statusCode: number; readonly message: string } {
  switch (error.type) {
    case "NOT_FOUND":
      return { statusCode: 404, message: "Manufacturing inquiry not found." };
    case "FORBIDDEN":
      return { statusCode: 403, message: "Your organization cannot act on this inquiry." };
    case "INVALID_CURSOR":
      return { statusCode: 422, message: "The pagination cursor could not be read." };
    case "INVALID_STATE":
      return { statusCode: 409, message: error.message };
    case "NOT_ACCEPTING_INQUIRIES":
      return {
        statusCode: 409,
        message: "This factory is not accepting inquiries at the moment.",
      };
    case "SELF_INQUIRY_FORBIDDEN":
      return {
        statusCode: 409,
        message: "An organization cannot send a manufacturing inquiry to itself.",
      };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled manufacturing inquiry error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondManufacturingInquiryError(
  res: Response,
  error: CommerceManufacturingInquiryError,
): void {
  const { statusCode, message } = mapManufacturingInquiryErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message });
}
