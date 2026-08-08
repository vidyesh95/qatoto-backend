import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceConnectorOutbox,
  commerceConnectorWebhookEvent,
  commerceExternalProvider,
} from "#src/db/schema.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import { errorFields, logger } from "#src/lib/logger.js";
import type { Result } from "#src/types/index.js";

/**
 * The shared external-connector substrate (STORE Phase 14).
 *
 * Five connectors — escrow, logistics, insurance, laboratory, foreign exchange — all need
 * the same three things: a durable record of a command we intend to send, a durable record
 * of an event we have received, and a worker that turns the first into the second without
 * ever doing either twice. That machinery lives here once.
 *
 * ## The rule the whole phase rests on
 *
 * A COMMAND POSTS NOTHING. `enqueueConnectorCommand` records an intent. The worker calls
 * the adapter. Neither moves a ledger balance. Only a normalized provider EVENT does that,
 * and it reaches the ledger through exactly one function whether it arrived as a webhook or
 * was pulled by the reconciler.
 *
 * The reason is not fastidiousness. A release request that returned "released" and posted
 * on the strength of its own return value would credit a seller the instant we ASKED, which
 * is not when the money moved and may never be. Qatoto's books follow the provider.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ConnectorOutboxRow = typeof commerceConnectorOutbox.$inferSelect;
type ExternalProviderRow = typeof commerceExternalProvider.$inferSelect;

export type ConnectorKind = ConnectorOutboxRow["connectorKind"];
export type ConnectorCommandKind = ConnectorOutboxRow["kind"];

export type CommerceConnectorError =
  | { type: "PROVIDER_NOT_FOUND" }
  | { type: "PROVIDER_NOT_ACTIVE"; state: ExternalProviderRow["state"] }
  | { type: "PROVIDER_UNAVAILABLE"; reason: string }
  | { type: "PROVIDER_REJECTED"; reason: string }
  | { type: "SIGNATURE_INVALID"; reason: string }
  | { type: "OUTBOX_ROW_MISSING" }
  | { type: "OUTBOX_TERMINAL" };

/**
 * Retries mirror the payment outbox: bounded attempts, exponential backoff, and a terminal
 * `failed` state that stops the loop rather than retrying a rejected command forever.
 */
export const MAX_CONNECTOR_OUTBOX_ATTEMPTS = 8;
const CONNECTOR_OUTBOX_BACKOFF_BASE_MS = 5_000;

export function computeConnectorBackoffMs(attemptCount: number): number {
  return CONNECTOR_OUTBOX_BACKOFF_BASE_MS * 2 ** Math.min(attemptCount, 6);
}

