import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "#src/db/index.js";
import { platformRoleGrantProposal, user } from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { appendPlatformAuditEntry } from "#src/modules/platform/audit/platform-audit.service.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import {
  listPlatformCapabilitiesForRole,
  requirePlatformCapability,
  type PlatformAccessError,
  type PlatformCapability,
  type PlatformRole,
} from "#src/modules/platform/roles/platform-role.service.js";
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
  | { type: "CANNOT_CHANGE_OWN_ROLE" }
  | { type: "ROLE_ALREADY_SET"; platformRole: PlatformRole | null }
  | { type: "PROPOSAL_ALREADY_EXISTS"; subjectUserId: string }
  | { type: "PROPOSAL_NOT_FOUND"; proposalId: string }
  | { type: "PROPOSAL_ALREADY_DECIDED" }
  | { type: "SELF_COUNTERSIGN_FORBIDDEN" }
  | { type: "SUBJECT_ROLE_CHANGED"; platformRole: PlatformRole | null };

/** A proposed change, and who is on each side of it. */
export interface PlatformRoleProposalView {
  readonly proposalId: string;
  readonly subjectUserId: string;
  readonly subjectEmail: string;
  readonly subjectName: string;
  readonly previousPlatformRole: PlatformRole | null;
  readonly nextPlatformRole: PlatformRole | null;
  readonly proposedByUserId: string;
  readonly proposedByName: string | null;
  readonly proposedAt: Date;
  readonly proposeNote: string;
}

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
 * Proposes a role change. `manage_platform_roles`. CHANGES NOTHING YET.
 *
 * The role moves only when a DIFFERENT admin countersigns. That is the §7A shape applied to
 * staff: `compensation_period` is finalized by one person and ratified by another, because a
 * single signature on something that moves money — or, here, that hands out the power to
 * moderate and to grant — is one compromised session away from being nobody's signature.
 */
export async function proposePlatformRoleChange(
  actorUserId: string,
  input: {
    readonly email: string;
    readonly nextPlatformRole: PlatformRole | null;
    readonly note: string;
  },
): Promise<Result<PlatformRoleProposalView, PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const subjectResult = await findUserForRoleGrant(actorUserId, input.email);
  if (!subjectResult.success) return subjectResult;
  const subject = subjectResult.value;

  // On the RESOLVED id, so a second address or a different casing of the same account cannot
  // walk around it. The CHECK constraint refuses the row too.
  if (subject.userId === actorUserId) {
    return { success: false, error: { type: "CANNOT_CHANGE_OWN_ROLE" } };
  }

  // A proposal that changes nothing is not a decision worth a second person's time.
  if (subject.platformRole === input.nextPlatformRole) {
    return {
      success: false,
      error: { type: "ROLE_ALREADY_SET", platformRole: subject.platformRole },
    };
  }

  try {
    const [created] = await db
      .insert(platformRoleGrantProposal)
      .values({
        subjectUserId: subject.userId,
        previousPlatformRole: subject.platformRole,
        nextPlatformRole: input.nextPlatformRole,
        proposedByUserId: actorUserId,
        proposeNote: input.note,
      })
      .returning({
        id: platformRoleGrantProposal.id,
        proposedAt: platformRoleGrantProposal.proposedAt,
      });

    if (!created) throw new Error("proposePlatformRoleChange: insert returned no row");

    await notifyOtherAdmins(actorUserId, {
      kind: "platform_role_change_proposed",
      subjectUserId: subject.userId,
      nextPlatformRole: input.nextPlatformRole,
      proposalId: created.id,
    });

    return {
      success: true,
      value: {
        proposalId: created.id,
        subjectUserId: subject.userId,
        subjectEmail: subject.email,
        subjectName: subject.name,
        previousPlatformRole: subject.platformRole,
        nextPlatformRole: input.nextPlatformRole,
        proposedByUserId: actorUserId,
        proposedByName: null,
        proposedAt: created.proposedAt,
        proposeNote: input.note,
      },
    };
  } catch (insertError: unknown) {
    // The partial unique index. Never check-then-insert: that is a TOCTOU race, and two live
    // proposals for one account is exactly how two admins countersign each other's.
    if (isUniqueViolation(insertError)) {
      return {
        success: false,
        error: { type: "PROPOSAL_ALREADY_EXISTS", subjectUserId: subject.userId },
      };
    }
    throw insertError;
  }
}

