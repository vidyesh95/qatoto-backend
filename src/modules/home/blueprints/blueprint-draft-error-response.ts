import type { Response } from "express";

import type { BlueprintDraftError } from "#src/modules/home/blueprints/blueprint-draft.service.js";

/**
 * Error mapping for `/blueprints/drafts`.
 *
 * ITS OWN FILE, for the reason `teardown-write-error-response.ts` gives: a merged mapper carries
 * arms unreachable from its own surface, and the `never` default stops being a guarantee.
 *
 * THE STATUS POLICY:
 *   404 — no such draft, AND somebody else's draft. One answer for both; see below.
 *   409 — the author is at their draft ceiling, or another tab saved first.
 *   422 — the document is not a JSON object.
 */
export function respondBlueprintDraftError(res: Response, error: BlueprintDraftError): void {
  switch (error.type) {
    /*
     * ⚠️ 404 FOR A STRANGER'S DRAFT, NOT 403. A 403 would confirm that a draft with that id exists,
     * which is an existence oracle over other people's unfinished work — the same rule
     * `TEARDOWN_SUBMISSION_NOT_FOUND` follows, and it matters more here: a draft is the least
     * finished thing anybody has, and its owner has not decided to show it to anyone.
     */
    case "BLUEPRINT_DRAFT_NOT_FOUND":
      res.status(404).json({
        status: "error",
        statusCode: 404,
        message: "No draft with that id.",
      });
      return;
    case "BLUEPRINT_DRAFT_LIMIT_REACHED":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: `You have ${String(error.limit)} saved drafts. Delete one before starting another.`,
      });
      return;
    /*
     * ⚠️ THE CURRENT REVISION TRAVELS WITH THE REFUSAL, because the client needs it to recover: it
     * reloads, merges, and saves again. A bare 409 would leave a wizard with no way forward but to
     * discard the author's typing, which is the outcome the revision exists to prevent.
     */
    case "BLUEPRINT_DRAFT_REVISION_STALE":
      res.status(409).json({
        status: "error",
        statusCode: 409,
        message: "This draft was saved somewhere else. Reload it before saving again.",
        errors: { revision: [`The current revision is ${String(error.currentRevision)}.`] },
      });
      return;
    case "BLUEPRINT_DRAFT_DOCUMENT_NOT_OBJECT":
      res.status(422).json({
        status: "error",
        statusCode: 422,
        message: "A draft document must be a JSON object.",
        errors: { document: ["Send the wizard's state as a JSON object."] },
      });
      return;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled blueprint draft error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
