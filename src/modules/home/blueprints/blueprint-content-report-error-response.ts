import type { Response } from "express";

import type { BlueprintContentReportError } from "#src/modules/home/blueprints/blueprint-content-report.service.js";

/**
 * Error mapping for the reader-report intake and the moderator queue.
 *
 * THE STATUS POLICY:
 *   403 — reporting your own work. The caller already knows they wrote it, so this discloses
 *         nothing. ⚠️ There is no CHECK behind this rule: `user_report` can have
 *         `user_report_self_ck` because both ids sit on one row, while here the author id lives on
 *         the TARGET. The rule is real and the enforcement is in the service.
 *   404 — a blueprint that is not reportable, a blueprint that does not exist, and a report id
 *         that does not exist. All the same bytes.
 *   409 — already reported by this account (the partial unique index is what makes that honest),
 *         and a report that has already been resolved.
 *   422 — parse failures and a malformed cursor.
 */

export function respondBlueprintContentReportError(
  res: Response,
  error: BlueprintContentReportError,
): void {
  switch (error.type) {
    case "BLUEPRINT_CONTENT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That blueprint is not available.",
      });
      return;
    case "BLUEPRINT_SELF_REPORT_FORBIDDEN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You cannot report your own work.",
      });
      return;
    case "BLUEPRINT_ALREADY_REPORTED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        /*
         * ⚠️ THE MESSAGE SAYS "YOU", AND THAT IS THE WHOLE SENTENCE. Telling the reader that OTHER
         * people have also reported it would make brigading measurable — the rule
         * `user-reports.service.ts` states about the open count.
         */
        message: "You have already reported this. A moderator will look at it.",
      });
      return;
    case "BLUEPRINT_REPORT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That report is not available.",
      });
      return;
    case "BLUEPRINT_REPORT_ALREADY_RESOLVED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That report has already been answered.",
      });
      return;
    case "BLUEPRINT_CURSOR_MALFORMED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That page cursor is not valid.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint report error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
