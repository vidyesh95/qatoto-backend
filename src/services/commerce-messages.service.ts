import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceEncryptedDocument,
  commerceMessage,
  commerceMessageAttachment,
  commerceQuote,
  commerceRfq,
  commerceRfqInvitation,
  commerceThread,
  commerceThreadParticipant,
} from "#src/db/schema.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import type { Result } from "#src/types/index.js";

export type CommerceThreadResourceKind = "rfq" | "quote";

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

  if (thread.resourceKind !== "rfq" && thread.resourceKind !== "quote") {
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
