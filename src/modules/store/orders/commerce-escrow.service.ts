import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "#src/db/index.js";
import {
  commerceConnectorOutbox,
  commerceEscrowMilestone,
  commerceExternalEscrowSession,
  commerceOrder,
  commerceSettlementAgreement,
  commerceSettlementAgreementMilestone,
} from "#src/db/schema.js";
import { logger } from "#src/lib/logger.js";
import {
  claimConnectorOutboxRow,
  completeConnectorOutboxRow,
  enqueueConnectorCommand,
  failConnectorOutboxRow,
  loadProviderById,
  markConnectorWebhookProcessed,
  recordConnectorWebhookEvent,
  scheduleConnectorDispatch,
  type CommerceConnectorError,
} from "#src/modules/store/fulfillment/commerce-connector.service.js";
import {
  appendCommerceJournalEntry,
  recognizeCommission,
} from "#src/modules/store/orders/commerce-journal.service.js";
import {
  mintEscrowIdempotencyKey,
  resolveExternalEscrowProvider,
  type EscrowMilestonePlanEntry,
  type ExternalEscrowProviderAdapter,
  type NormalizedEscrowEvent,
  type NormalizedEscrowSessionState,
} from "#src/modules/store/storefront/external-escrow-provider.adapter.js";
import type { Result } from "#src/types/index.js";

/**
 * External escrow orchestration (STORE Phase 14).
 *
 * ## The one rule
 *
 * `applyNormalizedEscrowEvent` is the ONLY function in this backend that moves a settlement
 * balance. Commands do not. A release request tells the provider what we would like; it
 * does not credit anybody, because at that moment nothing has happened to the money.
 *
 * That is why the reconciler does not have its own apply path: it POLLS for an event the
 * webhook did not bring and hands it to the same function. A poll and a webhook being two
 * ways to move money would disagree in precisely the case that matters — a redelivery
 * racing a reconciliation — and one of them would double-post.
 *
 * ## What this service does not decide
 *
 * Whether an order uses escrow at all, and with whom, is settled by the two parties in
 * `commerce-settlement.service.ts`. By the time anything here runs, an agreement has been
 * proposed by one organization and accepted by the other.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EscrowSessionRow = typeof commerceExternalEscrowSession.$inferSelect;
type EscrowMilestoneRow = typeof commerceEscrowMilestone.$inferSelect;

export type CommerceEscrowError =
  | CommerceConnectorError
  | { type: "SESSION_NOT_FOUND" }
  | { type: "MILESTONE_NOT_FOUND" }
  | { type: "AGREEMENT_NOT_USABLE"; reason: string }
  | { type: "EVENT_NOT_APPLICABLE"; reason: string };

/**
 * How long a session may sit in a non-terminal state before the reconciler polls it.
 *
 * Generous on purpose. A buyer funding an escrow at their bank is not a fast operation, and
 * polling an untouched session every hour would produce noise rather than information.
 */
const SESSION_POLL_AFTER_MS = 6 * 60 * 60 * 1000;

const NON_TERMINAL_SESSION_STATES = [
  "created",
  "awaiting_funding",
  "funded",
  "partially_released",
] as const;

/**
 * The provider's vocabulary and the column's differ in exactly one place.
 *
 * `awaiting_agreement` is a state at the PROVIDER — a session exists there but the parties
 * have not both signed at its end. From this side that is indistinguishable from `created`:
 * the row exists and no money has been committed to it. Everything else maps across
 * unchanged, which is the whole point of normalizing at the adapter rather than storing a
 * provider's own state string.
 */
