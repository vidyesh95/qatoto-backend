import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceExternalProvider,
  commerceMessage,
  commerceSettlementAgreement,
  commerceSettlementAgreementMilestone,
  commerceThreadParticipant,
} from "#src/db/schema.js";
import { listActiveProviders, type ActiveProvider } from "#src/services/commerce-connector.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Negotiated settlement agreements (STORE Phase 14).
 *
 * QATOTO PROVIDES NO ESCROW AND NEVER HOLDS FUNDS. Two parties who want to trade cheaply
 * transact directly and carry the counterparty risk themselves — that is the default and it
 * stays the default. Parties who want the risk reduced discuss it in the thread they are
 * already using, agree on a licensed third-party provider, and opt in TOGETHER.
 *
 * ## Nothing here selects escrow for anybody
 *
 * There is no preference matrix, no platform mandate and no seller policy that turns escrow
 * on. The only way an order settles through escrow is that one organization proposed it and
 * the OTHER accepted. `listEligibleProviders` answers "who could serve this trade" — a fact
 * about reachability, not a recommendation.
 *
 * ## Append-only, exactly like a quote revision
 *
 * A counter-proposal is a new row; the previous goes `superseded`. Nothing is edited in
 * place, for the reason §2.2 gives about quotes: an edited term is a term whose history
 * cannot be shown to the party who agreed to something else.
 *
 * ## Refuse, never downgrade
 *
 * `resolveSettlementRail` refuses a checkout whose accepted agreement has become unusable
 * rather than quietly settling it unprotected. Silently dropping protection that two
 * parties agreed to is the trust lie §0 exists to prevent.
 */

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SettlementAgreementRow = typeof commerceSettlementAgreement.$inferSelect;
export type SettlementRail = "internal_custody" | "direct_offline" | "direct_processor" | "external_escrow";

export type CommerceSettlementError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "PROVIDER_INELIGIBLE"; reason: string }
  | { type: "AGREEMENT_NOT_OPEN"; state: SettlementAgreementRow["state"] }
  | { type: "SELF_ACCEPTANCE_FORBIDDEN" }
  | { type: "AGREEMENT_EXPIRED"; expiredAt: Date }
  | { type: "CONFLICT"; message: string };

export interface SettlementActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}

export interface ProposedMilestoneInput {
  readonly sequence: number;
  readonly milestoneKind: "deposit" | "shipment" | "inspection" | "delivery" | "final";
  readonly amountInCents: number;
  readonly releaseConditionNote: string | null;
}

export interface ProposeSettlementAgreementInput {
  readonly threadId: string;
  readonly buyerOrganizationId: string;
  readonly sellerOrganizationId: string;
  readonly externalProviderId: string;
  readonly escrowFeeBearer: "buyer" | "seller" | "split";
  readonly currency: string;
  readonly totalInCents: number;
  readonly expiresAt: Date;
  readonly milestones: readonly ProposedMilestoneInput[];
}

