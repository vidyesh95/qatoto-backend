import type { Response } from "express";

import type { DiscoveryModerationError } from "#src/services/discovery-moderation.service.js";
import type { DiscoveryVocabularyError } from "#src/services/discovery-vocabulary.service.js";
import type { MarketInsightError } from "#src/services/market-insights.service.js";
import type {
  ProblemClusterError,
  ProblemClusterLinkError,
} from "#src/services/problem-clusters.service.js";
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
  | SupplierError
  // §11j.4's authoring surface over `market_insight`. Same status policy again — its
  // moderator refusal is the identical PLATFORM_CAPABILITY_REQUIRED decided before any id
  // is read, and it REUSES this file's REGION_NOT_FOUND / CATEGORY_NOT_FOUND /
  // CATEGORY_NOT_APPROVED / ALREADY_PUBLISHED / NOT_PUBLISHED arms rather than adding
  // near-duplicates beside them.
  | MarketInsightError
  // §11j.4's cluster↔project link writes. NOT composing PlatformAccessError, deliberately:
  // that route never emits a 403, and the union not carrying the variant is what keeps a
  // later edit from introducing one.
  | ProblemClusterLinkError
  // §11j.4's controlled-vocabulary authoring. Same policy again — moderator-gated,
  // capability decided before any id is read.
  | DiscoveryVocabularyError;

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
    // Also what ANOTHER reporter's submission returns: the read is scoped to the caller in
    // the WHERE clause, so someone else's is indistinguishable from one that never existed.
    case "SUBMISSION_NOT_FOUND":
      return { statusCode: 404, message: "Report not found." };
    case "MARKET_INSIGHT_NOT_FOUND":
      return { statusCode: 404, message: "Market insight not found." };
    case "DISCOVERY_SKILL_NOT_FOUND":
      return { statusCode: 404, message: "Skill not found." };
    case "DISCOVERY_REGION_NOT_FOUND":
      return { statusCode: 404, message: "Region not found." };
    // BYTE-IDENTICAL to CLUSTER_NOT_FOUND above, and that is the entire point: on the
    // project-link routes, "no such project", "you are not its founder" and "you are not
    // staff" must be one answer. Founder-ness cannot be decided without reading the project
    // id, so a 403/404 split there would disclose whether that project exists (§11j.4's
    // stated 403 does not survive that requirement — see linkProjectToCluster).
    case "LINK_DENIED":
      return { statusCode: 404, message: "Problem cluster not found." };
    case "LINK_NOT_FOUND":
      return { statusCode: 404, message: "That project is not linked to this cluster." };
    case "TALENT_PROFILE_NOT_FOUND":
      return { statusCode: 404, message: "You do not have a talent profile yet." };
    // The OTHER person's-profile 404, and a separate variant because the sentence above is
    // addressed to the owner. Covers "no such user" and "their profile is unpublished"
    // with one message, so the directory cannot be used to enumerate private profiles.
    case "TALENT_PROFILE_UNAVAILABLE":
      return { statusCode: 404, message: "Talent profile not found." };
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
    // 422 rather than a silent downgrade: a moderator asserting `origin`, or a founder
    // asserting `moderator`, is refused loudly. Rewriting provenance quietly is worse.
    case "LINK_SOURCE_NOT_PERMITTED":
      return {
        statusCode: 422,
        message: "You may not assert that link source.",
        errors: {
          source: [
            `"${error.source}" is not a source your standing can claim. A project's founder declares "origin" or "founder_declared"; a moderator records "moderator".`,
          ],
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
    // RESOURCE-NEUTRAL WORDING, because two domains now share these literals: a talent
    // profile (`/talent/me/publish`) and a market insight (`/admin/market-insights/:id/
    // publish`). "Your profile is already published" was correct when only one reached
    // here and is a lie on the other path — the same constraint recorded for
    // CATEGORY_LABEL_TAKEN below.
    case "SKILL_SLUG_TAKEN":
      return {
        statusCode: 409,
        message: `The slug "${error.slug}" is already in use.`,
        errors: { slug: ["Already taken."] },
      };
    case "REGION_SLUG_TAKEN":
      return {
        statusCode: 409,
        message: `The slug "${error.slug}" is already in use.`,
        errors: { slug: ["Already taken."] },
      };
    // DELETE is the mistake-eraser, not the retirement path — so the message names the
    // alternative rather than only refusing.
    case "SKILL_HAS_REFERENCES":
      return {
        statusCode: 409,
        message: `${error.profileCount} talent ${error.profileCount === 1 ? "profile cites" : "profiles cite"} this skill, so it cannot be deleted. Retire it with isActive: false instead.`,
      };
    case "REGION_HAS_REFERENCES":
      return {
        statusCode: 409,
        message:
          "Something still references this region — a talent profile, supplier, cluster, insight or child region — so it cannot be deleted.",
      };
    case "ALREADY_LINKED":
      return { statusCode: 409, message: "That project is already linked to this cluster." };
    // The OTHER 23505 on the same insert: `problem_cluster_project_link_origin_unq` allows
    // one origin cluster per project, which is what replaces the scalar column §5 describes.
    case "ORIGIN_ALREADY_SET":
      return {
        statusCode: 409,
        message:
          "This project already names a different cluster as its origin. Unlink that one first, or link this as a declared connection instead.",
      };
    case "CLUSTER_NOT_LINKABLE":
      return {
        statusCode: 409,
        message: `A ${error.status} cluster cannot take new project links.`,
      };
    case "ALREADY_PUBLISHED":
      return { statusCode: 409, message: "That is already published." };
    case "NOT_PUBLISHED":
      return { statusCode: 409, message: "That is not published." };

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
