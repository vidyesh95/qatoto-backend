import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import type { Result } from "#src/types/index.js";

/**
 * Platform-wide staff authorization — the Layer 3 sibling of `requireProjectRole`
 * (R_AND_D_BACKEND_STRUCTURE.md §4a).
 *
 * WHY A SERVICE AND NOT MIDDLEWARE. Identical reasoning to
 * `project-membership.service.ts`: middleware cannot return a `Result`, so it cannot
 * participate in the controller's exhaustive error switch (CLAUDE.md §3.2/§3.3). §4a
 * calls this out by name.
 *
 * WHY A CAPABILITY SET AND NOT A RANK LADDER. `PROJECT_ROLE_RANK` works because
 * founder > admin > maintainer > contributor is a real ladder. `platform_role` is NOT:
 * `auditor` is a read-only ESCROW role (§7) and `moderator` is a CONTENT role (§6, §10),
 * and they are disjoint. A rank map would make either one imply the other — an auditor
 * silently able to approve taxonomy, or a content moderator able to read the escrow
 * ledger. Capabilities make that unrepresentable.
 *
 * WHY THIS IS NEVER CACHED AND NEVER ON THE SESSION. `src/lib/auth.ts` deliberately does
 * not expose `platformRole` as an additionalField (schema.ts:79-86). A staff flag on a
 * client-visible session is a flag a client will eventually be trusted about, and a
 * cache that is stale in the wrong direction keeps a revoked moderator live. Both cost
 * one lookup on a partial index over a handful of rows.
 */

/** The platform roles, sourced from the column so the two can never drift. */
export type PlatformRole = NonNullable<(typeof user.$inferSelect)["platformRole"]>;

/**
 * What a staff member is allowed to DO. Routes name a capability, never a role, so
 * adding a fourth role later is a one-line change to the grant table below rather than
 * an edit to every call site.
 */
export type PlatformCapability =
  | "moderate_taxonomy"
  | "moderate_clusters"
  | "moderate_content"
  | "audit_escrow"
  /**
   * Grant and revoke platform roles over HTTP. `admin` ONLY — deliberately not held by
   * `moderator`, or a content moderator could promote themselves to auditor and read the
   * escrow ledger the capability split exists to keep them out of.
   */
  | "manage_platform_roles"
  /**
   * Author the home-page promotional carousel. `admin` ONLY, and deliberately NOT folded
   * into `moderate_content`.
   *
   * `moderate_content` is about DECIDING user-submitted content — approve this video,
   * hide that post — and every `moderator` holds it. This capability PUBLISHES: a slide
   * is a placement on the front page that may point at an arbitrary external https URL,
   * which is a phishing lure wearing our own branding. That blast radius belongs next to
   * role management, not next to a review queue.
   */
  | "manage_promotions";

/**
 * The grant table. Explicit and total: every role lists every capability it holds, so
 * reading this answers "who can do X" without tracing any logic.
 */
const PLATFORM_ROLE_GRANTS: Readonly<Record<PlatformRole, readonly PlatformCapability[]>> = {
  moderator: ["moderate_taxonomy", "moderate_clusters", "moderate_content"],
  auditor: ["audit_escrow"],
  admin: [
    "moderate_taxonomy",
    "moderate_clusters",
    "moderate_content",
    "audit_escrow",
    "manage_platform_roles",
    "manage_promotions",
  ],
};

/**
 * What a role holds, for a caller reporting on ITSELF.
 *
 * A READER RATHER THAN AN EXPORT OF THE TABLE, so the grant table stays the one place any
 * capability question is answered and cannot be copied, filtered or cached elsewhere.
 */
export function listPlatformCapabilitiesForRole(
  platformRole: PlatformRole,
): readonly PlatformCapability[] {
  return PLATFORM_ROLE_GRANTS[platformRole];
}

/** The caller's proven staff standing. Returned so callers can stamp an actor id. */
export interface PlatformStaffContext {
  readonly staffUserId: string;
  readonly platformRole: PlatformRole;
}

/**
 * The ONE staff-access error.
 *
 * 403, NOT 404 — and that is the 404-never-403 rule applied correctly, not an exception
 * to it. 404 exists so RESOURCE IDS cannot be probed. Here the caller is not probing an
 * id: the refusal is decided BEFORE any id is read, so a non-staff caller receives an
 * identical 403 for a valid id and for a garbage one. Nothing about the resource leaks.
 * The only fact disclosed is the caller's own staff status, which they already know.
 *
 * The corollary is a hard ordering requirement on every caller: CHECK THE CAPABILITY
 * FIRST, load the resource SECOND. Reversed, the route becomes an id oracle for anyone
 * holding a session.
 *
 * The payload deliberately carries the capability, not the caller's role — telling an
 * attacker which role they would need is free reconnaissance.
 */
export type PlatformAccessError = {
  type: "PLATFORM_CAPABILITY_REQUIRED";
  capability: PlatformCapability;
};

/**
 * Proves the caller holds `capability` platform-wide.
 *
 * Both failure modes — no staff role at all, and a staff role without this capability —
 * return the SAME error, for the same reason `requireProjectRole` collapses its three
 * cases: a distinguishable refusal is a probe.
 */
export async function requirePlatformCapability(
  userId: string,
  capability: PlatformCapability,
): Promise<Result<PlatformStaffContext, PlatformAccessError>> {
  const [row] = await db
    .select({ platformRole: user.platformRole })
    .from(user)
    .where(and(eq(user.id, userId), isNotNull(user.platformRole)))
    .limit(1);

  const platformRole = row?.platformRole;

  if (!platformRole || !PLATFORM_ROLE_GRANTS[platformRole].includes(capability)) {
    return { success: false, error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability } };
  }

  return { success: true, value: { staffUserId: userId, platformRole } };
}
