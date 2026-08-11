import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceManufacturingInquiry,
  commerceMessage,
  commerceMessageAttachment,
  commerceProductInquiry,
  commerceQuote,
  commerceRfq,
  commerceRfqInvitation,
  commerceThread,
  commerceThreadParticipant,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * The thread kinds this service serves.
 *
 * NARROWER THAN THE DATABASE ENUM ON PURPOSE. `commerce_thread_resource_kind` also
 * holds `order`, `service_engagement` and `dispute`, none of which has a party
 * resolver here — a thread of those kinds can exist in the column and must not be
 * readable through this service. `projectThread` re-checks at read time for exactly
 * that reason.
 *
 * `product_inquiry` joined the list in Phase 10 (Appendix A14), and
 * `manufacturing_inquiry` in Phase 17 (§16.5) — both one-to-one, both for the same reason.
 */
export type CommerceThreadResourceKind =
  | "rfq"
  | "quote"
  | "product_inquiry"
  | "manufacturing_inquiry";

export type CommerceMessagesError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "VALIDATION_FAILED"; message: string }
  | { type: "DOCUMENT_NOT_OWNED" };

export interface CommerceThreadProjection {
  readonly id: string;
  readonly resourceKind: CommerceThreadResourceKind;
  readonly resourceId: string;
  readonly createdByOrganizationId: string;
  readonly createdByMemberId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly participants: readonly {
    readonly organizationId: string;
    readonly participantRole: "buyer" | "provider" | "moderator";
  }[];
}

export interface CommerceMessageProjection {
  readonly id: string;
  readonly threadId: string;
  readonly authorOrganizationId: string;
  readonly authorMemberId: string;
  readonly bodyText: string;
  readonly createdAt: Date;
  readonly encryptedDocumentIds: readonly string[];
}

interface ResourceParties {
  readonly buyerOrganizationId: string;
  readonly providerOrganizationIds: readonly string[];
}

