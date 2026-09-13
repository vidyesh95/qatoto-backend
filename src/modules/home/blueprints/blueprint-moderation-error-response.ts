import type { Response } from "express";

import type { BlueprintModerationError } from "#src/modules/home/blueprints/blueprint-moderation.service.js";

/**
 * Error mapping for the three blueprint moderation verbs.
 *
 * ⚠️ ITS OWN FILE, for the reason `teardown-write-error-response.ts` is separate from
 * `showcase-launch-error-response.ts`: a merged mapper would carry arms unreachable from its own
 * surface, and the `never` default would stop being a guarantee about this controller.
 *
 * THE STATUS POLICY:
 *   403 — the capability refusal (decided by the controller BEFORE any id is read, so it probes
 *         nothing) and self-moderation, which is decided after the caller already holds the
 *         capability and therefore discloses nothing new.
 *   404 — no such published row. Reached only by a caller who already passed the capability check.
 *   409 — a conflict with the row's current state: already in it, not public yet, or a verb that
 *         does not apply as it stands.
 *   422 — parse failures only, answered by `respondValidationFailed` before this is reached.
 */

export function respondBlueprintModerationError(
  res: Response,
  error: BlueprintModerationError,
): void {
  switch (error.type) {
    case "BLUEPRINT_CONTENT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That blueprint is not available.",
      });
      return;
    case "BLUEPRINT_SELF_MODERATION_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You cannot moderate your own work. Ask another moderator.",
      });
      return;
    case "BLUEPRINT_ALREADY_IN_STATE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `That blueprint is already ${error.moderationState}.`,
      });
      return;
    case "BLUEPRINT_NOT_PUBLIC_YET":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message:
          "These verbs act on a published blueprint. This one has not been published, so decide its submission instead.",
      });
      return;
    case "BLUEPRINT_TRANSITION_NOT_AVAILABLE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        /*
         * ⚠️ THE MESSAGE NAMES THE TWO-STEP PATH RATHER THAN JUST REFUSING. `quarantined → flagged`
         * is refused because downgrading REPUBLISHES the withheld files, which is a decision
         * somebody has to own — so the moderator is told the route exists and costs two entries.
         */
        message:
          error.verb === "flag" && error.moderationState === "quarantined"
            ? "A quarantine already withholds more than a flag. Restore it first if the files should go back up."
            : `A ${error.verb} does not apply to a ${error.moderationState} ${error.arm === "case_study" ? "case study" : "teardown"}.`,
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint moderation error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
