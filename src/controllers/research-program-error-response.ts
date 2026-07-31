import type { Response } from "express";

import type { PlatformAccessError } from "#src/services/platform-role.service.js";
import type { ResearchPaperCategoryError } from "#src/services/research-paper-categories.service.js";
import type { ResearchPaperError } from "#src/services/research-papers.service.js";
import type { ProgramNotWritableError } from "#src/services/research-program-access.service.js";
import type { ResearchProgramBranchError } from "#src/services/research-program-branches.service.js";
import type { ResearchProgramModerationError } from "#src/services/research-program-moderation.service.js";
import type { ResearchProgramOpportunityError } from "#src/services/research-program-opportunities.service.js";
import type { ResearchParticipantError } from "#src/services/research-program-participants.service.js";
import type { ResearchProgramPostError } from "#src/services/research-program-posts.service.js";
import type { ResearchProgramError } from "#src/services/research-programs.service.js";

/**
 * The one place a §10 domain error becomes an HTTP status
 * (R_AND_D_BACKEND_STRUCTURE.md §10, §11f, §13).
 *
 * WHY A SEPARATE FILE, not exported from the controller: no controller in this repo imports
 * another, and exporting a mapper from a route-owning controller would invert the
 * routes → controllers → services layering. Same arrangement as
 * `proof-of-effort-error-response.ts` and the four other `*-error-response.ts` files.
 *
 * THE `default:` BRANCH IS A `never` ASSIGNMENT, and that is the load-bearing part. Adding a
 * variant to any of the nine service error unions breaks THIS file at compile time, so a new
 * failure mode cannot reach a client as an unexplained 500. It is the same guard
 * `mapProofOfEffortErrorToResponse` uses.
 *
 * THE STATUS POLICY, restated for this domain because it differs from the project one in
 * exactly one interesting way:
 *
 *   404 — every LOOKUP and every READ-authorization failure. "No such program", "not
 *         yours", "that branch belongs to another program" are indistinguishable, so a
 *         stranger cannot enumerate which slugs or ids exist. Never 403 for these.
 *
 *   403 — only where the caller has ALREADY been shown the resource, so the refusal
 *         reveals nothing new: `NOT_THE_UPLOADER`, `NOT_THE_AUTHOR`. Plus
 *         `PLATFORM_CAPABILITY_REQUIRED`, which is decided BEFORE any id is read and so
 *         cannot be an id oracle (`platform-role.service.ts` explains why that is the rule
 *         applied correctly rather than an exception to it).
 *
 *   409 — lifecycle conflicts. A program already decided, a paper already reviewed, a post
 *         already hidden, a reply past the depth cap, content already reported. **A 409 here
 *         is usually a finding, not a retry** — it means the state moved, and a client that
 *         retries blindly will keep getting it.
 *
 *   422 — parse failures and cross-field validations a schema cannot express: a branch nested
 *         past the depth cap, a readiness range inverted, a tranche on a non-funder, an effort
 *         date in the future, a PDF that is not a PDF.
 *
 *   413 — handled in the multipart middleware, never here.
 *   502 / 503 — object storage. `NOT_CONFIGURED` is a 503 because the deployment is
 *         incomplete rather than the request wrong; an upload failure is a 502 because a
 *         third party refused. Both mirror the Cloudinary mapping verbatim, which is the
 *         whole reason `object-storage.ts` copied that error shape.
 *
 * THE ONE DELIBERATE DEPARTURE FROM THE PROJECT POLICY: `PROGRAM_NOT_PUBLISHED` is a **409,
 * not a 404**. A caller who can see a `pending` program (its creator, or staff) already knows
 * it exists, so there is nothing left to protect — and a 404 on a page they are looking at
 * would read as a bug. The 404-never-403 rule exists to stop id probing, not to make every
 * refusal opaque.
 */

/** Every domain error the §10 controller can surface. */
export type ResearchProgramDomainError =
  | ResearchProgramError
  | ProgramNotWritableError
  | ResearchProgramBranchError
  | ResearchPaperError
  | ResearchPaperCategoryError
  | ResearchProgramPostError
  | ResearchParticipantError
  | ResearchProgramOpportunityError
  | ResearchProgramModerationError
  | PlatformAccessError;