async function resolveRfqParties(
  rfqId: string,
  callerOrganizationId: string,
): Promise<Result<ResourceParties, CommerceMessagesError>> {
  const [rfq] = await db
    .select({
      id: commerceRfq.id,
      buyerOrganizationId: commerceRfq.buyerOrganizationId,
    })
    .from(commerceRfq)
    .where(eq(commerceRfq.id, rfqId))
    .limit(1);

  if (!rfq) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const invitations = await db
    .select({
      providerOrganizationId: commerceRfqInvitation.providerOrganizationId,
    })
    .from(commerceRfqInvitation)
    .where(
      and(eq(commerceRfqInvitation.rfqId, rfqId), ne(commerceRfqInvitation.state, "withdrawn")),
    );

  const invitedProviderIds = invitations.map((invitation) => invitation.providerOrganizationId);
  const isBuyer = rfq.buyerOrganizationId === callerOrganizationId;
  const isInvitedProvider = invitedProviderIds.includes(callerOrganizationId);

  if (!isBuyer && !isInvitedProvider) {
    // Missing RFQs and unauthorized RFQs are indistinguishable to callers.
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  return {
    success: true,
    value: {
      buyerOrganizationId: rfq.buyerOrganizationId,
      providerOrganizationIds: invitedProviderIds,
    },
  };
}

async function resolveQuoteParties(
  quoteId: string,
  callerOrganizationId: string,
): Promise<Result<ResourceParties, CommerceMessagesError>> {
  const [quoteRow] = await db
    .select({
      quoteId: commerceQuote.id,
      providerOrganizationId: commerceQuote.providerOrganizationId,
      buyerOrganizationId: commerceRfq.buyerOrganizationId,
    })
    .from(commerceQuote)
    .innerJoin(commerceRfq, eq(commerceRfq.id, commerceQuote.rfqId))
    .where(eq(commerceQuote.id, quoteId))
    .limit(1);

  if (!quoteRow) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const isBuyer = quoteRow.buyerOrganizationId === callerOrganizationId;
  const isProvider = quoteRow.providerOrganizationId === callerOrganizationId;
  if (!isBuyer && !isProvider) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  return {
    success: true,
    value: {
      buyerOrganizationId: quoteRow.buyerOrganizationId,
      providerOrganizationIds: [quoteRow.providerOrganizationId],
    },
  };
}

/**
 * Parties to a pre-sales inquiry (Appendix A14): exactly two, and never more.
 *
 * Contrast `resolveRfqParties`, which returns EVERY invited provider. That difference
 * is the reason an inquiry thread is never merged into an RFQ thread when the inquiry
 * converts — folding a one-to-one pre-sales conversation into a multi-bidder thread
 * would show one seller's chat to its competitors.
 */
async function resolveProductInquiryParties(
  inquiryId: string,
  callerOrganizationId: string,
): Promise<Result<ResourceParties, CommerceMessagesError>> {
  const [inquiry] = await db
    .select({
      buyerOrganizationId: commerceProductInquiry.buyerOrganizationId,
      sellerOrganizationId: commerceProductInquiry.sellerOrganizationId,
    })
    .from(commerceProductInquiry)
    .where(eq(commerceProductInquiry.id, inquiryId))
    .limit(1);

  // NOT_FOUND rather than FORBIDDEN for a non-party: §11's anti-enumeration rule, and
  // the same shape the RFQ and quote resolvers use.
  if (
    !inquiry ||
    (inquiry.buyerOrganizationId !== callerOrganizationId &&
      inquiry.sellerOrganizationId !== callerOrganizationId)
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return {
    success: true,
    value: {
      buyerOrganizationId: inquiry.buyerOrganizationId,
      providerOrganizationIds: [inquiry.sellerOrganizationId],
    },
  };
}

/**
 * Parties to a manufacturing inquiry (§16.5): exactly two, like a product inquiry.
 *
 * A DRAFT HAS NO CONVERSATION. The inquiry service opens the thread on the `sent`
 * transition, so a resolver reaching a `draft` row means somebody guessed an id — hence
 * NOT_FOUND rather than an empty thread.
 */
async function resolveManufacturingInquiryParties(
  inquiryId: string,
  callerOrganizationId: string,
): Promise<Result<ResourceParties, CommerceMessagesError>> {
  const [inquiry] = await db
    .select({
      buyerOrganizationId: commerceManufacturingInquiry.buyerOrganizationId,
      factoryOrganizationId: commerceManufacturingInquiry.factoryOrganizationId,
      state: commerceManufacturingInquiry.state,
    })
    .from(commerceManufacturingInquiry)
    .where(eq(commerceManufacturingInquiry.id, inquiryId))
    .limit(1);

  if (
    !inquiry ||
    inquiry.state === "draft" ||
    (inquiry.buyerOrganizationId !== callerOrganizationId &&
      inquiry.factoryOrganizationId !== callerOrganizationId)
  ) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return {
    success: true,
    value: {
      buyerOrganizationId: inquiry.buyerOrganizationId,
      providerOrganizationIds: [inquiry.factoryOrganizationId],
    },
  };
}

async function resolveResourceParties(input: {
  readonly resourceKind: CommerceThreadResourceKind;
  readonly resourceId: string;
  readonly organizationId: string;
}): Promise<Result<ResourceParties, CommerceMessagesError>> {
  switch (input.resourceKind) {
    case "rfq":
      return resolveRfqParties(input.resourceId, input.organizationId);
    case "quote":
      return resolveQuoteParties(input.resourceId, input.organizationId);
    case "product_inquiry":
      return resolveProductInquiryParties(input.resourceId, input.organizationId);
    case "manufacturing_inquiry":
      return resolveManufacturingInquiryParties(input.resourceId, input.organizationId);
    default: {
      const exhaustiveKind: never = input.resourceKind;
      void exhaustiveKind;
      return {
        success: false,
        error: { type: "VALIDATION_FAILED", message: "Unsupported resource kind." },
      };
    }
  }
}

async function projectThread(threadId: string): Promise<CommerceThreadProjection | null> {
  const [thread] = await db
    .select({
      id: commerceThread.id,
      resourceKind: commerceThread.resourceKind,
      resourceId: commerceThread.resourceId,
      createdByOrganizationId: commerceThread.createdByOrganizationId,
      createdByMemberId: commerceThread.createdByMemberId,
      createdAt: commerceThread.createdAt,
      updatedAt: commerceThread.updatedAt,
    })
    .from(commerceThread)
    .where(eq(commerceThread.id, threadId))
    .limit(1);

  if (!thread) {
    return null;
  }

  /**
   * The COLUMN admits `order`, `service_engagement` and `dispute`; this service does
   * not. A thread of one of those kinds can legally exist in the database with no
   * party resolver behind it, so a read that trusted the column would hand back a
   * thread nobody had been authorized against. Re-checked here, at the boundary.
   */
  if (
    thread.resourceKind !== "rfq" &&
    thread.resourceKind !== "quote" &&
    thread.resourceKind !== "product_inquiry" &&
    thread.resourceKind !== "manufacturing_inquiry"
  ) {
    return null;
  }

  const participants = await db
    .select({
      organizationId: commerceThreadParticipant.organizationId,
      participantRole: commerceThreadParticipant.participantRole,
    })
    .from(commerceThreadParticipant)
    .where(eq(commerceThreadParticipant.threadId, threadId))
    .orderBy(asc(commerceThreadParticipant.organizationId));

  return {
    id: thread.id,
    resourceKind: thread.resourceKind,
    resourceId: thread.resourceId,
    createdByOrganizationId: thread.createdByOrganizationId,
    createdByMemberId: thread.createdByMemberId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    participants,
  };
}

async function ensureParticipants(input: {
  readonly threadId: string;
  readonly buyerOrganizationId: string;
  readonly providerOrganizationIds: readonly string[];
}): Promise<void> {
  const participantRows: {
    threadId: string;
    organizationId: string;
    participantRole: "buyer" | "provider";
  }[] = [
    {
      threadId: input.threadId,
      organizationId: input.buyerOrganizationId,
      participantRole: "buyer",
    },
  ];

  for (const providerOrganizationId of input.providerOrganizationIds) {
    if (providerOrganizationId === input.buyerOrganizationId) {
      continue;
    }
    participantRows.push({
      threadId: input.threadId,
      organizationId: providerOrganizationId,
      participantRole: "provider",
    });
  }

  if (participantRows.length === 0) {
    return;
  }

  await db
    .insert(commerceThreadParticipant)
    .values(participantRows)
    .onConflictDoNothing({
      target: [commerceThreadParticipant.threadId, commerceThreadParticipant.organizationId],
    });
}

async function assertThreadParticipant(input: {
  readonly threadId: string;
  readonly organizationId: string;
}): Promise<Result<true, CommerceMessagesError>> {
  const [participant] = await db
    .select({ id: commerceThreadParticipant.id })
    .from(commerceThreadParticipant)
    .where(
      and(
        eq(commerceThreadParticipant.threadId, input.threadId),
        eq(commerceThreadParticipant.organizationId, input.organizationId),
      ),
    )
    .limit(1);

  if (!participant) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }

  return { success: true, value: true };
}

/**
 * Creates or returns the unique negotiation thread for an RFQ or quote resource.
 * Participants are derived from resource ownership/invitations, never from the body.
 */
export async function createOrGetThread(input: {
  readonly resourceKind: CommerceThreadResourceKind;
  readonly resourceId: string;
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}): Promise<Result<CommerceThreadProjection, CommerceMessagesError>> {
  void input.actorUserId;

  const parties = await resolveResourceParties({
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    organizationId: input.organizationId,
  });
  if (!parties.success) {
    return parties;
  }

  const [inserted] = await db
    .insert(commerceThread)
    .values({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      createdByOrganizationId: input.organizationId,
      createdByMemberId: input.memberId,
    })
    .onConflictDoNothing({
      target: [commerceThread.resourceKind, commerceThread.resourceId],
    })
    .returning({
      id: commerceThread.id,
    });

  let threadId = inserted?.id;
  if (threadId === undefined) {
    const [existing] = await db
      .select({ id: commerceThread.id })
      .from(commerceThread)
      .where(
        and(
          eq(commerceThread.resourceKind, input.resourceKind),
          eq(commerceThread.resourceId, input.resourceId),
        ),
      )
      .limit(1);
    if (!existing) {
      return { success: false, error: { type: "NOT_FOUND" } };
    }
    threadId = existing.id;
  }

  await ensureParticipants({
    threadId,
    buyerOrganizationId: parties.value.buyerOrganizationId,
    providerOrganizationIds: parties.value.providerOrganizationIds,
  });

  const projection = await projectThread(threadId);
  if (!projection) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  return { success: true, value: projection };
}

/**
 * Cursor-paginated messages for a thread the caller's organization participates in.
 */
/**
 * The four kinds this service can resolve parties for, as a value the SQL can filter on.
 *
 * Derived from the same list `projectThread` re-checks, and kept beside it deliberately: a
 * fifth kind added to the type without being added here would silently vanish from every
 * inbox, which is a harder bug to notice than a thread that 404s.
 */
const SERVED_THREAD_RESOURCE_KINDS: readonly CommerceThreadResourceKind[] = [
  "rfq",
  "quote",
  "product_inquiry",
  "manufacturing_inquiry",
];

/** A26-style preview cap: enough to recognise a conversation, not enough to read it. */
const THREAD_PREVIEW_CHARACTERS = 160;

/**
 * Narrows the database enum to the kinds this service can resolve parties for.
 *
 * The inbox query already filters on `SERVED_THREAD_RESOURCE_KINDS`, so this can only fail if
 * the SQL and the list disagree — which is a programmer error, and §3.3 says a programmer
 * error throws. It is a guard rather than a fallback because a fallback would relabel an
 * unservable thread as an RFQ and put it in somebody's inbox under the wrong name.
 */
function isServedThreadResourceKind(
  resourceKind: (typeof commerceThread.$inferSelect)["resourceKind"],
): resourceKind is CommerceThreadResourceKind {
  return SERVED_THREAD_RESOURCE_KINDS.some((servedKind) => servedKind === resourceKind);
}

export interface CommerceThreadInboxEntry extends CommerceThreadProjection {
  /**
   * NULL for a thread nobody has written into yet — `createOrGetThread` mints the thread
   * before the first message, so an empty one is a normal state rather than a defect.
   */
  readonly lastMessage: {
    readonly id: string;
    readonly authorOrganizationId: string;
    readonly bodyPreview: string;
    readonly createdAt: Date;
  } | null;
}

/**
 * The caller's thread inbox (Appendix A38).
 *
 * WHY THIS ROUTE HAD TO EXIST. `POST /commerce/threads` returned a `threadId` and nothing
 * else ever yielded one, so every thread the frontend could reach was a thread it had just
 * created in the same session. Reload the page and the conversation was unreachable. The same
 * absence made §14's settlement agreements unreachable, because
 * `GET|POST /commerce/threads/:threadId/settlement-agreements` are keyed on an id no list
 * produced — one missing read, two dead features.
 *
 * SCOPED BY PARTICIPATION, NOT BY AUTHORSHIP. `commerce_thread_participant` is the same table
 * `assertThreadParticipant` reads, so an organization sees exactly the threads it is allowed
 * to open and the inbox cannot disagree with the detail read.
 *
 * ORDERED BY ACTIVITY, keyed on `updatedAt` then `id` — §7's rule that a keyset order must end
 * in a unique column so equal timestamps cannot skip a row.
 */
export async function listThreadsForOrganization(input: {
  readonly organizationId: string;
  readonly resourceKind?: CommerceThreadResourceKind | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<
  Result<
    {
      readonly items: readonly CommerceThreadInboxEntry[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceMessagesError
  >
> {
  const pageLimit = input.limit ?? 20;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "limit must be an integer between 1 and 100." },
    };
  }

  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "VALIDATION_FAILED", message: "Invalid cursor." } };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceThread.updatedAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceThread.updatedAt, new Date(decodedCursor.sortKey)),
            gt(commerceThread.id, decodedCursor.id),
          ),
        );

  const threadRows = await db
    .select({
      id: commerceThread.id,
      resourceKind: commerceThread.resourceKind,
      resourceId: commerceThread.resourceId,
      createdByOrganizationId: commerceThread.createdByOrganizationId,
      createdByMemberId: commerceThread.createdByMemberId,
      createdAt: commerceThread.createdAt,
      updatedAt: commerceThread.updatedAt,
    })
    .from(commerceThreadParticipant)
    .innerJoin(commerceThread, eq(commerceThread.id, commerceThreadParticipant.threadId))
    .where(
      and(
        eq(commerceThreadParticipant.organizationId, input.organizationId),
        // The same narrowing `projectThread` applies. A kind with no party resolver behind it
        // must not appear in an inbox that promises every row is openable. The caller's
        // optional filter narrows WITHIN this set and can never widen past it.
        input.resourceKind === undefined
          ? inArray(commerceThread.resourceKind, [...SERVED_THREAD_RESOURCE_KINDS])
          : eq(commerceThread.resourceKind, input.resourceKind),
        cursorPredicate,
      ),
    )
    .orderBy(desc(commerceThread.updatedAt), asc(commerceThread.id))
    .limit(pageLimit + 1);

  const hasMore = threadRows.length > pageLimit;
  const pageRows = threadRows.slice(0, pageLimit);
  const threadIds = pageRows.map((row) => row.id);

  if (threadIds.length === 0) {
    return { success: true, value: { items: [], page: { nextCursor: null, hasMore: false } } };
  }

  /**
   * Participants and last messages in one batch each, so the query count per page is constant
   * rather than proportional to page size — the shape `loadReviewChildren` established.
   */
  const [participantRows, lastMessageRows] = await Promise.all([
    db
      .select({
        threadId: commerceThreadParticipant.threadId,
        organizationId: commerceThreadParticipant.organizationId,
        participantRole: commerceThreadParticipant.participantRole,
      })
      .from(commerceThreadParticipant)
      .where(inArray(commerceThreadParticipant.threadId, threadIds))
      .orderBy(asc(commerceThreadParticipant.organizationId)),
    // DISTINCT ON is the one thing the query builder cannot express here, and a correlated
    // subquery per thread would reintroduce the N+1 the batch exists to avoid.
    db.execute<{
      thread_id: string;
      id: string;
      author_organization_id: string;
      body_text: string;
      created_at: Date;
    }>(sql`
      SELECT DISTINCT ON (thread_id)
             thread_id, id, author_organization_id, body_text, created_at
        FROM commerce_message
       WHERE thread_id IN (${sql.join(
         threadIds.map((threadId) => sql`${threadId}`),
         sql`, `,
       )})
       ORDER BY thread_id, created_at DESC, id ASC
    `),
  ]);

  const participantsByThreadId = new Map<
    string,
    {
      readonly organizationId: string;
      readonly participantRole: "buyer" | "provider" | "moderator";
    }[]
  >();
  for (const participant of participantRows) {
    const existing = participantsByThreadId.get(participant.threadId) ?? [];
    existing.push({
      organizationId: participant.organizationId,
      participantRole: participant.participantRole,
    });
    participantsByThreadId.set(participant.threadId, existing);
  }

  const lastMessageByThreadId = new Map<string, CommerceThreadInboxEntry["lastMessage"]>();
  for (const message of lastMessageRows.rows) {
    lastMessageByThreadId.set(message.thread_id, {
      id: message.id,
      authorOrganizationId: message.author_organization_id,
      bodyPreview: message.body_text.slice(0, THREAD_PREVIEW_CHARACTERS),
      // A raw row is a driver value, so the timestamp arrives however the parser gave it.
      createdAt: new Date(message.created_at),
    });
  }

  const items = pageRows.map((row) => {
    if (!isServedThreadResourceKind(row.resourceKind)) {
      throw new Error(
        `Thread ${row.id} of kind ${row.resourceKind} passed the inbox filter, which excludes it.`,
      );
    }
    return {
      id: row.id,
      resourceKind: row.resourceKind,
      resourceId: row.resourceId,
      createdByOrganizationId: row.createdByOrganizationId,
      createdByMemberId: row.createdByMemberId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      participants: participantsByThreadId.get(row.id) ?? [],
      lastMessage: lastMessageByThreadId.get(row.id) ?? null,
    };
  });

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.updatedAt.toISOString(), id: lastRow.id })
      : null;

  return { success: true, value: { items, page: { nextCursor, hasMore } } };
}

