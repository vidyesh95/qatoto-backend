import { and, asc, desc, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceOrganization,
  commerceReview,
  commerceReviewMedia,
  commerceReviewReply,
  commerceReviewScore,
  commerceReviewVote,
} from "#src/db/schema.js";
import { withTradingOrganizationCountryCode } from "#src/lib/commerce-organization-country.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import {
  resolveEligibleProductRefBySlug,
  type StoreCatalogError,
} from "#src/modules/store/catalog/store-catalog.service.js";
import type { StoreReviewListQuery } from "#src/modules/store/storefront/store-reviews.schemas.js";
import {
  EMPTY_REVIEW_SCORE_AVERAGES,
  EMPTY_REVIEW_SUMMARY,
  loadOrganizationReviewScoreAverages,
  loadOrganizationReviewSummaries,
  loadProductReviewScoreAverages,
  loadProductReviewSummaries,
  type ReviewScoreAverages,
  type ReviewSummaryAggregate,
} from "#src/modules/store/trust/commerce-trust-metrics.service.js";
import type { Result } from "#src/types/index.js";

type ReviewSort = StoreReviewListQuery["sort"];

/**
 * `helpfulCount` is padded so the cursor sorts as text the same way the column sorts
 * as an integer, and so the decoder can reject anything that is not exactly a count.
 * Ten digits covers any count this table will ever hold.
 */
const HELPFUL_CURSOR_DIGITS = 10;
const HELPFUL_CURSOR_PATTERN = /^\d{10}$/;
const RATING_CURSOR_PATTERN = /^[1-5]\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface StoreReviewMediaProjection {
  readonly id: string;
  readonly mediaKind: "photo" | "youtube_video";
  readonly url: string | null;
  readonly youtubeVideoId: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
}

export interface StoreReviewScoresProjection {
  readonly service: number | null;
  readonly shipping: number | null;
  readonly quality: number | null;
}

export interface StoreReviewReplyProjection {
  readonly body: string;
  readonly respondedAt: Date;
  readonly responder: {
    readonly organizationId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly logoUrl: string | null;
  } | null;
}

/** A24. What the CALLER has done to this review, absent when there is no caller. */
export interface StoreReviewViewerState {
  readonly hasVotedHelpful: boolean;
}

/**
 * Who is reading. Resolved by the controller from the optional session — descriptively,
 * never by a guard, because on a public read a missing organization is a rendering
 * detail rather than a refusal.
 */
export interface StoreReviewViewerContext {
  readonly organizationId: string | null;
}

export const ANONYMOUS_REVIEW_VIEWER: StoreReviewViewerContext = { organizationId: null };

export interface StoreReviewProjection {
  readonly id: string;
  readonly rating: number;
  readonly body: string;
  readonly createdAt: Date;
  readonly productId: string | null;
  /**
   * `null` when the reviewing organization is not publicly visible — the card then
   * renders "Verified buyer". A private organization's identity is not disclosed by
   * the act of leaving a review.
   */
  readonly reviewer: {
    readonly organizationId: string;
    readonly slug: string;
    readonly displayName: string;
    readonly countryCode: string;
    readonly logoUrl: string | null;
  } | null;
  readonly scores: StoreReviewScoresProjection;
  readonly media: readonly StoreReviewMediaProjection[];
  readonly helpfulCount: number;
  /**
   * A24, following A11's `engagement.viewer`: `null` for a caller with no active
   * commerce organization, NOT `{hasVotedHelpful: false}`. A toggle whose own state
   * needs a second authenticated call renders wrong on first paint and then corrects
   * itself, which reads as a bug and teaches a buyer that the count is not to be
   * trusted — so a fact about the CALLER belongs on the read the caller already made.
   *
   * Keyed on the ORGANIZATION, because `commerce_review_vote` is. A signed-in visitor
   * with no active organization cannot vote at all, so `null` is also the honest answer
   * about what they may do.
   */
  readonly viewer: StoreReviewViewerState | null;
  readonly reply: StoreReviewReplyProjection | null;
}

