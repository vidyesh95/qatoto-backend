import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  resolveCommercePaymentProvider,
  type CommercePaymentProviderError,
  type CommercePaymentProviderName,
  type NormalizedPaymentIntentState,
  type NormalizedRefundState,
} from "#src/adapters/commerce-payment-provider.adapter.js";
import { db } from "#src/db/index.js";
import {
  commerceOrder,
  commerceOrderProductLine,
  commerceOrganizationMember,
  commercePaymentIntent,
  commercePaymentOutbox,
  commercePaymentWebhookEvent,
  commerceProviderTransfer,
  commerceRefund,
} from "#src/db/schema.js";
import { sendJob, JOB_NAMES, idempotencyKeyFor } from "#src/lib/jobs.js";
import {
  evaluateBuyerQualification,
  type BuyerQualificationVerdict,
} from "#src/services/commerce-buyer-qualification.service.js";
import { appendCommerceJournalEntry } from "#src/services/commerce-journal.service.js";
import type { CommerceOrganizationMemberRole } from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PaymentIntentRow = typeof commercePaymentIntent.$inferSelect;
type RefundRow = typeof commerceRefund.$inferSelect;
type OrderRow = typeof commerceOrder.$inferSelect;
type TransferRow = typeof commerceProviderTransfer.$inferSelect;

export type CommercePaymentsError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "OVER_REFUND"; refundableInCents: number }
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string };

export interface CommercePaymentActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface PaymentIntentProjection {
  readonly id: string;
  readonly orderId: string;
  readonly state: PaymentIntentRow["state"];
  readonly amountInCents: number;
  readonly currency: string;
  readonly provider: CommercePaymentProviderName;
  readonly providerPaymentRef: string | null;
  readonly failureReason: string | null;
  readonly authorizedAt: Date | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RefundProjection {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly orderId: string;
  readonly state: RefundRow["state"];
  readonly amountInCents: number;
  readonly currency: string;
  readonly providerRefundRef: string | null;
  readonly reason: string | null;
  readonly failureReason: string | null;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
}

export interface CreatePaymentIntentOutcome {
  readonly paymentIntent: PaymentIntentProjection;
  readonly accepted: true;
}

export interface CreateRefundInput {
  readonly amountInCents?: number | undefined;
  readonly reason?: string | undefined;
}

const MAX_OUTBOX_ATTEMPTS = 8;
const OUTBOX_BACKOFF_BASE_MS = 5_000;

const BUYER_CREATE_PAYMENT_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "buyer",
  "finance",
];

const BUYER_REFUND_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "buyer",
  "finance",
];

const COUNTERPARTY_REFUND_ROLES: readonly CommerceOrganizationMemberRole[] = [
  "owner",
  "administrator",
  "seller",
  "provider_operator",
  "finance",
];

