import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceCompletion,
  commerceDispute,
  commerceDisputeEvent,
  commerceOrder,
  commerceOrganizationMember,
  commerceReview,
  commerceReviewMedia,
  commerceReviewReply,
  commerceReviewScore,
  commerceReviewVote,
} from "#src/db/schema.js";
import {
  deleteReviewMedia as deleteReviewMediaAsset,
  uploadReviewMedia,
  type CloudinaryError,
} from "#src/lib/cloudinary.js";
import { validateAndNormalizeImage, type ImageValidationError } from "#src/lib/image.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { extractYoutubeVideoId } from "#src/lib/youtube.js";
import type {
  AttachReviewVideoInput,
  CreateDisputeInput,
  CreateReviewInput,
  DecideDisputeInput,
  UpsertReviewReplyInput,
} from "#src/schemas/commerce-trust.schemas.js";
import {
  memberCanOperateBuyer,
  memberCanOperateCounterparty,
  type CommerceOrganizationMemberRole,
} from "#src/services/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/services/commerce-organization-audit.service.js";
import { requirePlatformCapability } from "#src/services/platform-role.service.js";
import type { Result } from "#src/types/index.js";

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OrderState = (typeof commerceOrder.$inferSelect)["state"];
type DisputeState = (typeof commerceDispute.$inferSelect)["state"];
type ReviewScoreAxis = (typeof commerceReviewScore.$inferSelect)["axis"];

/**
 * The six-photo cap (Appendix A8), enforced three ways: here, by
 * `commerce_review_media_count_ck` on the counter, and by
 * `commerce_review_media_position_ck` on the position. The service check is what
 * produces a useful error; the two constraints are what make the rule true.
 */
const MAXIMUM_REVIEW_MEDIA_COUNT = 6;

/**
 * A review photo renders in a strip, not in the product's hero box, so it is
 * normalized to a smaller box than `product_image`'s 1600.
 */
const REVIEW_MEDIA_OUTPUT_MAX_DIMENSION_PX = 1200;

/**
 * `shipping` is meaningless on a service engagement — nothing shipped. This is a
 * cross-table rule, so it lives here rather than in a CHECK: `createReview` already
 * holds the completion row under a lock and can see the target kind.
 */
const SERVICE_ENGAGEMENT_FORBIDDEN_SCORE_AXES: readonly ReviewScoreAxis[] = ["shipping"];

export type CommerceTrustError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "SELF_REVIEW_FORBIDDEN" }
  | { type: "DISPUTE_PARTY_MODERATION_FORBIDDEN" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "CONFLICT"; message: string }
  | { type: "INVALID_CURSOR" }
  | { type: "PLATFORM_CAPABILITY_REQUIRED"; capability: "moderate_commerce" }
  /** Appendix A8 — the six-photo cap, checked under the review row lock. */
  | { type: "MEDIA_LIMIT_REACHED"; limit: number }
  /** Appendix A8 — a review party voting on its own review. */
  | { type: "SELF_VOTE_FORBIDDEN" }
  /** Appendix A8 — `shipping` on a completion that never shipped anything. */
  | { type: "UNSUPPORTED_SCORE_AXIS"; axis: ReviewScoreAxis }
  /** Appendix A8 — a video attachment whose URL is not a YouTube video. */
  | { type: "INVALID_YOUTUBE_URL" };

/**
 * Media writes compose three unions rather than merging them (the shape `ProductError`
 * already uses). Keeping them separate means `openDispute` and the public review read
 * are not typed as possibly-`UPLOAD_FAILED`, and the controller's media mapper can
 * delegate its `default` branch to `mapTrustError` with TypeScript narrowing the
 * remainder — so no assertion is needed anywhere.
 */
export type CommerceReviewMediaError = CommerceTrustError | ImageValidationError | CloudinaryError;

export interface CommerceTrustActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface ReviewScoreEntry {
  readonly axis: ReviewScoreAxis;
  readonly score: number;
}

/**
 * The AUTHOR-facing projection, returned from the write routes. It keeps
 * `completionId` because it goes back to the organization that owns that completion.
 * The PUBLIC projection in `store-reviews.service.ts` deliberately drops it — §5.1
 * excludes order internals from buyer-safe reads.
 */
export interface ReviewProjection {
  readonly id: string;
  readonly completionId: string;
  readonly subjectOrganizationId: string;
  readonly productId: string | null;
  readonly rating: number;
  readonly body: string;
  readonly visibility: "visible" | "hidden";
  readonly helpfulCount: number;
  readonly mediaCount: number;
  readonly scores: readonly ReviewScoreEntry[];
  /**
   * A38. NULL until the author spends their one edit. PROJECTED PUBLICLY on purpose — a
   * rewritten review that does not say it was rewritten is the manipulation, not the edit.
   */
  readonly editedAt: Date | null;
  readonly createdAt: Date;
}

export interface ReviewMediaProjection {
  readonly id: string;
  readonly reviewId: string;
  readonly mediaKind: "photo" | "youtube_video";
  readonly url: string | null;
  readonly youtubeVideoId: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
  /**
   * A40. Projected to the AUTHOR, unlike the public read which filters unavailable rows out
   * entirely. A buyer whose video died deserves to know that rather than finding an empty slot
   * where they remember attaching something — and only they can replace it.
   */
  readonly state: "visible" | "unavailable_upstream";
  readonly unavailableAt: Date | null;
}

export interface ReviewHelpfulVoteProjection {
  readonly reviewId: string;
  readonly isHelpful: boolean;
  readonly helpfulCount: number;
}

