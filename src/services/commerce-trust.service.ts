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
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
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
  | { type: "DISPUTE_PARTY_MODERATION_FORBIDDEN" }
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

export function evaluateReviewRelationship(input: {
  readonly actorOrganizationId: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
}): "eligible" | "not_found" | "self_review" {
  if (input.buyerOrganizationId !== input.actorOrganizationId) return "not_found";
  if (input.buyerOrganizationId === input.counterpartyOrganizationId) return "self_review";
  return "eligible";
}

export function evaluateDisputeOpeningRelationship(input: {
  readonly actorOrganizationId: string;
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
  readonly orderState: OrderState;
}): "eligible" | "not_found" | "forbidden" | "invalid_state" {
  const actorIsOrderParty =
    input.buyerOrganizationId === input.actorOrganizationId ||
    input.counterpartyOrganizationId === input.actorOrganizationId;
  if (!actorIsOrderParty) return "not_found";
  if (input.buyerOrganizationId === input.counterpartyOrganizationId) return "forbidden";
  if (input.buyerOrganizationId !== input.actorOrganizationId) return "forbidden";
  if (!DISPUTABLE_ORDER_STATES.includes(input.orderState)) return "invalid_state";
  return "eligible";
}

export function isModeratorMemberOfDisputeParty(input: {
  readonly moderatorOrganizationIds: readonly string[];
  readonly buyerOrganizationId: string;
  readonly counterpartyOrganizationId: string;
}): boolean {
  return input.moderatorOrganizationIds.some(
    (organizationId) =>
      organizationId === input.buyerOrganizationId ||
      organizationId === input.counterpartyOrganizationId,
  );
}

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
    const reviewRelationship = evaluateReviewRelationship({
      actorOrganizationId: actor.organizationId,
      buyerOrganizationId: completion.buyerOrganizationId,
      counterpartyOrganizationId: completion.counterpartyOrganizationId,
    });
    if (reviewRelationship !== "eligible") {
      return { status: reviewRelationship };
    }

    const [existing] = await transaction
      .select()
      .from(commerceReview)
      .where(
        and(
          eq(commerceReview.completionId, completion.id),
          eq(commerceReview.reviewerOrganizationId, actor.organizationId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.rating === input.rating && existing.body === input.body) {
        return { status: "existing" as const, review: existing };
      }
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
    case "existing":
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
    const disputeOpeningRelationship = evaluateDisputeOpeningRelationship({
      actorOrganizationId: actor.organizationId,
      buyerOrganizationId: order.buyerOrganizationId,
      counterpartyOrganizationId: order.counterpartyOrganizationId,
      orderState: order.state,
    });
    if (disputeOpeningRelationship === "not_found") {
      return { status: "not_found" as const };
    }
    if (disputeOpeningRelationship === "forbidden") {
      return { status: "forbidden" as const };
    }

    const [existingOpenDispute] = await transaction
      .select()
      .from(commerceDispute)
      .where(and(eq(commerceDispute.orderId, order.id), eq(commerceDispute.state, "open")))
      .limit(1);
    if (existingOpenDispute) {
      if (
        existingOpenDispute.reasonCode === input.reasonCode &&
        existingOpenDispute.summary === input.summary
      ) {
        return { status: "existing" as const, dispute: existingOpenDispute };
      }
      return {
        status: "conflict" as const,
        message: "An open dispute already exists for this order.",
      };
    }
    if (disputeOpeningRelationship === "invalid_state") {
      return {
        status: "invalid_state" as const,
        message: "Disputes require a confirmed or fulfilled order.",
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
    case "existing":
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
    const decodedCursor = decodeTimestampStoreCursor(input.cursor);
    if (!decodedCursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    cursorPredicate = or(
      lt(commerceDispute.createdAt, decodedCursor.sortKey),
      and(
        eq(commerceDispute.createdAt, decodedCursor.sortKey),
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
      .where(eq(commerceOrganizationMember.userId, moderatorUserId));
    if (
      isModeratorMemberOfDisputeParty({
        moderatorOrganizationIds: memberships.map((membership) => membership.organizationId),
        buyerOrganizationId: dispute.buyerOrganizationId,
        counterpartyOrganizationId: dispute.counterpartyOrganizationId,
      })
    ) {
      return { status: "party_moderation_forbidden" as const };
    }

    const [order] = await transaction
      .select()
      .from(commerceOrder)
      .where(eq(commerceOrder.id, dispute.orderId))
      .for("update");
    if (!order) return { status: "not_found" as const };
    if (order.state !== "disputed") {
      return {
        status: "conflict" as const,
        message: "The order is no longer frozen by this dispute.",
      };
    }

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
      throw new Error("Locked open dispute vanished while recording its decision.");
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

    const [restoredOrder] = await transaction
      .update(commerceOrder)
      .set({ state: dispute.priorOrderState, updatedAt: now })
      .where(and(eq(commerceOrder.id, order.id), eq(commerceOrder.state, "disputed")))
      .returning({ id: commerceOrder.id });
    if (!restoredOrder) {
      throw new Error("Locked disputed order vanished while restoring its prior state.");
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
    case "party_moderation_forbidden":
      return { success: false, error: { type: "DISPUTE_PARTY_MODERATION_FORBIDDEN" } };
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