function toSessionStateColumn(state: NormalizedEscrowSessionState): EscrowSessionRow["state"] {
  return state === "awaiting_agreement" ? "created" : state;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export interface CreateEscrowSessionInput {
  readonly orderId: string;
  readonly agreementId: string;
  readonly providerId: string;
  readonly currency: string;
  readonly totalInCents: number;
}

/**
 * Creates the local session and its milestone commitments, and enqueues the provider call.
 *
 * MILESTONES ARE COPIED FROM THE AGREEMENT, NOT JOINED TO IT. Once money is locked at a
 * provider, a later agreement revision must not be able to rewrite what was locked. The
 * agreement is the negotiation; these rows are the commitment, and they are allowed to
 * diverge the moment somebody proposes a change to a live order.
 *
 * Runs inside the caller's transaction — normally `confirmCheckout`'s — so a session can
 * never exist without the order that justified it.
 */
export async function createEscrowSessionForOrder(
  transaction: DatabaseTransaction,
  input: CreateEscrowSessionInput,
): Promise<Result<{ readonly sessionId: string; readonly outboxId: string }, CommerceEscrowError>> {
  const planRows = await transaction
    .select()
    .from(commerceSettlementAgreementMilestone)
    .where(eq(commerceSettlementAgreementMilestone.agreementId, input.agreementId))
    .orderBy(commerceSettlementAgreementMilestone.sequence);

  if (planRows.length === 0) {
    return {
      success: false,
      error: { type: "AGREEMENT_NOT_USABLE", reason: "agreement_has_no_milestones" },
    };
  }

  const planTotal = planRows.reduce((runningTotal, row) => runningTotal + row.amountInCents, 0);
  if (planTotal !== input.totalInCents) {
    /**
     * Re-checked here even though a deferred trigger already enforces it against the
     * AGREEMENT total. This compares against the ORDER total, which is a different number
     * the moment an agreement was negotiated before the cart changed.
     */
    return {
      success: false,
      error: { type: "AGREEMENT_NOT_USABLE", reason: "milestones_do_not_sum_to_order_total" },
    };
  }

  const [session] = await transaction
    .insert(commerceExternalEscrowSession)
    .values({
      orderId: input.orderId,
      agreementId: input.agreementId,
      providerId: input.providerId,
      state: "created",
      currency: input.currency,
      totalInCents: input.totalInCents,
    })
    .returning({ id: commerceExternalEscrowSession.id });
  if (!session) throw new Error("createEscrowSessionForOrder: session insert returned no row");

  const milestoneRows = await transaction
    .insert(commerceEscrowMilestone)
    .values(
      planRows.map((planRow) => ({
        sessionId: session.id,
        agreementMilestoneId: planRow.id,
        sequence: planRow.sequence,
        milestoneKind: planRow.milestoneKind,
        amountInCents: planRow.amountInCents,
        currency: planRow.currency,
        state: "planned" as const,
      })),
    )
    .returning({
      id: commerceEscrowMilestone.id,
      sequence: commerceEscrowMilestone.sequence,
      milestoneKind: commerceEscrowMilestone.milestoneKind,
      amountInCents: commerceEscrowMilestone.amountInCents,
    });

  const plan: readonly EscrowMilestonePlanEntry[] = milestoneRows
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((row, index) => ({
      milestoneId: row.id,
      sequence: row.sequence,
      milestoneKind: row.milestoneKind,
      amountInCents: row.amountInCents,
      releaseConditionNote: planRows[index]?.releaseConditionNote ?? null,
    }));

  const enqueued = await enqueueConnectorCommand(transaction, {
    providerId: input.providerId,
    connectorKind: "external_escrow",
    kind: "escrow_create_session",
    orderId: input.orderId,
    escrowSessionId: session.id,
    escrowMilestoneId: null,
    idempotencyKey: mintEscrowIdempotencyKey("session"),
    requestPayload: {
      sessionId: session.id,
      orderId: input.orderId,
      currency: input.currency,
      totalInCents: input.totalInCents,
      milestones: plan,
    },
  });

  return { success: true, value: { sessionId: session.id, outboxId: enqueued.outboxId } };
}

// ---------------------------------------------------------------------------
// Outbox dispatch
// ---------------------------------------------------------------------------

/**
 * The outbox payload is data THIS backend wrote, but it is still parsed rather than cast.
 * It has been sitting in a table across a deploy, so the code reading it is not necessarily
 * the code that wrote it -- and a cast would turn a shape change into an undefined field
 * that reaches a provider as a malformed command instead of a loud failure.
 */
const EscrowCommandPayloadSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    currency: z.string().optional(),
    totalInCents: z.number().int().optional(),
    milestoneId: z.string().min(1).optional(),
    amountInCents: z.number().int().optional(),
    milestones: z
      .array(
        z.object({
          milestoneId: z.string().min(1),
          sequence: z.number().int().positive(),
          milestoneKind: z.enum(["deposit", "shipment", "inspection", "delivery", "final"]),
          amountInCents: z.number().int().positive(),
          releaseConditionNote: z.string().nullable(),
        }),
      )
      .optional(),
  })
  .strip();

type OutboxCommandPayload = z.infer<typeof EscrowCommandPayloadSchema>;

