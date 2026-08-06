import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceDispute,
  commerceDisputeEvent,
  commerceOrder,
  commerceOrganizationMember,
  commerceReview,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type {
  CreateDisputeInput,
  CreateReviewInput,
  DecideDisputeInput,
} from "#src/schemas/commerce-trust.schemas.js";
import {
  memberCanOperateBuyer,
  type CommerceOrganizationMemberRole,
} from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderState = (typeof commerceOrder.$inferSelect)["state"];
type DisputeState = (typeof commerceDispute.$inferSelect)["state"];

export type CommerceTrustError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "SELF_REVIEW_FORBIDDEN" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "INVALID_CURSOR" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" };

export interface CommerceTrustActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface ReviewProjection {
  readonly id: string;
  readonly completionId: string;
  readonly subjectOrganizationId: string;
  readonly productId: string | null;
  readonly rating: number;
  readonly body: string;
  readonly visibility: "visible" | "hidden";
  readonly createdAt: Date;
}

export interface DisputeProjection {
  readonly id: string;
  readonly orderId: string;
  readonly state: DisputeState;
  readonly reasonCode: string;
  readonly summary: string;
  readonly priorOrderState: OrderState;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly openedByOrganizationId: string;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

const DEFAULT_PAGE_LIMIT = 20;
const DISPUTABLE_ORDER_STATES: readonly OrderState[] = [
  "confirmed",
  "in_fulfillment",
  "partially_completed",
  "completed",
];

async function appendAuditOrThrow(
  transaction: DatabaseTransaction,
  input: Parameters<typeof appendCommerceOrganizationAuditEntry>[1],
): Promise<void> {
  const appended = await appendCommerceOrganizationAuditEntry(transaction, input);
  if (!appended.success) {
    throw new Error(`Commerce trust audit append failed: ${appended.error.type}`);
  }
}

function projectDispute(dispute: typeof commerceDispute.$inferSelect): DisputeProjection {
  return {
    id: dispute.id,
    orderId: dispute.orderId,
    state: dispute.state,
    reasonCode: dispute.reasonCode,
    summary: dispute.summary,
    priorOrderState: dispute.priorOrderState,
    buyerOrganizationId: dispute.buyerOrganizationId,
    counterpartyOrganizationId: dispute.counterpartyOrganizationId,
    openedByOrganizationId: dispute.openedByOrganizationId,
    createdAt: dispute.createdAt,
    decidedAt: dispute.decidedAt,
  };
}

function projectReview(review: typeof commerceReview.$inferSelect): ReviewProjection {
  return {
    id: review.id,
    completionId: review.completionId,
    subjectOrganizationId: review.subjectOrganizationId,
    productId: review.productId,
    rating: review.rating,
    body: review.body,
    visibility: review.visibility,
    createdAt: review.createdAt,
  };
}

export async function createReview(
  actor: CommerceTrustActorContext,
  completionId: string,
  input: CreateReviewInput,
): Promise<Result<ReviewProjection, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [completion] = await transaction
      .select()
      .from(commerceCompletion)
      .where(eq(commerceCompletion.id, completionId))
      .for("update");
    if (!completion) return { status: "not_found" as const };
    if (completion.buyerOrganizationId !== actor.organizationId) {
      return { status: "not_found" as const };
    }
    if (completion.buyerOrganizationId === completion.counterpartyOrganizationId) {
      return { status: "self_review" as const };
    }

