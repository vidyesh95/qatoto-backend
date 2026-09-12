import type { Response } from "express";

import type { TeardownModerationError } from "#src/modules/home/blueprints/teardown-moderation.service.js";
import type { TeardownSubmitError } from "#src/modules/home/blueprints/teardown-submission.service.js";

/**
 * Error mapping for the teardown write path — submitting, and deciding.
 *
 * A SEPARATE FILE FROM `showcase-launch-error-response.ts`, whose 422s are keyed to launch fields
 * (`headingImage`, `callToAction`, `writeUp`), and from `blueprint-error-response.ts`, whose 403
 * says "requires the admin role" because the hero carousel is gated on `manage_promotions`. Merging
 * would give either mapper a switch where half the arms are unreachable from its own surface.
 *
 * THE STATUS POLICY:
 *   403 — the capability refusal (decided before any id is read, so it probes nothing), and a
 *         moderator deciding a submission they wrote.
 *   404 — no submission with that id, reached only by a caller who already holds the capability.
 *         It is also the answer for a submission somebody else wrote: a stranger's id and a
 *         nonexistent one are the same bytes, or this route enumerates unpublished work.
 *   409 — the unit is already surveyed, or the submission is already decided.
 *   422 — a stored document that no longer parses against the current schema.
 *
 * Ordinary parse failures never reach here: they go to `respondValidationFailed`, the one Zod
 * responder in this repository, and come back as 422 with `flatten().fieldErrors`.
 */

export type TeardownWriteError = TeardownSubmitError | TeardownModerationError;

export {
  firstParam,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/modules/home/blueprints/blueprint-error-response.js";

/**
 * ⚠️ THE ONE PLACE A STORED ROW'S TITLE IS ECHOED, AND IT IS CONTRACT-MANDATED.
 *
 * The frontend's refusal reads "A survey of this unit is already on Qatoto: …", which is useful
 * precisely because the author can go and read that survey. `case-study-submission.service.ts`
 * deliberately names nothing in the same situation, and the difference is not a disagreement: the
 * service decides whether a title MAY be named — public rows and the caller's own only — and hands
 * this mapper `null` when it may not. A title that arrives here has already been cleared.
 */
function describeSubjectConflict(existingTitle: string | null): string {
  if (existingTitle === null) {
    return "A survey of this unit is already under review. Two surveys of one unit are reviewed together, so wait for that one or survey a different unit.";
  }
  return `A survey of this unit is already on Qatoto: "${existingTitle}". Two surveys of one unit are reviewed together, so add to that one or survey a different unit.`;
}

export function mapTeardownWriteErrorToResponse(error: TeardownWriteError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- Standing.
    case "PLATFORM_CAPABILITY_REQUIRED":
      return { statusCode: 403, message: "Reviewing teardowns requires the moderator role." };
    case "TEARDOWN_SELF_MODERATION_FORBIDDEN":
      return {
        statusCode: 403,
        message: "A teardown cannot be decided by the person who submitted it.",
      };

    // --- Reach.
    case "TEARDOWN_SUBMISSION_NOT_FOUND":
      return { statusCode: 404, message: "Teardown submission not found." };

    // --- Conflict.
    case "TEARDOWN_SUBJECT_ALREADY_SURVEYED":
      return {
        statusCode: 409,
        message: describeSubjectConflict(error.existingTitle),
        /*
         * The field key is what lets the wizard walk the author back to the input they must change,
         * and what tells this 409 apart from the idempotency middleware's bare one.
         */
        errors: { "provenance.subjectProductName": [describeSubjectConflict(error.existingTitle)] },
      };
    case "TEARDOWN_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message: `This teardown has already been ${error.moderationState === "published" ? "published" : "sent back"}.`,
      };

    // --- The request, or what it points at.
    case "TEARDOWN_SUBMISSION_UNPARSEABLE":
      return {
        statusCode: 422,
        message:
          "This submission was written against an older shape and no longer parses. Send it back with a note asking for a fresh survey.",
        errors: { document: error.issues },
      };

    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled teardown write error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondTeardownWriteError(res: Response, error: TeardownWriteError): void {
  const { statusCode, message, errors } = mapTeardownWriteErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
