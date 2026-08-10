import type { Request, Response } from "express";
import { z } from "zod";

import { describeUnsupportedImageFormat } from "#src/lib/image.js";
import type { ProjectApplicationError } from "#src/services/project-applications.service.js";
import type { ProjectInsightLinkError } from "#src/services/project-insight-links.service.js";
import type { ProjectMemberError } from "#src/services/project-membership.service.js";
import type { ProjectRoleError } from "#src/services/project-roles.service.js";
import type { ResearchCategoryError } from "#src/services/research-categories.service.js";
import type { ResearchProjectError } from "#src/services/research-projects.service.js";

/**
 * Shared response helpers for the R&D controllers.
 *
 * WHY A SEPARATE FILE. No controller in this repo imports another —
 * `mapProductErrorToResponse` is private to products.controller.ts — and exporting a
 * mapper FROM a route-owning controller would invert the routes → controllers →
 * services layering. The four R&D controllers compose one domain error union, so the
 * mapper lives here and they all import it.
 *
 * THE STATUS POLICY, stated once (§4a/§13):
 *   404 — EVERY authorization failure. "No such project", "not a member", "role below
 *         minimum" and "child id belongs to another project" are indistinguishable, so
 *         a stranger cannot probe which ids exist. Never 403 for these.
 *   403 — only where membership is ALREADY PROVEN and the refusal is about a rule, so
 *         it reveals nothing new (FOUNDER_ROLE_IMMUTABLE, SELF_ROLE_GRANT_FORBIDDEN).
 *   422 — parse failures, and cross-table validations a schema cannot express.
 *   409 — lifecycle conflicts (already published, role not open, membership inactive).
 */

/** Every domain error the four R&D controllers can surface. */
export type ProjectDomainError =
  | ResearchProjectError
  | ProjectRoleError
  | ProjectApplicationError
  | ProjectMemberError
  | ResearchCategoryError
  | ProjectInsightLinkError;

export function respondUnauthenticated(res: Response): void {
  res.status(401).json({
    status: "error",
    statusCode: 401,
    message: "Please sign in.",
  });
}

/** Express 5 gives `string | string[]` for a param; take the first. */
export function firstParam(value: string | readonly string[]): string {
  return Array.isArray(value) ? (value[0] ?? "") : String(value);
}

/**
 * THE ONE Zod-failure responder. Every controller routes here, directly or through a thin local
 * wrapper that keeps its own name for its call sites.
 *
 * Zod v4: `z.flattenError(error).fieldErrors`, NOT the deprecated `error.flatten()`. 422, not 400.
 * (A `validate.ts` middleware used to sit in `src/middleware/` answering 400 with a raw issue list;
 * it was used by zero routes and was deleted rather than left as a contradictory example.)
 *
 * THE `form` KEY IS THE WHOLE POINT — see the comment inside. Twenty-five controllers once built
 * this body themselves and every one of them dropped it, so a `.strict()` rejection reached the
 * browser as an empty object. If you are writing a new controller: call this, do not re-implement it.
 */
export interface ValidationFailureBody {
  readonly status: "error";
  readonly statusCode: 422;
  readonly message: string;
  readonly errors: Readonly<Record<string, readonly string[]>>;
}

/**
 * The envelope, as a VALUE.
 *
 * Split out from the responder so it can be asserted without faking an Express `Response` — the
 * same mapper/responder split every `*-error-response.ts` in this directory already uses, and the
 * reason those files are testable without a single type assertion.
 */
export function buildValidationFailureBody(error: z.ZodError): ValidationFailureBody {
  const flattened = z.flattenError(error);

  // Object-level issues — notably `.strict()`'s unrecognized_keys, which is how EVERY
  // rejected server-owned field arrives — land in `formErrors`, NOT `fieldErrors`.
  // Sending only fieldErrors returns `errors: {}` for exactly the hostile-payload case
  // this domain cares most about, leaving the client with "Validation failed" and no
  // indication of which key was refused. Surface both under one key the frontend's
  // `fieldErrors` map can render, under the reserved key "form".
  const errors: Record<string, readonly string[]> = { ...flattened.fieldErrors };
  if (flattened.formErrors.length > 0) {
    errors.form = flattened.formErrors;
  }

  return {
    status: "error",
    statusCode: 422,
    /**
     * USER-FACING COPY, not a diagnostic — and on most screens it is the ONLY thing rendered.
     *
     * 48 client components render `message`; exactly 2 also render `fieldErrors`. So on ~46
     * surfaces this sentence IS the error, with the per-field detail below invisible. It says what
     * to DO for that reason, and it matches the house style the other 656 error messages keep:
     * sentence case, second person, trailing period. `"Validation failed"` was none of those.
     *
     * Pinned by `project-error-response.test.ts`, because it changed once already without anything
     * noticing.
     */
    message: "Please check the highlighted fields.",
    errors,
  };
}

