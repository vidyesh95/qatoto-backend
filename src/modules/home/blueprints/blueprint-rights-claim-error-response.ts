import type { Response } from "express";

import type { BlueprintRightsClaimError } from "#src/modules/home/blueprints/blueprint-rights-claim.service.js";

/**
 * Error mapping for the rights-claim intake and its moderator queue.
 *
 * THE STATUS POLICY:
 *   403 — a claim against your own teardown. The caller knows they published it; nothing leaks.
 *   404 — a teardown that is not claimable or does not exist, and a claim id that does not exist.
 *   409 — an open claim by this account on this target already exists, and a claim that has
 *         already been answered.
 *   422 — a target id that is not one of this teardown's documents, files or parts, and a
 *         malformed cursor. The target is a 422 on `target` rather than a 404 because the teardown
 *         exists and the claimant can fix the pick.
 */
export function respondBlueprintRightsClaimError(
  res: Response,
  error: BlueprintRightsClaimError,
): void {
  switch (error.type) {
    case "RIGHTS_CLAIM_TEARDOWN_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That teardown is not available.",
      });
      return;
    case "RIGHTS_CLAIM_ON_OWN_TEARDOWN":
      res.status(403).json({
        status: "error",
        statusCode: 403,
        message: "You published this teardown, so you cannot file a rights claim against it.",
      });
      return;
    case "RIGHTS_CLAIM_TARGET_NOT_FOUND":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That file or part is not in this teardown. Pick again from the list.",
        errors: {
          target: ["That file or part is not in this teardown. Pick again from the list."],
        },
      });
      return;
    case "RIGHTS_CLAIM_ALREADY_OPEN":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        // ⚠️ "YOU", never a count of other claimants — the report queue's anti-brigading rule.
        message:
          "You already have an open claim about this. A moderator will read it before you can file another.",
      });
      return;
    case "RIGHTS_CLAIM_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "That claim is not available.",
      });
      return;
    case "RIGHTS_CLAIM_ALREADY_RESOLVED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "That claim has already been answered.",
      });
      return;
    case "RIGHTS_CLAIM_CURSOR_MALFORMED":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "That page cursor is not valid.",
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled rights claim error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