/**
 * Drains one connector outbox row.
 *
 * NOTHING HERE POSTS TO THE LEDGER. The adapter's answer updates provider references and
 * command state only. Even when a provider replies "released" to a release request, that
 * reply is an acknowledgement of the instruction; the release is recorded when the
 * provider's event says the money moved.
 */
export async function processConnectorOutboxRow(
  outboxId: string,
): Promise<Result<{ readonly processed: boolean }, CommerceEscrowError>> {
  const claimed = await db.transaction(async (transaction) =>
    claimConnectorOutboxRow(transaction, outboxId),
  );

  switch (claimed.status) {
    case "missing":
      return { success: false, error: { type: "OUTBOX_ROW_MISSING" } };
    case "terminal_failed":
      return { success: false, error: { type: "OUTBOX_TERMINAL" } };
    case "already_done":
    case "not_ready":
    case "race":
      return { success: true, value: { processed: false } };
    case "claimed":
      break;
    default: {
      const exhaustiveClaim: never = claimed;
      throw new Error(`Unhandled outbox claim: ${JSON.stringify(exhaustiveClaim)}`);
    }
  }

  const outboxRow = claimed.row;
  const providerLoaded = await loadProviderById(outboxRow.providerId);
  if (!providerLoaded.success) {
    await db.transaction(async (transaction) => {
      await failConnectorOutboxRow(transaction, {
        outboxId,
        attemptCount: outboxRow.attemptCount,
        lastError: `provider_unavailable:${providerLoaded.error.type}`,
        // A suspended or deleted provider will not become available by retrying.
        terminal: true,
      });
    });
    return { success: false, error: providerLoaded.error };
  }

  const adapterResolved = resolveExternalEscrowProvider(providerLoaded.value.providerSlug);
  if (!adapterResolved.success) {
    await db.transaction(async (transaction) => {
      await failConnectorOutboxRow(transaction, {
        outboxId,
        attemptCount: outboxRow.attemptCount,
        lastError: `adapter_unavailable:${adapterResolved.error.type}`,
        terminal: true,
      });
    });
    return {
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", reason: "escrow adapter is not available" },
    };
  }

  const dispatched = await dispatchEscrowCommand(adapterResolved.value, outboxRow);

  if (!dispatched.success) {
    await db.transaction(async (transaction) => {
      await failConnectorOutboxRow(transaction, {
        outboxId,
        attemptCount: outboxRow.attemptCount,
        lastError: dispatched.error,
        terminal: dispatched.terminal,
      });
    });
    return {
      success: false,
      error: { type: "PROVIDER_REJECTED", reason: dispatched.error },
    };
  }

  await db.transaction(async (transaction) => {
    await completeConnectorOutboxRow(transaction, outboxId);
  });
  return { success: true, value: { processed: true } };
}

interface DispatchOutcome {
  readonly success: boolean;
  readonly error: string;
  readonly terminal: boolean;
}

async function dispatchEscrowCommand(
  adapter: ExternalEscrowProviderAdapter,
  outboxRow: typeof commerceConnectorOutbox.$inferSelect,
): Promise<DispatchOutcome> {
  const parsedPayload = EscrowCommandPayloadSchema.safeParse(
    JSON.parse(outboxRow.requestPayloadJson),
  );
  if (!parsedPayload.success) {
    // Terminal: a payload this row will never carry differently is not worth retrying.
    return { success: false, error: "outbox_payload_schema_invalid", terminal: true };
  }
  const payload = parsedPayload.data;

  switch (outboxRow.kind) {
    case "escrow_create_session":
      return dispatchCreateSession(adapter, outboxRow, payload);
    case "escrow_lock_milestones":
    case "escrow_submit_verification":
    case "escrow_request_release":
    case "escrow_request_refund":
      return dispatchMilestoneCommand(adapter, outboxRow);
    default: {
      const exhaustiveKind: never = outboxRow.kind;
      throw new Error(`Unhandled connector command: ${JSON.stringify(exhaustiveKind)}`);
    }
  }
}