/** Every live proposal, newest first. `manage_platform_roles`. */
export async function listPendingPlatformRoleProposals(
  actorUserId: string,
): Promise<Result<readonly PlatformRoleProposalView[], PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const proposer = alias(user, "proposer");
  const rows = await db
    .select({
      proposalId: platformRoleGrantProposal.id,
      subjectUserId: platformRoleGrantProposal.subjectUserId,
      subjectEmail: user.email,
      subjectName: user.name,
      previousPlatformRole: platformRoleGrantProposal.previousPlatformRole,
      nextPlatformRole: platformRoleGrantProposal.nextPlatformRole,
      proposedByUserId: platformRoleGrantProposal.proposedByUserId,
      proposedByName: proposer.name,
      proposedAt: platformRoleGrantProposal.proposedAt,
      proposeNote: platformRoleGrantProposal.proposeNote,
    })
    .from(platformRoleGrantProposal)
    .innerJoin(user, eq(user.id, platformRoleGrantProposal.subjectUserId))
    .innerJoin(proposer, eq(proposer.id, platformRoleGrantProposal.proposedByUserId))
    .where(
      and(
        isNull(platformRoleGrantProposal.countersignedAt),
        isNull(platformRoleGrantProposal.cancelledAt),
      ),
    )
    .orderBy(desc(platformRoleGrantProposal.proposedAt));

  return { success: true, value: rows };
}

/**
 * The SECOND pair of eyes. `manage_platform_roles`, and a different person.
 *
 * This is the only code path that moves `user.platform_role` over HTTP. The role write, the
 * proposal stamp, the audit entry and the notifications all land in ONE transaction: a role
 * that changed with no chain entry behind it is worse than a failed grant somebody retries.
 */
export async function countersignPlatformRoleChange(
  actorUserId: string,
  proposalId: string,
  input: { readonly note: string },
): Promise<Result<PlatformRoleSubjectView, PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const [proposal] = await db
    .select()
    .from(platformRoleGrantProposal)
    .where(eq(platformRoleGrantProposal.id, proposalId))
    .limit(1);

  if (!proposal) return { success: false, error: { type: "PROPOSAL_NOT_FOUND", proposalId } };
  if (proposal.countersignedAt !== null || proposal.cancelledAt !== null) {
    return { success: false, error: { type: "PROPOSAL_ALREADY_DECIDED" } };
  }

  // §7A.5's rule, in its own words and for the same reason: EVEN FOR A FOUNDER. The CHECK
  // constraint refuses the row as well, so this survives a future caller that forgets.
  if (proposal.proposedByUserId === actorUserId) {
    return { success: false, error: { type: "SELF_COUNTERSIGN_FORBIDDEN" } };
  }
  if (proposal.subjectUserId === actorUserId) {
    return { success: false, error: { type: "CANNOT_CHANGE_OWN_ROLE" } };
  }

  const [subjectNow] = await db
    .select({ id: user.id, email: user.email, name: user.name, platformRole: user.platformRole })
    .from(user)
    .where(eq(user.id, proposal.subjectUserId))
    .limit(1);

  if (!subjectNow) {
    return { success: false, error: { type: "USER_NOT_FOUND", email: proposal.subjectUserId } };
  }

  // The role moved between propose and countersign — by the script, or by another proposal.
  // Refused rather than applied: the second signature was given for a transition that no
  // longer exists.
  if (subjectNow.platformRole !== proposal.previousPlatformRole) {
    return {
      success: false,
      error: { type: "SUBJECT_ROLE_CHANGED", platformRole: subjectNow.platformRole },
    };
  }

  const decidedAt = new Date();
  const [updatedRow] = await db.transaction(async (tx) => {
    const stamped = await tx
      .update(platformRoleGrantProposal)
      .set({
        countersignedAt: decidedAt,
        countersignedByUserId: actorUserId,
        countersignNote: input.note,
      })
      .where(
        and(
          eq(platformRoleGrantProposal.id, proposalId),
          isNull(platformRoleGrantProposal.countersignedAt),
          isNull(platformRoleGrantProposal.cancelledAt),
        ),
      )
      .returning({ id: platformRoleGrantProposal.id });

    // Lost the race with another countersigner. Nothing was decided here, so nothing is
    // written — an audit entry for a write that matched no row is a false trail.
    if (stamped.length === 0) return [];

    const rows = await tx
      .update(user)
      .set({ platformRole: proposal.nextPlatformRole })
      .where(eq(user.id, proposal.subjectUserId))
      .returning({
        id: user.id,
        email: user.email,
        name: user.name,
        platformRole: user.platformRole,
      });

    // BOTH HALVES ARE ON THE CHAIN. The actor is the countersigner, because theirs is the
    // signature that made it happen; the proposer is in the payload, because "who asked for
    // this" is the other half of the answer.
    await appendPlatformAuditEntry(tx, {
      eventKind:
        proposal.nextPlatformRole === null ? "platform_role_revoked" : "platform_role_granted",
      actorUserId,
      actorRoleSnapshot: capabilityResult.value.platformRole,
      actionLabel:
        proposal.nextPlatformRole === null ? "Revoked a platform role" : "Granted a platform role",
      targetLabel: `user ${proposal.subjectUserId}`,
      detailNote: `${proposal.previousPlatformRole ?? "none"} -> ${proposal.nextPlatformRole ?? "none"}`,
      payload: {
        subjectUserId: proposal.subjectUserId,
        previousRole: proposal.previousPlatformRole ?? "none",
        nextRole: proposal.nextPlatformRole ?? "none",
        proposalId,
        proposedByUserId: proposal.proposedByUserId,
      },
      occurredAt: decidedAt,
    });

    // The subject was never told before. Being made — or unmade — a moderator is a fact
    // about them, not only about the platform.
    await enqueueNotifications(tx, actorUserId, [
      {
        recipientUserId: proposal.subjectUserId,
        kind: "platform_role_changed",
        payload: {
          previousRole: proposal.previousPlatformRole ?? "none",
          nextRole: proposal.nextPlatformRole ?? "none",
          proposalId,
        },
      },
    ]);

    return rows;
  });

  if (!updatedRow) return { success: false, error: { type: "PROPOSAL_ALREADY_DECIDED" } };

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

