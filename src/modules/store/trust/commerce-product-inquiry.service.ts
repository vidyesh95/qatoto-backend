import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { commerceProductInquiry, product } from "#src/db/schema.js";
import {
  memberCanOperateBuyer,
  type CommerceOrganizationMemberRole,
} from "#src/modules/store/organizations/commerce-organization-access.service.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { createOrGetThread } from "#src/modules/store/procurement/commerce-messages.service.js";
import type { CommerceThreadProjection } from "#src/modules/store/procurement/commerce-messages.service.js";
import { decodeTimestampStoreCursor, encodeStoreCursor } from "#src/modules/store/store-cursor.js";
import type { ListProductInquiriesQuery } from "#src/modules/store/trust/commerce-product-inquiry.schemas.js";
import type { Result } from "#src/types/index.js";

export type CommerceProductInquiryError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  /** A seller opening a pre-sales inquiry on its own listing. */
  | { type: "SELF_INQUIRY_FORBIDDEN" }
  | { type: "INVALID_CURSOR" };

export interface ProductInquiryActorContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly memberRole: CommerceOrganizationMemberRole;
  readonly actorUserId: string;
}

export interface ProductInquiryProjection {
  readonly id: string;
  readonly productId: string;
  readonly buyerOrganizationId: string;
  readonly sellerOrganizationId: string;
  readonly convertedToRfqId: string | null;
  readonly createdAt: Date;
  /** Present on create; the list read is a queue and does not fan out to threads. */
  readonly thread: CommerceThreadProjection | null;
}

function projectInquiry(
  inquiry: typeof commerceProductInquiry.$inferSelect,
  thread: CommerceThreadProjection | null,
): ProductInquiryProjection {
  return {
    id: inquiry.id,
    productId: inquiry.productId,
    buyerOrganizationId: inquiry.buyerOrganizationId,
    sellerOrganizationId: inquiry.sellerOrganizationId,
    convertedToRfqId: inquiry.convertedToRfqId,
    createdAt: inquiry.createdAt,
    thread,
  };
}

/**
 * Open — or return — the buyer organization's inquiry about one listing, and its
 * thread (Appendix A14).
 *
 * IDEMPOTENT BY THE UNIQUE INDEX, not by the idempotency key alone. "Chat now" is a
 * button a buyer will press again from a second tab; the second press must reach the
 * same conversation rather than fail or fork one. `onConflictDoNothing` plus a re-read
 * is the same shape `createOrGetThread` itself uses.
 *
 * Takes an already-verified `sellerOrganizationId` from the caller, which resolved the
 * product through the catalog's single public-eligibility rule — an inquiry about a
 * draft or suspended listing must 404 exactly as the listing does.
 */
export async function createOrGetProductInquiry(
  actor: ProductInquiryActorContext,
  input: { readonly productId: string; readonly sellerOrganizationId: string },
): Promise<Result<ProductInquiryProjection, CommerceProductInquiryError>> {
  if (!memberCanOperateBuyer(actor.memberRole)) {
    return { success: false, error: { type: "FORBIDDEN" } };
  }
  if (actor.organizationId === input.sellerOrganizationId) {
    return { success: false, error: { type: "SELF_INQUIRY_FORBIDDEN" } };
  }

  const inquiry = await db.transaction(async (transaction) => {
    const inserted = await transaction
      .insert(commerceProductInquiry)
      .values({
        productId: input.productId,
        buyerOrganizationId: actor.organizationId,
        buyerMemberId: actor.memberId,
        sellerOrganizationId: input.sellerOrganizationId,
      })
      .onConflictDoNothing({
        target: [commerceProductInquiry.productId, commerceProductInquiry.buyerOrganizationId],
      })
      .returning();

    const created = inserted[0];
    if (created) {
      const appended = await appendCommerceOrganizationAuditEntry(transaction, {
        organizationId: actor.organizationId,
        eventKind: "product_inquiry_opened",
        actorUserId: actor.actorUserId,
        actorMemberRoleSnapshot: actor.memberRole,
        targetEntityType: "commerce_product_inquiry",
        targetEntityId: created.id,
        payload: {
          inquiryId: created.id,
          productId: input.productId,
          sellerOrganizationId: input.sellerOrganizationId,
        },
        occurredAt: new Date(),
      });
      if (!appended.success) {
        throw new Error(`Product inquiry audit append failed: ${appended.error.type}`);
      }
      return created;
    }

    const [existing] = await transaction
      .select()
      .from(commerceProductInquiry)
      .where(
        and(
          eq(commerceProductInquiry.productId, input.productId),
          eq(commerceProductInquiry.buyerOrganizationId, actor.organizationId),
        ),
      )
      .limit(1);
    return existing ?? null;
  });

  if (!inquiry) return { success: false, error: { type: "NOT_FOUND" } };

  /**
   * The thread is created OUTSIDE the inquiry transaction, and that is safe because
   * `createOrGetThread` is itself create-or-get: if this call fails, the next press of
   * the button finds the inquiry and creates the thread then. The alternative —
   * inlining thread creation — would mean duplicating participant derivation, which is
   * the logic §4.11 says must have exactly one home.
   */
  const thread = await createOrGetThread({
    resourceKind: "product_inquiry",
    resourceId: inquiry.id,
    organizationId: actor.organizationId,
    memberId: actor.memberId,
    actorUserId: actor.actorUserId,
  });

  return {
    success: true,
    value: projectInquiry(inquiry, thread.success ? thread.value : null),
  };
}

