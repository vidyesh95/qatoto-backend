import { escrowRelease, milestone } from "#src/db/schema.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";

/**
 * MILESTONE RELEASE — THE FOUR-EYES RULE (R_AND_D_BACKEND_STRUCTURE.md §7).
 *
 * ```text
 * POST /milestones/:milestoneId/escrow-releases   body: { requestNote? }   ← NO amount field
 * ```
 *
 * The amount is read from `milestone.plannedPayoutInCents` and SNAPSHOTTED into
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