export interface ReviewReplyProjection {
  readonly reviewId: string;
  readonly responderOrganizationId: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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

/** A28. One dispute as its own participants see it, with the timeline behind it. */
export interface DisputeDetailProjection extends DisputeProjection {
  readonly decisionNote: string | null;
  readonly timeline: readonly {
    readonly sequence: number;
    readonly eventKind: (typeof commerceDisputeEvent.$inferSelect)["eventKind"];
    readonly note: string | null;
    readonly occurredAt: Date;
  }[];
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

function projectReview(
  review: typeof commerceReview.$inferSelect,
  scores: readonly ReviewScoreEntry[] = [],
): ReviewProjection {
  return {
    id: review.id,
    completionId: review.completionId,
    subjectOrganizationId: review.subjectOrganizationId,
    productId: review.productId,
    rating: review.rating,
    body: review.body,
    visibility: review.visibility,
    helpfulCount: review.helpfulCount,
    mediaCount: review.mediaCount,
    scores: scores.toSorted((left, right) => left.axis.localeCompare(right.axis)),
    editedAt: review.editedAt,
    createdAt: review.createdAt,
  };
}

/**
 * Turns the optional `{ service?, shipping?, quality? }` body object into rows.
 * Sorted, so the replay comparison below can compare two arrays without caring what
 * order the client sent its keys in.
 */
function toReviewScoreEntries(scores: CreateReviewInput["scores"]): readonly ReviewScoreEntry[] {
  if (!scores) return [];
  const entries: ReviewScoreEntry[] = [];
  if (scores.service !== undefined) entries.push({ axis: "service", score: scores.service });
  if (scores.shipping !== undefined) entries.push({ axis: "shipping", score: scores.shipping });
  if (scores.quality !== undefined) entries.push({ axis: "quality", score: scores.quality });
  return entries.toSorted((left, right) => left.axis.localeCompare(right.axis));
}

function reviewScoresMatch(
  storedScores: readonly ReviewScoreEntry[],
  requestedScores: readonly ReviewScoreEntry[],
): boolean {
  if (storedScores.length !== requestedScores.length) return false;
  return storedScores.every((stored, index) => {
    const requested = requestedScores[index];
    return (
      requested !== undefined && requested.axis === stored.axis && requested.score === stored.score
    );
  });
}

async function loadReviewScores(
  executor: DatabaseTransaction | typeof db,
  reviewId: string,
): Promise<readonly ReviewScoreEntry[]> {
  const rows = await executor
    .select({ axis: commerceReviewScore.axis, score: commerceReviewScore.score })
    .from(commerceReviewScore)
    .where(eq(commerceReviewScore.reviewId, reviewId))
    .orderBy(asc(commerceReviewScore.axis));
  return rows;
}

export async function createReview(
  actor: CommerceTrustActorContext,
  completionId: string,
  input: CreateReviewInput,
): Promise<Result<ReviewProjection, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const requestedScores = toReviewScoreEntries(input.scores);

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

    /**
     * A service engagement shipped nothing, so a shipping score would be a rating of
     * something that never happened. Checked here rather than in a CHECK because the
     * fact lives on the completion, one table over — and checked BEFORE the replay
     * comparison so an invalid axis is a 422 rather than a confusing 409.
     */
    if (completion.targetKind === "service_engagement") {
      const forbiddenAxis = requestedScores.find((entry) =>
        SERVICE_ENGAGEMENT_FORBIDDEN_SCORE_AXES.includes(entry.axis),
      );
      if (forbiddenAxis) {
        return { status: "unsupported_score_axis" as const, axis: forbiddenAxis.axis };
      }
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
      /**
       * Replay comparison now covers the scores too. Without that, retrying the exact
       * same request with an added axis would return the ORIGINAL review and silently
       * drop the new scores — a success response for a write that did not happen.
       */
      const storedScores = await loadReviewScores(transaction, existing.id);
      if (
        existing.rating === input.rating &&
        existing.body === input.body &&
        reviewScoresMatch(storedScores, requestedScores)
      ) {
        return { status: "existing" as const, review: existing, scores: storedScores };
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

    if (requestedScores.length > 0) {
      await transaction.insert(commerceReviewScore).values(
        requestedScores.map((entry) => ({
          reviewId: inserted.id,
          axis: entry.axis,
          score: entry.score,
        })),
      );
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
        scoredAxes: requestedScores.map((entry) => entry.axis),
      },
      occurredAt: now,
    });