export function mapResearchProgramErrorToResponse(error: ResearchProgramDomainError): {
  readonly statusCode: number;
  readonly message: string;
} {
  switch (error.type) {
    // ---- 404: every lookup and read-authorization failure ----
    case "NOT_FOUND":
      return { statusCode: 404, message: "Research program not found." };
    case "BRANCH_NOT_FOUND":
      return { statusCode: 404, message: "Research branch not found." };
    case "PARENT_BRANCH_NOT_FOUND":
      return { statusCode: 404, message: "The parent research branch was not found." };
    case "PAPER_NOT_FOUND":
      return { statusCode: 404, message: "Research paper not found." };
    case "PAPER_CATEGORY_NOT_FOUND":
      return { statusCode: 404, message: "Paper category not found." };
    case "POST_NOT_FOUND":
      return { statusCode: 404, message: "Post not found." };
    case "REPORT_NOT_FOUND":
      return { statusCode: 404, message: "Content report not found." };
    case "OPPORTUNITY_NOT_FOUND":
      return { statusCode: 404, message: "Product opportunity not found." };
    case "PAPER_FILE_MISSING":
      // A real state, not an error in the request: the paper exists and has no attached
      // file. Distinct from PAPER_NOT_FOUND so a client can offer the DOI link instead.
      return { statusCode: 404, message: "This paper has no attached file." };

    // ---- 403: the caller has already been shown the resource ----
    case "PLATFORM_CAPABILITY_REQUIRED":
      // Deliberately does NOT name the role that would suffice — telling an attacker which
      // role they need is free reconnaissance (`platform-role.service.ts`).
      return { statusCode: 403, message: "This action requires a moderator." };
    case "NOT_THE_UPLOADER":
      return { statusCode: 403, message: "Only the person who uploaded this paper can change it." };
    case "NOT_THE_AUTHOR":
      return { statusCode: 403, message: "Only the author can change this post." };

    // ---- 409: lifecycle conflicts. Usually a finding, not a retry ----
    case "PROGRAM_NOT_PUBLISHED":
      return {
        statusCode: 409,
        message:
          error.status === "pending"
            ? "This program is still awaiting review, so it cannot take contributions yet."
            : `This program is ${error.status} and is closed to contributions.`,
      };
    case "PROGRAM_ALREADY_DECIDED":
      return {
        statusCode: 409,
        message: `This program has already been reviewed and is ${error.status}.`,
      };
    case "PAPER_ALREADY_REVIEWED":
      return {
        statusCode: 409,
        message: `This paper has already been reviewed and is ${error.status}.`,
      };
    case "PAPER_FILE_ALREADY_ATTACHED":
      // Replacing a file would silently change what a reviewer approved.
      return {
        statusCode: 409,
        message: "This paper already has a file. Delete it and upload again to replace it.",
      };
    case "DUPLICATE_DOI":
      return {
        statusCode: 409,
        message: `A paper with DOI ${error.doi} is already in this program.`,
      };
    case "DUPLICATE_PAPER":
      return { statusCode: 409, message: "This exact file is already in this program." };
    case "PAPER_CATEGORY_LABEL_TAKEN":
      return { statusCode: 409, message: `A paper category named "${error.slug}" already exists.` };
    case "PAPER_CATEGORY_ALREADY_DECIDED":
      // Refused rather than replayed: a second verdict would overwrite which moderator is
      // accountable for the first one.
      return {
        statusCode: 409,
        message: `This paper category has already been reviewed and is ${error.status}.`,
      };
    case "POST_HIDDEN":
      return { statusCode: 409, message: "This post was hidden by a moderator." };
    case "POST_ALREADY_IN_STATE":
      return {
        statusCode: 409,
        message: error.isHidden ? "This post is already hidden." : "This post is not hidden.",
      };
    case "REPLY_DEPTH_EXCEEDED":
      return {
        statusCode: 409,
        message: "Replies only go one level deep. Reply to the original post instead.",
      };
    case "ALREADY_REPORTED":
      return { statusCode: 409, message: "You have already reported this." };
    case "REPORT_ALREADY_RESOLVED":
      return { statusCode: 409, message: "This report has already been resolved." };
    case "ALREADY_A_PARTICIPANT":
      // Not swallowed like a branch claim: the second call usually carries a different role
      // or compensation preference, and ignoring it would look like an accepted edit.
      return {
        statusCode: 409,
        message: "You are already a contributor here. Update your details instead.",
      };
    case "BRANCH_CYCLE":
      return { statusCode: 409, message: "A branch cannot be moved beneath itself." };
    case "BRANCH_HAS_CHILDREN":
      return {
        statusCode: 409,
        message: `This branch still has ${String(error.childCount)} sub-branches. Move or remove them first.`,
      };

    // ---- 422: cross-field and cross-table validation a schema cannot express ----
    case "PROGRAM_TITLE_UNUSABLE":
      return {
        statusCode: 422,
        message: "That title cannot be turned into a web address. Use letters and numbers.",
      };
    case "NOT_A_PARTICIPANT":
      return {
        statusCode: 422,
        message: "Join this program before logging effort or recording a contribution.",
      };
    case "TRANCHE_ROLE_MISMATCH":
      return {
        statusCode: 422,
        message: "Funding tranches only apply to a venture capitalist.",
      };
    case "CASH_AMOUNT_REQUIRED":
      return {
        statusCode: 422,
        message: "A cash commitment needs an amount and a currency.",
      };
    case "CASH_AMOUNT_FORBIDDEN":
      return {
        statusCode: 422,
        message: "Only a cash commitment carries an amount.",
      };
    case "EFFORT_DATE_IN_FUTURE":
      return { statusCode: 422, message: "You cannot log effort for a future date." };
    case "BRANCH_DEPTH_EXCEEDED":
      return {
        statusCode: 422,
        message: `The branch tree is limited to ${String(error.maxDepth)} levels deep.`,
      };
    case "READINESS_RANGE_INVALID":
      return {
        statusCode: 422,
        message: "The earliest readiness month cannot be after the latest.",
      };
    case "INVALID_PDF":
      return { statusCode: 422, message: describePdfRejection(error.reason) };

    // ---- 502 / 503: object storage. Mirrors the Cloudinary mapping verbatim ----
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Paper storage is not configured." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Paper upload failed. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Paper deletion failed. Please try again." };

    default: {
      // Adding a variant to any §10 service error union breaks HERE, at compile time,
      // rather than reaching a client as an unexplained 500.
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled research program error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Turns a PDF rejection into something the uploader can act on.
 *
 * Each case has a different remedy — re-export, re-upload, pick a smaller file — so one
 * generic "invalid PDF" would leave someone guessing at which. `TRUNCATED` in particular
 * means "try again", and it is the only one that does.
 */
function describePdfRejection(reason: string): string {
  switch (reason) {
    case "EMPTY":
      return "The uploaded file was empty.";
    case "TOO_SMALL":
      return "That file is too small to be a research paper.";
    case "TOO_LARGE":
      return "Paper exceeds the 25 MB size limit.";
    case "NOT_A_PDF":
      return "That file is not a PDF. Export your paper as a PDF and upload it again.";
    case "UNSUPPORTED_PDF_VERSION":
      return "That PDF version is not supported. Re-export it as PDF 1.4 or later.";
    case "TRUNCATED":
      return "The upload was cut off before it finished. Please try again.";
    default:
      // Not a `never` check: `reason` arrives as a plain string from the error payload, so
      // a genuinely unknown value must degrade to a usable message rather than throw
      // inside an error handler.
      return "That file could not be read as a PDF.";
  }
}

export function respondResearchProgramError(
  res: Response,
  error: ResearchProgramDomainError,
): void {
  const { statusCode, message } = mapResearchProgramErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message });
}