function projectPaymentIntent(row: PaymentIntentRow): PaymentIntentProjection {
  return {
    id: row.id,
    orderId: row.orderId,
    state: row.state,
    amountInCents: row.amountInCents,
    currency: row.currency,
    provider: row.provider,
    providerPaymentRef: row.providerPaymentRef,
    failureReason: row.failureReason,
    authorizedAt: row.authorizedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function projectRefund(row: RefundRow): RefundProjection {
  return {
    id: row.id,
    paymentIntentId: row.paymentIntentId,
    orderId: row.orderId,
    state: row.state,
    amountInCents: row.amountInCents,
    currency: row.currency,
    providerRefundRef: row.providerRefundRef,
    reason: row.reason,
    failureReason: row.failureReason,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce payment audit append failed: ${appended.error.type}`);
  }
}

function mapProviderResolutionError(error: CommercePaymentProviderError): CommercePaymentsError {
  switch (error.type) {
    case "PROVIDER_UNAVAILABLE":
      return { type: "PROVIDER_UNAVAILABLE", reason: error.reason };
    case "PROVIDER_REJECTED":
      return { type: "PROVIDER_REJECTED", reason: error.reason };
    case "PROVIDER_NOT_FOUND":
      return { type: "PROVIDER_REJECTED", reason: `provider_ref_not_found:${error.providerRef}` };
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled provider error: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function mintTransferIdempotencyKey(purpose: "payment" | "refund"): string {
  return `${purpose}_${randomUUID()}`;
}

function computeOutboxBackoffMs(attemptCount: number): number {
  const cappedAttempt = Math.min(attemptCount, 6);
  return OUTBOX_BACKOFF_BASE_MS * 2 ** cappedAttempt;
}

function mapNormalizedPaymentState(state: NormalizedPaymentIntentState): PaymentIntentRow["state"] {
  switch (state) {
    case "requires_action":
      return "requires_action";
    case "processing":
      return "processing";
    case "authorized":
      return "authorized";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const exhaustiveCheck: never = state;
      throw new Error(`Unhandled normalized payment state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function mapNormalizedRefundState(state: NormalizedRefundState): RefundRow["state"] {
  switch (state) {
    case "processing":
      return "processing";
    case "settled":
      return "settled";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default: {
      const exhaustiveCheck: never = state;
      throw new Error(`Unhandled normalized refund state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function enqueueOutboxDispatch(outboxId: string): Promise<void> {
  const enqueueResult = await sendJob(
    JOB_NAMES.dispatchCommerceWebhookEvent,
    { outboxId },
    { idempotencyKey: idempotencyKeyFor.dispatchCommerceWebhookEvent(outboxId) },
  );
  if (!enqueueResult.success) {
    // The scheduled reconciler will pick up pending outbox rows; do not roll back the
    // committed payment intent because the queue was briefly unavailable.
    console.error(
      `commerce-payments: failed to enqueue outbox ${outboxId}: ${enqueueResult.error.type}`,
    );
  }
}

/**
 * Creates a payment intent for an order in `pending_payment`.
 *
 * Amount/currency come from the immutable order snapshot. The local intent, transfer, and
 * outbox rows commit before any provider call; the worker drains the outbox.
 */
export async function createPaymentIntent(
  actor: CommercePaymentActorContext,
  orderId: string,
  requestIdempotencyKey: string,
): Promise<Result<CreatePaymentIntentOutcome, CommercePaymentsError>> {
  if (!BUYER_CREATE_PAYMENT_ROLES.includes(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const providerResolved = resolveCommercePaymentProvider();
  if (!providerResolved.success) {
    return { success: false, error: mapProviderResolutionError(providerResolved.error) };
  }
  const providerName = providerResolved.value.providerName;

  const existingByKey = await db
    .select()
    .from(commercePaymentIntent)
    .where(eq(commercePaymentIntent.idempotencyKey, requestIdempotencyKey))
    .limit(1);
  const priorIntent = existingByKey[0];
  if (priorIntent) {
    if (priorIntent.buyerOrganizationId !== actor.organizationId) {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
    return {
      success: true,
      value: { paymentIntent: projectPaymentIntent(priorIntent), accepted: true },
    };
  }

  const created = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };
    if (order.buyerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (order.state !== "pending_payment") {
      return {
        status: "invalid_state" as const,
        message: "Payment intents can only be created for orders awaiting payment.",
      };
    }
    if (order.totalInCents <= 0) {
      return {
        status: "invalid_state" as const,
        message: "Order total must be positive before payment.",
      };
    }

    const [activeIntent] = await transaction
      .select({ id: commercePaymentIntent.id })
      .from(commercePaymentIntent)
      .where(
        and(
          eq(commercePaymentIntent.orderId, order.id),
          inArray(commercePaymentIntent.state, [
            "created",
            "requires_action",
            "processing",
            "authorized",
            "settled",
            "partially_refunded",
            "refunded",
            "disputed",
          ]),
        ),
      )
      .limit(1);
    if (activeIntent) {
      return {
        status: "conflict" as const,
        message: "An active payment intent already exists for this order.",
      };
    }

    const now = new Date();
    const [intent] = await transaction
      .insert(commercePaymentIntent)
      .values({
        orderId: order.id,
        buyerOrganizationId: order.buyerOrganizationId,
        counterpartyOrganizationId: order.counterpartyOrganizationId,
        provider: providerName,
        state: "created",
        amountInCents: order.totalInCents,
        currency: order.currency,
        idempotencyKey: requestIdempotencyKey,
        createdByMemberId: actor.memberId,
      })
      .returning();
    if (!intent) {
      throw new Error("createPaymentIntent: intent insert returned no row");
    }

    const [transfer] = await transaction
      .insert(commerceProviderTransfer)
      .values({
        paymentIntentId: intent.id,
        orderId: order.id,
        provider: providerName,
        direction: "inbound",
        state: "created",
        amountInCents: intent.amountInCents,
        currency: intent.currency,
        idempotencyKey: mintTransferIdempotencyKey("payment"),
      })
      .returning();
    if (!transfer) {
      throw new Error("createPaymentIntent: transfer insert returned no row");
    }

    const [outbox] = await transaction
      .insert(commercePaymentOutbox)
      .values({
        kind: "submit_payment_intent",
        state: "pending",
        paymentIntentId: intent.id,
        transferId: transfer.id,
        orderId: order.id,
        availableAt: now,
      })
      .returning({ id: commercePaymentOutbox.id });
    if (!outbox) {
      throw new Error("createPaymentIntent: outbox insert returned no row");
    }

    await transaction
      .update(commerceOrder)
      .set({ state: "payment_processing", updatedAt: now })
      .where(and(eq(commerceOrder.id, order.id), eq(commerceOrder.state, "pending_payment")));

    await appendAuditOrThrow(transaction, {
      organizationId: order.buyerOrganizationId,
      eventKind: "payment_intent_created",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_payment_intent",
      targetEntityId: intent.id,
      payload: {
        orderId: order.id,
        amountInCents: String(intent.amountInCents),
        currency: intent.currency,
        provider: providerName,
      },
      occurredAt: now,
    });

    return { status: "created" as const, intent, outboxId: outbox.id };
  });

  switch (created.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE", message: created.message } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: created.message } };
    case "created":
      await enqueueOutboxDispatch(created.outboxId);
      return {
        success: true,
        value: { paymentIntent: projectPaymentIntent(created.intent), accepted: true },
      };
    default: {
      const exhaustiveCheck: never = created;
      throw new Error(`Unhandled createPaymentIntent outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Visible to the buyer or counterparty organization on the intent's order. */
export async function getPaymentIntent(
  actor: CommercePaymentActorContext,
  paymentIntentId: string,
): Promise<Result<PaymentIntentProjection, CommercePaymentsError>> {
  const [intent] = await db
    .select()
    .from(commercePaymentIntent)
    .where(eq(commercePaymentIntent.id, paymentIntentId))
    .limit(1);
  if (!intent) return { success: false, error: { type: "NOT_FOUND" } };
  if (
    intent.buyerOrganizationId !== actor.organizationId &&
    intent.counterpartyOrganizationId !== actor.organizationId
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  return { success: true, value: projectPaymentIntent(intent) };
}

async function sumActiveRefundsInCents(
  transaction: DatabaseTransaction,
  paymentIntentId: string,
): Promise<number> {
  const [row] = await transaction
    .select({
      total: sql<string>`coalesce(sum(${commerceRefund.amountInCents}), 0)`,
    })
    .from(commerceRefund)
    .where(
      and(
        eq(commerceRefund.paymentIntentId, paymentIntentId),
        inArray(commerceRefund.state, ["created", "processing", "settled"]),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Creates a refund against a settled (or partially refunded) payment intent.
 * Amount defaults to the remaining refundable balance when omitted.
 */
export async function createRefund(
  actor: CommercePaymentActorContext,
  orderId: string,
  requestIdempotencyKey: string,
  input: CreateRefundInput,
): Promise<Result<RefundProjection, CommercePaymentsError>> {
  const providerResolved = resolveCommercePaymentProvider();
  if (!providerResolved.success) {
    return { success: false, error: mapProviderResolutionError(providerResolved.error) };
  }
  const providerName = providerResolved.value.providerName;

  const existingByKey = await db
    .select()
    .from(commerceRefund)
    .where(eq(commerceRefund.idempotencyKey, requestIdempotencyKey))
    .limit(1);
  const priorRefund = existingByKey[0];
  if (priorRefund) {
    if (priorRefund.buyerOrganizationId !== actor.organizationId) {
      // Counterparty-created refunds store buyer org id; authorize by order membership below.
      const [order] = await db
        .select({
          buyerOrganizationId: commerceOrder.buyerOrganizationId,
          counterpartyOrganizationId: commerceOrder.counterpartyOrganizationId,
        })
        .from(commerceOrder)
        .where(eq(commerceOrder.id, priorRefund.orderId))
        .limit(1);
      if (
        !order ||
        (order.buyerOrganizationId !== actor.organizationId &&
          order.counterpartyOrganizationId !== actor.organizationId)
      ) {
        return { success: false, error: { type: "NOT_FOUND" } };
      }
    }
    return { success: true, value: projectRefund(priorRefund) };
  }

  const created = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };

    const isBuyer = order.buyerOrganizationId === actor.organizationId;
    const isCounterparty = order.counterpartyOrganizationId === actor.organizationId;
    if (!isBuyer && !isCounterparty) return { status: "not_found" as const };

    if (isBuyer && !BUYER_REFUND_ROLES.includes(actor.memberRole)) {
      return { status: "forbidden" as const };
    }
    if (isCounterparty && !COUNTERPARTY_REFUND_ROLES.includes(actor.memberRole)) {
      return { status: "forbidden" as const };
    }

    const [intent] = await transaction
      .select()
      .from(commercePaymentIntent)
      .where(
        and(
          eq(commercePaymentIntent.orderId, order.id),
          inArray(commercePaymentIntent.state, ["settled", "partially_refunded"]),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent) {
      return {
        status: "invalid_state" as const,
        message: "No settled payment intent is available to refund on this order.",
      };
    }
    if (!intent.providerPaymentRef) {
      return {
        status: "invalid_state" as const,
        message: "Payment intent is missing a provider reference.",
      };
    }

    const alreadyRefunded = await sumActiveRefundsInCents(transaction, intent.id);
    const refundableInCents = intent.amountInCents - alreadyRefunded;
    if (refundableInCents <= 0) {
      return { status: "over_refund" as const, refundableInCents: 0 };
    }

    const requestedAmount = input.amountInCents ?? refundableInCents;
    if (requestedAmount <= 0 || requestedAmount > refundableInCents) {
      return { status: "over_refund" as const, refundableInCents };
    }

    const now = new Date();
    const [refund] = await transaction
      .insert(commerceRefund)
      .values({
        paymentIntentId: intent.id,
        orderId: order.id,
        buyerOrganizationId: order.buyerOrganizationId,
        provider: providerName,
        state: "created",
        amountInCents: requestedAmount,
        currency: intent.currency,
        idempotencyKey: requestIdempotencyKey,
        reason: input.reason ?? null,
        createdByMemberId: actor.memberId,
      })
      .returning();
    if (!refund) {
      throw new Error("createRefund: refund insert returned no row");
    }

    const [transfer] = await transaction
      .insert(commerceProviderTransfer)
      .values({
        paymentIntentId: intent.id,
        refundId: refund.id,
        orderId: order.id,
        provider: providerName,
        direction: "outbound",
        state: "created",
        amountInCents: refund.amountInCents,
        currency: refund.currency,
        idempotencyKey: mintTransferIdempotencyKey("refund"),
      })
      .returning();
    if (!transfer) {
      throw new Error("createRefund: transfer insert returned no row");
    }

    const [outbox] = await transaction
      .insert(commercePaymentOutbox)
      .values({
        kind: "submit_refund",
        state: "pending",
        paymentIntentId: intent.id,
        refundId: refund.id,
        transferId: transfer.id,
        orderId: order.id,
        availableAt: now,
      })
      .returning({ id: commercePaymentOutbox.id });
    if (!outbox) {
      throw new Error("createRefund: outbox insert returned no row");
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "payment_refund_created",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_refund",
      targetEntityId: refund.id,
      payload: {
        orderId: order.id,
        paymentIntentId: intent.id,
        amountInCents: String(refund.amountInCents),
        currency: refund.currency,
      },
      occurredAt: now,
    });

    return { status: "created" as const, refund, outboxId: outbox.id };
  });

  switch (created.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE", message: created.message } };
    case "over_refund":
      return {
        success: false,
        error: { type: "OVER_REFUND", refundableInCents: created.refundableInCents },
      };
    case "created":
      await enqueueOutboxDispatch(created.outboxId);
      return { success: true, value: projectRefund(created.refund) };
    default: {
      const exhaustiveCheck: never = created;
      throw new Error(`Unhandled createRefund outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

async function recordWebhookEvent(
  transaction: DatabaseTransaction,
  input: {
    readonly provider: CommercePaymentProviderName;
    readonly providerEventId: string;
    readonly eventType: string;
    readonly paymentIntentId: string | null;
    readonly transferId: string | null;
    readonly refundId: string | null;
    readonly orderId: string | null;
    readonly payload: Readonly<Record<string, string | number | null>>;
  },
): Promise<{ readonly eventId: string; readonly deduplicated: boolean }> {
  const [inserted] = await transaction
    .insert(commercePaymentWebhookEvent)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      paymentIntentId: input.paymentIntentId,
      transferId: input.transferId,
      refundId: input.refundId,
      orderId: input.orderId,
      payloadJson: JSON.stringify(input.payload),
    })
    .onConflictDoNothing()
    .returning({ id: commercePaymentWebhookEvent.id });

  if (inserted) {
    return { eventId: inserted.id, deduplicated: false };
  }

  const [existing] = await transaction
    .select({ id: commercePaymentWebhookEvent.id })
    .from(commercePaymentWebhookEvent)
    .where(
      and(
        eq(commercePaymentWebhookEvent.provider, input.provider),
        eq(commercePaymentWebhookEvent.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("recordWebhookEvent: conflict without existing row");
  }
  return { eventId: existing.id, deduplicated: true };
}

async function markWebhookProcessed(
  transaction: DatabaseTransaction,
  eventId: string,
  processingError: string | null,
): Promise<void> {
  await transaction
    .update(commercePaymentWebhookEvent)
    .set({
      processedAt: new Date(),
      processingError,
    })
    .where(
      and(
        eq(commercePaymentWebhookEvent.id, eventId),
        sql`${commercePaymentWebhookEvent.processedAt} IS NULL`,
      ),
    );
}

async function applyPaymentSettlement(
  transaction: DatabaseTransaction,
  intent: PaymentIntentRow,
  transfer: TransferRow,
  order: OrderRow,
  providerPaymentRef: string,
  occurredAt: Date,
): Promise<void> {
  const amount = BigInt(intent.amountInCents);

  // Fake (and immediate) settlement posts one settled entry. A future real processor that
  // separates authorize from capture should append authorize → reverse → settle instead.
  await appendCommerceJournalEntry(transaction, {
    orderId: order.id,
    currency: intent.currency,
    kind: "payment_settled",
    description: `Payment settled for order ${order.id}`,
    settlement: "settled",
    occurredAt,
    lines: [
      { accountKind: "buyer_clearing", signedAmountInCents: -amount },
      { accountKind: "order_held", signedAmountInCents: amount },
    ],
    linkedPaymentIntentId: intent.id,
    linkedTransferId: transfer.id,
    createdByUserId: null,
  });

  await transaction
    .update(commerceProviderTransfer)
    .set({
      state: "settled",
      providerTransferRef: `xfer_${providerPaymentRef}`,
      submittedAt: transfer.submittedAt ?? occurredAt,
      settledAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceProviderTransfer.id, transfer.id));

  await transaction
    .update(commercePaymentIntent)
    .set({
      state: "settled",
      providerPaymentRef,
      authorizedAt: occurredAt,
      settledAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commercePaymentIntent.id, intent.id));

  /*
   * STORE Phase 13. Confirmation is where the ranking engine's clock starts and where the
   * trusted-buyer verdict is frozen, and both must commit in the SAME statement as the
   * state transition.
   *
   * `confirmedAt` uses `coalesce` so a replayed settlement — the whole reason the webhook
   * inbox exists — cannot rewrite an instant that already happened. The state predicate
   * below already makes the transition happen once; the coalesce makes it idempotent even
   * if that predicate is ever loosened.
   */
  const qualificationVerdict = await evaluateOrderBuyerQualification(
    transaction,
    order,
    occurredAt,
  );

  await transaction
    .update(commerceOrder)
    .set({
      state: "confirmed",
      confirmedAt: sql`coalesce(${commerceOrder.confirmedAt}, ${occurredAt})`,
      buyerQualificationState: qualificationVerdict.state,
      buyerQualificationReasons: [...qualificationVerdict.reasons],
      updatedAt: occurredAt,
    })
    .where(
      and(
        eq(commerceOrder.id, order.id),
        inArray(commerceOrder.state, ["pending_payment", "payment_processing"]),
      ),
    );

  await appendAuditOrThrow(transaction, {
    organizationId: order.buyerOrganizationId,
    eventKind: "payment_intent_settled",
    actorUserId: null,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_payment_intent",
    targetEntityId: intent.id,
    payload: {
      orderId: order.id,
      amountInCents: String(intent.amountInCents),
      currency: intent.currency,
      providerPaymentRef,
    },
    occurredAt,
  });
}

/**
 * Resolves the two facts `evaluateBuyerQualification` needs that live outside the order
 * row, then evaluates the bar (STORE Phase 13).
 *
 * A DEFENSIVE FALLBACK RATHER THAN A THROW. If the acting member cannot be resolved — a
 * membership deleted between order creation and settlement, which `restrict` should
 * prevent but which is not this function's problem to police — the order is stamped
 * `unqualified` rather than aborting a payment that has already moved money at the
 * provider. Losing a ranking signal is recoverable; failing a settled payment is not.
 */
async function evaluateOrderBuyerQualification(
  transaction: DatabaseTransaction,
  order: OrderRow,
  occurredAt: Date,
): Promise<BuyerQualificationVerdict> {
  const [actingMember] = await transaction
    .select({ userId: commerceOrganizationMember.userId })
    .from(commerceOrganizationMember)
    .where(eq(commerceOrganizationMember.id, order.createdByMemberId))
    .limit(1);

  if (!actingMember) {
    return { state: "unqualified", reasons: ["no_qualifying_credential"] };
  }

  const productLines = await transaction
    .select({ isSample: commerceOrderProductLine.isSample })
    .from(commerceOrderProductLine)
    .where(eq(commerceOrderProductLine.orderId, order.id));

  // A service-only order has no product lines at all. `every` on an empty array is true,
  // so guard it: an order with nothing to sample is not a sample order.
  const isSampleOnlyOrder = productLines.length > 0 && productLines.every((line) => line.isSample);

  return evaluateBuyerQualification(transaction, {
    buyerOrganizationId: order.buyerOrganizationId,
    actingUserId: actingMember.userId,
    orderId: order.id,
    isSampleOnlyOrder,
    occurredAt,
  });
}

async function applyPaymentFailure(
  transaction: DatabaseTransaction,
  intent: PaymentIntentRow,
  transfer: TransferRow,
  order: OrderRow,
  failureReason: string,
  occurredAt: Date,
): Promise<void> {
  await transaction
    .update(commerceProviderTransfer)
    .set({
      state: "failed",
      failureReason,
      failedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceProviderTransfer.id, transfer.id));

  await transaction
    .update(commercePaymentIntent)
    .set({
      state: "failed",
      failureReason,
      failedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commercePaymentIntent.id, intent.id));

  await transaction
    .update(commerceOrder)
    .set({ state: "pending_payment", updatedAt: occurredAt })
    .where(and(eq(commerceOrder.id, order.id), eq(commerceOrder.state, "payment_processing")));

  await appendAuditOrThrow(transaction, {
    organizationId: order.buyerOrganizationId,
    eventKind: "payment_intent_failed",
    actorUserId: null,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_payment_intent",
    targetEntityId: intent.id,
    payload: {
      orderId: order.id,
      failureReason,
    },
    occurredAt,
  });
}

async function applyRefundSettlement(
  transaction: DatabaseTransaction,
  intent: PaymentIntentRow,
  refund: RefundRow,
  transfer: TransferRow,
  order: OrderRow,
  providerRefundRef: string,
  occurredAt: Date,
): Promise<void> {
  const amount = BigInt(refund.amountInCents);

  await appendCommerceJournalEntry(transaction, {
    orderId: order.id,
    currency: refund.currency,
    kind: "payment_refunded",
    description: `Refund settled for order ${order.id}`,
    settlement: "settled",
    occurredAt,
    lines: [
      { accountKind: "order_held", signedAmountInCents: -amount },
      { accountKind: "refunds_payable", signedAmountInCents: amount },
    ],
    linkedPaymentIntentId: intent.id,
    linkedRefundId: refund.id,
    linkedTransferId: transfer.id,
    createdByUserId: null,
  });

  await appendCommerceJournalEntry(transaction, {
    orderId: order.id,
    currency: refund.currency,
    kind: "payment_refunded",
    description: `Refund returned to buyer for order ${order.id}`,
    settlement: "settled",
    occurredAt,
    lines: [
      { accountKind: "refunds_payable", signedAmountInCents: -amount },
      { accountKind: "buyer_clearing", signedAmountInCents: amount },
    ],
    linkedPaymentIntentId: intent.id,
    linkedRefundId: refund.id,
    linkedTransferId: transfer.id,
    createdByUserId: null,
  });

  await transaction
    .update(commerceProviderTransfer)
    .set({
      state: "settled",
      providerTransferRef: `xfer_${providerRefundRef}`,
      submittedAt: transfer.submittedAt ?? occurredAt,
      settledAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceProviderTransfer.id, transfer.id));

  await transaction
    .update(commerceRefund)
    .set({
      state: "settled",
      providerRefundRef,
      settledAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceRefund.id, refund.id));

  const alreadyRefunded = await sumActiveRefundsInCents(transaction, intent.id);
  const nextIntentState =
    alreadyRefunded >= intent.amountInCents ? "refunded" : "partially_refunded";

  await transaction
    .update(commercePaymentIntent)
    .set({
      state: nextIntentState,
      updatedAt: occurredAt,
    })
    .where(eq(commercePaymentIntent.id, intent.id));

  await appendAuditOrThrow(transaction, {
    organizationId: order.buyerOrganizationId,
    eventKind: "payment_refund_settled",
    actorUserId: null,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_refund",
    targetEntityId: refund.id,
    payload: {
      orderId: order.id,
      paymentIntentId: intent.id,
      amountInCents: String(refund.amountInCents),
      currency: refund.currency,
      providerRefundRef,
    },
    occurredAt,
  });
}

async function applyRefundFailure(
  transaction: DatabaseTransaction,
  refund: RefundRow,
  transfer: TransferRow,
  order: OrderRow,
  failureReason: string,
  occurredAt: Date,
): Promise<void> {
  await transaction
    .update(commerceProviderTransfer)
    .set({
      state: "failed",
      failureReason,
      failedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceProviderTransfer.id, transfer.id));

  await transaction
    .update(commerceRefund)
    .set({
      state: "failed",
      failureReason,
      failedAt: occurredAt,
      updatedAt: occurredAt,
    })
    .where(eq(commerceRefund.id, refund.id));

  await appendAuditOrThrow(transaction, {
    organizationId: order.buyerOrganizationId,
    eventKind: "payment_refund_failed",
    actorUserId: null,
    actorMemberRoleSnapshot: null,
    targetEntityType: "commerce_refund",
    targetEntityId: refund.id,
    payload: {
      orderId: order.id,
      failureReason,
    },
    occurredAt,
  });
}

/**
 * Drains one outbox row: call the provider adapter, persist the webhook event, then apply
 * the normalized result. Idempotent under outbox and webhook uniqueness constraints.
 */
export async function processCommercePaymentOutboxRow(
  outboxId: string,
): Promise<Result<{ readonly processed: boolean }, CommercePaymentsError>> {
  const providerResolved = resolveCommercePaymentProvider();
  if (!providerResolved.success) {
    return { success: false, error: mapProviderResolutionError(providerResolved.error) };
  }
  const adapter = providerResolved.value;

  const claim = await db.transaction(async (transaction) => {
    const [outbox] = await transaction
      .select()
      .from(commercePaymentOutbox)
      .where(eq(commercePaymentOutbox.id, outboxId))
      .for("update");
    if (!outbox) return { status: "missing" as const };
    if (outbox.state === "completed") return { status: "already_done" as const };
    if (outbox.state === "failed" && outbox.attemptCount >= MAX_OUTBOX_ATTEMPTS) {
      return { status: "terminal_failed" as const };
    }
    if (outbox.availableAt.getTime() > Date.now()) {
      return { status: "not_ready" as const };
    }

    const [claimed] = await transaction
      .update(commercePaymentOutbox)
      .set({
        state: "processing",
        attemptCount: outbox.attemptCount + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(commercePaymentOutbox.id, outbox.id),
          inArray(commercePaymentOutbox.state, ["pending", "failed", "processing"]),
        ),
      )
      .returning();
    if (!claimed) return { status: "race" as const };

    const [transfer] = await transaction
      .select()
      .from(commerceProviderTransfer)
      .where(eq(commerceProviderTransfer.id, claimed.transferId))
      .for("update");
    if (!transfer) {
      throw new Error(`processCommercePaymentOutboxRow: transfer ${claimed.transferId} missing`);
    }

    const [intent] = await transaction
      .select()
      .from(commercePaymentIntent)
      .where(eq(commercePaymentIntent.id, transfer.paymentIntentId))
      .for("update");
    if (!intent) {
      throw new Error(
        `processCommercePaymentOutboxRow: intent ${transfer.paymentIntentId} missing`,
      );
    }

    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, claimed.orderId))
      .for("update");
    if (!order) {
      throw new Error(`processCommercePaymentOutboxRow: order ${claimed.orderId} missing`);
    }

    let refund: RefundRow | null = null;
    if (claimed.refundId) {
      const [refundRow] = await transaction
        .select()
        .from(commerceRefund)
        .where(eq(commerceRefund.id, claimed.refundId))
        .for("update");
      refund = refundRow ?? null;
    }

    return {
      status: "claimed" as const,
      outbox: claimed,
      transfer,
      intent,
      order,
      refund,
    };
  });

  if (claim.status !== "claimed") {
    return { success: true, value: { processed: false } };
  }

  const now = new Date();

  try {
    if (claim.outbox.kind === "submit_payment_intent") {
      if (claim.transfer.state === "settled" && claim.intent.state === "settled") {
        await db
          .update(commercePaymentOutbox)
          .set({ state: "completed", processedAt: now, updatedAt: now })
          .where(eq(commercePaymentOutbox.id, claim.outbox.id));
        return { success: true, value: { processed: true } };
      }

      await db
        .update(commerceProviderTransfer)
        .set({
          state: "submitted",
          submittedAt: claim.transfer.submittedAt ?? now,
          updatedAt: now,
        })
        .where(
          and(
            eq(commerceProviderTransfer.id, claim.transfer.id),
            eq(commerceProviderTransfer.state, "created"),
          ),
        );

      await db
        .update(commercePaymentIntent)
        .set({ state: "processing", updatedAt: now })
        .where(
          and(
            eq(commercePaymentIntent.id, claim.intent.id),
            inArray(commercePaymentIntent.state, ["created", "requires_action", "processing"]),
          ),
        );

      const adapterResult = await adapter.createPaymentIntent({
        idempotencyKey: claim.transfer.idempotencyKey,
        amountInCents: claim.intent.amountInCents,
        currency: claim.intent.currency,
        orderId: claim.order.id,
        paymentIntentId: claim.intent.id,
      });

      if (!adapterResult.success) {
        throw new Error(`provider_${adapterResult.error.type}`);
      }

      const mappedState = mapNormalizedPaymentState(adapterResult.value.state);
      const providerEventId = `evt_payment_${mappedState}_${claim.transfer.id}`;

      await db.transaction(async (transaction) => {
        const webhook = await recordWebhookEvent(transaction, {
          provider: adapter.providerName,
          providerEventId,
          eventType: `payment_intent.${mappedState}`,
          paymentIntentId: claim.intent.id,
          transferId: claim.transfer.id,
          refundId: null,
          orderId: claim.order.id,
          payload: {
            paymentIntentId: claim.intent.id,
            transferId: claim.transfer.id,
            providerPaymentRef: adapterResult.value.providerPaymentRef,
            state: mappedState,
            failureReason: adapterResult.value.failureReason,
          },
        });

        if (!webhook.deduplicated) {
          if (mappedState === "settled" || mappedState === "authorized") {
            await applyPaymentSettlement(
              transaction,
              claim.intent,
              claim.transfer,
              claim.order,
              adapterResult.value.providerPaymentRef,
              now,
            );
          } else if (mappedState === "failed" || mappedState === "cancelled") {
            await applyPaymentFailure(
              transaction,
              claim.intent,
              claim.transfer,
              claim.order,
              adapterResult.value.failureReason ?? mappedState,
              now,
            );
          } else {
            await transaction
              .update(commercePaymentIntent)
              .set({
                state: mappedState,
                providerPaymentRef: adapterResult.value.providerPaymentRef,
                updatedAt: now,
              })
              .where(eq(commercePaymentIntent.id, claim.intent.id));
            await transaction
              .update(commerceProviderTransfer)
              .set({
                providerTransferRef: `xfer_${adapterResult.value.providerPaymentRef}`,
                updatedAt: now,
              })
              .where(eq(commerceProviderTransfer.id, claim.transfer.id));
          }
        }

        await markWebhookProcessed(transaction, webhook.eventId, null);
        await transaction
          .update(commercePaymentOutbox)
          .set({ state: "completed", processedAt: now, lastError: null, updatedAt: now })
          .where(eq(commercePaymentOutbox.id, claim.outbox.id));
      });

      return { success: true, value: { processed: true } };
    }

    if (claim.outbox.kind === "submit_refund") {
      if (!claim.refund) {
        throw new Error("processCommercePaymentOutboxRow: refund outbox missing refund row");
      }
      if (!claim.intent.providerPaymentRef) {
        throw new Error("processCommercePaymentOutboxRow: refund requires provider payment ref");
      }

      if (claim.transfer.state === "settled" && claim.refund.state === "settled") {
        await db
          .update(commercePaymentOutbox)
          .set({ state: "completed", processedAt: now, updatedAt: now })
          .where(eq(commercePaymentOutbox.id, claim.outbox.id));
        return { success: true, value: { processed: true } };
      }

      await db
        .update(commerceProviderTransfer)
        .set({
          state: "submitted",
          submittedAt: claim.transfer.submittedAt ?? now,
          updatedAt: now,
        })
        .where(
          and(
            eq(commerceProviderTransfer.id, claim.transfer.id),
            eq(commerceProviderTransfer.state, "created"),
          ),
        );
      await db
        .update(commerceRefund)
        .set({ state: "processing", updatedAt: now })
        .where(
          and(
            eq(commerceRefund.id, claim.refund.id),
            inArray(commerceRefund.state, ["created", "processing"]),
          ),
        );

      const adapterResult = await adapter.createRefund({
        idempotencyKey: claim.transfer.idempotencyKey,
        amountInCents: claim.refund.amountInCents,
        currency: claim.refund.currency,
        providerPaymentRef: claim.intent.providerPaymentRef,
        refundId: claim.refund.id,
        paymentIntentId: claim.intent.id,
      });
      if (!adapterResult.success) {
        throw new Error(`provider_${adapterResult.error.type}`);
      }

      const mappedState = mapNormalizedRefundState(adapterResult.value.state);
      const providerEventId = `evt_refund_${mappedState}_${claim.transfer.id}`;

      await db.transaction(async (transaction) => {
        const webhook = await recordWebhookEvent(transaction, {
          provider: adapter.providerName,
          providerEventId,
          eventType: `refund.${mappedState}`,
          paymentIntentId: claim.intent.id,
          transferId: claim.transfer.id,
          refundId: claim.refund?.id ?? null,
          orderId: claim.order.id,
          payload: {
            refundId: claim.refund?.id ?? null,
            transferId: claim.transfer.id,
            providerRefundRef: adapterResult.value.providerRefundRef,
            state: mappedState,
            failureReason: adapterResult.value.failureReason,
          },
        });

        if (!webhook.deduplicated && claim.refund) {
          if (mappedState === "settled") {
            await applyRefundSettlement(
              transaction,
              claim.intent,
              claim.refund,
              claim.transfer,
              claim.order,
              adapterResult.value.providerRefundRef,
              now,
            );
          } else if (mappedState === "failed" || mappedState === "cancelled") {
            await applyRefundFailure(
              transaction,
              claim.refund,
              claim.transfer,
              claim.order,
              adapterResult.value.failureReason ?? mappedState,
              now,
            );
          } else {
            await transaction
              .update(commerceRefund)
              .set({
                state: mappedState,
                providerRefundRef: adapterResult.value.providerRefundRef,
                updatedAt: now,
              })
              .where(eq(commerceRefund.id, claim.refund.id));
          }
        }

        await markWebhookProcessed(transaction, webhook.eventId, null);
        await transaction
          .update(commercePaymentOutbox)
          .set({ state: "completed", processedAt: now, lastError: null, updatedAt: now })
          .where(eq(commercePaymentOutbox.id, claim.outbox.id));
      });

      return { success: true, value: { processed: true } };
    }

    const exhaustiveKind: never = claim.outbox.kind;
    throw new Error(`Unhandled outbox kind: ${JSON.stringify(exhaustiveKind)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown_outbox_failure";
    const nextAttempt = claim.outbox.attemptCount;
    const terminal = nextAttempt >= MAX_OUTBOX_ATTEMPTS;
    await db
      .update(commercePaymentOutbox)
      .set({
        state: terminal ? "failed" : "pending",
        lastError: message.slice(0, 1000),
        availableAt: new Date(Date.now() + computeOutboxBackoffMs(nextAttempt)),
        updatedAt: new Date(),
      })
      .where(eq(commercePaymentOutbox.id, claim.outbox.id));

    if (terminal) {
      return {
        success: false,
        error: { type: "PROVIDER_REJECTED", reason: message },
      };
    }
    return { success: true, value: { processed: false } };
  }
}

/**
 * Reconciles stale outbox rows and re-checks submitted transfers against the adapter.
 */
export async function reconcileCommercePayments(asOf: Date): Promise<{
  readonly outboxDispatched: number;
  readonly transfersChecked: number;
}> {
  const pendingOutbox = await db
    .select({ id: commercePaymentOutbox.id })
    .from(commercePaymentOutbox)
    .where(
      and(
        inArray(commercePaymentOutbox.state, ["pending", "failed"]),
        sql`${commercePaymentOutbox.availableAt} <= ${asOf}`,
        sql`${commercePaymentOutbox.attemptCount} < ${MAX_OUTBOX_ATTEMPTS}`,
      ),
    )
    .orderBy(commercePaymentOutbox.availableAt, commercePaymentOutbox.id)
    .limit(100);

  let outboxDispatched = 0;
  for (const row of pendingOutbox) {
    await enqueueOutboxDispatch(row.id);
    outboxDispatched += 1;
  }

  const submittedTransfers = await db
    .select()
    .from(commerceProviderTransfer)
    .where(eq(commerceProviderTransfer.state, "submitted"))
    .orderBy(commerceProviderTransfer.updatedAt, commerceProviderTransfer.id)
    .limit(50);

  const providerResolved = resolveCommercePaymentProvider();
  let transfersChecked = 0;
  if (providerResolved.success) {
    const adapter = providerResolved.value;
    for (const transfer of submittedTransfers) {
      transfersChecked += 1;
      const [intent] = await db
        .select()
        .from(commercePaymentIntent)
        .where(eq(commercePaymentIntent.id, transfer.paymentIntentId))
        .limit(1);
      if (!intent?.providerPaymentRef && transfer.direction === "inbound") {
        // Still waiting for first provider response; outbox owns that path.
        continue;
      }

      if (transfer.direction === "inbound" && intent?.providerPaymentRef) {
        const retrieved = await adapter.retrievePaymentIntent(intent.providerPaymentRef);
        if (
          retrieved.success &&
          (retrieved.value.state === "settled" || retrieved.value.state === "authorized")
        ) {
          const [outbox] = await db
            .select({ id: commercePaymentOutbox.id })
            .from(commercePaymentOutbox)
            .where(eq(commercePaymentOutbox.transferId, transfer.id))
            .limit(1);
          if (outbox) {
            await enqueueOutboxDispatch(outbox.id);
          }
        }
      }
    }
  }

  return { outboxDispatched, transfersChecked };
}
