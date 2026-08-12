import { and, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  escrowJournalEntry,
  fundingRound,
  fundingRoundPledge,
  providerTransfer,
} from "#src/db/schema.js";
import type { PlatformAccessError } from "#src/modules/platform/roles/platform-role.service.js";
import {
  markSettlementEventProcessed,
  recordSettlementEvent,
  type ProviderTransferError,
} from "#src/services/escrow-provider-adapter.service.js";
import { appendJournalEntry, appendReversingEntry } from "#src/services/escrow.service.js";

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

interface SettlementContext {
  readonly transfer: typeof providerTransfer.$inferSelect;
  readonly pledge: typeof fundingRoundPledge.$inferSelect;
}

/**
 * Loads and locks the transfer plus its pledge.
 *
 * `FOR UPDATE` on both: two auditors clicking settle at the same instant must serialize,
 * and the unique constraint on `provider_webhook_event` is the backstop rather than the
 * primary defence — a constraint violation rolls the whole transaction back, which is
 * correct but reads in the logs as an error rather than as a duplicate click.
 */
async function lockSettlementContext(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  transferId: string,
): Promise<SettlementContext | { readonly missing: "transfer" | "pledge" }> {
  const [transfer] = await tx
    .select()
    .from(providerTransfer)
    .where(eq(providerTransfer.id, transferId))
    .for("update");

  if (!transfer) {
    return { missing: "transfer" };
  }

  const [pledge] = await tx
    .select()
    .from(fundingRoundPledge)
    .where(eq(fundingRoundPledge.providerTransferId, transferId))
    .for("update");

  if (!pledge) {
    return { missing: "pledge" };
  }
  return { transfer, pledge };
}

/**
 * Settles or fails one inbound transfer, in ONE transaction.
 *
 * `decidedByUserId` is the auditor. The caller MUST have proven the `audit_escrow`
 * capability before reaching here — this function does not re-check it, and the ordering
 * matters: platform-role.service.ts requires the capability check to precede the resource
 * load, or the route becomes an id oracle for anyone holding a session.
 */
export async function decideSettlement(input: {
  readonly transferId: string;
  readonly outcome: "settled" | "failed";
  readonly decidedByUserId: string;
  readonly note: string | null;
  readonly failureReason?: string | undefined;
}): Promise<
  | { readonly success: true; readonly value: SettlementResult }
  | { readonly success: false; readonly error: SettlementError }