    return { status: "created" as const, review: inserted, scores: requestedScores };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "unsupported_score_axis":
      return { success: false, error: { type: "UNSUPPORTED_SCORE_AXIS", axis: outcome.axis } };
    case "self_review":
      return { success: false, error: { type: "SELF_REVIEW_FORBIDDEN" } };
    case "conflict":
      return { success: false, error: { type: "CONFLICT", message: outcome.message } };
    case "existing":
    case "created":
      return { success: true, value: projectReview(outcome.review, outcome.scores) };
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
      // Zero by construction — the dispute row was inserted three statements ago — but taken
      // from the same helper the other two writers use, so there is one rule and not two.
      sequence: await nextDisputeEventSequence(transaction, inserted.id),
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

/**
 * A28. One dispute, read by a party to the order it is about.
 *
 * THE PREDICATE IS `cancelOrder`'S, and both refusals collapse to `NOT_FOUND`. "No such
 * dispute" and "not your dispute" must be indistinguishable, or the route becomes an
 * oracle for which dispute ids exist — and a dispute id names two organizations and a
 * commercial disagreement between them.
 *
 * This is deliberately NOT `evaluateDisputeOpeningRelationship`. That one splits
 * party-but-not-buyer into a 403 because only a buyer may OPEN a dispute; both parties
 * may read one, and the counterparty being told a dispute exists against them is the
 * entire point of telling them.
 */
/**
 * Is this organization a party to this dispute? (A28's rule, A40's helper.)
 *
 * EXTRACTED so the read and the note write cannot answer it differently. It was inline in
 * `getDisputeForParticipant` and correct there; a second copy in the writer is how the two
 * eventually disagree about who may speak in a dispute they can both read.
 *
 * BOTH SIDES, unlike `evaluateDisputeOpeningRelationship`, which 403s a party who is not the
 * buyer because only a buyer may OPEN a dispute. A counterparty who cannot answer an accusation
 * is the reason a timeline exists at all.
 */
/**
 * The next position on a dispute's timeline.
 *
 * `MAX(sequence) + 1`, NOT `count(*)`. The two agree today only because the table is append-only
 * by trigger (`0052`) and every existing writer starts at zero — so a count happens to equal the
 * highest sequence plus one. A40 adds a third writer, and a rule that holds by coincidence across
 * three call sites is one somebody eventually breaks.
 *
 * MUST BE CALLED UNDER THE DISPUTE ROW LOCK. Every caller already takes `FOR UPDATE` on
 * `commerce_dispute` before reaching here, which is what makes read-then-insert safe;
 * `commerce_dispute_event_sequence_uidx` is the backstop if one ever forgets.
 */
async function nextDisputeEventSequence(
  transaction: DatabaseTransaction,
  disputeId: string,
): Promise<number> {
  const [highest] = await transaction
    .select({ sequence: sql<number | null>`max(${commerceDisputeEvent.sequence})` })
    .from(commerceDisputeEvent)
    .where(eq(commerceDisputeEvent.disputeId, disputeId));
  return highest?.sequence === null || highest?.sequence === undefined ? 0 : highest.sequence + 1;
}

export function isDisputeParty(
  dispute: { readonly buyerOrganizationId: string; readonly counterpartyOrganizationId: string },
  organizationId: string,
): boolean {
  return (
    dispute.buyerOrganizationId === organizationId ||
    dispute.counterpartyOrganizationId === organizationId
  );
}

/**
 * Add a note to a dispute's timeline (Appendix A40).
 *
 * `commerce_dispute_event_kind` has carried `note_added` since `0052` with NO WRITER. A28 then
 * shipped the participant read, which projects the timeline with `note` included and filters on
 * no `eventKind` — so a note has had somewhere to appear ever since, and nothing to put there. A
 * buyer could open a dispute over a six-figure order and then say nothing further, and the seller
 * could read the accusation and not answer it.
 *
 * BOTH PARTIES, WHILE IT IS OPEN.
 *
 * - Both, because both can already read it, and a counterparty who cannot respond makes the
 *   timeline a one-sided record of a two-sided disagreement.
 * - Open only, because `decideDispute` has already restored the order's `priorOrderState` by the
 *   time a dispute is `closed` or `dismissed`. There is nothing left to argue about, and an
 *   append-only table means a note added afterwards could never be withdrawn.
 * - A NON-PARTY GETS `NOT_FOUND`, never `FORBIDDEN` — A28's rule, so the route cannot be used to
 *   discover which dispute ids exist.
 *
 * The row is immutable once written (`commerce_dispute_event_append_only`, `0052:134-139`), which
 * is the point: a timeline somebody can edit afterwards is not evidence.
 */
export async function addDisputeNote(
  actor: CommerceTrustActorContext,
  disputeId: string,
  input: { readonly note: string },
): Promise<Result<DisputeDetailProjection, CommerceTrustError>> {
  const outcome = await db.transaction(async (transaction) => {
    /**
     * `FOR UPDATE` for the same reason `decideDispute` takes it: `nextDisputeEventSequence`
     * reads the highest sequence and then inserts, and two concurrent notes without the lock
     * would both read the same number and one would lose to the unique index.
     */
    const [dispute] = await transaction
      .select()
      .from(commerceDispute)
      .where(eq(commerceDispute.id, disputeId))
      .limit(1)
      .for("update");

    if (!dispute || !isDisputeParty(dispute, actor.organizationId)) {
      return { status: "not_found" as const };
    }
    if (dispute.state !== "open") {
      return { status: "already_decided" as const, state: dispute.state };
    }

    await transaction.insert(commerceDisputeEvent).values({
      disputeId: dispute.id,
      sequence: await nextDisputeEventSequence(transaction, dispute.id),
      eventKind: "note_added",
      actorUserId: actor.actorUserId,
      note: input.note,
      occurredAt: new Date(),
    });

    return { status: "added" as const };
  });

  switch (outcome.status) {
    case "added":
      /**
       * Answers the WHOLE timeline rather than the one note. A party adding a note wants to see
       * the conversation it joined, and re-reading through the participant read means the
       * response cannot disagree with what a refresh would show.
       */
      return getDisputeForParticipant(actor, disputeId);
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "already_decided":
      return {
        success: false,
        error: {
          type: "INVALID_STATE",
          message: `This dispute was already ${outcome.state} and can no longer be added to.`,
        },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled dispute note outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

export async function getDisputeForParticipant(
  actor: CommerceTrustActorContext,
  disputeId: string,
): Promise<Result<DisputeDetailProjection, CommerceTrustError>> {
  const [dispute] = await db
    .select()
    .from(commerceDispute)
    .where(eq(commerceDispute.id, disputeId))
    .limit(1);

  if (!dispute || !isDisputeParty(dispute, actor.organizationId)) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const eventRows = await db
    .select({
      sequence: commerceDisputeEvent.sequence,
      eventKind: commerceDisputeEvent.eventKind,
      note: commerceDisputeEvent.note,
      occurredAt: commerceDisputeEvent.occurredAt,
    })
    .from(commerceDisputeEvent)
    .where(eq(commerceDisputeEvent.disputeId, dispute.id))
    .orderBy(asc(commerceDisputeEvent.occurredAt), asc(commerceDisputeEvent.sequence));

  return {
    success: true,
    value: {
      ...projectDispute(dispute),
      /**
       * `decisionNote` is included, and it is the reason a participant asks. The
       * moderator's identity is NOT: which member of staff decided is not a fact either
       * trading party has any claim on.
       */
      decisionNote: dispute.decisionNote,
      timeline: eventRows,
    },
  };
}

/**
 * A28. Every dispute the caller's organization is a party to, newest first.
 *
 * Both sides of the predicate, not just the buyer: `commerce_dispute_parties_ck` means
 * only a buyer opens one, but a seller with a dispute filed against them needs to find
 * it without being handed the id by someone else.
 */
export async function listDisputesForParticipant(
  actor: CommerceTrustActorContext,
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

  const rows = await db
    .select()
    .from(commerceDispute)
    .where(
      and(
        or(
          eq(commerceDispute.buyerOrganizationId, actor.organizationId),
          eq(commerceDispute.counterpartyOrganizationId, actor.organizationId),
        ),
        input.state === undefined ? undefined : eq(commerceDispute.state, input.state),
        cursorPredicate,
      ),
    )
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
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
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

    await transaction.insert(commerceDisputeEvent).values({
      disputeId: dispute.id,
      sequence: await nextDisputeEventSequence(transaction, dispute.id),
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

// ---------------------------------------------------------------------------
// Appendix A8 — review depth: media, helpful votes, and the seller reply.
//
// Everything below authorizes against the review row and returns NOT_FOUND rather
// than FORBIDDEN when the caller is the wrong organization, matching
// `evaluateReviewRelationship` and §11's anti-enumeration rule.
//
// A HIDDEN REVIEW IS 404 FOR EVERYONE, including its own author trying to attach
// media to it. Once a review is pulled it stops being editable — that is what
// post-moderation means, and an author who could keep decorating a hidden review
// would be able to tell it had been hidden.
// ---------------------------------------------------------------------------

/**
 * The gallery is re-packed to 0..n-1 after a removal so positions stay contiguous.
 *
 * TWO passes, not a per-row loop. `commerce_review_media_position_uidx` is a plain
 * unique index and cannot be DEFERRABLE, so writing final positions one row at a time
 * collides with a sibling that has not moved yet. Parking every row beyond the legal
 * range first is the same trick A2's gallery re-pack uses — except the park value has
 * to clear `commerce_review_media_position_ck` too, which is why the parked rows are
 * written with a negative offset rather than a large positive one.
 *
 * Six rows maximum, so the cost is irrelevant; the correctness is not.
 */
async function repackReviewMediaPositions(
  transaction: DatabaseTransaction,
  reviewId: string,
): Promise<void> {
  const remaining = await transaction
    .select({ id: commerceReviewMedia.id })
    .from(commerceReviewMedia)
    .where(eq(commerceReviewMedia.reviewId, reviewId))
    .orderBy(asc(commerceReviewMedia.position));

  if (remaining.length === 0) return;

  // The CHECK is `position BETWEEN 0 AND 5`, so it must be dropped for the park pass.
  await transaction.execute(
    sql`ALTER TABLE commerce_review_media DROP CONSTRAINT IF EXISTS commerce_review_media_position_ck`,
  );
  await transaction
    .update(commerceReviewMedia)
    .set({ position: sql`${commerceReviewMedia.position} + 100` })
    .where(eq(commerceReviewMedia.reviewId, reviewId));

  for (const [index, row] of remaining.entries()) {
    await transaction
      .update(commerceReviewMedia)
      .set({ position: index })
      .where(eq(commerceReviewMedia.id, row.id));
  }
  await transaction.execute(
    sql`ALTER TABLE commerce_review_media ADD CONSTRAINT commerce_review_media_position_ck CHECK (position BETWEEN 0 AND 5)`,
  );
}

function projectReviewMedia(media: typeof commerceReviewMedia.$inferSelect): ReviewMediaProjection {
  return {
    id: media.id,
    reviewId: media.reviewId,
    mediaKind: media.mediaKind,
    url: media.url,
    youtubeVideoId: media.youtubeVideoId,
    widthPx: media.widthPx,
    heightPx: media.heightPx,
    position: media.position,
    state: media.state,
    unavailableAt: media.unavailableAt,
  };
}

/**
 * Loads a review the ACTOR AUTHORED, for a media write. Visible reviews only.
 */
async function loadOwnVisibleReview(
  executor: DatabaseTransaction | typeof db,
  reviewId: string,
  actorOrganizationId: string,
  lockForUpdate: boolean,
): Promise<typeof commerceReview.$inferSelect | null> {
  const query = executor
    .select()
    .from(commerceReview)
    .where(
      and(
        eq(commerceReview.id, reviewId),
        eq(commerceReview.reviewerOrganizationId, actorOrganizationId),
        eq(commerceReview.visibility, "visible"),
      ),
    )
    .limit(1);
  const [review] = lockForUpdate ? await query.for("update") : await query;
  return review ?? null;
}

/**
 * Attach one photo to a review the caller wrote (Appendix A8).
 *
 * ORDER OF OPERATIONS, and it matters: authorize and cap-check cheaply, then decode
 * and upload, then commit under the review's row lock which re-checks the cap. The
 * upload happens outside the transaction because holding a row lock across a network
 * call to Cloudinary would serialize every attach behind the slowest one.
 *
 * If the transaction then fails, the asset is destroyed rather than orphaned —
 * `addProductImage` accepts the orphan, but a review gallery is capped at six and an
 * orphan under `qatoto/reviews/<reviewId>/` would survive the review itself.
 */
export async function attachReviewPhoto(
  actor: CommerceTrustActorContext,
  reviewId: string,
  imageBuffer: Buffer,
): Promise<Result<ReviewMediaProjection, CommerceReviewMediaError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const preflightReview = await loadOwnVisibleReview(db, reviewId, actor.organizationId, false);
  if (!preflightReview) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (preflightReview.mediaCount >= MAXIMUM_REVIEW_MEDIA_COUNT) {
    return {
      success: false,
      error: { type: "MEDIA_LIMIT_REACHED", limit: MAXIMUM_REVIEW_MEDIA_COUNT },
    };
  }

  const normalized = await validateAndNormalizeImage(imageBuffer, {
    outputMaxDimensionPx: REVIEW_MEDIA_OUTPUT_MAX_DIMENSION_PX,
    outputFormat: "avif",
  });
  if (!normalized.success) {
    return { success: false, error: normalized.error };
  }

  const mediaId = randomUUID();
  const uploaded = await uploadReviewMedia(reviewId, mediaId, normalized.value.buffer);
  if (!uploaded.success) {
    return { success: false, error: uploaded.error };
  }

  try {
    const outcome = await db.transaction(async (transaction) => {
      const review = await loadOwnVisibleReview(transaction, reviewId, actor.organizationId, true);
      if (!review) return { status: "not_found" as const };
      if (review.mediaCount >= MAXIMUM_REVIEW_MEDIA_COUNT) {
        return { status: "limit_reached" as const };
      }

      const [inserted] = await transaction
        .insert(commerceReviewMedia)
        .values({
          id: mediaId,
          reviewId: review.id,
          mediaKind: "photo",
          url: uploaded.value.secureUrl,
          widthPx: normalized.value.width,
          heightPx: normalized.value.height,
          position: review.mediaCount,
        })
        .returning();
      if (!inserted) return { status: "limit_reached" as const };

      await transaction
        .update(commerceReview)
        .set({ mediaCount: sql`${commerceReview.mediaCount} + 1` })
        .where(eq(commerceReview.id, review.id));

      // Payload keys avoid `filename`, `objectKey` and `publicId`: FORBIDDEN_PAYLOAD_KEY
      // matches `filename` and `object.*key` and THROWS, which is how `addressKind`
      // took down address creation in Phase 11.
      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "review_media_attached",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_review_media",
        targetEntityId: inserted.id,
        payload: {
          mediaId: inserted.id,
          reviewId: review.id,
          mediaKind: "photo",
          position: String(inserted.position),
        },
        occurredAt: new Date(),
      });

      return { status: "attached" as const, media: inserted };
    });

    switch (outcome.status) {
      case "not_found":
        await deleteReviewMediaAsset(reviewId, mediaId);
        return { success: false, error: { type: "NOT_FOUND" } };
      case "limit_reached":
        await deleteReviewMediaAsset(reviewId, mediaId);
        return {
          success: false,
          error: { type: "MEDIA_LIMIT_REACHED", limit: MAXIMUM_REVIEW_MEDIA_COUNT },
        };
      case "attached":
        return { success: true, value: projectReviewMedia(outcome.media) };
      default: {
        const exhaustiveCheck: never = outcome;
        throw new Error(`Unhandled attachReviewPhoto outcome: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  } catch (transactionError) {
    await deleteReviewMediaAsset(reviewId, mediaId);
    throw transactionError;
  }
}

/**
 * Attach a YouTube video to a review the caller wrote (Appendix A8).
 *
 * No bytes move. The id is EXTRACTED from the submitted URL server-side rather than
 * accepted as an id, so a caller cannot smuggle in something that is not a YouTube
 * video reference.
 *
 * WHETHER THE VIDEO EXISTS IS NOT CHECKED, and this comment used to claim otherwise —
 * it credited "the shipped `verify-youtube-video` oEmbed job", which operates on the
 * `video` table alone (`src/jobs/verify-youtube-video.ts`) and has never read
 * `commerce_review_media`. A well-formed id pointing at a deleted or private video is
 * therefore stored and rendered indefinitely. A false comment about a verification is
 * worse than a missing one, so it says the true thing now.
 *
 * The decided design for when it is built: a dead video HIDES ITS MEDIA ROW and leaves
 * the review standing. A buyer's testimony must not be deleted because a third-party
 * host removed a file, which rules out dropping the row and recomputing `mediaCount`.
 * That needs a state column on `commerce_review_media`; it is not built yet.
 */
export async function attachReviewVideo(
  actor: CommerceTrustActorContext,
  reviewId: string,
  input: AttachReviewVideoInput,
): Promise<Result<ReviewMediaProjection, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const youtubeVideoId = extractYoutubeVideoId(input.youtubeUrl);
  if (!youtubeVideoId) {
    return { success: false, error: { type: "INVALID_YOUTUBE_URL" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const review = await loadOwnVisibleReview(transaction, reviewId, actor.organizationId, true);
    if (!review) return { status: "not_found" as const };
    if (review.mediaCount >= MAXIMUM_REVIEW_MEDIA_COUNT) {
      return { status: "limit_reached" as const };
    }

    const [inserted] = await transaction
      .insert(commerceReviewMedia)
      .values({
        reviewId: review.id,
        mediaKind: "youtube_video",
        youtubeVideoId,
        position: review.mediaCount,
      })
      .returning();
    if (!inserted) return { status: "limit_reached" as const };

    await transaction
      .update(commerceReview)
      .set({ mediaCount: sql`${commerceReview.mediaCount} + 1` })
      .where(eq(commerceReview.id, review.id));

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "review_media_attached",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_review_media",
      targetEntityId: inserted.id,
      payload: {
        mediaId: inserted.id,
        reviewId: review.id,
        mediaKind: "youtube_video",
        position: String(inserted.position),
      },
      occurredAt: new Date(),
    });

    return { status: "attached" as const, media: inserted };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "limit_reached":
      return {
        success: false,
        error: { type: "MEDIA_LIMIT_REACHED", limit: MAXIMUM_REVIEW_MEDIA_COUNT },
      };
    case "attached":
      return { success: true, value: projectReviewMedia(outcome.media) };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled attachReviewVideo outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Remove one media row from a review the caller wrote (Appendix A8).
 *
 * The Cloudinary asset is destroyed AFTER the transaction commits. The other order —
 * destroy then commit — can leave a row pointing at a deleted asset if the commit
 * fails, which renders as a broken image forever. An orphaned asset after a
 * successful commit is invisible and reclaimable; a broken URL is neither.
 */
/**
 * A38. How long an author has to correct their own review, and how many times.
 *
 * ONE EDIT, THIRTY DAYS — Alibaba's rule, checked rather than assumed. Amazon allows unlimited
 * edits and deletion at any time and funds an enforcement team to absorb the consequences; on
 * five-figure B2B orders that combination is an extortion lever, so the bound is in the model.
 */
const REVIEW_EDIT_WINDOW_DAYS = 30;

/**
 * Edit a review the caller wrote (Appendix A38).
 *
 * FOUR THINGS HAPPEN TOGETHER, and each one closes a distinct abuse:
 *
 *   * the update predicate carries `editedAt IS NULL` and the window, so two concurrent
 *     submissions cannot both spend the one edit — the second updates zero rows;
 *   * `helpfulCount` resets to zero and the votes are deleted, which is what stops VOTE
 *     LAUNDERING: a review that earned two hundred endorsements as praise must not carry that
 *     social proof into a rewritten complaint. Amazon does the same;
 *   * `editedAt` is stamped and projected publicly, because a rewrite that does not announce
 *     itself is the manipulation rather than the correction;
 *   * scores are left alone. They are their own rows with their own axes, and silently
 *     dropping them on a body edit would lose data the author did not touch.
 *
 * NO AGGREGATE RE-ROLL IS NEEDED, and that is worth stating because it looks like an omission.
 * `commerce-trust-metrics.service.ts` computes `averageRating` with `avg()` at read time and
 * nothing denormalizes a rating anywhere in the schema, so a changed rating is already correct
 * on the next read.
 *
 * THERE IS NO AUTHOR DELETE, deliberately — see the migration. Removal goes through A12's
 * content report, so a seller must convince a moderator rather than the buyer.
 */
export async function editOwnReview(
  actor: CommerceTrustActorContext,
  reviewId: string,
  input: { readonly rating: number; readonly body: string },
): Promise<Result<ReviewProjection, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const review = await loadOwnVisibleReview(transaction, reviewId, actor.organizationId, true);
    if (!review) return { status: "not_found" as const };

    if (review.editedAt !== null) return { status: "edit_already_used" as const };

    const windowClosesAt = new Date(
      review.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const editedAt = new Date();
    if (editedAt >= windowClosesAt) {
      return { status: "edit_window_closed" as const, windowClosedAt: windowClosesAt };
    }

    /**
     * The predicate restates both conditions even though they were just checked under the row
     * lock. The lock makes that redundant TODAY; restating it means a future caller that
     * forgets the lock still cannot spend one edit twice.
     */
    const [updated] = await transaction
      .update(commerceReview)
      .set({
        rating: input.rating,
        body: input.body,
        editedAt,
        helpfulCount: 0,
      })
      .where(
        and(
          eq(commerceReview.id, review.id),
          isNull(commerceReview.editedAt),
          gt(
            commerceReview.createdAt,
            new Date(editedAt.getTime() - REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000),
          ),
        ),
      )
      .returning();
    if (!updated) return { status: "edit_already_used" as const };

    // Vote laundering, closed. `verify-store-phase-10-constraints` asserts `helpfulCount`
    // against `count(*)` over this table, so the counter and the rows must move together.
    await transaction.delete(commerceReviewVote).where(eq(commerceReviewVote.reviewId, review.id));

    const scores = await transaction
      .select()
      .from(commerceReviewScore)
      .where(eq(commerceReviewScore.reviewId, review.id));

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "review_edited",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_review",
      targetEntityId: review.id,
      payload: {
        previousRating: String(review.rating),
        rating: String(input.rating),
        helpfulVotesCleared: String(review.helpfulCount),
      },
      occurredAt: editedAt,
    });

    return {
      status: "edited" as const,
      review: updated,
      scores: scores.map((score) => ({ axis: score.axis, score: score.score })),
    };
  });

  switch (outcome.status) {
    case "edited":
      return { success: true, value: projectReview(outcome.review, outcome.scores) };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "edit_already_used":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "A review may be edited once, and this one has already been edited.",
        },
      };
    case "edit_window_closed":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: `A review may be edited within ${String(REVIEW_EDIT_WINDOW_DAYS)} days of being posted.`,
        },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled review edit outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

export async function detachReviewMedia(
  actor: CommerceTrustActorContext,
  reviewId: string,
  mediaId: string,
): Promise<Result<{ readonly reviewId: string; readonly mediaCount: number }, CommerceTrustError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const review = await loadOwnVisibleReview(transaction, reviewId, actor.organizationId, true);
    if (!review) return { status: "not_found" as const };

    const [deleted] = await transaction
      .delete(commerceReviewMedia)
      .where(and(eq(commerceReviewMedia.id, mediaId), eq(commerceReviewMedia.reviewId, review.id)))
      .returning();
    if (!deleted) return { status: "not_found" as const };

    await repackReviewMediaPositions(transaction, review.id);

    const [updated] = await transaction
      .update(commerceReview)
      .set({ mediaCount: sql`GREATEST(${commerceReview.mediaCount} - 1, 0)` })
      .where(eq(commerceReview.id, review.id))
      .returning({ mediaCount: commerceReview.mediaCount });

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: "review_media_detached",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_review_media",
      targetEntityId: deleted.id,
      payload: {
        mediaId: deleted.id,
        reviewId: review.id,
        mediaKind: deleted.mediaKind,
      },
      occurredAt: new Date(),
    });

    return {
      status: "detached" as const,
      mediaKind: deleted.mediaKind,
      mediaCount: updated?.mediaCount ?? 0,
    };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  if (outcome.mediaKind === "photo") {
    await deleteReviewMediaAsset(reviewId, mediaId);
  }
  return { success: true, value: { reviewId, mediaCount: outcome.mediaCount } };
}

/**
 * Mark a review helpful (Appendix A8). Idempotent by verb — a repeated PUT returns the
 * same state rather than double-counting.
 *
 * THE NO-DOUBLE-COUNT SHAPE, copied from `setVideoSave`: insert with
 * `onConflictDoNothing().returning()`, and move the counter ONLY when a row actually
 * appeared. Reading "does a vote exist" and then inserting would race two concurrent
 * taps into two increments for one vote.
 *
 * Self-voting is refused here AND by `commerce_review_vote_relationship_guard`. The
 * service check produces a useful 403; the trigger is what makes the rule true.
 */
export async function setReviewHelpfulVote(
  actor: CommerceTrustActorContext,
  reviewId: string,
): Promise<Result<ReviewHelpfulVoteProjection, CommerceTrustError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [review] = await transaction
      .select()
      .from(commerceReview)
      .where(and(eq(commerceReview.id, reviewId), eq(commerceReview.visibility, "visible")))
      .limit(1)
      .for("update");
    if (!review) return { status: "not_found" as const };

    if (
      actor.organizationId === review.reviewerOrganizationId ||
      actor.organizationId === review.subjectOrganizationId
    ) {
      return { status: "self_vote" as const };
    }

    const inserted = await transaction
      .insert(commerceReviewVote)
      .values({
        reviewId: review.id,
        voterOrganizationId: actor.organizationId,
        voterMemberId: actor.memberId,
        voterUserId: actor.actorUserId,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      return { status: "unchanged" as const, helpfulCount: review.helpfulCount };
    }

    const [updated] = await transaction
      .update(commerceReview)
      .set({ helpfulCount: sql`${commerceReview.helpfulCount} + 1` })
      .where(eq(commerceReview.id, review.id))
      .returning({ helpfulCount: commerceReview.helpfulCount });

    return { status: "voted" as const, helpfulCount: updated?.helpfulCount ?? review.helpfulCount };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "self_vote":
      return { success: false, error: { type: "SELF_VOTE_FORBIDDEN" } };
    case "unchanged":
    case "voted":
      return {
        success: true,
        value: { reviewId, isHelpful: true, helpfulCount: outcome.helpfulCount },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(`Unhandled setReviewHelpfulVote outcome: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/** Withdraw a helpful vote (Appendix A8). Idempotent: removing a vote twice is fine. */
export async function clearReviewHelpfulVote(
  actor: CommerceTrustActorContext,
  reviewId: string,
): Promise<Result<ReviewHelpfulVoteProjection, CommerceTrustError>> {
  const outcome = await db.transaction(async (transaction) => {
    const [review] = await transaction
      .select()
      .from(commerceReview)
      .where(and(eq(commerceReview.id, reviewId), eq(commerceReview.visibility, "visible")))
      .limit(1)
      .for("update");
    if (!review) return { status: "not_found" as const };

    const removed = await transaction
      .delete(commerceReviewVote)
      .where(
        and(
          eq(commerceReviewVote.reviewId, review.id),
          eq(commerceReviewVote.voterOrganizationId, actor.organizationId),
        ),
      )
      .returning();

    if (removed.length === 0) {
      return { status: "unchanged" as const, helpfulCount: review.helpfulCount };
    }

    const [updated] = await transaction
      .update(commerceReview)
      .set({ helpfulCount: sql`GREATEST(${commerceReview.helpfulCount} - 1, 0)` })
      .where(eq(commerceReview.id, review.id))
      .returning({ helpfulCount: commerceReview.helpfulCount });

    return {
      status: "cleared" as const,
      helpfulCount: updated?.helpfulCount ?? review.helpfulCount,
    };
  });

  switch (outcome.status) {
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "unchanged":
    case "cleared":
      return {
        success: true,
        value: { reviewId, isHelpful: false, helpfulCount: outcome.helpfulCount },
      };
    default: {
      const exhaustiveCheck: never = outcome;
      throw new Error(
        `Unhandled clearReviewHelpfulVote outcome: ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

/**
 * Publish or revise the reviewed organization's public reply (Appendix A8).
 *
 * `requireActiveCommerceOrganization` guards the route rather than the SELLER variant,
 * because a review's subject may be a product seller OR a service provider — the role
 * family that covers both is `memberCanOperateCounterparty`, checked here.
 *
 * Unlike the review itself, a reply IS editable. A review is testimony and immutable;
 * a reply is the subject's own current statement about it, and freezing a seller's
 * first hurried sentence forever serves nobody.
 */
export async function upsertReviewReply(
  actor: CommerceTrustActorContext,
  reviewId: string,
  input: UpsertReviewReplyInput,
): Promise<Result<ReviewReplyProjection, CommerceTrustError>> {
  if (!memberCanOperateCounterparty(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [review] = await transaction
      .select()
      .from(commerceReview)
      .where(
        and(
          eq(commerceReview.id, reviewId),
          eq(commerceReview.subjectOrganizationId, actor.organizationId),
          eq(commerceReview.visibility, "visible"),
        ),
      )
      .limit(1)
      .for("update");
    if (!review) return { status: "not_found" as const };

    /**
     * A38. THE SELLER'S HALF OF THE EDIT BOUND, and until Phase 21 there was none: this route
     * was an unlimited upsert with no window, so a conciliatory public reply could be swapped
     * the moment the buyer relented. That is the mirror of the buyer-side abuse the review edit
     * closes, and Alibaba caps a supplier's reply the same way — once, within 30 days.
     *
     * A FIRST reply is always allowed, however old the review. The bound is on CHANGING what
     * was published, not on answering late.
     */
    const [existingReply] = await transaction
      .select()
      .from(commerceReviewReply)
      .where(eq(commerceReviewReply.reviewId, review.id))
      .limit(1)
      .for("update");

    const now = new Date();
    if (existingReply) {
      if (existingReply.editedAt !== null) return { status: "edit_already_used" as const };
      const windowClosesAt = new Date(
        existingReply.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      if (now >= windowClosesAt) return { status: "edit_window_closed" as const };
    }

    const [reply] = await transaction
      .insert(commerceReviewReply)
      .values({
        reviewId: review.id,
        responderOrganizationId: actor.organizationId,
        responderMemberId: actor.memberId,
        body: input.body,
      })
      .onConflictDoUpdate({
        target: commerceReviewReply.reviewId,
        set: {
          body: input.body,
          responderMemberId: actor.memberId,
          editedAt: now,
          updatedAt: now,
        },
        // Restates the check above, so a caller that skips the lock still cannot spend the one
        // edit twice.
        setWhere: isNull(commerceReviewReply.editedAt),
      })
      .returning();
    if (!reply) return { status: "edit_already_used" as const };

    await appendAuditOrThrow(transaction, {
      organizationId: actor.organizationId,
      eventKind: existingReply ? "review_reply_edited" : "review_reply_published",
      actorUserId: actor.actorUserId,
      actorMemberRoleSnapshot: actor.memberRole,
      targetEntityType: "commerce_review_reply",
      targetEntityId: reply.reviewId,
      payload: { reviewId: review.id },
      occurredAt: now,
    });

    return { status: "saved" as const, reply };
  });

  switch (outcome.status) {
    case "saved":
      return {
        success: true,
        value: {
          reviewId: outcome.reply.reviewId,
          responderOrganizationId: outcome.reply.responderOrganizationId,
          body: outcome.reply.body,
          createdAt: outcome.reply.createdAt,
          updatedAt: outcome.reply.updatedAt,
        },
      };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "edit_already_used":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: "A reply may be revised once, and this one has already been revised.",
        },
      };
    case "edit_window_closed":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: `A reply may be revised within ${String(REVIEW_EDIT_WINDOW_DAYS)} days of being posted.`,
        },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(`Unhandled review reply outcome: ${JSON.stringify(exhaustiveOutcome)}`);
    }
  }
}

/** Withdraw the reply (Appendix A8). Idempotent: withdrawing twice is not an error. */
export async function deleteReviewReply(
  actor: CommerceTrustActorContext,
  reviewId: string,
): Promise<Result<{ readonly reviewId: string }, CommerceTrustError>> {
  if (!memberCanOperateCounterparty(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  const outcome = await db.transaction(async (transaction) => {
    const [review] = await transaction
      .select()
      .from(commerceReview)
      .where(
        and(
          eq(commerceReview.id, reviewId),
          eq(commerceReview.subjectOrganizationId, actor.organizationId),
          eq(commerceReview.visibility, "visible"),
        ),
      )
      .limit(1);
    if (!review) return { status: "not_found" as const };

    /**
     * A38. BOUNDED TO THE SAME 30 DAYS AS THE REVISION, because withdrawing a reply and
     * rewriting one are the same act from the buyer's side: what the public saw is no longer
     * what the public sees. An unbounded delete would leave the swap open through the door the
     * revision cap just closed.
     *
     * The route is not removed, unlike the review's absent author delete — a seller withdrawing
     * their own words takes nothing away from anybody, whereas a buyer withdrawing a rating
     * takes away the record a seller is scored on.
     */
    const [existingReply] = await transaction
      .select()
      .from(commerceReviewReply)
      .where(eq(commerceReviewReply.reviewId, review.id))
      .limit(1)
      .for("update");

    // Idempotent as before: withdrawing a reply that is not there is not an error.
    if (existingReply) {
      const windowClosesAt = new Date(
        existingReply.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      if (new Date() >= windowClosesAt) return { status: "window_closed" as const };
    }

    const removed = await transaction
      .delete(commerceReviewReply)
      .where(eq(commerceReviewReply.reviewId, review.id))
      .returning();

    if (removed.length > 0) {
      await appendAuditOrThrow(transaction, {
        organizationId: actor.organizationId,
        eventKind: "review_reply_withdrawn",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_review_reply",
        targetEntityId: review.id,
        payload: { reviewId: review.id },
        occurredAt: new Date(),
      });
    }

    return { status: "removed" as const };
  });

  switch (outcome.status) {
    case "removed":
      return { success: true, value: { reviewId } };
    case "not_found":
      return { success: false, error: { type: "NOT_FOUND" } };
    case "window_closed":
      return {
        success: false,
        error: {
          type: "CONFLICT",
          message: `A reply may be withdrawn within ${String(REVIEW_EDIT_WINDOW_DAYS)} days of being posted.`,
        },
      };
    default: {
      const exhaustiveOutcome: never = outcome;
      throw new Error(
        `Unhandled review reply withdrawal outcome: ${JSON.stringify(exhaustiveOutcome)}`,
      );
    }
  }
}
