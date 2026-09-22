import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { providerTransfer, providerWebhookEvent } from "#src/db/schema.js";

/**
 * THE LEDGER-ONLY PROVIDER ADAPTER (R_AND_D_BACKEND_STRUCTURE.md §7 amendment, Appendix
 * A3).
 *
 * THIS MODULE IS THE ENTIRE SEAM. §7's design names Stripe Connect + Treasury, so that
 * Qatoto never custodies funds itself; that is deferred on cost, and everything around it
 * — the double-entry ledger, the zero-sum invariant, the hash chain, the four-eyes
 * release, the suspense account — ships for real. What is stubbed is the single outbound
 * call, and it is stubbed HERE so that switching Stripe on is an edit to one file plus one
 * signature-verified route, not a migration.
 *
 * **NO MONEY MOVES.** A pledge is a recorded intent; an escrow release is a recorded
 * entitlement. Do not ship a client that tells a backer their card was charged — §7 says
 * this in bold and it is the one thing in this domain that is a lie rather than a bug.
 *
 * THREE PROPERTIES SURVIVE THE SUBSTITUTION, which is why it is safe (§7):
 *
 *   1. Settlement is still EXACTLY ONE CODE PATH writing `raisedAmountInCents`,
 *      `backersCount` and the account balances — see escrow-settlement.service.ts.
 *   2. A pledge body still carries `{ amountInCents }` and nothing else.
 *   3. The ledger is authoritative for ENTITLEMENT while the adapter is authoritative for
 *      CASH, and `reconciliation_suspense` is where the two are allowed to differ.
 *
 * WHAT REPLACES THE WEBHOOK. `POST /webhooks/payments/stripe` does not exist: no route, no
 * raw-body mount, no signature verification, because adding a raw-body branch for a route
 * that does not exist is a security surface bought for nothing (§11). Settlement instead
 * flips through `POST /provider-transfers/:transferId/settle`, gated on the platform
 * `audit_escrow` capability. A HUMAN, not a timer and not the submitting worker — the
 * moment settlement becomes automatic, the audit story is that the system agreed with
 * itself.
 */

export type ProviderTransferRow = typeof providerTransfer.$inferSelect;

export type ProviderTransferError =
  | { type: "TRANSFER_NOT_FOUND"; transferId: string }
  | { type: "TRANSFER_NOT_SUBMITTABLE"; status: ProviderTransferRow["status"] }
  | { type: "TRANSFER_ALREADY_TERMINAL"; status: ProviderTransferRow["status"] };

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Mints the key BEFORE any provider call, because that is the only ordering in which a key
 * deduplicates anything (§7).
 *
 * A key minted after the call cannot deduplicate the call that just happened, which is the
 * entire failure mode idempotency keys exist for: the request timed out, we do not know
 * whether the money moved, and we have to be able to ask again without moving it twice.
 */
function mintIdempotencyKey(purpose: "pledge" | "payout"): string {
  return `${purpose}_${randomUUID()}`;
}

export interface CreateTransferInput {
  readonly projectId: string;
  readonly direction: ProviderTransferRow["direction"];
  readonly amountInCents: bigint;
  readonly currency: string;
  /** Outbound only, and resolved SERVER-SIDE. Never a request body field (§7). */
  readonly payoutDestinationId?: string | null | undefined;
}

/**
 * Writes the transfer row. Runs inside the caller's transaction, alongside the pledge or
 * release it belongs to, so a transfer never exists without the thing that justifies it.
 */
export async function createTransfer(
  tx: DatabaseExecutor,
  input: CreateTransferInput,
): Promise<ProviderTransferRow> {
  const [created] = await tx
    .insert(providerTransfer)
    .values({
      projectId: input.projectId,
      provider: "internal_adapter",
      direction: input.direction,
      status: "created",
      amountInCents: input.amountInCents,
      currency: input.currency,
      idempotencyKey: mintIdempotencyKey(input.direction === "inbound" ? "pledge" : "payout"),
      payoutDestinationId: input.payoutDestinationId ?? null,
    })
    .returning();

  if (!created) {
    throw new Error("createTransfer: insert returned no row");
  }
  return created;
}

/**
 * Records the adapter's "event" for a settlement decision, deduped by the same unique
 * constraint a real webhook would collide on.
 *
 * WHY THIS TABLE IS WRITTEN RATHER THAN RESERVED. A seam nobody exercises is a seam nobody
 * has tested. Running the internal path through `provider_webhook_event` means the
 * dedupe, the persist-before-process ordering and the replay-returns-200 behaviour are all
 * live today, and the Stripe route later adds signature verification in front of machinery
 * that already works.
 *
 * Returns `null` when the event was already recorded — the caller answers success without
 * processing, which is exactly §7's "return 200 for duplicates".
 */
export async function recordSettlementEvent(
  tx: DatabaseExecutor,
  input: {
    readonly transferId: string;
    readonly projectId: string;
    readonly eventType: "transfer.settled" | "transfer.failed";
    readonly decidedByUserId: string;
    readonly note: string | null;
  },
): Promise<string | null> {
  // Derived from the transfer and the outcome, NOT random: a replayed decision must
  // produce the same event id or the dedupe constraint never fires.
  const providerEventId = `evt_${input.eventType}_${input.transferId}`;

  const [inserted] = await tx
    .insert(providerWebhookEvent)
    .values({
      provider: "internal_adapter",
      providerEventId,
      eventType: input.eventType,
      projectId: input.projectId,
      providerTransferId: input.transferId,
      // Stored verbatim as text: evidence of what arrived, not a parsed opinion of it.
      payloadJson: JSON.stringify({
        transferId: input.transferId,
        eventType: input.eventType,
        decidedByUserId: input.decidedByUserId,
        note: input.note,
      }),
    })
    .onConflictDoNothing()
    .returning({ id: providerWebhookEvent.id });

  return inserted?.id ?? null;
}

/** Marks a recorded event processed, once its transaction has done the work. */
export async function markSettlementEventProcessed(
  tx: DatabaseExecutor,
  eventId: string,
): Promise<void> {
  await tx
    .update(providerWebhookEvent)
    .set({ processedAt: new Date() })
    .where(eq(providerWebhookEvent.id, eventId));
}