/** Withdraws a live proposal. `manage_platform_roles`; any admin, not only the proposer. */
export async function cancelPlatformRoleProposal(
  actorUserId: string,
  proposalId: string,
): Promise<Result<{ readonly proposalId: string }, PlatformRoleAdminError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "manage_platform_roles");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const cancelled = await db
    .update(platformRoleGrantProposal)
    .set({ cancelledAt: new Date(), cancelledByUserId: actorUserId })
    .where(
      and(
        eq(platformRoleGrantProposal.id, proposalId),
        isNull(platformRoleGrantProposal.countersignedAt),
        isNull(platformRoleGrantProposal.cancelledAt),
      ),
    )
    .returning({ id: platformRoleGrantProposal.id });

  // Either it never existed or it is already decided. Collapsed deliberately: the caller is
  // a proven admin, so there is nothing to protect, and the two are the same instruction —
  // reload the queue.
  if (cancelled.length === 0) {
    return { success: false, error: { type: "PROPOSAL_ALREADY_DECIDED" } };
  }

  return { success: true, value: { proposalId } };
}

/**
 * Tells every OTHER admin that a proposal is waiting.
 *
 * They are the only people who can countersign it, and before this a proposal could sit
 * unnoticed until somebody happened to open the page. `enqueueNotifications` drops the
 * actor's own copy, so the proposer is not told about their own proposal.
 */
async function notifyOtherAdmins(
  actorUserId: string,
  event: {
    readonly kind: "platform_role_change_proposed";
    readonly subjectUserId: string;
    readonly nextPlatformRole: PlatformRole | null;
    readonly proposalId: string;
  },
): Promise<void> {
  const admins = await db.select({ id: user.id }).from(user).where(eq(user.platformRole, "admin"));

  if (admins.length === 0) return;

  await db.transaction(async (tx) => {
    await enqueueNotifications(
      tx,
      actorUserId,
      admins.map((admin) => ({
        recipientUserId: admin.id,
        kind: event.kind,
        payload: {
          proposalId: event.proposalId,
          subjectUserId: event.subjectUserId,
          nextRole: event.nextPlatformRole ?? "none",
        },
      })),
    );
  });
}