export interface StoreReviewSummaryProjection extends ReviewSummaryAggregate {
  readonly scoreAverages: ReviewScoreAverages;
}

export interface StoreReviewListPage {
  /**
   * ALWAYS present, and ALWAYS computed over every visible review in scope — never
   * over the filtered subset. The filter chips display these counts, so a summary that
   * narrowed with the filter would make the chips renumber themselves as you click
   * them and leave no way back to the full picture.
   */
  readonly summary: StoreReviewSummaryProjection;
  readonly items: readonly StoreReviewProjection[];
  readonly page: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

// ---------------------------------------------------------------------------
// Cursor codecs.
//
// Private to this module and built on the shared `encodeStoreCursor` /
// `decodeStoreCursor`, whose format is `<sortKey>_<id>` split on the LAST underscore.
// Neither a padded integer nor an ISO timestamp nor a `rating|timestamp` composite
// contains an underscore, so that split stays correct for every sort here. `|`
// survives the round trip as `%7C`.
//
// Every sort ends in `id` — §7's rule that a list order must end in a unique column so
// pagination cannot skip rows sharing a sort key.
// ---------------------------------------------------------------------------

function encodeReviewCursor(
  sort: ReviewSort,
  row: {
    readonly id: string;
    readonly createdAt: Date;
    readonly rating: number;
    readonly helpfulCount: number;
  },
): string {
  switch (sort) {
    case "recent":
      return encodeStoreCursor({ sortKey: row.createdAt.toISOString(), id: row.id });
    case "helpful":
      return encodeStoreCursor({
        sortKey: String(row.helpfulCount).padStart(HELPFUL_CURSOR_DIGITS, "0"),
        id: row.id,
      });
    case "rating_high":
    case "rating_low":
      return encodeStoreCursor({
        sortKey: `${row.rating}|${row.createdAt.toISOString()}`,
        id: row.id,
      });
    default: {
      const exhaustiveCheck: never = sort;
      throw new Error(`Unhandled review sort: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

type DecodedReviewCursor =
  | { readonly kind: "timestamp"; readonly createdAt: Date; readonly id: string }
  | { readonly kind: "helpful"; readonly helpfulCount: number; readonly id: string }
  | {
      readonly kind: "rating";
      readonly rating: number;
      readonly createdAt: Date;
      readonly id: string;
    };

function parseIsoTimestamp(rawTimestamp: string): Date | null {
  if (!ISO_TIMESTAMP_PATTERN.test(rawTimestamp)) return null;
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== rawTimestamp) return null;
  return parsed;
}

function decodeReviewCursor(sort: ReviewSort, cursor: string): DecodedReviewCursor | null {
  const parts = decodeStoreCursor(cursor);
  if (!parts) return null;

  switch (sort) {
    case "recent": {
      const createdAt = parseIsoTimestamp(parts.sortKey);
      return createdAt ? { kind: "timestamp", createdAt, id: parts.id } : null;
    }
    case "helpful": {
      if (!HELPFUL_CURSOR_PATTERN.test(parts.sortKey)) return null;
      return { kind: "helpful", helpfulCount: Number(parts.sortKey), id: parts.id };
    }
    case "rating_high":
    case "rating_low": {
      if (!RATING_CURSOR_PATTERN.test(parts.sortKey)) return null;
      const [rawRating, rawTimestamp] = parts.sortKey.split("|");
      if (rawRating === undefined || rawTimestamp === undefined) return null;
      const createdAt = parseIsoTimestamp(rawTimestamp);
      if (!createdAt) return null;
      return { kind: "rating", rating: Number(rawRating), createdAt, id: parts.id };
    }
    default: {
      const exhaustiveCheck: never = sort;
      throw new Error(`Unhandled review sort: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function buildKeysetPredicate(sort: ReviewSort, cursor: DecodedReviewCursor): SQL | undefined {
  switch (cursor.kind) {
    case "timestamp":
      return or(
        lt(commerceReview.createdAt, cursor.createdAt),
        and(eq(commerceReview.createdAt, cursor.createdAt), gt(commerceReview.id, cursor.id)),
      );
    case "helpful":
      return or(
        lt(commerceReview.helpfulCount, cursor.helpfulCount),
        and(eq(commerceReview.helpfulCount, cursor.helpfulCount), gt(commerceReview.id, cursor.id)),
      );
    case "rating": {
      // rating_high walks ratings downward, rating_low upward; the createdAt and id
      // tiebreakers run the same direction in both so the cursor shape can be shared.
      const beyondRating =
        sort === "rating_low"
          ? gt(commerceReview.rating, cursor.rating)
          : lt(commerceReview.rating, cursor.rating);
      return or(
        beyondRating,
        and(
          eq(commerceReview.rating, cursor.rating),
          lt(commerceReview.createdAt, cursor.createdAt),
        ),
        and(
          eq(commerceReview.rating, cursor.rating),
          eq(commerceReview.createdAt, cursor.createdAt),
          gt(commerceReview.id, cursor.id),
        ),
      );
    }
    default: {
      const exhaustiveCheck: never = cursor;
      throw new Error(`Unhandled review cursor: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function buildOrderBy(sort: ReviewSort): readonly SQL[] {
  switch (sort) {
    case "recent":
      return [desc(commerceReview.createdAt), asc(commerceReview.id)];
    case "helpful":
      return [desc(commerceReview.helpfulCount), asc(commerceReview.id)];
    case "rating_high":
      return [desc(commerceReview.rating), desc(commerceReview.createdAt), asc(commerceReview.id)];
    case "rating_low":
      return [asc(commerceReview.rating), desc(commerceReview.createdAt), asc(commerceReview.id)];
    default: {
      const exhaustiveCheck: never = sort;
      throw new Error(`Unhandled review sort: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Page assembly.
// ---------------------------------------------------------------------------

interface ReviewRow {
  readonly id: string;
  readonly rating: number;
  readonly body: string;
  readonly createdAt: Date;
  readonly productId: string | null;
  readonly helpfulCount: number;
  readonly mediaCount: number;
  readonly reviewerOrganizationId: string;
}

interface PublicOrganizationCard {
  readonly organizationId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly countryCode: string;
  readonly logoUrl: string | null;
}

/**
 * Loads the public identity of organizations that HAVE one. A private organization is
 * simply absent from the map, and the caller renders `null` rather than a name.
 */
async function loadPublicOrganizationCards(
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, PublicOrganizationCard>> {
  const cards = new Map<string, PublicOrganizationCard>();
  if (organizationIds.length === 0) return cards;

  const rows = await db
    .select({
      organizationId: commerceOrganization.id,
      slug: commerceOrganization.slug,
      displayName: commerceOrganization.displayName,
      countryCode: commerceOrganization.countryCode,
      logoUrl: commerceOrganization.logoUrl,
    })
    .from(commerceOrganization)
    .where(
      and(
        inArray(commerceOrganization.id, [...organizationIds]),
        eq(commerceOrganization.visibility, "public"),
        eq(commerceOrganization.tradeState, "active"),
      ),
    );

  for (const row of rows) {
    cards.set(row.organizationId, withTradingOrganizationCountryCode(row, row.organizationId));
  }
  return cards;
}

/**
 * Fans the page's ids out into media, scores and replies — three `inArray` batches, so
 * the query count per page is constant rather than proportional to page size.
 */
async function loadReviewChildren(reviewIds: readonly string[]): Promise<{
  readonly mediaByReview: ReadonlyMap<string, StoreReviewMediaProjection[]>;
  readonly scoresByReview: ReadonlyMap<string, StoreReviewScoresProjection>;
  readonly replyByReview: ReadonlyMap<
    string,
    { readonly body: string; readonly respondedAt: Date; readonly responderOrganizationId: string }
  >;
}> {
  const mediaByReview = new Map<string, StoreReviewMediaProjection[]>();
  const scoresByReview = new Map<string, StoreReviewScoresProjection>();
  const replyByReview = new Map<
    string,
    { body: string; respondedAt: Date; responderOrganizationId: string }
  >();

  if (reviewIds.length === 0) {
    return { mediaByReview, scoresByReview, replyByReview };
  }

  const [mediaRows, scoreRows, replyRows] = await Promise.all([
    db
      .select({
        id: commerceReviewMedia.id,
        reviewId: commerceReviewMedia.reviewId,
        mediaKind: commerceReviewMedia.mediaKind,
        url: commerceReviewMedia.url,
        youtubeVideoId: commerceReviewMedia.youtubeVideoId,
        widthPx: commerceReviewMedia.widthPx,
        heightPx: commerceReviewMedia.heightPx,
        position: commerceReviewMedia.position,
      })
      .from(commerceReviewMedia)
      .where(
        and(
          inArray(commerceReviewMedia.reviewId, [...reviewIds]),
          /**
           * A40. THE WHOLE POINT OF THE STATE COLUMN. Without this predicate a YouTube video
           * its host has deleted keeps rendering a dead player on the review, which is the bug
           * `commerce_review_media.state` exists to close. Backed by
           * `commerce_review_media_visible_idx`.
           */
          eq(commerceReviewMedia.state, "visible"),
        ),
      )
      .orderBy(asc(commerceReviewMedia.reviewId), asc(commerceReviewMedia.position)),
    db
      .select({
        reviewId: commerceReviewScore.reviewId,
        axis: commerceReviewScore.axis,
        score: commerceReviewScore.score,
      })
      .from(commerceReviewScore)
      .where(inArray(commerceReviewScore.reviewId, [...reviewIds])),
    db
      .select({
        reviewId: commerceReviewReply.reviewId,
        body: commerceReviewReply.body,
        respondedAt: commerceReviewReply.updatedAt,
        responderOrganizationId: commerceReviewReply.responderOrganizationId,
      })
      .from(commerceReviewReply)
      .where(inArray(commerceReviewReply.reviewId, [...reviewIds])),
  ]);

  for (const row of mediaRows) {
    const bucket = mediaByReview.get(row.reviewId) ?? [];
    bucket.push({
      id: row.id,
      mediaKind: row.mediaKind,
      url: row.url,
      youtubeVideoId: row.youtubeVideoId,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      position: row.position,
    });
    mediaByReview.set(row.reviewId, bucket);
  }

  for (const row of scoreRows) {
    const current = scoresByReview.get(row.reviewId) ?? {
      service: null,
      shipping: null,
      quality: null,
    };
    scoresByReview.set(row.reviewId, { ...current, [row.axis]: row.score });
  }

  for (const row of replyRows) {
    replyByReview.set(row.reviewId, {
      body: row.body,
      respondedAt: row.respondedAt,
      responderOrganizationId: row.responderOrganizationId,
    });
  }

  return { mediaByReview, scoresByReview, replyByReview };
}

async function assembleReviewPage(
  scopePredicate: SQL,
  query: StoreReviewListQuery,
  summary: StoreReviewSummaryProjection,
  viewer: StoreReviewViewerContext,
): Promise<Result<StoreReviewListPage, StoreCatalogError>> {
  const filters: SQL[] = [scopePredicate, eq(commerceReview.visibility, "visible")];
  if (query.rating !== undefined) {
    filters.push(eq(commerceReview.rating, query.rating));
  }
  if (query.hasMedia === true) {
    filters.push(gt(commerceReview.mediaCount, 0));
  }
  if (query.hasMedia === false) {
    filters.push(eq(commerceReview.mediaCount, 0));
  }
  /**
   * A38. `commerce_review_reply` has `reviewId` as its PRIMARY KEY — "one reply per review" is
   * unrepresentable rather than merely rejected — so this is a primary-key existence check and
   * needs no index of its own. Written as NOT EXISTS rather than a left join so the filter
   * cannot multiply rows if that key ever stops being unique.
   */
  if (query.unreplied === true) {
    filters.push(
      sql`NOT EXISTS (
        SELECT 1 FROM commerce_review_reply
         WHERE commerce_review_reply.review_id = ${commerceReview.id}
      )`,
    );
  }
  if (query.unreplied === false) {
    filters.push(
      sql`EXISTS (
        SELECT 1 FROM commerce_review_reply
         WHERE commerce_review_reply.review_id = ${commerceReview.id}
      )`,
    );
  }

  if (query.cursor !== undefined) {
    const decoded = decodeReviewCursor(query.sort, query.cursor);
    if (!decoded) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    const keyset = buildKeysetPredicate(query.sort, decoded);
    if (keyset) filters.push(keyset);
  }

  // Over-fetch by one: the extra row is the existence proof for `hasMore` and is
  // never returned.
  const rows: ReviewRow[] = await db
    .select({
      id: commerceReview.id,
      rating: commerceReview.rating,
      body: commerceReview.body,
      createdAt: commerceReview.createdAt,
      productId: commerceReview.productId,
      helpfulCount: commerceReview.helpfulCount,
      mediaCount: commerceReview.mediaCount,
      reviewerOrganizationId: commerceReview.reviewerOrganizationId,
    })
    .from(commerceReview)
    .where(and(...filters))
    .orderBy(...buildOrderBy(query.sort))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  const reviewIds = pageRows.map((row) => row.id);
  const viewerOrganizationId = viewer.organizationId;
  // One extra query per page, and only when there is an organization to ask about. It
  // is a prefix scan of `commerce_review_vote`'s primary key, so it needs no index.
  const [{ mediaByReview, scoresByReview, replyByReview }, viewerVoteRows] = await Promise.all([
    loadReviewChildren(reviewIds),
    viewerOrganizationId === null || reviewIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ reviewId: commerceReviewVote.reviewId })
          .from(commerceReviewVote)
          .where(
            and(
              inArray(commerceReviewVote.reviewId, reviewIds),
              eq(commerceReviewVote.voterOrganizationId, viewerOrganizationId),
            ),
          ),
  ]);
  const votedReviewIds = new Set(viewerVoteRows.map((row) => row.reviewId));

  const organizationIds = [
    ...new Set([
      ...pageRows.map((row) => row.reviewerOrganizationId),
      ...[...replyByReview.values()].map((reply) => reply.responderOrganizationId),
    ]),
  ];
  const organizationCards = await loadPublicOrganizationCards(organizationIds);

  const items: StoreReviewProjection[] = pageRows.map((row) => {
    const reviewerCard = organizationCards.get(row.reviewerOrganizationId);
    const reply = replyByReview.get(row.id);
    const responderCard = reply ? organizationCards.get(reply.responderOrganizationId) : undefined;

    return {
      id: row.id,
      rating: row.rating,
      body: row.body,
      createdAt: row.createdAt,
      productId: row.productId,
      reviewer: reviewerCard
        ? {
            organizationId: reviewerCard.organizationId,
            slug: reviewerCard.slug,
            displayName: reviewerCard.displayName,
            countryCode: reviewerCard.countryCode,
            logoUrl: reviewerCard.logoUrl,
          }
        : null,
      scores: scoresByReview.get(row.id) ?? { service: null, shipping: null, quality: null },
      media: mediaByReview.get(row.id) ?? [],
      helpfulCount: row.helpfulCount,
      viewer:
        viewerOrganizationId === null ? null : { hasVotedHelpful: votedReviewIds.has(row.id) },
      reply: reply
        ? {
            body: reply.body,
            respondedAt: reply.respondedAt,
            responder: responderCard
              ? {
                  organizationId: responderCard.organizationId,
                  slug: responderCard.slug,
                  displayName: responderCard.displayName,
                  logoUrl: responderCard.logoUrl,
                }
              : null,
          }
        : null,
    };
  });

  return {
    success: true,
    value: {
      summary,
      items,
      page: {
        nextCursor: hasMore && lastRow ? encodeReviewCursor(query.sort, lastRow) : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

/**
 * Reviews of one publicly eligible product (Appendix A8).
 *
 * The slug is resolved through `resolveEligibleProductRefBySlug`, so a draft,
 * suspended, unapproved or privately-owned listing returns NOT_FOUND here exactly as
 * it does on the detail route — the reviews of an invisible product are invisible.
 */
export async function listProductReviews(
  productSlug: string,
  query: StoreReviewListQuery,
  viewer: StoreReviewViewerContext = ANONYMOUS_REVIEW_VIEWER,
): Promise<Result<StoreReviewListPage, StoreCatalogError>> {
  const productRef = await resolveEligibleProductRefBySlug(productSlug);
  if (!productRef) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [summaries, scoreAverages] = await Promise.all([
    loadProductReviewSummaries([productRef.id]),
    loadProductReviewScoreAverages([productRef.id]),
  ]);

  return assembleReviewPage(
    eq(commerceReview.productId, productRef.id),
    query,
    {
      ...(summaries.get(productRef.id) ?? EMPTY_REVIEW_SUMMARY),
      scoreAverages: scoreAverages.get(productRef.id) ?? EMPTY_REVIEW_SCORE_AVERAGES,
    },
    viewer,
  );
}

/**
 * Reviews of one publicly visible organization (Appendix A8).
 *
 * Not redundant with the product route: `commerce_review.productId` is nullable
 * because a service-engagement completion has no product, so those reviews are
 * unreachable from any product and would otherwise be write-only forever.
 */
/**
 * The seller's own review inbox (Appendix A38).
 *
 * WHY IT IS NOT `listOrganizationReviews`. That read resolves a public SLUG and requires the
 * organization to be `visibility = 'public'` and `tradeState = 'active'`, which is right for a
 * storefront and wrong here: a seller must be able to read and answer reviews about themselves
 * while their organization is private, suspended, or mid-review. Scoping on the caller's own id
 * skips the slug lookup entirely, so there is nothing to be refused by.
 *
 * `unreplied=true` IS THE POINT OF THE ROUTE. Until Phase 21 the reply write
 * (`PUT /commerce/reviews/:reviewId/reply`) took an id that only the public per-product and
 * per-organization reads produced — so finding a review awaiting an answer meant paging every
 * review of every listing, from the browser, and checking each for a reply.
 *
 * The summary is the seller's real one, computed over every visible review rather than the
 * filtered page — a count that moved when you ticked "unreplied" would be a different fact
 * wearing the same name.
 */
export async function listSellerReviewInbox(
  sellerOrganizationId: string,
  query: StoreReviewListQuery,
  viewer: StoreReviewViewerContext = ANONYMOUS_REVIEW_VIEWER,
): Promise<Result<StoreReviewListPage, StoreCatalogError>> {
  const [summaries, scoreAverages] = await Promise.all([
    loadOrganizationReviewSummaries([sellerOrganizationId]),
    loadOrganizationReviewScoreAverages([sellerOrganizationId]),
  ]);

  return assembleReviewPage(
    eq(commerceReview.subjectOrganizationId, sellerOrganizationId),
    query,
    {
      ...(summaries.get(sellerOrganizationId) ?? EMPTY_REVIEW_SUMMARY),
      scoreAverages: scoreAverages.get(sellerOrganizationId) ?? EMPTY_REVIEW_SCORE_AVERAGES,
    },
    viewer,
  );
}

export async function listOrganizationReviews(
  organizationSlug: string,
  query: StoreReviewListQuery,
  viewer: StoreReviewViewerContext = ANONYMOUS_REVIEW_VIEWER,
): Promise<Result<StoreReviewListPage, StoreCatalogError>> {
  const [organization] = await db
    .select({ id: commerceOrganization.id })
    .from(commerceOrganization)
    .where(
      and(
        eq(commerceOrganization.slug, organizationSlug),
        eq(commerceOrganization.visibility, "public"),
        eq(commerceOrganization.tradeState, "active"),
      ),
    )
    .limit(1);

  if (!organization) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const [summaries, scoreAverages] = await Promise.all([
    loadOrganizationReviewSummaries([organization.id]),
    loadOrganizationReviewScoreAverages([organization.id]),
  ]);

  return assembleReviewPage(
    eq(commerceReview.subjectOrganizationId, organization.id),
    query,
    {
      ...(summaries.get(organization.id) ?? EMPTY_REVIEW_SUMMARY),
      scoreAverages: scoreAverages.get(organization.id) ?? EMPTY_REVIEW_SCORE_AVERAGES,
    },
    viewer,
  );
}
