import { eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { user } from "#src/db/schema.js";
import { appendPlatformAuditEntry } from "#src/services/platform-audit.service.js";
import {
  listPlatformCapabilitiesForRole,
  requirePlatformCapability,
  type PlatformAccessError,
  type PlatformCapability,
  type PlatformRole,
} from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Granting and revoking staff roles over HTTP (§4a Layer 3).
 *
 * THIS REVERSES A DECISION THE SCHEMA STATES OUTRIGHT, so the reasons it was made are the
 * constraints this file has to satisfy. `scripts/grant-platform-role.ts` was the only writer
 * of `user.platform_role` precisely because a self-grantable staff role would defeat category
 * moderation (§6) and the four-eyes escrow rule (§7) at once. Four limits keep that true:
 *
 *   1. `manage_platform_roles` is held by `admin` ALONE. A moderator cannot promote anyone,
 *      themselves included.
 *   2. NOBODY MAY CHANGE THEIR OWN ROLE — not to widen it, not to drop it. An admin who could
 *      self-demote could also step out of the audit trail's reach mid-incident.
 *   3. Lookup is by EXACT email and returns ONE row. There is no listing and no prefix search,
 *      so this is not an account-enumeration surface — which is also why `GET /users` keeps
 *      its three-column projection.
 *   4. Every write lands on the append-only audit chain in the same transaction.
 *
 * The script stays. It is still the only way to grant the FIRST admin, because everything
 * here requires an admin to already exist.
 */

export type PlatformRoleAdminError =
  | PlatformAccessError
  | { type: "USER_NOT_FOUND"; email: string }
  | { type: "CANNOT_CHANGE_OWN_ROLE" };

/** The caller reporting on itself. Never about another account — see `readOwnStaffContext`. */
export interface PlatformSelfView {
  readonly userId: string;
  readonly email: string;
  readonly platformRole: PlatformRole | null;
  readonly capabilities: readonly PlatformCapability[];
}

/** One account as the grant screen sees it. */
export interface PlatformRoleSubjectView {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly platformRole: PlatformRole | null;
}

/**
 * The caller's own role and capabilities.
 *
 * NO CAPABILITY IS REQUIRED, because this discloses exactly one fact and it is a fact the
 * caller already has: their own staff standing. Anyone could learn it by calling a staff
 * route and reading 403 versus 200; answering directly just stops the UI from having to
 * guess, and stops it treating one capability as a stand-in for another.
 *
 * THIS IS NOT THE THING THE SCHEMA COMMENT FORBIDS. That forbids `platformRole` as a Better
 * Auth `additionalField` — a value living ON THE SESSION, which is client-visible, cached,
 * and stale in the wrong direction when a role is revoked. This is an authenticated read that
 * hits the row every time, so a revoked moderator reads as revoked on their very next request.
 */
export async function readOwnStaffContext(callerUserId: string): Promise<PlatformSelfView | null> {
  const [row] = await db
    .select({ id: user.id, email: user.email, platformRole: user.platformRole })
    .from(user)
    .where(eq(user.id, callerUserId))
    .limit(1);

  if (!row) return null;

  return {
    userId: row.id,
    email: row.email,
    platformRole: row.platformRole,
    capabilities:
      row.platformRole === null ? [] : listPlatformCapabilitiesForRole(row.platformRole),
  };
}

/**
 * One account, by exact email. `manage_platform_roles`.
 *
 * CAPABILITY FIRST, EMAIL SECOND — the ordering every staff route in this codebase uses. A
 * non-admin gets the same 403 for a real address and an invented one, so this cannot be used
 * to test whether an account exists.
 */
export async function findUserForRoleGrant(
  actorUserId: string,
  email: string,
): Promise<Result<PlatformRoleSubjectView, PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  // `user.email` is citext, so this match is case-insensitive by column type.
  const [row] = await db
    .select({ id: user.id, email: user.email, name: user.name, platformRole: user.platformRole })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (!row) return { success: false, error: { type: "USER_NOT_FOUND", email } };

  return {
    success: true,
    value: { userId: row.id, email: row.email, name: row.name, platformRole: row.platformRole },
  };
}

/**
 * Grants, changes or revokes a role. `manage_platform_roles`.
 *
 * `nextPlatformRole: null` revokes — the JSON-native spelling of the script's `--role=none`.
 *
 * AN UNCHANGED ROLE IS A NO-OP, NOT A WRITE. Re-submitting the same value returns the row
 * untouched and appends nothing, so the chain records decisions rather than button presses.
 */
export async function setPlatformRole(
  actorUserId: string,
  input: { readonly email: string; readonly nextPlatformRole: PlatformRole | null },
): Promise<Result<PlatformRoleSubjectView, PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) {
    return { success: false, error: capabilityResult.error };
  }

  const subjectResult = await findUserForRoleGrant(actorUserId, input.email);
  if (!subjectResult.success) return subjectResult;
  const subject = subjectResult.value;

  // Checked on the RESOLVED id rather than on the submitted email, so a second address or a
  // different casing for the same account cannot walk around it.
  if (subject.userId === actorUserId) {
    return { success: false, error: { type: "CANNOT_CHANGE_OWN_ROLE" } };
  }

  if (subject.platformRole === input.nextPlatformRole) return { success: true, value: subject };

  const decidedAt = new Date();
  const [updatedRow] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(user)
      .set({ platformRole: input.nextPlatformRole })
      .where(eq(user.id, subject.userId))
      .returning({
        id: user.id,
        email: user.email,
        name: user.name,
        platformRole: user.platformRole,
      });

    if (rows.length > 0) {
      // THE ACTOR IS THE OPERATOR HERE, unlike `scripts/grant-platform-role.ts`, which records
      // the SUBJECT because a shell invocation has no session to attribute. Over HTTP the
      // operator is authenticated, so "who made this person a moderator" finally has a real
      // answer in the chain.
      await appendPlatformAuditEntry(tx, {
        eventKind:
          input.nextPlatformRole === null ? "platform_role_revoked" : "platform_role_granted",
        actorUserId,
        actorRoleSnapshot: capabilityResult.value.platformRole,
        actionLabel:
          input.nextPlatformRole === null ? "Revoked a platform role" : "Granted a platform role",
        targetLabel: `user ${subject.userId}`,
        detailNote: `${subject.platformRole ?? "none"} -> ${input.nextPlatformRole ?? "none"}`,
        payload: {
          subjectUserId: subject.userId,
          previousRole: subject.platformRole ?? "none",
          nextRole: input.nextPlatformRole ?? "none",
        },
        occurredAt: decidedAt,
      });
    }

    return rows;
  });

  // The row vanished between the read and the write — a deleted account, not a refusal to
  // explain away as success.
  if (!updatedRow) return { success: false, error: { type: "USER_NOT_FOUND", email: input.email } };

  return {
    success: true,
    value: {
      userId: updatedRow.id,
      email: updatedRow.email,
      name: updatedRow.name,
      platformRole: updatedRow.platformRole,
    },
  };
}