    const [existing] = await transaction
      .select({ id: commerceReview.id })
      .from(commerceReview)
      .where(
        and(
          eq(commerceReview.completionId, completion.id),
          eq(commerceReview.reviewerOrganizationId, actor.organizationId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        status: "conflict" as const,
        message: "This organization has already reviewed this completion.",
      };
    }

    const now = new Date();
    const [inserted] = await transaction
      .insert(commerceReview)
      .values({
        completionId: completion.id,
        reviewerOrganizationId: actor.organizationId,
        reviewerMemberId: actor.memberId,
        subjectOrganizationId: completion.counterpartyOrganizationId,
        productId: completion.productId,
        rating: input.rating,
        body: input.body,
        visibility: "visible",
      })
      .returning();
    if (!inserted) {
      return { status: "conflict" as const, message: "Review could not be created." };
    }

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "review_created",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_review",
      targetEntityId: inserted.id,
      payload: {
        reviewId: inserted.id,
        completionId: completion.id,
        rating: String(input.rating),
        subjectOrganizationId: completion.counterpartyOrganizationId,
      },
      occurredAt: now,
    });

    return { status: "created" as const, review: inserted };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_review":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "created":
      return { success: true, value: projectReview(outcome.review) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled createReview outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function openDispute(
  actor: CommerceTrustActorContext,
  orderId: string,
  input: CreateDisputeInput,
): Promise<Result<DisputeProjection, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };
    if (
      order.buyerOrganizationId !== actor.organizationId &&
      order.counterpartyOrganizationId !== actor.organizationId
    ) {
      return { status: "not_found" as const };
    }
    if (order.buyerOrganizationId !== actor.organizationId) {
      // MVP: only the buyer organization may open a dispute case.
      return { status: "forbidden" as const };
    }
    if (order.state === "disputed" || order.state === "cancelled") {
      return {
        status: "invalid_state" as const,
        message: "This order cannot enter a new dispute from its current state.",
      };
    }
    if (!DISPUTABLE_ORDER_STATES.includes(order.state)) {
      return {
        status: "invalid_state" as const,
        message: "Disputes require a confirmed or fulfilled order.",
      };
    }

    const [existingOpenDispute] = await transaction
      .select({ id: commerceDispute.id })
      .from(commerceDispute)
      .where(and(eq(commerceDispute.orderId, order.id), eq(commerceDispute.state, "open")))
      .limit(1);
    if (existingOpenDispute) {
      return {
        status: "conflict" as const,
        message: "An open dispute already exists for this order.",
      };
    }

    const now = new Date();
    const orderSnapshotJson = JSON.stringify({
      orderId: order.id,
      state: order.state,
      currency: order.currency,
      totalInCents: order.totalInCents,
      buyerOrganizationId: order.buyerOrganizationId,
      counterpartyOrganizationId: order.counterpartyOrganizationId,
      buyerLegalNameSnapshot: order.buyerLegalNameSnapshot,
      counterpartyLegalNameSnapshot: order.counterpartyLegalNameSnapshot,
      source: order.source,
    });

    const [inserted] = await transaction
      .insert(commerceDispute)
      .values({
        orderId: order.id,
        openedByOrganizationId: actor.organizationId,
        openedByMemberId: actor.memberId,
        buyerOrganizationId: order.buyerOrganizationId,
        counterpartyOrganizationId: order.counterpartyOrganizationId,
        priorOrderState: order.state,
        state: "open",
        reasonCode: input.reasonCode,
        summary: input.summary,
        orderSnapshotJson,
      })
      .returning();
    if (!inserted) {
      return { status: "conflict" as const, message: "Dispute could not be created." };
    }

    await transaction.insert(commerceDisputeEvent).values({
      disputeId: inserted.id,
      sequence: 0,
      eventKind: "opened",
      actorUserId: actor.actorUserId,
      note: input.summary,
      occurredAt: now,
    });

    await transaction
      .update(commerceOrder)
      .set({ state: "disputed", updatedAt: now })
      .where(eq(commerceOrder.id, order.id));

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "dispute_opened",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_dispute",
      targetEntityId: inserted.id,
      payload: {
        disputeId: inserted.id,
        orderId: order.id,
        reasonCode: input.reasonCode,
        priorOrderState: order.state,
      },
      occurredAt: now,
    });

    return { status: "created" as const, dispute: inserted };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "forbidden":
      return { success: false, error: { type: "FORBIDDEN" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "created":
      return { success: true, value: projectDispute(outcome.dispute) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled openDispute outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function listDisputesForModerator(
  moderatorUserId: string,
  input: { readonly limit?: number; readonly cursor?: string; readonly state?: DisputeState },
): Promise<
  Result<
    {
      readonly items: readonly DisputeProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceTrustError
  >
> {
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  let cursorPredicate: SQL | undefined;
  if (input.cursor) {
    const decodedCursor = decodeStoreCursor(input.cursor);
    if (!decodedCursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    cursorPredicate = or(
      lt(commerceDispute.createdAt, new Date(decodedCursor.sortKey)),
      and(
        eq(commerceDispute.createdAt, new Date(decodedCursor.sortKey)),
        gt(commerceDispute.id, decodedCursor.id),
      ),
    );
  }

  const statePredicate =
    input.state === undefined ? undefined : eq(commerceDispute.state, input.state);

  const rows = await db
    .select()
    .from(commerceDispute)
    .where(and(statePredicate, cursorPredicate))
    .orderBy(desc(commerceDispute.createdAt), asc(commerceDispute.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows.at(-1);
  return {
    success: true,
    value: {
      items: pageRows.map(projectDispute),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({
                sortKey: lastRow.createdAt.toISOString(),
                id: lastRow.id,
              })
            : null,
        hasMore,
      },
    },
  };
}

export async function decideDispute(
  moderatorUserId: string,
  disputeId: string,
  input: DecideDisputeInput,
): Promise<Result<DisputeProjection, CommerceTrustError>> {
  const capability = await requirePlatformCapability(moderatorUserId, "moderate_commerce");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [dispute] = await transaction
      .select()
      .from(commerceDispute)
      .where(eq(commerceDispute.id, disputeId))
      .for("update");
    if (!dispute) return { status: "not_found" as const };
    if (dispute.state !== "open") {
      return {
        status: "invalid_state" as const,
        message: "Only open disputes can be decided.",
      };
    }

    const memberships = await transaction
      .select({ organizationId: commerceOrganizationMember.organizationId })
      .from(commerceOrganizationMember)
      .where(
        and(
          eq(commerceOrganizationMember.userId, moderatorUserId),
          eq(commerceOrganizationMember.state, "active"),
          or(
            eq(commerceOrganizationMember.organizationId, dispute.buyerOrganizationId),
            eq(commerceOrganizationMember.organizationId, dispute.counterpartyOrganizationId),
          ),
        ),
      )
      .limit(1);
    if (memberships.length > 0) {
      return { status: "self_review" as const };
    }

    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, dispute.orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };

    const now = new Date();
    const [updated] = await transaction
      .update(commerceDispute)
      .set({
        state: input.decision,
        decidedByUserId: moderatorUserId,
        decisionNote: input.note ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(commerceDispute.id, dispute.id), eq(commerceDispute.state, "open")))
      .returning();
    if (!updated) {
      return {
        status: "conflict" as const,
        message: "Dispute was decided concurrently.",
      };
    }

    const [eventCount] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(commerceDisputeEvent)
      .where(eq(commerceDisputeEvent.disputeId, dispute.id));
    await transaction.insert(commerceDisputeEvent).values({
      disputeId: dispute.id,
      sequence: eventCount?.count ?? 0,
      eventKind: input.decision,
      actorUserId: moderatorUserId,
      note: input.note ?? null,
      occurredAt: now,
    });

    if (order.state === "disputed") {
      await transaction
        .update(commerceOrder)
        .set({ state: dispute.priorOrderState, updatedAt: now })
        .where(eq(commerceOrder.id, order.id));
    }

    await appendAuditOrThrow(transaction, {
      organizationId: dispute.buyerOrganizationId,
      eventKind: "dispute_decided",
      actorUserId: moderatorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_dispute",
      targetEntityId: dispute.id,
      payload: {
        disputeId: dispute.id,
        orderId: dispute.orderId,
        decision: input.decision,
        restoredOrderState: dispute.priorOrderState,
      },
      occurredAt: now,
    });

    return { status: "decided" as const, dispute: updated };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_review":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "invalid_state":
      return { success: false, error: { type: "INVALID_STATE", message: outcome.message } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "decided":
      return { success: true, value: projectDispute(outcome.dispute) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled decideDispute outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