> {
  return db.transaction(async (tx) => {
    const context = await lockSettlementContext(tx, input.transferId);

    if ("missing" in context) {
      return context.missing === "transfer"
        ? ({
            success: false,
            error: { type: "TRANSFER_NOT_FOUND", transferId: input.transferId },
          } as const)
        : ({
            success: false,
            error: { type: "PLEDGE_NOT_FOUND", transferId: input.transferId },
          } as const);
    }

    const { transfer, pledge } = context;

    // A settled or failed transfer is terminal — in the status machine, in the trigger,
    // and here. Re-settling is how one pledge becomes two.
    if (transfer.status === "settled" || transfer.status === "failed") {
      const [round] = await tx
        .select({
          raisedAmountInCents: fundingRound.raisedAmountInCents,
          backersCount: fundingRound.backersCount,
        })
        .from(fundingRound)
        .where(eq(fundingRound.id, pledge.roundId));

      return {
        success: true,
        value: {
          pledgeId: pledge.id,
          transferId: transfer.id,
          outcome: transfer.status === "settled" ? "settled" : "failed",
          deduplicated: true,
          raisedAmountInCents: (round?.raisedAmountInCents ?? 0n).toString(),
          backersCount: round?.backersCount ?? 0,
        },
      } as const;
    }

    if (pledge.status !== "pending") {
      return { success: false, error: { type: "PLEDGE_NOT_PENDING", status: pledge.status } };
    }

    // PERSIST THE EVENT BEFORE PROCESSING IT (§7's webhook discipline). A null id means
    // the decision was already recorded by a concurrent caller; answer success without
    // writing anything a second time.
    const eventId = await recordSettlementEvent(tx, {
      transferId: transfer.id,
      projectId: transfer.projectId,
      eventType: input.outcome === "settled" ? "transfer.settled" : "transfer.failed",
      decidedByUserId: input.decidedByUserId,
      note: input.note,
    });

    if (eventId === null) {
      const [round] = await tx
        .select({
          raisedAmountInCents: fundingRound.raisedAmountInCents,
          backersCount: fundingRound.backersCount,
        })
        .from(fundingRound)
        .where(eq(fundingRound.id, pledge.roundId));

      return {
        success: true,
        value: {
          pledgeId: pledge.id,
          transferId: transfer.id,
          outcome: input.outcome,
          deduplicated: true,
          raisedAmountInCents: (round?.raisedAmountInCents ?? 0n).toString(),
          backersCount: round?.backersCount ?? 0,
        },
      } as const;
    }

    // The authorizing entry. Found by its pledge link and kind rather than by an id stored
    // on the pledge: the journal is the record, and a pointer from a mutable row into an
    // immutable one is a pointer that can be edited to reverse the wrong entry.
    const [authorizingEntry] = await tx
      .select({ id: escrowJournalEntry.id })
      .from(escrowJournalEntry)
      .where(
        and(
          eq(escrowJournalEntry.linkedPledgeId, pledge.id),
          eq(escrowJournalEntry.kind, "pledge_authorized"),
        ),
      )
      .orderBy(escrowJournalEntry.sequenceNumber)
      .limit(1);

    if (!authorizingEntry) {
      return {
        success: false,
        error: { type: "AUTHORIZING_ENTRY_MISSING", pledgeId: pledge.id },
      };
    }

    const settledAt = new Date();
    const grossInCents = pledge.amountInCents;
    const netInCents = pledge.netToEscrowInCents;
    const feeInCents = pledge.platformFeeInCents;

    if (input.outcome === "failed") {
      // The mirror, and nothing else. Nothing ever entered the pool, so nothing leaves it.
      await appendReversingEntry(tx, {
        projectId: transfer.projectId,
        reversesJournalEntryId: authorizingEntry.id,
        kind: "pledge_failed",
        // SERVER-COMPOSED prose, so three clients cannot drift (§7).
        description: `Pledge declined — authorization released`,
        settlement: "failed",
        occurredAt: settledAt,
        createdByUserId: input.decidedByUserId,
        auditEventKind: "pledge_failed",
        actorRoleSnapshot: "platform_auditor",
        auditActionLabel: "Recorded a declined pledge",
        auditTargetLabel: `pledge ${pledge.id}`,
        ...(input.note === null ? {} : { auditDetailNote: input.note }),
      });

      await tx
        .update(providerTransfer)
        .set({
          status: "failed",
          failedAt: settledAt,
          failureReason: input.failureReason ?? "Declined by the settlement auditor",
          settlementDecidedByUserId: input.decidedByUserId,
        })
        .where(eq(providerTransfer.id, transfer.id));

      await tx
        .update(fundingRoundPledge)
        .set({ status: "failed" })
        .where(eq(fundingRoundPledge.id, pledge.id));

      await markSettlementEventProcessed(tx, eventId);

      const [round] = await tx
        .select({
          raisedAmountInCents: fundingRound.raisedAmountInCents,
          backersCount: fundingRound.backersCount,
        })
        .from(fundingRound)
        .where(eq(fundingRound.id, pledge.roundId));

      return {
        success: true,
        value: {
          pledgeId: pledge.id,
          transferId: transfer.id,
          outcome: "failed",
          deduplicated: false,
          raisedAmountInCents: (round?.raisedAmountInCents ?? 0n).toString(),
          backersCount: round?.backersCount ?? 0,
        },
      } as const;
    }

    // --- SETTLED. Entry B releases the authorization from the in-flight bucket…
    await appendReversingEntry(tx, {
      projectId: transfer.projectId,
      reversesJournalEntryId: authorizingEntry.id,
      kind: "reversal",
      description: `Pledge authorization released on settlement`,
      settlement: "pending",
      occurredAt: settledAt,
      createdByUserId: input.decidedByUserId,
      auditEventKind: "pledge_settled",
      actorRoleSnapshot: "platform_auditor",
      auditActionLabel: "Released a pledge authorization",
      auditTargetLabel: `pledge ${pledge.id}`,
    });

    // …and entry C is the money, for real. THIS is the write that moves a balance.
    await appendJournalEntry(tx, {
      projectId: transfer.projectId,
      currency: pledge.currency,
      kind: "pledge_settled",
      description: `Pledge settled — ${pledge.currency} ${grossInCents.toString()} gross`,
      settlement: "settled",
      occurredAt: settledAt,
      postings: [
        // The outside world is the source of funds, so it is a credit. See the sign
        // convention at the head of the §7 block in src/db/schema.ts.
        { accountKind: "provider_clearing", signedAmountInCents: -grossInCents },
        { accountKind: "escrow_held", signedAmountInCents: netInCents },
        ...(feeInCents === 0n
          ? []
          : [{ accountKind: "platform_fee" as const, signedAmountInCents: feeInCents }]),
      ],
      linkedPledgeId: pledge.id,
      createdByUserId: input.decidedByUserId,
      auditEventKind: "pledge_settled",
      actorRoleSnapshot: "platform_auditor",
      auditActionLabel: "Settled a pledge",
      auditTargetLabel: `pledge ${pledge.id}`,
      ...(input.note === null ? {} : { auditDetailNote: input.note }),
    });

    await tx
      .update(providerTransfer)
      .set({
        status: "settled",
        settledAt,
        settlementDecidedByUserId: input.decidedByUserId,
      })
      .where(eq(providerTransfer.id, transfer.id));

    await tx
      .update(fundingRoundPledge)
      .set({ status: "settled", settledAt })
      .where(eq(fundingRoundPledge.id, pledge.id));

    // ---------------------------------------------------------------------------
    // THE ONLY PLACE THESE TWO COLUMNS EVER MOVE.
    //
    // The GROSS pledge counts toward the round's progress, not the net: a backer who
    // pledged $50 funded $50 of the goal, and quietly showing them $47.50 because the
    // platform took a fee is a number nobody asked for and everybody would misread.
    // ---------------------------------------------------------------------------
    const [updatedRound] = await tx
      .update(fundingRound)
      .set({
        raisedAmountInCents: sql`${fundingRound.raisedAmountInCents} + ${grossInCents}`,
        backersCount: sql`${fundingRound.backersCount} + 1`,
      })
      .where(eq(fundingRound.id, pledge.roundId))
      .returning({
        raisedAmountInCents: fundingRound.raisedAmountInCents,
        backersCount: fundingRound.backersCount,
      });

    await markSettlementEventProcessed(tx, eventId);

    return {
      success: true,
      value: {
        pledgeId: pledge.id,
        transferId: transfer.id,
        outcome: "settled",
        deduplicated: false,
        raisedAmountInCents: (updatedRound?.raisedAmountInCents ?? 0n).toString(),
        backersCount: updatedRound?.backersCount ?? 0,
      },
    } as const;
  });
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

export async function listPendingSettlements(options: {
  readonly projectId?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<readonly PendingSettlementView[]> {
  const limit = Math.min(options.limit ?? 50, 200);

  const filters = [
    eq(providerTransfer.direction, "inbound"),
    sql`${providerTransfer.status} IN ('created', 'submitted')`,
  ];
  if (options.projectId !== undefined) {
    filters.push(eq(providerTransfer.projectId, options.projectId));
  }

  const rows = await db
    .select({
      transferId: providerTransfer.id,
      projectId: providerTransfer.projectId,
      pledgeId: fundingRoundPledge.id,
      amountInCents: providerTransfer.amountInCents,
      currency: providerTransfer.currency,
      status: providerTransfer.status,
      submittedAt: providerTransfer.submittedAt,
      createdAt: providerTransfer.createdAt,
    })
    .from(providerTransfer)
    .innerJoin(fundingRoundPledge, eq(fundingRoundPledge.providerTransferId, providerTransfer.id))
    .where(and(...filters))
    // §4c rule 4: the ordering ends in a unique column, or a cursor skips rows.
    .orderBy(providerTransfer.createdAt, providerTransfer.id)
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    projectSlug: null,
    amountInCents: row.amountInCents.toString(),
  }));
}