async function dispatchCreateSession(
  adapter: ExternalEscrowProviderAdapter,
  outboxRow: typeof commerceConnectorOutbox.$inferSelect,
  payload: OutboxCommandPayload,
): Promise<DispatchOutcome> {
  const sessionId = outboxRow.escrowSessionId;
  if (sessionId === null) {
    return { success: false, error: "create_session_without_session_id", terminal: true };
  }

  const context = await loadSessionContext(sessionId);
  if (context === null) {
    return { success: false, error: "session_row_missing", terminal: true };
  }

  const created = await adapter.createSession({
    idempotencyKey: outboxRow.idempotencyKey,
    sessionId,
    orderId: context.session.orderId,
    currency: context.session.currency,
    totalInCents: context.session.totalInCents,
    buyerOrganizationLegalName: context.buyerLegalName,
    sellerOrganizationLegalName: context.sellerLegalName,
    escrowFeeBearer: context.escrowFeeBearer,
    milestones: payload.milestones ?? [],
  });

  if (!created.success) {
    // A rejected plan will be rejected again identically; only availability is retryable.
    const terminal = created.error.type !== "PROVIDER_UNAVAILABLE";
    return { success: false, error: created.error.type, terminal };
  }

  await db.transaction(async (transaction) => {
    await transaction
      .update(commerceExternalEscrowSession)
      .set({
        providerSessionRef: created.value.providerSessionRef,
        hostedActionUrl: created.value.hostedActionUrl,
        state: created.value.state === "funded" ? "funded" : "awaiting_funding",
        updatedAt: new Date(),
      })
      .where(eq(commerceExternalEscrowSession.id, sessionId));

    for (const milestone of created.value.milestones) {
      await transaction
        .update(commerceEscrowMilestone)
        .set({
          providerMilestoneRef: milestone.providerMilestoneRef,
          state: "locked",
          lockedAt: new Date(),
        })
        .where(
          and(
            eq(commerceEscrowMilestone.sessionId, sessionId),
            eq(commerceEscrowMilestone.sequence, milestone.sequence),
          ),
        );
    }
  });

  return { success: true, error: "", terminal: false };
}

async function dispatchMilestoneCommand(
  adapter: ExternalEscrowProviderAdapter,
  outboxRow: typeof commerceConnectorOutbox.$inferSelect,
): Promise<DispatchOutcome> {
  const milestoneId = outboxRow.escrowMilestoneId;
  if (milestoneId === null) {
    return { success: false, error: "milestone_command_without_milestone_id", terminal: true };
  }

  const [milestone] = await db
    .select()
    .from(commerceEscrowMilestone)
    .where(eq(commerceEscrowMilestone.id, milestoneId))
    .limit(1);
  if (!milestone) return { success: false, error: "milestone_row_missing", terminal: true };
  if (milestone.providerMilestoneRef === null) {
    // The session has not been created at the provider yet; this command is early, not wrong.
    return { success: false, error: "milestone_has_no_provider_ref_yet", terminal: false };
  }

  const [session] = await db
    .select()
    .from(commerceExternalEscrowSession)
    .where(eq(commerceExternalEscrowSession.id, milestone.sessionId))
    .limit(1);
  if (!session?.providerSessionRef) {
    return { success: false, error: "session_has_no_provider_ref_yet", terminal: false };
  }

  const commandResult = await runMilestoneCommand(adapter, outboxRow.kind, {
    idempotencyKey: outboxRow.idempotencyKey,
    providerSessionRef: session.providerSessionRef,
    providerMilestoneRef: milestone.providerMilestoneRef,
    amountInCents: milestone.amountInCents,
    currency: milestone.currency,
  });
  if (!commandResult.success) {
    const terminal = commandResult.error.type !== "PROVIDER_UNAVAILABLE";
    return { success: false, error: commandResult.error.type, terminal };
  }

  /**
   * The command's own state is recorded, and nothing else. `release_requested` says we
   * asked — the money is still the provider's until its event says otherwise.
   */
  await db
    .update(commerceEscrowMilestone)
    .set({
      state: commandResult.value.state,
      releaseRequestedAt:
        outboxRow.kind === "escrow_request_release" ? new Date() : milestone.releaseRequestedAt,
      verificationSubmittedAt:
        outboxRow.kind === "escrow_submit_verification"
          ? new Date()
          : milestone.verificationSubmittedAt,
      updatedAt: new Date(),
    })
    .where(eq(commerceEscrowMilestone.id, milestoneId));

  return { success: true, error: "", terminal: false };
}

