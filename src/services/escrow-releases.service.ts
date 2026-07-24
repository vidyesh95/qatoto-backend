import { and, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  escrowRelease,
  milestone,
  projectMember,
  researchProject,
  sliceAllocationProposal,
} from "#src/db/schema.js";
import { canonicalizeDocument, type CanonicalValue } from "#src/lib/canonical-hash.js";
import { createTransfer } from "#src/services/escrow-provider-adapter.service.js";
import { appendJournalEntry, deriveAvailableEscrowInCents } from "#src/services/escrow.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import { appendAuditEntry } from "#src/services/project-audit.service.js";
import type { ProjectAccessError } from "#src/services/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * MILESTONE RELEASE — THE FOUR-EYES RULE (R_AND_D_BACKEND_STRUCTURE.md §7).
 *
 * ```text
 * POST /milestones/:milestoneId/escrow-releases   body: { requestNote? }   ← NO amount field
 * ```
 *
 * The amount is read from `milestone.escrowReleaseAmountInCents` and SNAPSHOTTED into
 * `escrow_release.amountInCents` at request time — so a founder cannot edit the milestone
 * between request and approval to inflate the payout, and cannot assert an amount at all.
 * A hand-written trigger freezes the snapshot afterwards, because the service declining to
 * write an UPDATE is not the same rule as the database refusing one.
 *
 * ---------------------------------------------------------------------------
 * APPROVAL RE-DERIVES **EVERY** GATE, SERVER-SIDE. Not one of them is trusted from the
 * request, from the UI, or from the state at request time:
 *
 *   1. requester ≠ approver                  422 SELF_APPROVAL_FORBIDDEN, EVEN FOR A FOUNDER
 *   2. the approver holds `audit_escrow`, or a project `admin` role they did not grant
 *      themselves (§4a — and `project_member.roleGrantedByUserId` is what makes that
 *      checkable rather than aspirational)
 *   3. `milestone.status = 'done'`
 *   4. the §9 Proof-of-Effort windows are closed: ZERO allocation proposals in `open` or
 *      `disputed` on this project
 *   5. `escrow_held` ≥ the snapshotted amount, RE-DERIVED from the postings rather than
 *      read from the cached column
 *
 * The evidence is frozen into `verificationSnapshot` so a later audit can prove **why**,
 * not merely **that**. Canonical JSON, so the bytes an auditor reads are the bytes that
 * were recorded.
 * ---------------------------------------------------------------------------
 *
 * THE PAYOUT DESTINATION IS NEVER CLIENT-SUPPLIED. `payoutDestinationId` resolves from the
 * project's registered provider account. A `destinationAccountId` in a request body is a
 * wire-fraud primitive; `.strict()` rejects it before this file runs.
 */

export type EscrowReleaseStatus = (typeof escrowRelease.$inferSelect)["status"];

export type EscrowReleaseError =
  | ProjectAccessError
  | { type: "MILESTONE_NOT_FOUND"; milestoneId: string }
  | { type: "RELEASE_NOT_FOUND"; releaseId: string }
  | { type: "RELEASE_ALREADY_REQUESTED" }
  | { type: "RELEASE_ALREADY_DECIDED"; status: EscrowReleaseStatus }
  | { type: "MILESTONE_HAS_NO_RELEASE_AMOUNT" }
  | { type: "SELF_APPROVAL_FORBIDDEN" }
  | { type: "APPROVER_NOT_AUTHORIZED" }
  | { type: "MILESTONE_NOT_DONE"; status: (typeof milestone.$inferSelect)["status"] }
  | { type: "EFFORT_WINDOWS_OPEN"; openCount: number; disputedCount: number }
  | { type: "INSUFFICIENT_ESCROW"; availableInCents: string; requiredInCents: string };