/**
 * The caller's inquiries, from whichever side they are on (Appendix A14).
 *
 * One route rather than a buyer route and a seller route: an organization can
 * legitimately be both on different listings, and `side` is a filter over rows the
 * caller may already see, never a permission.
 */
export async function listProductInquiries(
  actor: ProductInquiryActorContext,
  query: ListProductInquiriesQuery,
): Promise<
  Result<
    {
      readonly items: readonly ProductInquiryProjection[];
      readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
    },
    CommerceProductInquiryError
  >
> {
  const sidePredicate =
    query.side === "buyer"
      ? eq(commerceProductInquiry.buyerOrganizationId, actor.organizationId)
      : query.side === "seller"
        ? eq(commerceProductInquiry.sellerOrganizationId, actor.organizationId)
        : or(
            eq(commerceProductInquiry.buyerOrganizationId, actor.organizationId),
            eq(commerceProductInquiry.sellerOrganizationId, actor.organizationId),
          );

  const filters: SQL[] = [];
  if (sidePredicate) filters.push(sidePredicate);

  if (query.cursor !== undefined) {
    const cursor = decodeTimestampStoreCursor(query.cursor);
    if (!cursor) return { success: false, error: { type: "INVALID_CURSOR" } };
    const keyset = or(
      gt(commerceProductInquiry.createdAt, cursor.sortKey),
      and(
        eq(commerceProductInquiry.createdAt, cursor.sortKey),
        gt(commerceProductInquiry.id, cursor.id),
      ),
    );
    if (keyset) filters.push(keyset);
  }

  const rows = await db
    .select()
    .from(commerceProductInquiry)
    .where(and(...filters))
    .orderBy(asc(commerceProductInquiry.createdAt), asc(commerceProductInquiry.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows.at(-1);

  return {
    success: true,
    value: {
      items: pageRows.map((row) => projectInquiry(row, null)),
      page: {
        nextCursor:
          hasMore && lastRow
            ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
            : null,
        hasMore: hasMore && lastRow !== undefined,
      },
    },
  };
}

/**
 * What "Chat now" should render for this viewer (Appendix A14).
 *
 * A SERVER DECISION, never a client guess. It is a fact about the caller that the
 * caller already knows, so disclosing it leaks nothing — and the alternative is a
 * frontend inferring eligibility from an incomplete picture and putting a button in
 * front of a wall.
 *
 * `ask_question` is the honest middle rung, and the reason A9 shipped before this:
 * a buyer with no verified organization is not dead-ended, they are pointed at the
 * public channel that does accept them.
 */
export type ProductContactAffordance = "chat" | "ask_question" | "sign_in";

export function deriveContactAffordance(input: {
  readonly viewerUserId: string | null;
  readonly viewerOrganizationId: string | null;
  readonly viewerMemberRole: CommerceOrganizationMemberRole | null;
  readonly sellerOrganizationId: string;
}): ProductContactAffordance {
  if (input.viewerUserId === null) return "sign_in";
  if (
    input.viewerOrganizationId !== null &&
    input.viewerOrganizationId !== input.sellerOrganizationId &&
    input.viewerMemberRole !== null &&
    memberCanOperateBuyer(input.viewerMemberRole)
  ) {
    return "chat";
  }
  return "ask_question";
}

/**
 * Records that an inquiry produced an RFQ (Appendix A14).
 *
 * A POINTER, not a migration. The RFQ gets its own thread as it always has, and the
 * pre-sales history stays where it is, still attributable and still readable. The two
 * are never merged — see `resolveProductInquiryParties`.
 */
export async function linkInquiryToRfq(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    readonly inquiryId: string;
    readonly rfqId: string;
    readonly buyerOrganizationId: string;
  },
): Promise<boolean> {
  const updated = await transaction
    .update(commerceProductInquiry)
    .set({ convertedToRfqId: input.rfqId })
    .where(
      and(
        eq(commerceProductInquiry.id, input.inquiryId),
        // Scoped to the caller's own organization: an inquiry id from another buyer
        // must not be attachable to this RFQ.
        eq(commerceProductInquiry.buyerOrganizationId, input.buyerOrganizationId),
      ),
    )
    .returning({ id: commerceProductInquiry.id });
  return updated.length > 0;
}

/** Exported for the controller's eligibility check; keeps `product` imported once. */
export async function loadInquirySellerOrganizationId(productId: string): Promise<string | null> {
  const [row] = await db
    .select({ sellerOrganizationId: product.sellerOrganizationId })
    .from(product)
    .where(eq(product.id, productId))
    .limit(1);
  return row?.sellerOrganizationId ?? null;
}