/** Ours, minted before the call, so a retried command is recognisably the same command. */
export function mintConnectorIdempotencyKey(kind: ConnectorCommandKind): string {
  return `${kind}_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Provider registry reads
// ---------------------------------------------------------------------------

export interface ActiveProvider {
  readonly id: string;
  readonly connectorKind: ConnectorKind;
  readonly providerSlug: string;
  readonly displayName: string;
  readonly webhookSigningSecretRef: string | null;
  readonly supportedCountryCodes: readonly string[];
  readonly supportedCurrencies: readonly string[];
  readonly minimumOrderInCents: number | null;
  readonly maximumOrderInCents: number | null;
  readonly platformRank: number;
}

function projectProvider(row: ExternalProviderRow): ActiveProvider {
  return {
    id: row.id,
    connectorKind: row.connectorKind,
    providerSlug: row.providerSlug,
    displayName: row.displayName,
    webhookSigningSecretRef: row.webhookSigningSecretRef,
    supportedCountryCodes: row.supportedCountryCodes,
    supportedCurrencies: row.supportedCurrencies,
    minimumOrderInCents: row.minimumOrderInCents,
    maximumOrderInCents: row.maximumOrderInCents,
    platformRank: row.platformRank,
  };
}

export async function loadProviderById(
  providerId: string,
  executor: DatabaseTransaction | typeof db = db,
): Promise<Result<ActiveProvider, CommerceConnectorError>> {
  const [row] = await executor
    .select()
    .from(commerceExternalProvider)
    .where(eq(commerceExternalProvider.id, providerId))
    .limit(1);
  if (!row) return { success: false, error: { type: "PROVIDER_NOT_FOUND" } };
  if (row.state !== "active") {
    return { success: false, error: { type: "PROVIDER_NOT_ACTIVE", state: row.state } };
  }
  return { success: true, value: projectProvider(row) };
}

/**
 * Every ACTIVE provider of one kind, in the deterministic order eligibility uses:
 * platform rank ascending, then id. Ordering ends on a unique column so two providers
 * sharing a rank cannot swap places between reads (§7's cursor rule, applied to a list
 * that a buyer chooses from).
 */
export async function listActiveProviders(
  connectorKind: ConnectorKind,
  executor: DatabaseTransaction | typeof db = db,
): Promise<readonly ActiveProvider[]> {
  const rows = await executor
    .select()
    .from(commerceExternalProvider)
    .where(
      and(
        eq(commerceExternalProvider.connectorKind, connectorKind),
        eq(commerceExternalProvider.state, "active"),
      ),
    )
    .orderBy(commerceExternalProvider.platformRank, commerceExternalProvider.id);
  return rows.map(projectProvider);
}

/**
 * Resolves a provider's webhook signing secret from the environment.
 *
 * THE DATABASE HOLDS THE VARIABLE'S NAME, NEVER ITS VALUE (§11). A row is then safe to
 * read in a support context, and rotating a secret is a deploy rather than an UPDATE that
 * would sit in the write-ahead log forever.
 */
export function resolveWebhookSigningSecret(
  provider: ActiveProvider,
): Result<string, CommerceConnectorError> {
  if (provider.webhookSigningSecretRef === null) {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Provider "${provider.providerSlug}" has no webhook signing secret configured.`,
      },
    };
  }
  const secret = process.env[provider.webhookSigningSecretRef];
  if (secret === undefined || secret.length === 0) {
    return {
      success: false,
      error: {
        type: "PROVIDER_UNAVAILABLE",
        reason: `Environment variable "${provider.webhookSigningSecretRef}" is not set.`,
      },
    };
  }
  return { success: true, value: secret };
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface EnqueueConnectorCommandInput {
  readonly providerId: string;
  readonly connectorKind: ConnectorKind;
  readonly kind: ConnectorCommandKind;
  readonly orderId: string | null;
  readonly escrowSessionId: string | null;
  readonly escrowMilestoneId: string | null;
  readonly idempotencyKey: string;
  readonly requestPayload: Readonly<Record<string, unknown>>;
}

/**
 * Records the intent INSIDE the caller's transaction, so a command can never exist without
 * the domain change that justified it, nor the reverse.
 *
 * The dispatch job is enqueued by the caller AFTER commit — see `scheduleConnectorDispatch`.
 * Enqueueing inside the transaction would let a worker pick the row up before it is
 * visible and conclude it does not exist.
 */
export async function enqueueConnectorCommand(
  transaction: DatabaseTransaction,
  input: EnqueueConnectorCommandInput,
): Promise<{ readonly outboxId: string }> {
  const [inserted] = await transaction
    .insert(commerceConnectorOutbox)
    .values({
      providerId: input.providerId,
      connectorKind: input.connectorKind,
      kind: input.kind,
      orderId: input.orderId,
      escrowSessionId: input.escrowSessionId,
      escrowMilestoneId: input.escrowMilestoneId,
      idempotencyKey: input.idempotencyKey,
      requestPayloadJson: JSON.stringify(input.requestPayload),
    })
    .returning({ id: commerceConnectorOutbox.id });

  if (!inserted) {
    throw new Error("enqueueConnectorCommand: insert returned no row");
  }
  return { outboxId: inserted.id };
}

/**
 * Schedules the worker after the transaction has committed.
 *
 * A FAILED ENQUEUE IS LOGGED, NOT THROWN, exactly as the payment path does. The row is
 * already durable and `reconcile-connector-state` re-enqueues anything left pending, so
 * losing the notification costs latency rather than the command. Throwing here would
 * unwind a committed domain change for a scheduling hiccup.
 */
