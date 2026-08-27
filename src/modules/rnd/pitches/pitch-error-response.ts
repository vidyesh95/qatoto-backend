/**
 * The one §12 domain-error → HTTP mapper.
 *
 * MAPPER AND RESPONDER ARE SPLIT so the mapping is a pure function that can be tested
 * without an Express `Response`, matching `research-program-error-response.ts` and
 * `funding-error-response.ts`.
 *
 * THE STATUS POLICY, and every line of it is a decision rather than a habit:
 *
 *  - **404** for every lookup failure AND every ownership failure. "No such pitch" and
 *    "not your pitch" are the same answer on the wire, because a 403 on somebody else's
 *    draft confirms that draft exists — and a draft pitch is a funding solicitation nobody
 *    has approved yet. 404 exists so resource ids cannot be probed.
 *  - **403** for `PLATFORM_CAPABILITY_REQUIRED` ONLY. This is not an exception to the rule
 *    above, it is the rule applied correctly: the capability is checked BEFORE any id is
 *    read, so the caller is not probing an id and there is nothing to hide. See
 *    `platform-role.service.ts` — and note the ordering requirement it imposes on every
 *    controller here: capability first, resource second.
 *  - **409** for lifecycle conflicts. A 409 on this surface is usually a finding, not a
 *    retry: it means the pitch moved underneath the caller.
 *  - **422** for validation, including the URL parser's refusals, which name the offending
 *    field so the person can fix the one they got wrong.
 */

import type { Response } from "express";

import type { PlatformAccessError } from "#src/modules/platform/roles/platform-role.service.js";
import { describePitchLinkError } from "#src/modules/rnd/pitches/pitch-link.js";
import type { PitchModerationError } from "#src/modules/rnd/pitches/pitch-moderation.service.js";
import type { PitchOutcomeError } from "#src/modules/rnd/pitches/pitch-outcomes.service.js";
import type { PitchError } from "#src/modules/rnd/pitches/pitches.service.js";

export type PitchDomainError =
  | PitchError
  | PitchModerationError
  | PitchOutcomeError
  | PlatformAccessError;

export function mapPitchErrorToResponse(error: PitchDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404. Not found, and not-yours, are one answer. --------------------
    case "PITCH_NOT_FOUND":
      return { statusCode: 404, message: "Pitch not found." };
    case "PROJECT_NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "NOT_THE_FOUNDER":
      // Deliberately the same sentence as PROJECT_NOT_FOUND. A different one here would be
      // a permission hint, which is the leak this status policy exists to prevent.
      return { statusCode: 404, message: "Project not found." };
    case "OUTCOME_NOT_FOUND":
      return { statusCode: 404, message: "Funding record not found." };
    case "NOT_A_PARTY":
      return { statusCode: 404, message: "Funding record not found." };

    // --- 403. The capability check, which ran before any id was read. ------
    case "PLATFORM_CAPABILITY_REQUIRED":
      return { statusCode: 403, message: "This action requires a moderator." };

    // --- 409. The row moved underneath the caller. -------------------------
    case "PITCH_NOT_EDITABLE":
      return {
        statusCode: 409,
        message:
          error.status === "pending"
            ? "This pitch is being reviewed and cannot be edited until there is a decision."
            : "Only a draft or a rejected pitch can be edited.",
      };
    case "PITCH_NOT_SUBMITTABLE":
      return {
        statusCode: 409,
        message:
          error.status === "pending"
            ? "This pitch has already been submitted and is waiting for review."
            : "Only a draft or a rejected pitch can be submitted for review.",
      };
    case "PITCH_NOT_CLOSEABLE":
      return { statusCode: 409, message: "Only a published pitch can be closed." };
    case "PITCH_NOT_DELETABLE":
      return {
        statusCode: 409,
        message:
          "Only a draft can be deleted. A pitch that has been reviewed is a record — close it instead.",
      };
    case "PITCH_NOT_PENDING":
      return {
        statusCode: 409,
        message: `This pitch is ${error.status} and is no longer waiting for a decision.`,
      };
    case "PITCH_NOT_PUBLIC":
      return {
        statusCode: 409,
        message: "Funding can only be recorded against a pitch that was published.",
      };
    case "OUTCOME_ALREADY_CONFIRMED":
      return { statusCode: 409, message: "This funding record has already been confirmed." };

    // --- 422. Validation the schema could not express. ---------------------
    case "PITCH_TITLE_UNUSABLE":
      return {
        statusCode: 422,
        message: "That title cannot become a web address. Use some letters or numbers.",
        errors: { title: ["That title cannot become a web address."] },
      };
    case "PROJECT_NOT_PUBLIC":
      return {
        statusCode: 422,
        message:
          "Publish the project before submitting a pitch for it — a pitch must not be the thing that reveals a draft venture.",
      };
    case "PITCH_INCOMPLETE":
      return {
        statusCode: 422,
        message:
          "Add a funding link or a contact link before submitting. Qatoto hosts no funding of its own, so one of those two is how anyone reaches you.",
        errors: {
          [error.missingField]: ["Add a funding link or a contact link before submitting."],
        },
      };
    case "PITCH_VIDEO_NOT_ELIGIBLE":
      // ONE SENTENCE FOR FOUR CAUSES — no such video, not public, not yours, not this
      // venture's. Naming which one would let a caller probe video ids by watching the
      // message change, so the copy describes the requirement instead of the failure.
      return {
        statusCode: 422,
        message:
          "Pick a published, public video that is attached to this venture. Attach it from the upload wizard first if it is not.",
        errors: {
          pitchVideoId: ["That video cannot be used on this pitch."],
        },
      };
    case "PITCH_LINK_INVALID": {
      const reason = describePitchLinkError(error);
      // ONE SENTENCE, BOTH PLACES — the same contract `fieldRefusal` follows, so a client
      // rendering the summary and a client rendering the field show identical text.
      return { statusCode: 422, message: reason, errors: { [error.field]: [reason] } };
    }
    case "OUTCOME_HAS_NO_COUNTERPARTY":
      return {
        statusCode: 422,
        message:
          "This record does not name a Qatoto account for the funder, so there is nobody who can confirm it. It stays private to you.",
      };
    case "CANNOT_CONFIRM_OWN_REPORT":
      return {
        statusCode: 422,
        message:
          "A funding record has to be confirmed by the other party, not by whoever recorded it.",
      };
    case "FUNDER_NOT_FOUND":
      return {
        statusCode: 422,
        message:
          "That Qatoto account does not exist. Leave the account out and record the name only.",
        errors: { funderUserId: ["That Qatoto account does not exist."] },
      };

    default: {
      // Adding a variant to any §12 service error union breaks HERE, at compile time,
      // rather than reaching a client as an unexplained 500.
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled pitch error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondPitchError(res: Response, error: PitchDomainError): void {
  const { statusCode, message, errors } = mapPitchErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