export function respondValidationFailed(res: Response, error: z.ZodError): void {
  const body = buildValidationFailureBody(error);
  res.status(body.statusCode).json(body);
}

/**
 * Bodies that are entirely optional (`{ note? }`) must be read as `req.body ?? {}`.
 *
 * body-parser sets `req.body = undefined` when the request carries no Content-Length
 * and no Content-Type, and Express 5 does NOT default it to `{}` — so a client POSTing
 * an accept/decline with no body at all would otherwise fail validation with 422 for a
 * request that is perfectly valid.
 */
export function optionalBody(req: Request): unknown {
  return req.body ?? {};
}

/**
 * Maps a domain error to its HTTP shape. Does NOT touch `res` — mirrors
 * `mapProductErrorToResponse` so both are testable as pure functions.
 */
export function mapProjectErrorToResponse(error: ProjectDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: every authorization and lookup failure, all indistinguishable.
    case "NOT_FOUND":
      return { statusCode: 404, message: "Project not found." };
    case "ROLE_NOT_FOUND":
      return { statusCode: 404, message: "Role not found." };
    case "APPLICATION_NOT_FOUND":
      return { statusCode: 404, message: "Application not found." };
    case "INVITE_NOT_FOUND":
      return { statusCode: 404, message: "Invite not found." };
    case "MEMBER_NOT_FOUND":
      return { statusCode: 404, message: "Member not found." };
    // §11k.2. ONE string for four different refusals — no such project, not its founder and
    // not staff, no such insight, and that insight is an unpublished draft. Splitting any of
    // them turns the route into an oracle: founder-ness cannot be decided without reading the
    // slug, and a draft insight is invisible to every public read by design.
    case "INSIGHT_LINK_DENIED":
      return { statusCode: 404, message: "Project or insight not found." };
    // Reachable only after authorization passed, so it may be specific.
    case "INSIGHT_LINK_NOT_FOUND":
      return { statusCode: 404, message: "That insight is not linked to this project." };

    // --- 422: validation the schema could not do alone.
    case "CATEGORY_NOT_FOUND":
      return {
        statusCode: 422,
        message: "That category does not exist.",
        errors: { categoryId: ["Unknown category."] },
      };
    case "EQUITY_BAND_INVALID":
      return {
        statusCode: 422,
        message: "The offered equity band is invalid.",
        errors: {
          offeredEquityBasisPointsMin: ["Must be 0–10000 and not above the maximum."],
        },
      };
    case "INCOMPLETE_FOR_PUBLISH":
      return {
        statusCode: 422,
        message: "This project is not complete enough to publish.",
        errors: { missing: [...error.missing] },
      };
    case "SKILLS_NOT_SUBSET":
      return {
        statusCode: 422,
        message: "Selected skills must come from the role's own list.",
        errors: { selectedSkills: [...error.invalidSkills] },
      };
    case "DUPLICATE_COMPENSATION_KIND":
      return {
        statusCode: 422,
        message: "A role may advertise at most one strand per compensation kind.",
        errors: { compensation: [`Duplicate kind: ${error.kind}`] },
      };
    case "COMPENSATION_POLICY_MISMATCH":
      return {
        statusCode: 422,
        // §5: a founder cannot advertise a payout mechanism escrow will not execute.
        message: "That payout policy is not valid for this compensation kind.",
        errors: { compensation: [`${error.kind} cannot be earned as ${error.policy}`] },
      };
    case "COMPENSATION_RANGE_INVALID":
      return {
        statusCode: 422,
        message: "The compensation range is invalid.",
        errors: { compensation: [`Invalid range for ${error.kind}`] },
      };
    case "SLOTS_BELOW_FILLED":
      return {
        statusCode: 422,
        message: "Cannot reduce slots below the number already filled.",
        errors: { slotsTotal: [`At least ${error.slotsFilledCount} seats are filled.`] },
      };

    // --- 409: lifecycle conflicts.
    case "ALREADY_PUBLISHED":
      return { statusCode: 409, message: "This project is already published." };
    case "NOT_PUBLISHED":
      return { statusCode: 409, message: "This project is not published." };
    case "PROJECT_ARCHIVED":
      return { statusCode: 409, message: "This project is archived." };
    case "PROJECT_NOT_ACCEPTING":
      return { statusCode: 409, message: "This project is not accepting applications." };
    case "STAGE_UNCHANGED":
      return { statusCode: 409, message: "The project is already at that stage." };
    case "COVER_REQUIRED_WHILE_PUBLISHED":
      return {
        statusCode: 409,
        message: "Unpublish the project before removing its cover image.",
      };
    case "ROLE_NOT_OPEN":
      return { statusCode: 409, message: "That role is not open." };
    case "ROLE_FULL":
      return { statusCode: 409, message: "That role has no seats left." };
    case "ROLE_HAS_REFERENCES":
      return {
        statusCode: 409,
        message: "This role has applications or invites. Close it instead of deleting it.",
      };
    case "ALREADY_MEMBER":
      return { statusCode: 409, message: "That person is already on the team." };
    case "MEMBERSHIP_INACTIVE":
      return { statusCode: 409, message: "That membership is not active." };
    case "ALREADY_APPLIED":
      return { statusCode: 409, message: "You already have a live application here." };
    case "APPLICATION_NOT_PENDING":
      return { statusCode: 409, message: "That application has already been decided." };
    case "ALREADY_INVITED":
      return { statusCode: 409, message: "That person already has a live invite." };
    case "INVITE_NOT_PENDING":
      return { statusCode: 409, message: "That invite has already been answered." };
    case "CATEGORY_LABEL_TAKEN":
      return {
        statusCode: 409,
        message: "A category with that name already exists.",
        errors: { label: [`Resolves to the existing slug "${error.slug}".`] },
      };
    case "INSIGHT_ALREADY_LINKED":
      return { statusCode: 409, message: "This project already cites that insight." };
    case "SLUG_EXHAUSTED":
      return {
        statusCode: 409,
        message: "Could not derive a unique URL for that name. Try a different one.",
      };

    // --- 403: membership already proven; the refusal is about a rule.
    case "SELF_APPLICATION_FORBIDDEN":
      return { statusCode: 403, message: "You cannot apply to your own project." };
    case "SELF_INVITE_FORBIDDEN":
      return { statusCode: 403, message: "You cannot invite yourself." };
    case "NOT_THE_APPLICANT":
      return { statusCode: 403, message: "Only the applicant can do that." };
    case "NOT_THE_INVITEE":
      return { statusCode: 403, message: "Only the invited person can do that." };
    // Membership is already proven here, so naming the rule reveals nothing new.
    case "FOUNDER_ROLE_IMMUTABLE":
      return { statusCode: 403, message: "The founder's role cannot be changed or removed." };
    case "FOUNDER_CANNOT_LEAVE":
      return {
        statusCode: 409,
        message: "A founder cannot leave their own project. Archive it instead.",
      };
    // Deliberately collapses "no such user" and "already a member": splitting them
    // turns POST /invites into a user-enumeration oracle over the whole user table.
    case "INVITEE_NOT_ELIGIBLE":
      return { statusCode: 422, message: "That person cannot be invited to this project." };

    // --- Image + Cloudinary variants, reused verbatim from the product pipeline.
    case "NOT_AN_IMAGE":
      return { statusCode: 422, message: "That file is not a readable image." };
    case "UNSUPPORTED_FORMAT":
      // The sentence lives in `image.ts` beside the allowlist it describes — six mappers
      // spelling it out themselves is six copies to update, and the one that got missed
      // would be telling users the wrong thing.
      return { statusCode: 422, message: describeUnsupportedImageFormat(error.detected) };
    case "DIMENSIONS_TOO_SMALL":
      return {
        statusCode: 422,
        message: `Image is too small (${error.width}×${error.height}). Minimum 64×64.`,
      };
    case "DIMENSIONS_TOO_LARGE":
      return {
        statusCode: 422,
        message: `Image is too large (${error.width}×${error.height}). Maximum 8192×8192.`,
      };
    case "NOT_CONFIGURED":
      return { statusCode: 503, message: "Image storage is not configured." };
    case "UPLOAD_FAILED":
      return { statusCode: 502, message: "Image upload failed. Please try again." };
    case "DELETE_FAILED":
      return { statusCode: 502, message: "Image deletion failed. Please try again." };

    default: {
      // Adding a variant to any of the four service unions without handling it here
      // breaks the build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled project error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondProjectError(res: Response, error: ProjectDomainError): void {
  const { statusCode, message, errors } = mapProjectErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