export async function scheduleConnectorDispatch(outboxId: string): Promise<void> {
  /**
   * THIS FUNCTION MUST NOT THROW, and the try/catch is not defensive padding — an HTTP
   * smoke found the bug it prevents.
   *
   * It runs AFTER the checkout transaction has committed. The order exists, the agreement
   * is spent and the escrow session is written; all that remains is telling a worker to
   * make a call. When `jobs:install` had not been run for a newly added queue, `sendJob`
   * threw rather than returning a failed Result, the throw escaped into the request, and
   * the buyer received a 500 for an order that had in fact been placed successfully —
   * the worst possible answer, because a retry would place a second one.
   *
   * A lost notification costs latency and nothing else: the outbox row is durable and
   * `reconcile-connector-state` re-enqueues anything still pending within the hour.
   */
  try {
    const scheduled = await sendJob(
      JOB_NAMES.dispatchConnectorCommand,
      { outboxId },
      { idempotencyKey: idempotencyKeyFor.dispatchConnectorCommand(outboxId) },
    );
    if (!scheduled.success) {
      logger.error("failed to enqueue connector dispatch; the reconciler will retry it", {
        outboxId,
        enqueueError: scheduled.error.type,
      });
    }
  } catch (error: unknown) {
    logger.error("connector dispatch enqueue threw; the reconciler will retry it", {
      outboxId,
      ...errorFields(error),
    });
  }
}

export type ConnectorOutboxClaim =
  | { readonly status: "claimed"; readonly row: ConnectorOutboxRow }
  | { readonly status: "missing" }
  | { readonly status: "already_done" }
  | { readonly status: "terminal_failed" }
  | { readonly status: "not_ready" }
  | { readonly status: "race" };

/**
 * Claims one outbox row under a row lock, incrementing the attempt count before the
 * adapter is called rather than after.
 *
 * BEFORE, DELIBERATELY: a call that hangs and is killed must still count as an attempt, or
 * a command that reliably crashes the worker retries forever at full speed.
 */
export async function claimConnectorOutboxRow(
  transaction: DatabaseTransaction,
  outboxId: string,
): Promise<ConnectorOutboxClaim> {
  const [outbox] = await transaction
    .select()
    .from(commerceConnectorOutbox)
    .where(eq(commerceConnectorOutbox.id, outboxId))
    .for("update");
  if (!outbox) return { status: "missing" };
  if (outbox.state === "completed") return { status: "already_done" };
  if (outbox.state === "failed" && outbox.attemptCount >= MAX_CONNECTOR_OUTBOX_ATTEMPTS) {
    return { status: "terminal_failed" };
  }
  if (outbox.availableAt.getTime() > Date.now()) return { status: "not_ready" };

  const [claimed] = await transaction
    .update(commerceConnectorOutbox)
    .set({
      state: "processing",
      attemptCount: outbox.attemptCount + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commerceConnectorOutbox.id, outbox.id),
        inArray(commerceConnectorOutbox.state, ["pending", "failed", "processing"]),
      ),
    )
    .returning();
  if (!claimed) return { status: "race" };
  return { status: "claimed", row: claimed };
}

