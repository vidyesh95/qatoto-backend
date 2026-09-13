import type { Response } from "express";

import type { BlueprintModerationArm } from "#src/modules/home/blueprints/blueprint-moderation-transitions.js";
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

/**
 * The arm, as a moderator would say it.
 *
 * ⚠️ A `switch` WITH A `never` DEFAULT, BECAUSE THE TERNARY THIS REPLACES WAS ALREADY WRONG THE DAY
 * A THIRD ARM LANDED. `arm === "case_study" ? "case study" : "teardown"` does not fail to compile
 * when the union widens — it just calls a showcase launch a teardown, in the one sentence a
 * moderator reads to understand why their action was refused.
 */
function describeModerationArm(arm: BlueprintModerationArm): string {
  switch (arm) {
    case "teardown":
      return "teardown";
    case "case_study":
      return "case study";
    case "showcase":
      return "showcase launch";
    default: {
      const exhaustiveCheck: never = arm;
      throw new Error(`Unhandled moderation arm: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

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
            : `A ${error.verb} does not apply to a ${error.moderationState} ${describeModerationArm(error.arm)}.`,
      });
      return;
    /*
     * ⚠️ 404, AND IT IS THE SAME ANSWER FOR THREE DIFFERENT FACTS: no such report, a report about
     * a different row, and a report id the caller had no business knowing. Splitting them would
     * let anyone holding `moderate_content` map reports to targets by guessing ids, and the queue
     * already serves everything they are meant to know.
     */
    case "BLUEPRINT_REPORT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "No open report with that id is about this blueprint.",
      });
      return;
    /*
     * 409 rather than 404: the report EXISTS and the caller may see it in the queue, so telling
     * them it is already resolved is not a disclosure — it is the answer to why nothing happened.
     * The state change is refused with it, so two moderators racing one report cannot both be
     * told they answered it.
     */
    case "BLUEPRINT_REPORT_ALREADY_RESOLVED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That report was already resolved by another moderator.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint moderation error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
