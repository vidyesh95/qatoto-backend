import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  compensationPaymentRecord,
  compensationPeriod,
  compensationPeriodLine,
  projectMember,
  user,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import { containsPaymentInstrument } from "#src/modules/rnd/payment-instrument.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Payment ATTESTATIONS (R_AND_D_BACKEND_STRUCTURE.md §7A, §7A.5, §11g).
 *
 * ═══ NOTHING HERE MOVES MONEY, AND THAT IS THE PRODUCT ═══════════════════════════════
 *
 * The founder pays from their own bank or payroll provider. This records that they say
 * they did. Qatoto holds no funds, controls no balance and operates no payout rail — which
 * is what keeps it out of PSD2 authorisation in the EU, state money-transmitter licensing
 * plus FinCEN registration in the US, and RBI payment-aggregator authorisation in India
 * (§7A.6 item 1). None of that turns on whether a fee is charged. An unpaid escrow is
 * still an escrow; a record of a payment made elsewhere is bookkeeping software.
 *
 * ═══ TWO-SIDED CONFIRMATION IS WHAT MAKES THIS EVIDENCE ══════════════════════════════
 *
 * A founder recording "paid" is an assertion. A member confirming receipt is
 * corroboration. The pair, hash-chained against a frozen statement line, is the artifact
 * that answers "was this person paid what they were owed, and when" — the question a
 * labour inspector, an acquirer's diligence team, or an aggrieved ex-employee actually
 * asks. **The UI must show unconfirmed payments as unconfirmed and never as paid.**
 *
 * ═══ NO PAYMENT INSTRUMENT IS EVER STORED ════════════════════════════════════════════
 *
 * No account number, no IBAN, no UPI handle, no card detail. The `.strict()` schema
 * rejects those KEYS outright (§7A's rejected-keys list); `containsPaymentInstrument`
 * (src/modules/rnd/payment-instrument.ts) rejects the VALUES, because a founder pasting a full
 * card number into a free-text reference field is a mistake rather than an attack and
 * deserves a 422 rather than a silent PCI-DSS scope expansion. Both, not either: a
 * rejected-key list is defeated by putting the value somewhere else.
 *
 * RECORDING A PAYMENT CHANGES NO LINE. `paidAmountInCents` may differ from the line's
 * gross — a partial payment is a fact, and forcing it to match would make the record lie
 * about what happened.
 */

export type CompensationPaymentMethodKey =
  (typeof compensationPaymentRecord.$inferSelect)["methodKey"];

export type CompensationPaymentError =
  | ProjectAccessError
  | { type: "LINE_NOT_FOUND"; lineId: string }
  | { type: "PAYMENT_NOT_FOUND"; paymentId: string }
  | { type: "LINE_NOT_FINALIZED" }
  | { type: "LINE_IS_NOT_CASH"; kind: string }
  | { type: "PAYMENT_ALREADY_CONFIRMED" }
  | { type: "NOT_THE_PAID_MEMBER" }
  | { type: "PAYMENT_INSTRUMENT_IN_REFERENCE_NOTE" };

export interface RecordPaymentInput {
  readonly paidAmountInCents: bigint;
  /** Calendar day, `YYYY-MM-DD` — the day the payer says the money left. */
  readonly paidOnDate: string;
  readonly methodKey: CompensationPaymentMethodKey;
  readonly referenceNote: string | null;
  readonly idempotencyKey: string;
}

export interface CompensationPaymentView {
  readonly id: string;
  readonly lineId: string;
  /** Decimal STRING, never a JS number (§4b). */
  readonly paidAmountInCents: string;
  readonly currency: string;
  readonly paidOnDate: string;
  readonly methodKey: CompensationPaymentMethodKey;
  readonly referenceNote: string | null;
  readonly recordedByUserId: string;
  /**
   * NULL until the member confirms. A client rendering this as "paid" while it is null is
   * telling someone they were paid on one party's word alone (§7A).
   */
  readonly confirmedByMemberAt: Date | null;
  readonly confirmedByUserId: string | null;
  readonly createdAt: Date;
}

type PaymentRow = typeof compensationPaymentRecord.$inferSelect;

function toPaymentView(row: PaymentRow): CompensationPaymentView {
  return {
    id: row.id,
    lineId: row.lineId,
    paidAmountInCents: row.paidAmountInCents.toString(),
    currency: row.currency,
    paidOnDate: row.paidOnDate,
    methodKey: row.methodKey,
    referenceNote: row.referenceNote,
    recordedByUserId: row.recordedByUserId,
    confirmedByMemberAt: row.confirmedByMemberAt,
    confirmedByUserId: row.confirmedByUserId,
    createdAt: row.createdAt,
  };
}

interface PayableLine {
  readonly lineId: string;
  readonly projectId: string;
  readonly memberId: string;
  readonly memberUserId: string;
  readonly kind: string;
  readonly currency: string | null;
  readonly periodStatus: (typeof compensationPeriod.$inferSelect)["status"];
}

async function findPayableLine(projectId: string, lineId: string): Promise<PayableLine | null> {
  const [row] = await db
    .select({
      lineId: compensationPeriodLine.id,
      projectId: compensationPeriodLine.projectId,
      memberId: compensationPeriodLine.memberId,
      memberUserId: projectMember.userId,
      kind: compensationPeriodLine.kind,
      currency: compensationPeriodLine.currency,
      periodStatus: compensationPeriod.status,
    })
    .from(compensationPeriodLine)
    .innerJoin(compensationPeriod, eq(compensationPeriod.id, compensationPeriodLine.periodId))
    .innerJoin(projectMember, eq(projectMember.id, compensationPeriodLine.memberId))
    .where(
      // BOTH columns: a line id from another project must be indistinguishable from a
      // nonexistent one, or this becomes a cross-tenant probe.
      and(eq(compensationPeriodLine.id, lineId), eq(compensationPeriodLine.projectId, projectId)),
    );

  return row ?? null;
}

/**
 * `POST …/compensation-period-lines/:lineId/payments` — founder or admin attests.
 *
 * ONLY AGAINST A FINALIZED LINE. An open period is redrawn nightly, so recording a payment
 * against one would attest to a number that changes overnight — and the receipt would end
 * up describing an amount nobody ever owed.
 *
 * ONLY AGAINST A CASH LINE. An `equity_delta` line is a statement of entitlement, not an
 * obligation to pay anything, and §7A.6 item 4 is explicit that nothing in this domain
 * issues a share. "Paying" one is a category error the schema should not permit.
 */
export async function recordPayment(
  context: { readonly projectId: string },
  lineId: string,
  recordedByUserId: string,
  actorRoleSnapshot: string,
  input: RecordPaymentInput,
): Promise<Result<CompensationPaymentView, CompensationPaymentError>> {
  if (input.referenceNote !== null && containsPaymentInstrument(input.referenceNote)) {
    return { success: false, error: { type: "PAYMENT_INSTRUMENT_IN_REFERENCE_NOTE" } };
  }

  const line = await findPayableLine(context.projectId, lineId);
  if (!line) {
    return { success: false, error: { type: "LINE_NOT_FOUND", lineId } };
  }
  if (line.periodStatus === "open") {
    return { success: false, error: { type: "LINE_NOT_FINALIZED" } };
  }
  // Bound to a local because narrowing on a property does not survive into the closure
  // below — TypeScript cannot prove nothing mutated `line` in between.
  const lineCurrency = line.currency;
  if (line.kind === "equity_delta" || lineCurrency === null) {
    return { success: false, error: { type: "LINE_IS_NOT_CASH", kind: line.kind } };
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(compensationPaymentRecord)
        .values({
          lineId,
          projectId: context.projectId,
          paidAmountInCents: input.paidAmountInCents,
          // SERVER-DERIVED from the line, never from the body (§4b). An attestation in a
          // currency the line was never denominated in is not a payment of that line.
          currency: lineCurrency,
          paidOnDate: input.paidOnDate,
          methodKey: input.methodKey,
          referenceNote: input.referenceNote,
          recordedByUserId,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();

      if (!inserted) {
        throw new Error("recordPayment: insert returned no row");
      }

      // The member is the one who has to CONFIRM it, and until they do the UI shows the
      // payment as unconfirmed rather than paid (§7A.5). A confirmation nobody is asked
      // for is a statement line that stays open forever.
      await enqueueNotifications(tx, recordedByUserId, [
        {
          recipientUserId: line.memberUserId,
          kind: "compensation_payment_recorded",
          projectId: context.projectId,
          // No amount: it is on the line, behind membership.
          payload: { paymentId: inserted.id, lineId },
        },
      ]);

      await appendAuditEntry(tx, {
        projectId: context.projectId,
        eventKind: "compensation_payment_recorded",
        actorUserId: recordedByUserId,
        actorRoleSnapshot,
        actionLabel: "Recorded a payment made off-platform",
        targetLabel: `line ${lineId}`,
        detailNote: input.referenceNote ?? undefined,
        payload: {
          paymentId: inserted.id,
          lineId,
          memberId: line.memberId,
          paidAmountInCents: input.paidAmountInCents,
          currency: lineCurrency,
          paidOnDate: input.paidOnDate,
          methodKey: input.methodKey,
        },
        occurredAt: inserted.createdAt,
      });

      return inserted;
    });

    return { success: true, value: toPaymentView(created) };
  } catch (error: unknown) {
    // The (line_id, idempotency_key) unique. A retried POST across a flaky network must
    // not record the same payment twice — "did I already tell it I paid this?" is exactly
    // the question the retry cannot answer for itself.
    if (isUniqueViolation(error)) {
      const [existing] = await db
        .select()
        .from(compensationPaymentRecord)
        .where(
          and(
            eq(compensationPaymentRecord.lineId, lineId),
            eq(compensationPaymentRecord.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) {
        return { success: true, value: toPaymentView(existing) };
      }
    }
    throw error;
  }
}

/**
 * `POST …/compensation-period-lines/:lineId/payments/:paymentId/confirm` — THE MEMBER
 * ONLY, and never the person who recorded it.
 *
 * This is the half that turns a claim into a record. Without it the statement says a
 * founder asserted a payment; with it, the person who was supposed to receive the money
 * says they received it.
 */
export async function confirmPayment(
  context: { readonly projectId: string },
  lineId: string,
  paymentId: string,
  confirmingUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<CompensationPaymentView, CompensationPaymentError>> {
  const line = await findPayableLine(context.projectId, lineId);
  if (!line) {
    return { success: false, error: { type: "LINE_NOT_FOUND", lineId } };
  }

  const [payment] = await db
    .select()
    .from(compensationPaymentRecord)
    .where(
      and(
        eq(compensationPaymentRecord.id, paymentId),
        eq(compensationPaymentRecord.lineId, lineId),
        eq(compensationPaymentRecord.projectId, context.projectId),
      ),
    );

  if (!payment) {
    return { success: false, error: { type: "PAYMENT_NOT_FOUND", paymentId } };
  }
  // The subject of the line, and nobody else. A founder confirming their own attestation
  // would make the pair one assertion wearing two hats.
  if (line.memberUserId !== confirmingUserId) {
    return { success: false, error: { type: "NOT_THE_PAID_MEMBER" } };
  }
  if (payment.confirmedByMemberAt !== null) {
    return { success: false, error: { type: "PAYMENT_ALREADY_CONFIRMED" } };
  }

  const confirmed = await db.transaction(async (tx) => {
    const confirmedAt = new Date();
    const [next] = await tx
      .update(compensationPaymentRecord)
      .set({ confirmedByMemberAt: confirmedAt, confirmedByUserId: confirmingUserId })
      .where(
        and(
          eq(compensationPaymentRecord.id, paymentId),
          // Re-asserted inside the transaction: a concurrent confirm would otherwise hit
          // the once-only trigger and surface as a 500 rather than a 409.
          sql`${compensationPaymentRecord.confirmedByMemberAt} IS NULL`,
        ),
      )
      .returning();

    if (!next) {
      return null;
    }

    // Back to whoever attested the payment. The founder is waiting on exactly this — it
    // is what turns "recorded" into evidence that both sides agree (§7A.5).
    await enqueueNotifications(tx, confirmingUserId, [
      {
        recipientUserId: next.recordedByUserId,
        kind: "compensation_payment_confirmed",
        projectId: context.projectId,
        payload: { paymentId, lineId },
      },
    ]);

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "compensation_payment_confirmed",
      actorUserId: confirmingUserId,
      actorRoleSnapshot,
      actionLabel: "Confirmed receipt of a payment",
      targetLabel: `payment ${paymentId}`,
      payload: {
        paymentId,
        lineId,
        memberId: line.memberId,
        paidAmountInCents: next.paidAmountInCents,
        currency: next.currency,
        paidOnDate: next.paidOnDate,
      },
      occurredAt: confirmedAt,
    });

    return next;
  });

  if (!confirmed) {
    return { success: false, error: { type: "PAYMENT_ALREADY_CONFIRMED" } };
  }

  return { success: true, value: toPaymentView(confirmed) };
}

/** Every payment attested against a period's lines, for the statement read. */
export async function listPaymentsForPeriod(
  periodId: string,
): Promise<readonly CompensationPaymentView[]> {
  const rows = await db
    .select({ payment: compensationPaymentRecord })
    .from(compensationPaymentRecord)
    .innerJoin(
      compensationPeriodLine,
      eq(compensationPeriodLine.id, compensationPaymentRecord.lineId),
    )
    .where(eq(compensationPeriodLine.periodId, periodId))
    // Ends in a unique column so two payments recorded in the same millisecond never swap
    // places between reads (§4c rule 4).
    .orderBy(asc(compensationPaymentRecord.paidOnDate), asc(compensationPaymentRecord.id));

  return rows.map((row) => toPaymentView(row.payment));
}

export interface ProjectPaymentView extends CompensationPaymentView {
  readonly memberUserId: string;
  readonly memberName: string;
  readonly lineKind: string;
  readonly periodStartDate: string;
}

/**
 * Every payment recorded across a project — what `GET …/compensation` renders as
 * "actually paid" now that the escrow release table no longer answers that question.
 */
export async function listProjectPayments(
  projectId: string,
): Promise<readonly ProjectPaymentView[]> {
  const rows = await db
    .select({
      payment: compensationPaymentRecord,
      memberUserId: projectMember.userId,
      memberName: user.name,
      lineKind: compensationPeriodLine.kind,
      periodStartDate: compensationPeriod.periodStartDate,
    })
    .from(compensationPaymentRecord)
    .innerJoin(
      compensationPeriodLine,
      eq(compensationPeriodLine.id, compensationPaymentRecord.lineId),
    )
    .innerJoin(compensationPeriod, eq(compensationPeriod.id, compensationPeriodLine.periodId))
    .innerJoin(projectMember, eq(projectMember.id, compensationPeriodLine.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(eq(compensationPaymentRecord.projectId, projectId))
    .orderBy(asc(compensationPaymentRecord.paidOnDate), asc(compensationPaymentRecord.id));

  return rows.map((row) => ({
    ...toPaymentView(row.payment),
    memberUserId: row.memberUserId,
    memberName: row.memberName,
    lineKind: row.lineKind,
    periodStartDate: row.periodStartDate,
  }));
}
