import type { Response } from "express";

import type { DiscoveryModerationError } from "#src/services/discovery-moderation.service.js";
import type { ProblemClusterError } from "#src/services/problem-clusters.service.js";
import type { ResearchCategoryError } from "#src/services/research-categories.service.js";
import type { SupplierError } from "#src/services/suppliers.service.js";
import type { TalentProfileError } from "#src/services/talent-profiles.service.js";

/**
 * Error mapping for the §6 discovery controllers.
 *
 * WHY A SEPARATE FILE FROM project-error-response.ts, rather than extending it. The two
 * status policies genuinely differ: §11b mandates 403 on `/discovery/admin/*`, and folding
 * that into the project mapper would falsify its own header, which states plainly that
 * EVERY authorization failure is a 404. A policy with an undocumented exception is a policy
 * nobody can trust. Splitting also keeps each exhaustive switch reviewable — the project
 * union is already ~45 arms.
 *
 * The transport-generic helpers are IMPORTED from that file, never copied. When §7 lands
 * and there are three consumers, extract them to src/controllers/http-response.ts — not
 * before.
 *
 * THE STATUS POLICY FOR §6, stated once:
 *   404 — resource lookups. A cluster/profile/proposal id that does not exist, or that the
 *         caller may not see, is indistinguishable.
 *   403 — ONLY the platform-capability refusal on /discovery/admin/*. This does not break
 *         the 404-never-403 rule, it APPLIES it: the refusal is decided BEFORE any id is
 *         read, so a non-staff caller gets an identical 403 for a valid id and a garbage
 *         one. The route is not an id oracle. The single fact disclosed is the caller's own
 *         staff status, which they already know.
 *   422 — parse failures, and cross-table validation a schema cannot express.
 *   409 — lifecycle conflicts (already decided, already published).
 */

export {
  firstParam,
  optionalBody,
  respondUnauthenticated,
  respondValidationFailed,
} from "#src/controllers/project-error-response.js";

/** Every domain error the four discovery controllers can surface. */
export type DiscoveryDomainError =
  | ProblemClusterError
  | TalentProfileError
  | DiscoveryModerationError
  // Composed, NOT redeclared: `POST /discovery/categories` runs the same service over the
  // same table as `POST /research-categories`, so it must fail identically.
  | ResearchCategoryError
  // §11i's supplier directory is a §6-family catalogue with the SAME status policy — its
  // moderator refusal is the identical `PLATFORM_CAPABILITY_REQUIRED` decided before any
  // id is read. A second mapper would have had to restate that policy and could then drift
  // from it.
  | SupplierError;

/**
 * Maps a discovery error to its HTTP shape. Does NOT touch `res` — a pure function, so it
 * is testable without a request, mirroring `mapProjectErrorToResponse`.
 */