export async function completeConnectorOutboxRow(
  transaction: DatabaseTransaction,
  outboxId: string,
): Promise<void> {
  await transaction
    .update(commerceConnectorOutbox)
    .set({ state: "completed", processedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(commerceConnectorOutbox.id, outboxId));
}

/**
 * Records a failed attempt and schedules the next one, or gives up.
 *
 * A `terminal` outcome is not a silent death: the row stays `failed` with its last error,
 * which is what makes a stuck connector visible rather than merely quiet.
 */
export async function failConnectorOutboxRow(
  transaction: DatabaseTransaction,
  input: {
    readonly outboxId: string;
    readonly attemptCount: number;
    readonly lastError: string;
    readonly terminal: boolean;
  },
): Promise<void> {
  const exhausted = input.terminal || input.attemptCount >= MAX_CONNECTOR_OUTBOX_ATTEMPTS;
  await transaction
    .update(commerceConnectorOutbox)
    .set({
      state: exhausted ? "failed" : "pending",
      lastError: input.lastError.slice(0, 2000),
      availableAt: exhausted
        ? new Date()
        : new Date(Date.now() + computeConnectorBackoffMs(input.attemptCount)),
      updatedAt: new Date(),
    })
    .where(eq(commerceConnectorOutbox.id, input.outboxId));
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface RecordConnectorWebhookInput {
  readonly providerId: string;
  readonly connectorKind: ConnectorKind;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly orderId: string | null;
  readonly escrowSessionId: string | null;
  readonly payload: unknown;
}

/**
 * Persists an inbound event BEFORE anything acts on it, and reports whether it had already
 * been seen.
 *
 * The insert-then-select-on-conflict shape is the one `commerce-payments.service.ts`
 * already uses. It is not merely a convenience: the unique
 * `(provider_id, provider_event_id)` index is what makes a replayed delivery a no-op, and
 * therefore what makes a route with no session authentication safe to expose at all. A
 * caller that sees `deduplicated` answers 200 and does nothing further.
 */
export async function recordConnectorWebhookEvent(
  transaction: DatabaseTransaction,
  input: RecordConnectorWebhookInput,
): Promise<{ readonly eventId: string; readonly deduplicated: boolean }> {
  const [inserted] = await transaction
    .insert(commerceConnectorWebhookEvent)
    .values({
      providerId: input.providerId,
      connectorKind: input.connectorKind,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      orderId: input.orderId,
      escrowSessionId: input.escrowSessionId,
      payloadJson: JSON.stringify(input.payload),
    })
    .onConflictDoNothing()
    .returning({ id: commerceConnectorWebhookEvent.id });

  if (inserted) return { eventId: inserted.id, deduplicated: false };

  const [existing] = await transaction
    .select({ id: commerceConnectorWebhookEvent.id })
    .from(commerceConnectorWebhookEvent)
    .where(
      and(
        eq(commerceConnectorWebhookEvent.providerId, input.providerId),
        eq(commerceConnectorWebhookEvent.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);
  if (!existing) {
    // A conflict with no conflicting row is a broken invariant, not a domain failure.
    throw new Error("recordConnectorWebhookEvent: conflict without an existing row");
  }
  return { eventId: existing.id, deduplicated: true };
}

/**
 * Stamps an event processed, and only if it is not already.
 *
 * The `processed_at IS NULL` predicate is what keeps the mark idempotent under a concurrent
 * redelivery: two workers applying the same event both succeed, and the second writes
 * nothing.
 */
export async function markConnectorWebhookProcessed(
  transaction: DatabaseTransaction,
  eventId: string,
  processingError: string | null,
): Promise<void> {
  await transaction
    .update(commerceConnectorWebhookEvent)
    .set({ processedAt: new Date(), processingError })
    .where(
      and(
        eq(commerceConnectorWebhookEvent.id, eventId),
        sql`${commerceConnectorWebhookEvent.processedAt} IS NULL`,
      ),
    );
}

/**
 * Re-enqueues connector commands that were left pending — a worker that died mid-flight,
 * or an enqueue that failed after its row committed.
 *
 * Bounded per run: a reconciler that tries to drain an unbounded backlog in one tick
 * starves the queue it is trying to help.
 */
export async function reconcileConnectorOutbox(
  limit = 100,
): Promise<{ readonly reEnqueued: number }> {
  const stale = await db
    .select({ id: commerceConnectorOutbox.id })
    .from(commerceConnectorOutbox)
    .where(
      and(
        inArray(commerceConnectorOutbox.state, ["pending", "processing"]),
        sql`${commerceConnectorOutbox.availableAt} <= now()`,
        sql`${commerceConnectorOutbox.attemptCount} < ${MAX_CONNECTOR_OUTBOX_ATTEMPTS}`,
      ),
    )
    .orderBy(commerceConnectorOutbox.availableAt, commerceConnectorOutbox.id)
    .limit(limit);

  for (const row of stale) {
    await scheduleConnectorDispatch(row.id);
  }
  return { reEnqueued: stale.length };
}
