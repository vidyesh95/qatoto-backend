import type { Response } from "express";

import type { ImportIntelligenceError } from "#src/modules/rnd/import-intelligence/import-intelligence.service.js";

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/rnd/projects/project-error-response.js";

/**
 * The §11m error mapper.
 *
 * ITS OWN MAPPER, following the one-per-domain precedent (workshop, studio, funding,
 * compensation, proof-of-effort, go-to-market). Reusing discovery's would mean one
 * exhaustive switch owning two status policies, which is exactly the drift discovery was
 * split out of `project-error-response.ts` to avoid.
 *
 * THE STATUS POLICY, restated because it is the part a reviewer checks:
 *
 *   403 — the platform-capability refusal, and ONLY that. It is decided as the FIRST
 *         statement of the service function, before any id is read, so it is identical
 *         for a real id and a garbage one and discloses nothing. Every other refusal
 *         here happens after a lookup and must not be a 403.
 *   404 — every lookup failure. A commodity, a region, a capability, a substitute or a
 *         suggestion that is not there.
 *   409 — the two conflicts that are FINDINGS rather than retries: a mapping that already
 *         exists (edit theirs, do not write a second), and a suggestion somebody has
 *         already decided (re-deciding would silently erase a reviewer's judgement).
 *   422 — parse failures, emitted by `respondValidationFailed` before this mapper runs.
 *   503 — the job queue refused a pathway request. Retryable, nobody's fault, and NOT a
 *         model failure: the model has not been called at the point this is decided.
 *
 * The exhaustive `switch` with a `never` default is what makes a new error variant a
 * COMPILE error rather than an unhandled 500.
 */
export function mapImportIntelligenceErrorToResponse(error: ImportIntelligenceError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 403: decided before any id is read, so it is not an oracle.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return {
        statusCode: 403,
        message: "This action requires a platform moderation capability.",
        errors: { capability: [error.capability] },
      };

    // --- 404: lookups.
    case "COMMODITY_NOT_FOUND":
      return { statusCode: 404, message: "Commodity not found." };
    case "REGION_NOT_FOUND":
      return { statusCode: 404, message: "Region not found." };
    case "SUPPLIER_CAPABILITY_NOT_FOUND":
      return { statusCode: 404, message: "Supplier capability not found." };
    case "SUBSTITUTE_NOT_FOUND":
      return { statusCode: 404, message: "Substitute mapping not found." };
    case "SUGGESTION_NOT_FOUND":
      return { statusCode: 404, message: "Pathway suggestion not found." };
    case "ASSESSMENT_NOT_FOUND":
      return { statusCode: 404, message: "Localization assessment not found." };

    // --- 409: findings, not retries. The message names what to do instead.
    case "SUBSTITUTE_ALREADY_MAPPED":
      return {
        statusCode: 409,
        message:
          "A substitute with this label is already mapped for this commodity and region. Edit the existing mapping rather than adding a second.",
        errors: { substituteLabel: [error.substituteLabel] },
      };
    case "SUGGESTION_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message:
          "This suggestion has already been accepted or dismissed. Read the recorded decision rather than replacing it.",
      };

    // --- 503: the QUEUE would not take the job. Nothing has been asked of the model, so
    //     this is not a model failure and it is not the caller's fault — it is retryable,
    //     and the copy says so rather than blaming the request.
    case "PATHWAY_ENQUEUE_FAILED":
      return {
        statusCode: 503,
        message:
          "Could not queue the pathway write just now. Nothing was generated and nothing was charged. Try again shortly.",
        errors: { reason: [error.detail] },
      };

    default: {
      const exhaustiveCheck: never = error;
      return exhaustiveCheck;
    }
  }
}

export function respondImportIntelligenceError(
  res: Response,
  error: ImportIntelligenceError,
): void {
  const { statusCode, message, errors } = mapImportIntelligenceErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