async function runMilestoneCommand(
  adapter: ExternalEscrowProviderAdapter,
  kind: (typeof commerceConnectorOutbox.$inferSelect)["kind"],
  args: {
    readonly idempotencyKey: string;
    readonly providerSessionRef: string;
    readonly providerMilestoneRef: string;
    readonly amountInCents: number;
    readonly currency: string;
  },
) {
  switch (kind) {
    case "escrow_request_release":
      return adapter.requestRelease(args);
    case "escrow_request_refund":
      return adapter.requestRefund({ ...args, reason: "buyer_refund_requested" });
    case "escrow_submit_verification":
      return adapter.submitVerification({
        idempotencyKey: args.idempotencyKey,
        providerSessionRef: args.providerSessionRef,
        providerMilestoneRef: args.providerMilestoneRef,
        sourceKind: "order_completion",
        sourceId: args.providerMilestoneRef,
        evidenceSummary: "fulfillment recorded by Qatoto",
      });
    case "escrow_lock_milestones":
    case "escrow_create_session":
      throw new Error(`runMilestoneCommand: ${kind} is not a milestone command`);
    default: {
      const exhaustiveKind: never = kind;
      throw new Error(`Unhandled milestone command: ${JSON.stringify(exhaustiveKind)}`);
    }
  }
}

interface SessionContext {
  readonly session: EscrowSessionRow;
  readonly buyerLegalName: string;
  readonly sellerLegalName: string;
  readonly escrowFeeBearer: "buyer" | "seller" | "split";
}