export interface EscrowReleaseView {
  readonly id: string;
  readonly projectId: string;
  readonly milestoneId: string;
  readonly milestoneTitle: string | null;
  /** The SNAPSHOT, frozen at request time. Not the milestone's current value. */
  readonly amountInCents: string;
  readonly currency: string;
  readonly status: EscrowReleaseStatus;
  readonly requestedByUserId: string;
  readonly requestNote: string | null;
  readonly requestedAt: Date;
  readonly decidedByUserId: string | null;
  readonly decisionNote: string | null;
  readonly decidedAt: Date | null;
  /** The canonical bytes of every gate and its evidence, recorded at the decision. */
  readonly verificationSnapshot: string | null;
  readonly journalEntryId: string | null;
  readonly providerTransferId: string | null;
}

function toReleaseView(
  row: typeof escrowRelease.$inferSelect,
  milestoneTitle: string | null,
): EscrowReleaseView {
  return {
    id: row.id,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    milestoneTitle,
    amountInCents: row.amountInCents.toString(),
    currency: row.currency,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    requestNote: row.requestNote,
    requestedAt: row.requestedAt,
    decidedByUserId: row.decidedByUserId,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt,
    verificationSnapshot: row.verificationSnapshot,
    journalEntryId: row.journalEntryId,
    providerTransferId: row.providerTransferId,
  };
}

/**
 * `POST /milestones/:milestoneId/escrow-releases` — body `{ requestNote? }`, no amount.
 *
 * The founder or an admin requests; approval is somebody else's job entirely.
 */