export async function listMessages(input: {
  readonly threadId: string;
  readonly organizationId: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<
  Result<
    {
      readonly items: readonly CommerceMessageProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceMessagesError
  >
> {
  const [thread] = await db
    .select({ id: commerceThread.id })
    .from(commerceThread)
    .where(eq(commerceThread.id, input.threadId))
    .limit(1);
  if (!thread) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const participantCheck = await assertThreadParticipant({
    threadId: input.threadId,
    organizationId: input.organizationId,
  });
  if (!participantCheck.success) {
    return participantCheck;
  }

  const pageLimit = input.limit ?? 20;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "limit must be an integer between 1 and 100." },
    };
  }

  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return {
      success: false,
      error: { type: "VALIDATION_FAILED", message: "Invalid cursor." },
    };
  }

  const cursorPredicate =
    decodedCursor === null
      ? undefined
      : or(
          lt(commerceMessage.createdAt, new Date(decodedCursor.sortKey)),
          and(
            eq(commerceMessage.createdAt, new Date(decodedCursor.sortKey)),
            gt(commerceMessage.id, decodedCursor.id),
          ),
        );

  const rows = await db
    .select({
      id: commerceMessage.id,
      threadId: commerceMessage.threadId,
      authorOrganizationId: commerceMessage.authorOrganizationId,
      authorMemberId: commerceMessage.authorMemberId,
      bodyText: commerceMessage.bodyText,
      createdAt: commerceMessage.createdAt,
    })
    .from(commerceMessage)
    .where(and(eq(commerceMessage.threadId, input.threadId), cursorPredicate))
    .orderBy(desc(commerceMessage.createdAt), asc(commerceMessage.id))
    .limit(pageLimit + 1);

  const pageRows = rows.slice(0, pageLimit);
  const messageIds = pageRows.map((row) => row.id);
  const attachments =
    messageIds.length === 0
      ? []
      : await db
          .select({
            messageId: commerceMessageAttachment.messageId,
            encryptedDocumentId: commerceMessageAttachment.encryptedDocumentId,
          })
          .from(commerceMessageAttachment)
          .where(inArray(commerceMessageAttachment.messageId, messageIds));

  const attachmentsByMessageId = new Map<string, string[]>();
  for (const attachment of attachments) {
    const existing = attachmentsByMessageId.get(attachment.messageId) ?? [];
    existing.push(attachment.encryptedDocumentId);
    attachmentsByMessageId.set(attachment.messageId, existing);
  }

  const items: CommerceMessageProjection[] = pageRows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    authorOrganizationId: row.authorOrganizationId,
    authorMemberId: row.authorMemberId,
    bodyText: row.bodyText,
    createdAt: row.createdAt,
    encryptedDocumentIds: attachmentsByMessageId.get(row.id) ?? [],
  }));

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    rows.length > pageLimit && lastRow
      ? encodeStoreCursor({
          sortKey: lastRow.createdAt.toISOString(),
          id: lastRow.id,
        })
      : null;

  return {
    success: true,
    value: {
      items,
      page: { nextCursor, hasMore: nextCursor !== null },
    },
  };
}