export interface SettlementAgreementProjection {
  readonly id: string;
  readonly threadId: string;
  readonly revisionNumber: number;
  readonly state: SettlementAgreementRow["state"];
  readonly buyerOrganizationId: string;
  readonly sellerOrganizationId: string;
  readonly proposedByOrganizationId: string;
  readonly provider: { readonly id: string; readonly slug: string; readonly displayName: string };
  readonly escrowFeeBearer: SettlementAgreementRow["escrowFeeBearer"];
  readonly currency: string;
  readonly totalInCents: number;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedByOrganizationId: string | null;
  readonly consumedByOrderId: string | null;
  readonly milestones: readonly {
    readonly sequence: number;
    readonly milestoneKind: ProposedMilestoneInput["milestoneKind"];
    readonly amountInCents: number;
    readonly releaseConditionNote: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface ProviderEligibilityQuery {
  readonly buyerCountryCode: string;
  readonly sellerCountryCode: string;
  readonly currency: string;
  readonly totalInCents: number;
}

/**
 * Whether one provider could serve one trade. A fact about REACHABILITY, not a preference.
 *
 * An empty `supportedCountryCodes` or `supportedCurrencies` means "unrestricted" rather than
 * "serves nowhere" — a provider row with no coverage recorded yet should not silently
 * disappear from every list while looking configured.
 */
export function isProviderEligible(
  provider: ActiveProvider,
  query: ProviderEligibilityQuery,
): boolean {
  const coversCountry = (countryCode: string): boolean =>
    provider.supportedCountryCodes.length === 0 ||
    provider.supportedCountryCodes.includes(countryCode);

  if (!coversCountry(query.buyerCountryCode)) return false;
  if (!coversCountry(query.sellerCountryCode)) return false;
  if (
    provider.supportedCurrencies.length > 0 &&
    !provider.supportedCurrencies.includes(query.currency)
  ) {
    return false;
  }
  if (provider.minimumOrderInCents !== null && query.totalInCents < provider.minimumOrderInCents) {
    return false;
  }
  if (provider.maximumOrderInCents !== null && query.totalInCents > provider.maximumOrderInCents) {
    return false;
  }
  return true;
}

/**
 * The escrow providers that could serve this trade, in deterministic order.
 *
 * `listActiveProviders` already orders by platform rank then id, so two providers sharing a
 * rank cannot swap places between reads — the same determinism §7 requires of any list a
 * client pages through or picks from.
 */
export async function listEligibleProviders(
  query: ProviderEligibilityQuery,
): Promise<readonly ActiveProvider[]> {
  const providers = await listActiveProviders("external_escrow");
  return providers.filter((provider) => isProviderEligible(provider, query));
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

async function assertThreadParticipant(
  executor: DatabaseTransaction | typeof db,
  threadId: string,
  organizationId: string,
): Promise<boolean> {
  const [participant] = await executor
    .select({ id: commerceThreadParticipant.id })
    .from(commerceThreadParticipant)
    .where(
      and(
        eq(commerceThreadParticipant.threadId, threadId),
        eq(commerceThreadParticipant.organizationId, organizationId),
      ),
    )
    .limit(1);
  return participant !== undefined;
}

/**
 * Proposes escrow terms, or counters an existing proposal.
 *
 * The proposer is always the CALLER's organization, taken from the authenticated context
 * and never from the body (§0). A body naming a different proposer would let one party
 * fabricate an offer in the other's name.
 */
export async function proposeSettlementAgreement(
  actor: SettlementActorContext,
  input: ProposeSettlementAgreementInput,
): Promise<Result<SettlementAgreementProjection, CommerceSettlementError>> {
  if (input.buyerOrganizationId === input.sellerOrganizationId) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "Buyer and seller must differ." },
    };
  }
  if (
    actor.organizationId !== input.buyerOrganizationId &&
    actor.organizationId !== input.sellerOrganizationId
  ) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }
  if (input.milestones.length === 0) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "A settlement plan needs at least one milestone." },
    };
  }

  const milestoneTotal = input.milestones.reduce(
    (runningTotal, milestone) => runningTotal + milestone.amountInCents,
    0,
  );
  if (milestoneTotal !== input.totalInCents) {
    /**
     * Checked here as well as by the deferred database trigger. The trigger is the thing
     * that cannot be bypassed; this is the thing that can say which number was wrong.
     */
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: `Milestones sum to ${String(milestoneTotal)} but the agreement total is ${String(input.totalInCents)}.`,
      },
    };
  }

  const sequences = input.milestones.map((milestone) => milestone.sequence);
  if (new Set(sequences).size !== sequences.length) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "Milestone sequences must be distinct." },
    };
  }

  return db.transaction(async (transaction) => {
    const participates = await assertThreadParticipant(transaction, input.threadId, actor.organizationId);
    if (!participates) return { success: false, error: { type: "FORBIDDEN" } };

    const [provider] = await transaction
      .select()
      .from(commerceExternalProvider)
      .where(eq(commerceExternalProvider.id, input.externalProviderId))
      .limit(1);
    if (!provider || provider.connectorKind !== "external_escrow") {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
    if (provider.state !== "active") {
      return {
        success: false,
        error: { type: "PROVIDER_INELIGIBLE", reason: "provider_not_active" },
      };
    }

    /**
     * Supersede the live revision under a lock so two simultaneous counter-proposals
     * cannot both believe they superseded the same row and land on the same revision
     * number. The unique index would catch that; the lock means the loser retries rather
     * than surfacing a constraint violation to a buyer.
     */
    const existing = await transaction
      .select()
      .from(commerceSettlementAgreement)
      .where(eq(commerceSettlementAgreement.threadId, input.threadId))
      .orderBy(desc(commerceSettlementAgreement.revisionNumber))
      .for("update");

    const latest = existing[0];
    if (latest?.state === "consumed") {
      return {
        success: false,
        error: { type: "CONFLICT", message: "This thread's agreement has already been used by an order." },
      };
    }
    if (latest !== undefined && (latest.state === "proposed" || latest.state === "accepted")) {
      await transaction
        .update(commerceSettlementAgreement)
        .set({ state: "superseded", updatedAt: new Date() })
        .where(eq(commerceSettlementAgreement.id, latest.id));
    }

    const [created] = await transaction
      .insert(commerceSettlementAgreement)
      .values({
        threadId: input.threadId,
        buyerOrganizationId: input.buyerOrganizationId,
        sellerOrganizationId: input.sellerOrganizationId,
        proposedByOrganizationId: actor.organizationId,
        proposedByMemberId: actor.memberId,
        revisionNumber: (latest?.revisionNumber ?? 0) + 1,
        supersedesAgreementId: latest?.id ?? null,
        externalProviderId: provider.id,
        escrowFeeBearer: input.escrowFeeBearer,
        currency: input.currency,
        totalInCents: input.totalInCents,
        state: "proposed",
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!created) throw new Error("proposeSettlementAgreement: insert returned no row");

    await transaction.insert(commerceSettlementAgreementMilestone).values(
      input.milestones.map((milestone) => ({
        agreementId: created.id,
        sequence: milestone.sequence,
        milestoneKind: milestone.milestoneKind,
        amountInCents: milestone.amountInCents,
        currency: input.currency,
        releaseConditionNote: milestone.releaseConditionNote,
      })),
    );

    await appendSettlementMessage(transaction, {
      threadId: input.threadId,
      organizationId: actor.organizationId,
      memberId: actor.memberId,
      agreementId: created.id,
      messageKind: "settlement_proposed",
      bodyText: `Proposed settlement through ${provider.displayName}: ${String(input.milestones.length)} milestone(s), ${input.currency} ${String(input.totalInCents)} in total.`,
    });

    return projectAgreement(transaction, created.id);
  });
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type AgreementResponse = "accept" | "decline" | "withdraw";

/**
 * Accepts, declines or withdraws a proposal.
 *
 * ACCEPTANCE IS THE COUNTERPARTY'S ALONE. A proposer accepting its own proposal is not a
 * mutual agreement, and `commerce_settlement_agreement_acceptor_ck` makes that
 * unrepresentable at the database — this check exists so the caller gets a tagged error
 * rather than a constraint violation. Withdrawal is the mirror: only the proposer may.
 */
export async function respondToSettlementAgreement(
  actor: SettlementActorContext,
  agreementId: string,
  response: AgreementResponse,
): Promise<Result<SettlementAgreementProjection, CommerceSettlementError>> {
  return db.transaction(async (transaction) => {
    const [agreement] = await transaction
      .select()
      .from(commerceSettlementAgreement)
      .where(eq(commerceSettlementAgreement.id, agreementId))
      .for("update");
    if (!agreement) return { success: false, error: { type: "NOT_FOUND" } };

    const isParty =
      actor.organizationId === agreement.buyerOrganizationId ||
      actor.organizationId === agreement.sellerOrganizationId;
    // A non-party gets NOT_FOUND, never FORBIDDEN: a distinguishable 403 would confirm that
    // an agreement with this id exists between two organizations (§11, no enumeration).
    if (!isParty) return { success: false, error: { type: "NOT_FOUND" } };

    if (agreement.state !== "proposed") {
      return { success: false, error: { type: "AGREEMENT_NOT_OPEN", state: agreement.state } };
    }
    if (agreement.expiresAt.getTime() <= Date.now()) {
      await transaction
        .update(commerceSettlementAgreement)
        .set({ state: "expired", updatedAt: new Date() })
        .where(eq(commerceSettlementAgreement.id, agreement.id));
      return { success: false, error: { type: "AGREEMENT_EXPIRED", expiredAt: agreement.expiresAt } };
    }

    const now = new Date();

    switch (response) {
      case "accept": {
        if (actor.organizationId === agreement.proposedByOrganizationId) {
          return { success: false, error: { type: "SELF_ACCEPTANCE_FORBIDDEN" } };
        }
        await transaction
          .update(commerceSettlementAgreement)
          .set({
            state: "accepted",
            acceptedAt: now,
            acceptedByOrganizationId: actor.organizationId,
            acceptedByMemberId: actor.memberId,
            updatedAt: now,
          })
          .where(eq(commerceSettlementAgreement.id, agreement.id));
        break;
      }
      case "decline": {
        if (actor.organizationId === agreement.proposedByOrganizationId) {
          return {
            success: false,
            error: {
              type: "VALIDATION_FAILED",
              message: "Withdraw your own proposal rather than declining it.",
            },
          };
        }
        await transaction
          .update(commerceSettlementAgreement)
          .set({ state: "declined", updatedAt: now })
          .where(eq(commerceSettlementAgreement.id, agreement.id));
        break;
      }
      case "withdraw": {
        if (actor.organizationId !== agreement.proposedByOrganizationId) {
          return { success: false, error: { type: "FORBIDDEN" } };
        }
        await transaction
          .update(commerceSettlementAgreement)
          .set({ state: "withdrawn", updatedAt: now })
          .where(eq(commerceSettlementAgreement.id, agreement.id));
        break;
      }
      default: {
        const exhaustiveResponse: never = response;
        throw new Error(`Unhandled agreement response: ${JSON.stringify(exhaustiveResponse)}`);
      }
    }

    const messageKind =
      response === "accept"
        ? ("settlement_accepted" as const)
        : response === "decline"
          ? ("settlement_declined" as const)
          : ("settlement_withdrawn" as const);

    await appendSettlementMessage(transaction, {
      threadId: agreement.threadId,
      organizationId: actor.organizationId,
      memberId: actor.memberId,
      agreementId: agreement.id,
      messageKind,
      bodyText: `Settlement proposal revision ${String(agreement.revisionNumber)} was ${response === "accept" ? "accepted" : response === "decline" ? "declined" : "withdrawn"}.`,
    });

    return projectAgreement(transaction, agreement.id);
  });
}

/**
 * Writes the proposal into the conversation that produced it.
 *
 * A typed row rather than prose in `bodyText`: a client can render a proposal card from
 * `messageKind` plus `settlementAgreementId`, and no participant can forge one by typing.
 * `authorMemberId` stays honest — a settlement message is authored by the member who acted,
 * not by "the system".
 */
async function appendSettlementMessage(
  transaction: DatabaseTransaction,
  input: {
    readonly threadId: string;
    readonly organizationId: string;
    readonly memberId: string;
    readonly agreementId: string;
    readonly messageKind:
      | "settlement_proposed"
      | "settlement_accepted"
      | "settlement_declined"
      | "settlement_withdrawn";
    readonly bodyText: string;
  },
): Promise<void> {
  await transaction.insert(commerceMessage).values({
    threadId: input.threadId,
    authorOrganizationId: input.organizationId,
    authorMemberId: input.memberId,
    bodyText: input.bodyText,
    messageKind: input.messageKind,
    settlementAgreementId: input.agreementId,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function projectAgreement(
  executor: DatabaseTransaction | typeof db,
  agreementId: string,
): Promise<Result<SettlementAgreementProjection, CommerceSettlementError>> {
  const [row] = await executor
    .select({
      agreement: commerceSettlementAgreement,
      providerSlug: commerceExternalProvider.providerSlug,
      providerName: commerceExternalProvider.displayName,
    })
    .from(commerceSettlementAgreement)
    .innerJoin(
      commerceExternalProvider,
      eq(commerceExternalProvider.id, commerceSettlementAgreement.externalProviderId),
    )
    .where(eq(commerceSettlementAgreement.id, agreementId))
    .limit(1);
  if (!row) return { success: false, error: { type: "NOT_FOUND" } };

  const milestones = await executor
    .select({
      sequence: commerceSettlementAgreementMilestone.sequence,
      milestoneKind: commerceSettlementAgreementMilestone.milestoneKind,
      amountInCents: commerceSettlementAgreementMilestone.amountInCents,
      releaseConditionNote: commerceSettlementAgreementMilestone.releaseConditionNote,
    })
    .from(commerceSettlementAgreementMilestone)
    .where(eq(commerceSettlementAgreementMilestone.agreementId, agreementId))
    .orderBy(commerceSettlementAgreementMilestone.sequence);

  return {
    success: true,
    value: {
      id: row.agreement.id,
      threadId: row.agreement.threadId,
      revisionNumber: row.agreement.revisionNumber,
      state: row.agreement.state,
      buyerOrganizationId: row.agreement.buyerOrganizationId,
      sellerOrganizationId: row.agreement.sellerOrganizationId,
      proposedByOrganizationId: row.agreement.proposedByOrganizationId,
      provider: {
        id: row.agreement.externalProviderId,
        slug: row.providerSlug,
        displayName: row.providerName,
      },
      escrowFeeBearer: row.agreement.escrowFeeBearer,
      currency: row.agreement.currency,
      totalInCents: row.agreement.totalInCents,
      expiresAt: row.agreement.expiresAt,
      acceptedAt: row.agreement.acceptedAt,
      acceptedByOrganizationId: row.agreement.acceptedByOrganizationId,
      consumedByOrderId: row.agreement.consumedByOrderId,
      milestones,
    },
  };
}

export async function listThreadSettlementAgreements(
  actor: SettlementActorContext,
  threadId: string,
): Promise<Result<readonly SettlementAgreementProjection[], CommerceSettlementError>> {
  const participates = await assertThreadParticipant(db, threadId, actor.organizationId);
  if (!participates) return { success: false, error: { type: "NOT_FOUND" } };

  const rows = await db
    .select({ id: commerceSettlementAgreement.id })
    .from(commerceSettlementAgreement)
    .where(eq(commerceSettlementAgreement.threadId, threadId))
    .orderBy(desc(commerceSettlementAgreement.revisionNumber));

  const projections: SettlementAgreementProjection[] = [];
  for (const row of rows) {
    const projected = await projectAgreement(db, row.id);
    if (projected.success) projections.push(projected.value);
  }
  return { success: true, value: projections };
}

// ---------------------------------------------------------------------------
// Rail resolution
// ---------------------------------------------------------------------------

export type RailResolution =
  | {
      readonly rail: "external_escrow";
      readonly agreementId: string;
      readonly providerId: string;
      readonly currency: string;
      readonly totalInCents: number;
    }
  | { readonly rail: "direct_processor" }
  | { readonly rail: "direct_offline" };

export type RailResolutionError =
  | { type: "ESCROW_AGREEMENT_UNAVAILABLE"; reason: string }
  | { type: "ESCROW_AGREEMENT_MISMATCH"; reason: string };

export interface ResolveRailInput {
  readonly buyerOrganizationId: string;
  readonly sellerOrganizationId: string;
  readonly currency: string;
  readonly totalInCents: number;
  /** Present when the buyer paid through the processor rather than settling offline. */
  readonly hasProcessorPayment: boolean;
  /**
   * The agreement the buyer says applies. Validated against the accepted, unconsumed set —
   * a body may NAME an agreement, it may never establish one (§0).
   */
  readonly requestedAgreementId: string | null;
}

/**
 * Decides how one order settles, under the caller's row lock at confirm.
 *
 * The rule is deliberately trivial, and the interesting part is what it refuses. A buyer who
 * agreed to escrow and cannot have it — provider suspended, agreement expired, totals moved
 * since it was accepted — is REFUSED. It is never quietly downgraded to an unprotected
 * order, because a buyer who believes a licensed third party is holding their money and is
 * wrong about that is worse off than one who knew they were carrying the risk.
 */
export async function resolveSettlementRail(
  transaction: DatabaseTransaction,
  input: ResolveRailInput,
): Promise<Result<RailResolution, RailResolutionError>> {
  if (input.requestedAgreementId === null) {
    return {
      success: true,
      value: input.hasProcessorPayment ? { rail: "direct_processor" } : { rail: "direct_offline" },
    };
  }

  const [agreement] = await transaction
    .select({
      agreement: commerceSettlementAgreement,
      providerState: commerceExternalProvider.state,
    })
    .from(commerceSettlementAgreement)
    .innerJoin(
      commerceExternalProvider,
      eq(commerceExternalProvider.id, commerceSettlementAgreement.externalProviderId),
    )
    .where(eq(commerceSettlementAgreement.id, input.requestedAgreementId))
    .for("update", { of: commerceSettlementAgreement });

  if (!agreement) {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_UNAVAILABLE", reason: "agreement_not_found" },
    };
  }
  if (
    agreement.agreement.buyerOrganizationId !== input.buyerOrganizationId ||
    agreement.agreement.sellerOrganizationId !== input.sellerOrganizationId
  ) {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_MISMATCH", reason: "agreement_is_between_other_parties" },
    };
  }
  if (agreement.agreement.state !== "accepted") {
    return {
      success: false,
      error: {
        type: "ESCROW_AGREEMENT_UNAVAILABLE",
        reason: `agreement_state_${agreement.agreement.state}`,
      },
    };
  }
  if (agreement.agreement.expiresAt.getTime() <= Date.now()) {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_UNAVAILABLE", reason: "agreement_expired" },
    };
  }
  if (agreement.providerState !== "active") {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_UNAVAILABLE", reason: "provider_suspended" },
    };
  }
  if (agreement.agreement.currency !== input.currency) {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_MISMATCH", reason: "currency_changed_since_acceptance" },
    };
  }
  if (agreement.agreement.totalInCents !== input.totalInCents) {
    /**
     * The cart moved after the terms were agreed. Refusing is the only honest answer: the
     * milestone plan divides a total that is no longer the total, and silently rescaling it
     * would rewrite terms the parties negotiated line by line.
     */
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_MISMATCH", reason: "order_total_changed_since_acceptance" },
    };
  }

  return {
    success: true,
    value: {
      rail: "external_escrow",
      agreementId: agreement.agreement.id,
      providerId: agreement.agreement.externalProviderId,
      currency: agreement.agreement.currency,
      totalInCents: agreement.agreement.totalInCents,
    },
  };
}