export async function requestEscrowRelease(input: {
  readonly projectId: string;
  readonly milestoneId: string;
  readonly requestedByUserId: string;
  readonly requesterRoleSnapshot: string;
  readonly requestNote: string | null;
}): Promise<Result<EscrowReleaseView, EscrowReleaseError>> {
  const outcome = await db.transaction(async (tx) => {
    const [milestoneRow] = await tx
      .select()
      .from(milestone)
      // BOTH columns: a milestone id belonging to another project must be
      // indistinguishable from a nonexistent one, or this becomes a cross-tenant probe.
      .where(and(eq(milestone.id, input.milestoneId), eq(milestone.projectId, input.projectId)))
      .for("update");

    if (!milestoneRow) {
      return { kind: "milestone-missing" } as const;
    }
    // A release for nothing is not a release. The column CHECK forbids a zero amount, so
    // catching it here turns a 500 into a message that says what to fix.
    if (milestoneRow.escrowReleaseAmountInCents <= 0n) {
      return { kind: "no-amount" } as const;
    }

    // At most one open request per milestone — the partial unique index says so too, but
    // hitting it would surface as a 23505 rather than as a sentence.
    const [existingOpen] = await tx
      .select({ id: escrowRelease.id })
      .from(escrowRelease)
      .where(
        and(
          eq(escrowRelease.milestoneId, input.milestoneId),
          inArray(escrowRelease.status, ["requested", "approved"]),
        ),
      )
      .limit(1);

    if (existingOpen) {
      return { kind: "already-requested" } as const;
    }

    const requestedAt = new Date();
    const [created] = await tx
      .insert(escrowRelease)
      .values({
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        // ---------------------------------------------------------------------------
        // THE SNAPSHOT. Read from the milestone HERE and never again. Editing the
        // milestone after this line changes nothing about what this release pays.
        // ---------------------------------------------------------------------------
        amountInCents: milestoneRow.escrowReleaseAmountInCents,
        currency: milestoneRow.currency,
        status: "requested",
        requestedByUserId: input.requestedByUserId,
        requestNote: input.requestNote,
        requestedAt,
      })
      .returning();

    if (!created) {
      throw new Error("requestEscrowRelease: insert returned no row");
    }

    await appendAuditEntry(tx, {
      projectId: input.projectId,
      eventKind: "escrow_release_requested",
      actorUserId: input.requestedByUserId,
      actorRoleSnapshot: input.requesterRoleSnapshot,
      actionLabel: "Requested an escrow release",
      targetLabel: `milestone ${milestoneRow.title}`,
      ...(input.requestNote === null ? {} : { detailNote: input.requestNote }),
      payload: {
        releaseId: created.id,
        milestoneId: milestoneRow.id,
        // The snapshot goes INTO THE CHAIN at request time, so the amount this release was
        // asked for is tamper-evident independently of the release row itself.
        snapshottedAmountInCents: created.amountInCents,
        currency: created.currency,
      },
      occurredAt: requestedAt,
    });

    return { kind: "requested", release: created, milestoneTitle: milestoneRow.title } as const;
  });

  switch (outcome.kind) {
    case "milestone-missing":
      return {
        success: false,
        error: { type: "MILESTONE_NOT_FOUND", milestoneId: input.milestoneId },
      };
    case "no-amount":
      return { success: false, error: { type: "MILESTONE_HAS_NO_RELEASE_AMOUNT" } };
    case "already-requested":
      return { success: false, error: { type: "RELEASE_ALREADY_REQUESTED" } };
    case "requested":
      return { success: true, value: toReleaseView(outcome.release, outcome.milestoneTitle) };
    default: {
      // Adding an outcome without handling it breaks the build, which is the point
      // (CLAUDE.md §3.2).
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled release request outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** What the approver was allowed to approve BY, recorded in the snapshot. */
type ApproverBasis = "platform_auditor" | "project_admin" | "project_founder_with_auditor";

interface ApproverStanding {
  readonly authorized: boolean;
  readonly basis: ApproverBasis | null;
}

/**
 * GATE 2. The approver holds the platform `audit_escrow` capability, or a project `admin`
 * role THEY DID NOT GRANT THEMSELVES (§4a, §7).
 *
 * The self-grant half is the one that is easy to forget and easy to exploit: four eyes
 * bought by a founder handing themselves the second role is one pair of eyes with extra
 * steps. `project_member.roleGrantedByUserId` plus its CHECK constraint makes it
 * structural, and an `admin` row with a NULL grantor is refused here as un-provenanced —
 * a row predating the column cannot prove it was not self-granted, and a payout gate is
 * the wrong place to give something the benefit of the doubt.
 *
 * A FOUNDER IS NOT AUTOMATICALLY AN APPROVER. §7 lists `admin` and `platform_auditor`, and
 * a founder approving their own project's payout with no second party is precisely the
 * arrangement this rule exists to prevent.
 */
async function resolveApproverStanding(
  projectId: string,
  approverUserId: string,
): Promise<ApproverStanding> {
  // CAPABILITY FIRST, RESOURCE SECOND — platform-role.service.ts's ordering rule. Reversed,
  // the route becomes an id oracle for anyone holding a session.
  const staffResult = await requirePlatformCapability(approverUserId, "audit_escrow");
  if (staffResult.success) {
    return { authorized: true, basis: "platform_auditor" };
  }

  const [membership] = await db
    .select({
      projectRole: projectMember.projectRole,
      status: projectMember.status,
      roleGrantedByUserId: projectMember.roleGrantedByUserId,
      userId: projectMember.userId,
    })
    .from(projectMember)
    .where(
      and(
        eq(projectMember.projectId, projectId),
        eq(projectMember.userId, approverUserId),
        eq(projectMember.status, "active"),
      ),
    );

  if (!membership || membership.projectRole !== "admin") {
    return { authorized: false, basis: null };
  }
  // Un-provenanced or self-granted: not a second pair of eyes.
  if (
    membership.roleGrantedByUserId === null ||
    membership.roleGrantedByUserId === membership.userId
  ) {
    return { authorized: false, basis: null };
  }

  return { authorized: true, basis: "project_admin" };
}

/**
 * GATE 4. §9's dispute windows, PROJECT-WIDE.
 *
 * §7 requires "the 24-hour dispute window is closed with zero open disputes" before money
 * leaves escrow, and §9 models both as `slice_allocation_proposal.status`. `open` means a
 * window that has not expired; `disputed` means one somebody objected to. Either state
 * means the project's effort record is not settled, and paying out against an unsettled
 * effort record is the fraud §7's whole verification chain exists to prevent.
 *
 * PROJECT-WIDE rather than milestone-scoped, which is a deliberate reading of §7's literal
 * wording: there is no link between a milestone and a §9 claim in either spec, and
 * inventing one would leave every unlinked milestone vacuously gated.
 */
interface EffortWindowState {
  readonly openCount: number;
  readonly disputedCount: number;
  readonly proposalIds: readonly string[];
}

async function readEffortWindowState(projectId: string): Promise<EffortWindowState> {
  const rows = await db
    .select({ id: sliceAllocationProposal.id, status: sliceAllocationProposal.status })
    .from(sliceAllocationProposal)
    .where(
      and(
        eq(sliceAllocationProposal.projectId, projectId),
        inArray(sliceAllocationProposal.status, ["open", "disputed"]),
      ),
    );

  return {
    openCount: rows.filter((row) => row.status === "open").length,
    disputedCount: rows.filter((row) => row.status === "disputed").length,
    // Named, not just counted: an auditor reading the snapshot a year later needs to know
    // WHICH windows were open, and a bare count is unfalsifiable.
    proposalIds: rows.map((row) => row.id).toSorted(),
  };
}

/**
 * `POST /escrow-releases/:id/approve` — the transaction every gate above guards.
 *
 * `approverUserId` comes from the session. There is no field for it, and the request body
 * carries `{ note }` and nothing else.
 */
export async function approveEscrowRelease(input: {
  readonly releaseId: string;
  readonly approverUserId: string;
  readonly note: string;
}): Promise<Result<EscrowReleaseView, EscrowReleaseError>> {
  const [existing] = await db
    .select({ release: escrowRelease, milestoneRow: milestone })
    .from(escrowRelease)
    .innerJoin(milestone, eq(milestone.id, escrowRelease.milestoneId))
    .where(eq(escrowRelease.id, input.releaseId));

  if (!existing) {
    return { success: false, error: { type: "RELEASE_NOT_FOUND", releaseId: input.releaseId } };
  }

  const { release, milestoneRow } = existing;

  if (release.status !== "requested") {
    return { success: false, error: { type: "RELEASE_ALREADY_DECIDED", status: release.status } };
  }

  // --- GATE 1. Requester ≠ approver, EVEN FOR A FOUNDER. Checked before anything else,
  // --- because it is the cheapest and the one whose failure needs no other context.
  if (release.requestedByUserId === input.approverUserId) {
    return { success: false, error: { type: "SELF_APPROVAL_FORBIDDEN" } };
  }

  // --- GATE 2. The approver's standing.
  const approver = await resolveApproverStanding(release.projectId, input.approverUserId);
  if (!approver.authorized) {
    return { success: false, error: { type: "APPROVER_NOT_AUTHORIZED" } };
  }

  // --- GATE 3. The milestone is actually finished.
  if (milestoneRow.status !== "done") {
    return { success: false, error: { type: "MILESTONE_NOT_DONE", status: milestoneRow.status } };
  }

  // --- GATE 4. §9's windows are settled.
  const windows = await readEffortWindowState(release.projectId);
  if (windows.openCount > 0 || windows.disputedCount > 0) {
    return {
      success: false,
      error: {
        type: "EFFORT_WINDOWS_OPEN",
        openCount: windows.openCount,
        disputedCount: windows.disputedCount,
      },
    };
  }

  // --- GATE 5. The money is actually there. RE-DERIVED from the postings, never read from
  // --- `escrow_account.cachedBalanceInCents`: a cache that is stale in the permissive
  // --- direction pays out money the project does not have.
  const availableInCents = await deriveAvailableEscrowInCents(release.projectId);
  if (availableInCents < release.amountInCents) {
    return {
      success: false,
      error: {
        type: "INSUFFICIENT_ESCROW",
        availableInCents: availableInCents.toString(),
        requiredInCents: release.amountInCents.toString(),
      },
    };
  }

  const decidedAt = new Date();

  // THE EVIDENCE, frozen. Canonical JSON so the bytes an auditor reads a year from now are
  // the bytes that were recorded — `jsonb` would reorder keys and normalize numbers, and
  // the snapshot would no longer be a quotation.
  const verificationSnapshot: CanonicalValue = {
    schemaVersion: 1n,
    decidedAt,
    requesterUserId: release.requestedByUserId,
    approverUserId: input.approverUserId,
    approverBasis: approver.basis,
    milestoneId: milestoneRow.id,
    milestoneStatus: milestoneRow.status,
    milestoneCompletedAt: milestoneRow.completedAt,
    snapshottedAmountInCents: release.amountInCents,
    // What the pool actually held at the moment of the decision, not what a cache said.
    availableEscrowInCents: availableInCents,
    openAllocationWindowCount: BigInt(windows.openCount),
    disputedAllocationWindowCount: BigInt(windows.disputedCount),
    openAllocationProposalIds: windows.proposalIds,
    currency: release.currency,
  };

  const approved = await db.transaction(async (tx) => {
    // The payout leg. `payoutDestinationId` resolves from the PROJECT, never from a body.
    const transfer = await createTransfer(tx, {
      projectId: release.projectId,
      direction: "outbound",
      amountInCents: release.amountInCents,
      currency: release.currency,
      payoutDestinationId: resolvePayoutDestinationId(release.projectId),
    });

    const entry = await appendJournalEntry(tx, {
      projectId: release.projectId,
      currency: release.currency,
      kind: "milestone_release",
      // SERVER-COMPOSED prose, exactly as §7's example spells it.
      description: `Milestone release — ${milestoneRow.title}`,
      // `settled` immediately: this is an INTERNAL movement out of the pool, decided by a
      // human on our own books. Whether the cash then reaches the project's bank is the
      // outbound transfer's business, and the ledger is authoritative for entitlement
      // while the provider is authoritative for cash (§7).
      settlement: "settled",
      occurredAt: decidedAt,
      postings: [
        { accountKind: "escrow_held", signedAmountInCents: -release.amountInCents },
        { accountKind: "released_to_project", signedAmountInCents: release.amountInCents },
      ],
      linkedMilestoneId: milestoneRow.id,
      linkedReleaseId: release.id,
      createdByUserId: input.approverUserId,
      auditEventKind: "escrow_release_approved",
      actorRoleSnapshot: approver.basis ?? "unknown",
      auditActionLabel: "Approved an escrow release",
      auditTargetLabel: `milestone ${milestoneRow.title}`,
      auditDetailNote: input.note,
    });

    // The status predicate in the WHERE is the concurrency control: two approvers racing,
    // and only one UPDATE matches. The partial unique index on `approved` is the backstop.
    const [row] = await tx
      .update(escrowRelease)
      .set({
        status: "approved",
        decidedByUserId: input.approverUserId,
        decisionNote: input.note,
        decidedAt,
        verificationSnapshot: canonicalizeDocument(verificationSnapshot),
        journalEntryId: entry.id,
        providerTransferId: transfer.id,
      })
      .where(and(eq(escrowRelease.id, input.releaseId), eq(escrowRelease.status, "requested")))
      .returning();

    if (!row) {
      // Someone else decided it between the read and here. Roll the journal entry back
      // with the transaction rather than leaving a payout nothing points at.
      throw new Error(`approveEscrowRelease: release ${input.releaseId} was decided concurrently`);
    }
    return row;
  });

  return { success: true, value: toReleaseView(approved, milestoneRow.title) };
}

/**
 * `POST /escrow-releases/:id/reject` — the same four-eyes and standing gates as approval.
 *
 * Rejection moves no money, so gates 3–5 do not apply: a release can be rejected precisely
 * BECAUSE the milestone is not done or the escrow is short, and requiring those checks to
 * pass before someone may say no would trap the request open forever.
 */
export async function rejectEscrowRelease(input: {
  readonly releaseId: string;
  readonly approverUserId: string;
  readonly note: string;
}): Promise<Result<EscrowReleaseView, EscrowReleaseError>> {
  const [existing] = await db
    .select({ release: escrowRelease, milestoneRow: milestone })
    .from(escrowRelease)
    .innerJoin(milestone, eq(milestone.id, escrowRelease.milestoneId))
    .where(eq(escrowRelease.id, input.releaseId));

  if (!existing) {
    return { success: false, error: { type: "RELEASE_NOT_FOUND", releaseId: input.releaseId } };
  }
  if (existing.release.status !== "requested") {
    return {
      success: false,
      error: { type: "RELEASE_ALREADY_DECIDED", status: existing.release.status },
    };
  }
  if (existing.release.requestedByUserId === input.approverUserId) {
    return { success: false, error: { type: "SELF_APPROVAL_FORBIDDEN" } };
  }

  const approver = await resolveApproverStanding(existing.release.projectId, input.approverUserId);
  if (!approver.authorized) {
    return { success: false, error: { type: "APPROVER_NOT_AUTHORIZED" } };
  }

  const decidedAt = new Date();
  const verificationSnapshot: CanonicalValue = {
    schemaVersion: 1n,
    decidedAt,
    outcome: "rejected",
    requesterUserId: existing.release.requestedByUserId,
    approverUserId: input.approverUserId,
    approverBasis: approver.basis,
    milestoneId: existing.milestoneRow.id,
    milestoneStatus: existing.milestoneRow.status,
    snapshottedAmountInCents: existing.release.amountInCents,
    currency: existing.release.currency,
  };

  const rejected = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(escrowRelease)
      .set({
        status: "rejected",
        decidedByUserId: input.approverUserId,
        decisionNote: input.note,
        decidedAt,
        verificationSnapshot: canonicalizeDocument(verificationSnapshot),
      })
      .where(and(eq(escrowRelease.id, input.releaseId), eq(escrowRelease.status, "requested")))
      .returning();

    if (!row) {
      throw new Error(`rejectEscrowRelease: release ${input.releaseId} was decided concurrently`);
    }

    await appendAuditEntry(tx, {
      projectId: existing.release.projectId,
      eventKind: "escrow_release_rejected",
      actorUserId: input.approverUserId,
      actorRoleSnapshot: approver.basis ?? "unknown",
      actionLabel: "Rejected an escrow release",
      targetLabel: `milestone ${existing.milestoneRow.title}`,
      detailNote: input.note,
      payload: {
        releaseId: row.id,
        milestoneId: existing.milestoneRow.id,
        snapshottedAmountInCents: row.amountInCents,
        currency: row.currency,
      },
      occurredAt: decidedAt,
    });

    return row;
  });

  return { success: true, value: toReleaseView(rejected, existing.milestoneRow.title) };
}

/**
 * Where an approved release's money is said to go.
 *
 * A STUB WITH A HONEST NAME. §7 requires the destination to resolve from the project's
 * registered provider account rather than from a request, and Appendix A3 defers the
 * provider that would issue such an account — so there is nothing real to resolve to yet.
 * Returning a deterministic project-scoped identifier keeps the COLUMN populated and the
 * shape correct, and makes the Stripe swap a change to this one function.
 *
 * It is emphatically NOT a bank account, and no client may present it as one.
 */
function resolvePayoutDestinationId(projectId: string): string {
  return `internal_payout_${projectId}`;
}

export async function listProjectEscrowReleases(
  projectId: string,
  options: { readonly limit?: number | undefined } = {},
): Promise<readonly EscrowReleaseView[]> {
  const limit = Math.min(options.limit ?? 50, 200);

  const rows = await db
    .select({ release: escrowRelease, milestoneTitle: milestone.title })
    .from(escrowRelease)
    .innerJoin(milestone, eq(milestone.id, escrowRelease.milestoneId))
    .where(eq(escrowRelease.projectId, projectId))
    // §4c rule 4: ends in a unique column.
    .orderBy(desc(escrowRelease.requestedAt), desc(escrowRelease.id))
    .limit(limit);

  return rows.map((row) => toReleaseView(row.release, row.milestoneTitle));
}

/** A release with its project, for the routes keyed on `releaseId` rather than a slug. */
export async function findReleaseProject(
  releaseId: string,
): Promise<{ readonly projectId: string; readonly projectSlug: string } | null> {
  const [row] = await db
    .select({ projectId: escrowRelease.projectId, projectSlug: researchProject.slug })
    .from(escrowRelease)
    .innerJoin(researchProject, eq(researchProject.id, escrowRelease.projectId))
    .where(eq(escrowRelease.id, releaseId));

  return row ?? null;
}

/** Count of releases a project has ever had approved — a §11c summary figure. */
export async function countApprovedReleases(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(escrowRelease)
    .where(and(eq(escrowRelease.projectId, projectId), eq(escrowRelease.status, "approved")));

  return row?.total ?? 0;
}