export function mapDiscoveryErrorToResponse(error: DiscoveryDomainError): {
  readonly statusCode: number;
  readonly message: string;
  readonly errors?: Readonly<Record<string, readonly string[]>>;
} {
  switch (error.type) {
    // --- 404: lookups. Indistinguishable from "you may not see this".
    case "CLUSTER_NOT_FOUND":
      return { statusCode: 404, message: "Problem cluster not found." };
    case "TALENT_PROFILE_NOT_FOUND":
      return { statusCode: 404, message: "You do not have a talent profile yet." };
    case "MERGE_PROPOSAL_NOT_FOUND":
      return { statusCode: 404, message: "Merge proposal not found." };
    case "SUPPLIER_NOT_FOUND":
      // An inactive listing answers identically to one that never existed — retiring a
      // supplier must not leave a probe that says "this slug used to be here".
      return { statusCode: 404, message: "Supplier not found." };
    case "CATEGORY_NOT_FOUND":
      return {
        statusCode: 404,
        message: "Category not found.",
        errors: { categoryId: ["No such category."] },
      };

    // --- 403: the ONLY variant, and only on /discovery/admin/*.
    case "PLATFORM_CAPABILITY_REQUIRED":
      // Names no resource and no id, so it cannot be used to test whether an id exists.
      return { statusCode: 403, message: "This action requires a platform staff role." };

    // --- 422: validation a schema could not express.
    case "CATEGORY_NOT_APPROVED":
      return {
        statusCode: 422,
        message: "That category is still awaiting review.",
        errors: {
          categoryId: ["Category is pending moderation and cannot be used until it is approved."],
        },
      };
    case "VIEWPORT_INCOMPLETE":
      return {
        statusCode: 422,
        message: "A map viewport needs all four bounds.",
        errors: {
          form: ["Send min/max latitude AND min/max longitude together, or none of them."],
        },
      };
    case "REGION_NOT_FOUND":
      return {
        statusCode: 422,
        message: "That region does not exist.",
        errors: { regionId: ["Unknown region."] },
      };
    case "SKILL_NOT_FOUND":
      // Names the offending slugs so the client can strike the bad chips rather than
      // guessing — mirrors SKILLS_NOT_SUBSET in the project mapper.
      return {
        statusCode: 422,
        message: "Skills must come from the canonical skill list.",
        errors: { skillSlugs: [...error.skillSlugs] },
      };
    case "INCOMPLETE_FOR_PUBLISH":
      return {
        statusCode: 422,
        message: "Your profile is not complete enough to publish.",
        errors: { missing: [...error.missing] },
      };
    case "DUPLICATE_COMPENSATION_KIND":
      return {
        statusCode: 422,
        message: "You may state at most one ask per compensation kind.",
        errors: { compensationAsks: [`Duplicate kind: ${error.kind}`] },
      };
    case "COMPENSATION_RANGE_INVALID":
      return {
        statusCode: 422,
        message: "That compensation range is invalid.",
        errors: { compensationAsks: [`Maximum is below minimum for ${error.kind}.`] },
      };
    case "SUPPLIER_CAPABILITY_UNKNOWN":
      // Names the offending slugs, exactly as SKILL_NOT_FOUND does. The caller here is
      // already a moderator, so there is nothing left to leak by being specific.
      return {
        statusCode: 422,
        message: "Capabilities must come from the canonical capability list.",
        errors: { capabilitySlugs: [...error.capabilitySlugs] },
      };
    case "SUPPLIER_REGION_UNKNOWN":
      return {
        statusCode: 422,
        message: "That region does not exist.",
        errors: { regionSlug: [`Unknown region "${error.regionSlug}".`] },
      };
    case "MERGE_TARGET_INVALID":
      return {
        statusCode: 422,
        message:
          error.reason === "self_merge"
            ? "A cluster cannot be merged into itself."
            : "The target cluster has already been merged into another.",
      };
    // NOTE: there is deliberately no COORDINATES_OUT_OF_RANGE arm. Coordinates never
    // arrive from a client at all — `POST /discovery/problem-reports` takes `locationText`
    // and the server geocodes it — so there is no client-supplied coordinate left to
    // reject. The exhaustive switch is what surfaced that the variant had become dead.

    // --- 409: lifecycle conflicts.
    case "CATEGORY_LABEL_TAKEN":
      // Byte-identical to the project mapper's arm by design: same service, same table, so
      // two variants sharing a `type` literal must also share a rendering.
      return {
        statusCode: 409,
        message: "A category with that name already exists.",
        errors: { label: [`Resolves to the existing slug "${error.slug}".`] },
      };
    case "SUPPLIER_SLUG_TAKEN":
      // The UNIQUE on `supplier.slug` IS the de-duplication mechanism (§6): a collision is
      // a 409, never a silently suffixed second row for the same supplier.
      return {
        statusCode: 409,
        message: "A supplier with that slug already exists.",
        errors: { slug: [`"${error.slug}" is already listed.`] },
      };
    case "CATEGORY_ALREADY_DECIDED":
      return { statusCode: 409, message: `That category is already ${error.status}.` };
    case "MERGE_PROPOSAL_ALREADY_DECIDED":
      return { statusCode: 409, message: `That proposal is already ${error.status}.` };
    case "ALREADY_PUBLISHED":
      return { statusCode: 409, message: "Your profile is already published." };
    case "NOT_PUBLISHED":
      return { statusCode: 409, message: "Your profile is not published." };

    default: {
      // Adding a variant to any discovery service union without handling it here breaks
      // the build, which is the point (CLAUDE.md §3.2).
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled discovery error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export function respondDiscoveryError(res: Response, error: DiscoveryDomainError): void {
  const { statusCode, message, errors } = mapDiscoveryErrorToResponse(error);
  res.status(statusCode).json({ status: "error", statusCode, message, errors });
}