/**
 * Marks an accepted agreement spent by the order that used it.
 *
 * Guarded on `state = 'accepted'` in the predicate rather than checked beforehand, so two
 * concurrent confirmations cannot both consume it — the second updates no rows and is told
 * so, which is the same shape the inventory reservation path uses.
 */
export async function consumeSettlementAgreement(
  transaction: DatabaseTransaction,
  agreementId: string,
  orderId: string,
): Promise<Result<true, RailResolutionError>> {
  const consumed = await transaction
    .update(commerceSettlementAgreement)
    .set({ state: "consumed", consumedByOrderId: orderId, updatedAt: new Date() })
    .where(
      and(
        eq(commerceSettlementAgreement.id, agreementId),
        eq(commerceSettlementAgreement.state, "accepted"),
      ),
    )
    .returning({ id: commerceSettlementAgreement.id });

  if (consumed.length === 0) {
    return {
      success: false,
      error: { type: "ESCROW_AGREEMENT_UNAVAILABLE", reason: "agreement_already_consumed" },
    };
  }
  return { success: true, value: true };
}

/**
 * Expires proposals and acceptances whose deadline has passed.
 *
 * Called from the hourly connector reconciliation. Expiry is a STORED state here, unlike
 * certification lapse in Phase 12 which is computed at read time — the difference is that a
 * lapsed certificate only affects a projection, whereas a live accepted agreement is a
 * standing offer to bind an order, and leaving it nominally acceptable between ticks would
 * let a checkout consume terms whose deadline had passed.
 */
export async function expireStaleSettlementAgreements(): Promise<{ readonly expired: number }> {
  const expired = await db
    .update(commerceSettlementAgreement)
    .set({ state: "expired", updatedAt: new Date() })
    .where(
      and(
        /**
         * BOTH states, and `accepted` is the one that matters. A stale `proposed` row is
         * merely untidy — nothing can act on it. A stale `accepted` row is a standing
         * offer to bind an order, and it also occupies
         * `commerce_settlement_agreement_accepted_uidx`, so leaving it in place blocks the
         * parties from agreeing fresh terms. `resolveSettlementRail` refuses it either way;
         * this is what makes the refusal legible instead of mysterious.
         */
        inArray(commerceSettlementAgreement.state, ["proposed", "accepted"]),
        sql`${commerceSettlementAgreement.expiresAt} <= now()`,
      ),
    )
    .returning({ id: commerceSettlementAgreement.id });
  return { expired: expired.length };
}