async function loadSessionContext(sessionId: string): Promise<SessionContext | null> {
  const [row] = await db
    .select({
      session: commerceExternalEscrowSession,
      buyerLegalName: commerceOrder.buyerLegalNameSnapshot,
      sellerLegalName: commerceOrder.counterpartyLegalNameSnapshot,
      escrowFeeBearer: commerceSettlementAgreement.escrowFeeBearer,
    })
    .from(commerceExternalEscrowSession)
    .innerJoin(commerceOrder, eq(commerceOrder.id, commerceExternalEscrowSession.orderId))
    .innerJoin(
      commerceSettlementAgreement,
      eq(commerceSettlementAgreement.id, commerceExternalEscrowSession.agreementId),
    )
    .where(eq(commerceExternalEscrowSession.id, sessionId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Event application — the ONLY place a settlement balance moves
// ---------------------------------------------------------------------------

export interface ApplyEscrowEventInput {
  readonly providerId: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly event: NormalizedEscrowEvent;
  readonly rawPayload: unknown;
}

/**
 * Persists the event, then applies it — in that order, in one transaction.
 *
 * PERSIST BEFORE PROCESSING is what makes a replay harmless: the unique
 * `(provider_id, provider_event_id)` index turns a second delivery into a no-op that still
 * answers 200. Without it, an at-least-once provider would double-post every release it
 * retried.
 */
export async function applyNormalizedEscrowEvent(
  input: ApplyEscrowEventInput,
): Promise<
  Result<{ readonly applied: boolean; readonly deduplicated: boolean }, CommerceEscrowError>
> {
  return db.transaction(async (transaction) => {
    const [session] = await transaction
      .select()
      .from(commerceExternalEscrowSession)
      .where(
        and(
          eq(commerceExternalEscrowSession.providerId, input.providerId),
          eq(commerceExternalEscrowSession.providerSessionRef, input.event.providerSessionRef),
        ),
      )
      .for("update");

    const recorded = await recordConnectorWebhookEvent(transaction, {
      providerId: input.providerId,
      connectorKind: "external_escrow",
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      orderId: session?.orderId ?? null,
      escrowSessionId: session?.id ?? null,
      payload: input.rawPayload,
    });

    if (recorded.deduplicated) {
      return { success: true, value: { applied: false, deduplicated: true } };
    }

    if (!session) {
      /**
       * Recorded and marked processed with an error rather than rejected. A provider event
       * for a session we do not know about is a fact worth keeping — it is how a
       * misconfigured signing secret or a crossed-over sandbox account gets noticed — and
       * refusing it would make the provider retry forever.
       */
      await markConnectorWebhookProcessed(transaction, recorded.eventId, "session_not_found");
      return { success: false, error: { type: "SESSION_NOT_FOUND" } };
    }

    const applied = await applyEventToSession(transaction, session, input.event);
    await markConnectorWebhookProcessed(
      transaction,
      recorded.eventId,
      applied.success ? null : applied.error.type,
    );
    if (!applied.success) return applied;

    return { success: true, value: { applied: true, deduplicated: false } };
  });
}

async function applyEventToSession(
  transaction: DatabaseTransaction,
  session: EscrowSessionRow,
  event: NormalizedEscrowEvent,
): Promise<Result<true, CommerceEscrowError>> {
  const occurredAt = new Date();

  switch (event.kind) {
    case "session_funded":
      return applySessionFunded(transaction, session, event.fundedAmountInCents, occurredAt);

    case "milestone_released":
      return applyMilestoneMovement(transaction, {
        session,
        providerMilestoneRef: event.providerMilestoneRef,
        amountInCents: event.releasedAmountInCents,
        direction: "released",
        occurredAt,
      });

    case "milestone_refunded":
      return applyMilestoneMovement(transaction, {
        session,
        providerMilestoneRef: event.providerMilestoneRef,
        amountInCents: event.refundedAmountInCents,
        direction: "refunded",
        occurredAt,
      });

    case "milestone_state_changed": {
      await transaction
        .update(commerceEscrowMilestone)
        .set({ state: event.state, updatedAt: occurredAt })
        .where(
          and(
            eq(commerceEscrowMilestone.sessionId, session.id),
            eq(commerceEscrowMilestone.providerMilestoneRef, event.providerMilestoneRef),
          ),
        );
      return { success: true, value: true };
    }

    case "session_state_changed": {
      /**
       * A bare state change posts nothing. `funded`, `released` and `refunded` all imply
       * money moved, and the amount is not in this event — accepting it as a movement
       * would mean inventing the figure. The money-bearing events carry their amounts.
       */
      await transaction
        .update(commerceExternalEscrowSession)
        .set({ state: toSessionStateColumn(event.state), updatedAt: occurredAt })
        .where(eq(commerceExternalEscrowSession.id, session.id));
      return { success: true, value: true };
    }

    case "dispute_opened": {
      await transaction
        .update(commerceExternalEscrowSession)
        .set({ state: "disputed", disputedAt: occurredAt, updatedAt: occurredAt })
        .where(eq(commerceExternalEscrowSession.id, session.id));
      await transaction
        .update(commerceOrder)
        .set({ state: "disputed", updatedAt: occurredAt })
        .where(
          and(
            eq(commerceOrder.id, session.orderId),
            inArray(commerceOrder.state, ["confirmed", "in_fulfillment", "partially_completed"]),
          ),
        );
      return { success: true, value: true };
    }

    case "dispute_resolved": {
      /**
       * The outcome does not itself move money. Whichever way it went, the provider emits
       * the corresponding `milestone_released` / `milestone_refunded` events carrying the
       * amounts — and a `split` emits both. Posting from this event would double-count.
       */
      await transaction
        .update(commerceExternalEscrowSession)
        .set({ state: "funded", updatedAt: occurredAt })
        .where(eq(commerceExternalEscrowSession.id, session.id));
      return { success: true, value: true };
    }

    default: {
      const exhaustiveEvent: never = event;
      throw new Error(`Unhandled escrow event: ${JSON.stringify(exhaustiveEvent)}`);
    }
  }
}

async function applySessionFunded(
  transaction: DatabaseTransaction,
  session: EscrowSessionRow,
  fundedAmountInCents: number,
  occurredAt: Date,
): Promise<Result<true, CommerceEscrowError>> {
  if (session.fundedAt !== null) {
    // Already funded. Not an error — a provider may restate a funding it already sent.
    return { success: true, value: true };
  }
  if (fundedAmountInCents !== session.totalInCents) {
    return {
      success: false,
      error: {
        type: "EVENT_NOT_APPLICABLE",
        reason: "funded_amount_does_not_match_session_total",
      },
    };
  }

  await transaction
    .update(commerceExternalEscrowSession)
    .set({ state: "funded", fundedAt: occurredAt, updatedAt: occurredAt })
    .where(eq(commerceExternalEscrowSession.id, session.id));

  await appendCommerceJournalEntry(transaction, {
    orderId: session.orderId,
    currency: session.currency,
    kind: "escrow_funded",
    description: "Buyer funded the external escrow session",
    settlement: "settled",
    occurredAt,
    lines: [
      { accountKind: "settlement_funding_memo", signedAmountInCents: -BigInt(fundedAmountInCents) },
      { accountKind: "settlement_custody_memo", signedAmountInCents: BigInt(fundedAmountInCents) },
    ],
    // No acting user: the provider moved this money, not a person on this platform.
    createdByUserId: null,
  });

  /**
   * Funding is what confirms the order, and it is the escrow analogue of payment
   * settlement. `confirmedAt` is coalesced so a restated funding cannot move the velocity
   * clock Phase 13 reads.
   */
  await transaction
    .update(commerceOrder)
    .set({
      state: "confirmed",
      confirmedAt: sql`coalesce(${commerceOrder.confirmedAt}, ${occurredAt})`,
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(commerceOrder.id, session.orderId),
        inArray(commerceOrder.state, ["pending_payment", "payment_processing"]),
      ),
    );

  return { success: true, value: true };
}

async function applyMilestoneMovement(
  transaction: DatabaseTransaction,
  input: {
    readonly session: EscrowSessionRow;
    readonly providerMilestoneRef: string;
    readonly amountInCents: number;
    readonly direction: "released" | "refunded";
    readonly occurredAt: Date;
  },
): Promise<Result<true, CommerceEscrowError>> {
  const [milestone] = await transaction
    .select()
    .from(commerceEscrowMilestone)
    .where(
      and(
        eq(commerceEscrowMilestone.sessionId, input.session.id),
        eq(commerceEscrowMilestone.providerMilestoneRef, input.providerMilestoneRef),
      ),
    )
    .for("update");
  if (!milestone) return { success: false, error: { type: "MILESTONE_NOT_FOUND" } };

  if (milestone.state === "released" || milestone.state === "refunded") {
    // Terminal already. A redelivery of a movement we have posted must not post again.
    return { success: true, value: true };
  }
  if (input.amountInCents !== milestone.amountInCents) {
    return {
      success: false,
      error: { type: "EVENT_NOT_APPLICABLE", reason: "amount_does_not_match_milestone" },
    };
  }
  if (input.session.fundedAt === null) {
    return {
      success: false,
      error: { type: "EVENT_NOT_APPLICABLE", reason: "session_was_never_funded" },
    };
  }

  await transaction
    .update(commerceEscrowMilestone)
    .set({
      state: input.direction,
      releasedAt: input.direction === "released" ? input.occurredAt : null,
      refundedAt: input.direction === "refunded" ? input.occurredAt : null,
      updatedAt: input.occurredAt,
    })
    .where(eq(commerceEscrowMilestone.id, milestone.id));

  await appendCommerceJournalEntry(transaction, {
    orderId: input.session.orderId,
    currency: input.session.currency,
    kind: input.direction === "released" ? "escrow_released" : "escrow_refunded",
    description:
      input.direction === "released"
        ? `Escrow released milestone ${String(milestone.sequence)} to the seller`
        : `Escrow returned milestone ${String(milestone.sequence)} to the buyer`,
    settlement: "settled",
    occurredAt: input.occurredAt,
    lines: [
      { accountKind: "settlement_custody_memo", signedAmountInCents: -BigInt(input.amountInCents) },
      {
        accountKind:
          input.direction === "released" ? "settlement_released_memo" : "settlement_refunded_memo",
        signedAmountInCents: BigInt(input.amountInCents),
      },
    ],
    createdByUserId: null,
  });

  if (input.direction === "released") {
    await recognizeCommission(transaction, {
      orderId: input.session.orderId,
      currency: input.session.currency,
      releasedAmountInCents: input.amountInCents,
      occurredAt: input.occurredAt,
      description: "Platform commission recognized on an escrow release",
    });
  }

  await settleSessionIfComplete(transaction, input.session, input.occurredAt);
  return { success: true, value: true };
}

/**
 * Moves the session to a terminal state once no milestone is outstanding.
 *
 * `partially_released` is a real state and not a rounding of `funded`: a buyer looking at a
 * three-milestone order needs to see that one tranche is gone and two are still held.
 */
async function settleSessionIfComplete(
  transaction: DatabaseTransaction,
  session: EscrowSessionRow,
  occurredAt: Date,
): Promise<void> {
  const milestones = await transaction
    .select({ state: commerceEscrowMilestone.state })
    .from(commerceEscrowMilestone)
    .where(eq(commerceEscrowMilestone.sessionId, session.id));

  const outstanding = milestones.filter(
    (row) => row.state !== "released" && row.state !== "refunded" && row.state !== "cancelled",
  );
  const anyReleased = milestones.some((row) => row.state === "released");
  const anyRefunded = milestones.some((row) => row.state === "refunded");

  if (outstanding.length > 0) {
    if (anyReleased || anyRefunded) {
      await transaction
        .update(commerceExternalEscrowSession)
        .set({ state: "partially_released", updatedAt: occurredAt })
        .where(eq(commerceExternalEscrowSession.id, session.id));
    }
    return;
  }

  await transaction
    .update(commerceExternalEscrowSession)
    .set({
      state: anyReleased ? "released" : "refunded",
      releasedAt: anyReleased ? occurredAt : null,
      refundedAt: anyReleased ? null : occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceExternalEscrowSession.id, session.id));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Polls sessions whose next event has not arrived, and applies whatever the provider says
 * through the same path a webhook uses.
 *
 * A POLL IS NOT A SECOND WAY TO MOVE MONEY. It fetches the event the webhook did not
 * bring; `applyNormalizedEscrowEvent` still does the applying, and the inbox's uniqueness
 * still decides whether it counts. Synthetic event ids are derived from the session
 * reference and the observed state, so polling the same unchanged session twice dedups.
 */
export async function reconcileExternalEscrowSessions(
  limit = 50,
): Promise<{ readonly polled: number; readonly applied: number }> {
  const staleBefore = new Date(Date.now() - SESSION_POLL_AFTER_MS);

  const sessions = await db
    .select()
    .from(commerceExternalEscrowSession)
    .where(
      and(
        inArray(commerceExternalEscrowSession.state, [...NON_TERMINAL_SESSION_STATES]),
        lt(commerceExternalEscrowSession.updatedAt, staleBefore),
        sql`${commerceExternalEscrowSession.providerSessionRef} IS NOT NULL`,
      ),
    )
    .orderBy(commerceExternalEscrowSession.updatedAt, commerceExternalEscrowSession.id)
    .limit(limit);

  let appliedCount = 0;

  for (const session of sessions) {
    const providerSessionRef = session.providerSessionRef;
    if (providerSessionRef === null) continue;

    const providerLoaded = await loadProviderById(session.providerId);
    if (!providerLoaded.success) continue;

    const adapterResolved = resolveExternalEscrowProvider(providerLoaded.value.providerSlug);
    if (!adapterResolved.success) continue;

    const retrieved = await adapterResolved.value.retrieveSession(providerSessionRef);
    if (!retrieved.success) {
      logger.warn("escrow session poll failed", {
        sessionId: session.id,
        providerError: retrieved.error.type,
      });
      continue;
    }
    if (toSessionStateColumn(retrieved.value.state) === session.state) continue;

    const applied = await applyNormalizedEscrowEvent({
      providerId: session.providerId,
      providerEventId: `poll_${providerSessionRef}_${retrieved.value.state}`,
      eventType: "reconciler.session_state_changed",
      event: {
        kind: "session_state_changed",
        providerSessionRef,
        state: retrieved.value.state,
      },
      rawPayload: { source: "reconciler", observedState: retrieved.value.state },
    });
    if (applied.success && applied.value.applied) appliedCount += 1;
  }

  return { polled: sessions.length, applied: appliedCount };
}

/**
 * Requests release of every milestone whose condition an order has now satisfied.
 *
 * Called from the completion path. It ENQUEUES COMMANDS and posts nothing — the release is
 * recorded when the provider says the money moved, not when Qatoto decides it should.
 */
export async function requestEscrowReleaseForCompletedOrder(
  transaction: DatabaseTransaction,
  orderId: string,
): Promise<{ readonly requested: readonly string[] }> {
  const [session] = await transaction
    .select()
    .from(commerceExternalEscrowSession)
    .where(eq(commerceExternalEscrowSession.orderId, orderId))
    .for("update");
  if (!session || session.fundedAt === null) return { requested: [] };

  const releasable = await transaction
    .select()
    .from(commerceEscrowMilestone)
    .where(
      and(
        eq(commerceEscrowMilestone.sessionId, session.id),
        inArray(commerceEscrowMilestone.state, ["locked", "verification_pending"]),
      ),
    )
    .orderBy(commerceEscrowMilestone.sequence);

  const outboxIds: string[] = [];
  for (const milestone of releasable) {
    const enqueued = await enqueueConnectorCommand(transaction, {
      providerId: session.providerId,
      connectorKind: "external_escrow",
      kind: "escrow_request_release",
      orderId,
      escrowSessionId: session.id,
      escrowMilestoneId: milestone.id,
      idempotencyKey: mintEscrowIdempotencyKey("release"),
      requestPayload: {
        milestoneId: milestone.id,
        amountInCents: milestone.amountInCents,
        currency: milestone.currency,
      },
    });
    outboxIds.push(enqueued.outboxId);
  }

  return { requested: outboxIds };
}

/** Schedules dispatch for commands enqueued in a transaction that has now committed. */
export async function scheduleEscrowCommands(outboxIds: readonly string[]): Promise<void> {
  for (const outboxId of outboxIds) {
    await scheduleConnectorDispatch(outboxId);
  }
}

export type { EscrowMilestoneRow };