/**
 * Append-only message write. Attachments must be available encrypted documents owned by
 * the caller's organization.
 */
export async function appendMessage(input: {
  readonly threadId: string;
  readonly organizationId: string;
  readonly memberId: string;
  readonly bodyText: string;
  readonly encryptedDocumentIds?: readonly string[] | undefined;
}): Promise<Result<CommerceMessageProjection, CommerceMessagesError>> {
  const trimmedBody = input.bodyText.trim();
  if (trimmedBody.length < 1 || trimmedBody.length > 10_000) {
    return {
      success: false,
      error: {
        type: "VALIDATION_FAILED",
        message: "bodyText must be between 1 and 10000 characters.",
      },
    };
  }

  const [thread] = await db
    .select({ id: commerceThread.id })
    .from(commerceThread)
    .where(eq(commerceThread.id, input.threadId))
    .limit(1);
  if (!thread) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }

  const participantCheck = await assertThreadParticipant({
    threadId: input.threadId,
    organizationId: input.organizationId,
  });
  if (!participantCheck.success) {
    return participantCheck;
  }

  const uniqueDocumentIds = [...new Set(input.encryptedDocumentIds ?? [])];
  if (uniqueDocumentIds.length > 0) {
    const ownedDocuments = await db
      .select({ id: commerceEncryptedDocument.id })
      .from(commerceEncryptedDocument)
      .where(
        and(
          inArray(commerceEncryptedDocument.id, uniqueDocumentIds),
          eq(commerceEncryptedDocument.organizationId, input.organizationId),
          eq(commerceEncryptedDocument.state, "available"),
        ),
      );

    if (ownedDocuments.length !== uniqueDocumentIds.length) {
      return { success: false, error: { type: "DOCUMENT_NOT_OWNED" } };
    }
  }

  const messageProjection = await db.transaction(async (tx) => {
    const [insertedMessage] = await tx
      .insert(commerceMessage)
      .values({
        threadId: input.threadId,
        authorOrganizationId: input.organizationId,
        authorMemberId: input.memberId,
        bodyText: trimmedBody,
      })
      .returning({
        id: commerceMessage.id,
        threadId: commerceMessage.threadId,
        authorOrganizationId: commerceMessage.authorOrganizationId,
        authorMemberId: commerceMessage.authorMemberId,
        bodyText: commerceMessage.bodyText,
        createdAt: commerceMessage.createdAt,
      });

    if (!insertedMessage) {
      throw new Error("commerce-messages: insert returned no message row.");
    }

    if (uniqueDocumentIds.length > 0) {
      await tx.insert(commerceMessageAttachment).values(
        uniqueDocumentIds.map((encryptedDocumentId) => ({
          messageId: insertedMessage.id,
          encryptedDocumentId,
        })),
      );
    }

    await tx
      .update(commerceThread)
      .set({ updatedAt: new Date() })
      .where(eq(commerceThread.id, input.threadId));

    return insertedMessage;
  });

  return {
    success: true,
    value: {
      id: messageProjection.id,
      threadId: messageProjection.threadId,
      authorOrganizationId: messageProjection.authorOrganizationId,
      authorMemberId: messageProjection.authorMemberId,
      bodyText: messageProjection.bodyText,
      createdAt: messageProjection.createdAt,
      encryptedDocumentIds: uniqueDocumentIds,
    },
  };
}

