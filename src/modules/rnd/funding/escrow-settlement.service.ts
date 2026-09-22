import { fundingRoundPledge, providerTransfer } from "#src/db/schema.js";
import type { PlatformAccessError } from "#src/modules/platform/roles/platform-role.service.js";
import { type ProviderTransferError } from "#src/modules/rnd/funding/escrow-provider-adapter.service.js";

/**
 * THE SETTLEMENT PATH (R_AND_D_BACKEND_STRUCTURE.md §7).
 *
 * **THIS FILE IS THE ONLY WRITER OF `funding_round.raisedAmountInCents`,
 * `funding_round.backersCount` AND THE SETTLED ACCOUNT BALANCES.** §7 states that as a
 * grep-able invariant, and it is: grep the repository for `raisedAmountInCents` and every
 * write is in this file, inside the transaction that appends the journal entry. No
 * controller and no user-facing service function touches them.
 *
 * If you are adding a second place those numbers move, you are removing the property that
 * makes the whole domain checkable. A pledge that increments a counter at request time and
 * a webhook that increments it again at settlement is not a bug you find in review; it is
 * a bug you find in a reconciliation report six weeks later, and by then the number has
 * been on an investor's screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT SETTLEMENT ACTUALLY WRITES, and why it is three entries rather than an UPDATE.
 *
 * §7 describes settlement as flipping `escrow_journal_entry.settlement` from `pending` to
 * `settled`, and four paragraphs later revokes UPDATE on that table. Both cannot hold. The
 * append-only rule wins because it is the one with a trigger behind it, so:
 *
 *   at pledge   entry A  `pledge_authorized`  pending   clearing −gross, held +net, fee +fee
 *   at settle   entry B  `reversal`           pending   the exact mirror of A
 *               entry C  `pledge_settled`     settled   the same postings as A, now real
 *   at failure  entry B' `pledge_failed`      failed    the exact mirror of A, and no C
 *
 * The in-flight figure returns to zero either way without a column being rewritten, and
 * the journal reads as a story an auditor can follow rather than a row whose history was
 * overwritten.
 *
 * NEVER TRUST A PAYLOAD'S AMOUNT OVER OUR OWN `provider_transfer` ROW (§7). The event
 * identifies WHICH transfer settled, not HOW MUCH. Every figure below is read from our
 * rows; the settle endpoint's body carries a note and nothing else.
 * ---------------------------------------------------------------------------
 */

export type SettlementError =
  | PlatformAccessError
  | ProviderTransferError
  | { type: "PLEDGE_NOT_FOUND"; transferId: string }
  | { type: "PLEDGE_NOT_PENDING"; status: (typeof fundingRoundPledge.$inferSelect)["status"] }
  | { type: "AUTHORIZING_ENTRY_MISSING"; pledgeId: string };

export interface SettlementResult {
  readonly pledgeId: string;
  readonly transferId: string;
  readonly outcome: "settled" | "failed";
  /** TRUE when the decision had already been recorded and nothing was written again. */
  readonly deduplicated: boolean;
  readonly raisedAmountInCents: string;
  readonly backersCount: number;
}

/** Transfers a settlement auditor has not decided yet — the work queue for §11c's row. */
export interface PendingSettlementView {
  readonly transferId: string;
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly pledgeId: string;
  readonly amountInCents: string;
  readonly currency: string;
  readonly status: (typeof providerTransfer.$inferSelect)["status"];
  readonly submittedAt: Date | null;
  readonly createdAt: Date;
}