/**
 * Expires submitted quotes past revision validity and open RFQs past response deadline.
 * Guarded UPDATEs so retries are harmless and accepted/declined/withdrawn rows are untouched.
 */
export async function expireCommerceQuotesAndRfqs(asOf: Date): Promise<{
  readonly expiredQuoteCount: number;
  readonly expiredRfqCount: number;
}> {
  const expiredQuotes = await db
    .update(commerceQuote)
    .set({
      status: "expired",
      expiredAt: asOf,
      updatedAt: asOf,
    })
    .where(
      and(
        eq(commerceQuote.status, "submitted"),
        sql`EXISTS (
          SELECT 1
          FROM commerce_quote_revision AS revision
          WHERE revision.quote_id = ${commerceQuote.id}
            AND revision.revision_number = ${commerceQuote.latestRevisionNumber}
            AND revision.submitted_at IS NOT NULL
            AND revision.validity_deadline_at < ${asOf}
        )`,
      ),
    )
    .returning({ id: commerceQuote.id });

  const expiredRfqs = await db
    .update(commerceRfq)
    .set({
      state: "expired",
      expiredAt: asOf,
      updatedAt: asOf,
    })
    .where(and(eq(commerceRfq.state, "open"), lt(commerceRfq.responseDeadlineAt, asOf)))
    .returning({ id: commerceRfq.id });

  return {
    expiredQuoteCount: expiredQuotes.length,
    expiredRfqCount: expiredRfqs.length,
  };
}
