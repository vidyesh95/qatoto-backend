import { randomBytes } from "node:crypto";

import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  commerceManufacturingInquiry,
  commerceManufacturingInquiryCertification,
  commerceOrganization,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { decodeStoreCursor, encodeStoreCursor } from "#src/lib/store-cursor.js";
import { appendCommerceOrganizationAuditEntry } from "#src/modules/store/organizations/commerce-organization-audit.service.js";
import { createOrGetThread } from "#src/services/commerce-messages.service.js";
import { resolveFactoryForInquiry } from "#src/services/store-factories.service.js";
import type { Result } from "#src/types/index.js";

/**
 * The manufacturing inquiry (STORE_BACKEND_STRUCTURE.md §16.5).
 *
 * THREE RULES THIS FILE EXISTS TO HOLD:
 *
 * 1. `create` ANSWERS `draft`, ALWAYS. Creating notifies nobody, exactly as an RFQ does,
 *    so no success copy may say "sent". `send` is a separate act with its own route.
 * 2. THE CONVERSATION IS ONE-TO-ONE. The thread opens on `send`, with two participants and
 *    never the RFQ shape's every-invited-provider list, because folding a one-to-one
 *    conversation into that would show one factory's chat to its competitors.
 * 3. `capabilityKind` IS REQUIRED and is checked against nothing — deliberately. It is not
 *    a filter, it is the field that tells the factory in the first line whether this is
 *    answerable at all. Refusing an inquiry because the factory has not declared that
 *    capability would be worse: a factory's capability list is self-declared and often
 *    incomplete, and silence is not a "no".
 */

type InquiryRow = typeof commerceManufacturingInquiry.$inferSelect;
type CapabilityKind = InquiryRow["capabilityKind"];
type StandardCode = (typeof commerceManufacturingInquiryCertification.$inferSelect)["standardCode"];

export type CommerceManufacturingInquiryError =
  | { type: "NOT_FOUND" }
  | { type: "FORBIDDEN" }
  | { type: "INVALID_CURSOR" }
  | { type: "INVALID_STATE"; message: string }
  | { type: "NOT_ACCEPTING_INQUIRIES" }
  | { type: "SELF_INQUIRY_FORBIDDEN" };

/**
 * What `POST` answers with: THE TABLE'S OWN COLUMNS, not a projection of the factory.
 *
 * The success screen has no factory object to read and must not pretend otherwise — the
 * same discipline `CreatedServiceOffering` keeps.
 */
export interface ManufacturingInquiryProjection {
  readonly id: string;
  readonly reference: string;
  readonly factoryOrganizationId: string;
  readonly factorySlug: string;
  readonly factoryDisplayName: string;
  readonly buyerOrganizationId: string;
  readonly state: InquiryRow["state"];
  readonly capabilityKind: CapabilityKind;
  readonly productDescription: string;
  readonly estimatedAnnualQuantity: number | null;
  readonly unitLabel: string | null;
  readonly targetUnitPriceInCents: number | null;
  readonly currency: string | null;
  readonly requiredCertifications: readonly StandardCode[];
  readonly desiredFirstDeliveryAt: string | null;
  readonly notes: string | null;
  readonly threadId: string | null;
  readonly convertedToRfqId: string | null;
  readonly sentAt: Date | null;
  readonly answeredAt: Date | null;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
}

export interface ManufacturingInquiryPage {
  readonly items: readonly ManufacturingInquiryProjection[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * A human-quotable handle: `MI-` plus ten crockford-ish characters.
 *
 * NO `I`, `L`, `O` OR `U`. This is read out on a phone call, which is the entire reason it
 * exists, so the two pairs people mishear are simply not in the alphabet. Uniqueness is
 * enforced by the index and retried on collision, never checked first — a check-then-insert
 * loses the race it exists to prevent.
 */
const REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REFERENCE_ATTEMPTS = 8;

function mintReference(): string {
  const bytes = randomBytes(10);
  let reference = "MI-";
  for (const byte of bytes) {
    reference += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  }
  return reference;
}

function projectInquiry(input: {
  readonly row: InquiryRow;
  readonly factorySlug: string;
  readonly factoryDisplayName: string;
  readonly requiredCertifications: readonly StandardCode[];
}): ManufacturingInquiryProjection {
  return {
    id: input.row.id,
    reference: input.row.reference,
    factoryOrganizationId: input.row.factoryOrganizationId,
    factorySlug: input.factorySlug,
    factoryDisplayName: input.factoryDisplayName,
    buyerOrganizationId: input.row.buyerOrganizationId,
    state: input.row.state,
    capabilityKind: input.row.capabilityKind,
    productDescription: input.row.productDescription,
    estimatedAnnualQuantity: input.row.estimatedAnnualQuantity,
    unitLabel: input.row.unitLabel,
    targetUnitPriceInCents: input.row.targetUnitPriceInCents,
    currency: input.row.currency,
    requiredCertifications: input.requiredCertifications,
    desiredFirstDeliveryAt: input.row.desiredFirstDeliveryAt,
    notes: input.row.notes,
    threadId: input.row.threadId,
    convertedToRfqId: input.row.convertedToRfqId,
    sentAt: input.row.sentAt,
    answeredAt: input.row.answeredAt,
    closedAt: input.row.closedAt,
    createdAt: input.row.createdAt,
  };
}

/** Batches the two joins every projection needs: the factory's identity, and the codes. */
async function projectInquiries(
  rows: readonly InquiryRow[],
): Promise<ManufacturingInquiryProjection[]> {
  if (rows.length === 0) return [];

  const factoryIds = [...new Set(rows.map((row) => row.factoryOrganizationId))];
  const inquiryIds = rows.map((row) => row.id);

  const [factories, certificationRows] = await Promise.all([
    db
      .select({
        id: commerceOrganization.id,
        slug: commerceOrganization.slug,
        displayName: commerceOrganization.displayName,
      })
      .from(commerceOrganization)
      .where(inArray(commerceOrganization.id, factoryIds)),
    db
      .select()
      .from(commerceManufacturingInquiryCertification)
      .where(inArray(commerceManufacturingInquiryCertification.inquiryId, inquiryIds))
      .orderBy(
        asc(commerceManufacturingInquiryCertification.inquiryId),
        asc(commerceManufacturingInquiryCertification.standardCode),
      ),
  ]);

  const factoryById = new Map(factories.map((factory) => [factory.id, factory]));
  const codesByInquiry = new Map<string, StandardCode[]>();
  for (const row of certificationRows) {
    const existing = codesByInquiry.get(row.inquiryId) ?? [];
    existing.push(row.standardCode);
    codesByInquiry.set(row.inquiryId, existing);
  }

  return rows.map((row) => {
    const factory = factoryById.get(row.factoryOrganizationId);
    return projectInquiry({
      row,
      /**
       * A factory whose organization row vanished cannot happen — the FK is `restrict` —
       * but the projection must still be total, so the id stands in rather than throwing
       * and taking a whole page of somebody's inquiries with it.
       */
      factorySlug: factory?.slug ?? row.factoryOrganizationId,
      factoryDisplayName: factory?.displayName ?? row.factoryOrganizationId,
      requiredCertifications: codesByInquiry.get(row.id) ?? [],
    });
  });
}

export interface CreateManufacturingInquiryInput {
  readonly factorySlug: string;
  readonly buyerOrganizationId: string;
  readonly buyerMemberId: string;
  readonly createdByUserId: string;
  readonly capabilityKind: CapabilityKind;
  readonly productDescription: string;
  readonly estimatedAnnualQuantity: number | null;
  readonly unitLabel: string | null;
  readonly targetUnitPriceInCents: number | null;
  readonly currency: string | null;
  readonly requiredCertifications: readonly StandardCode[];
  readonly desiredFirstDeliveryAt: string | null;
  readonly notes: string | null;
}

/**
 * Creates a DRAFT. Requires an `Idempotency-Key` at the route: a retry without one is a
 * second inquiry in the factory's queue, which a human then has to close by hand.
 *
 * NO UNIQUE INDEX ON `(factory, buyer)`, unlike `commerce_product_inquiry`. That table's
 * uniqueness models "have you asked about this listing"; a buyer may legitimately ask one
 * factory about four unrelated products, and collapsing those into one row would lose
 * three of them.
 */
export async function createManufacturingInquiry(
  input: CreateManufacturingInquiryInput,
): Promise<Result<ManufacturingInquiryProjection, CommerceManufacturingInquiryError>> {
  const factory = await resolveFactoryForInquiry(input.factorySlug);
  if (!factory.success) return { success: false, error: { type: "NOT_FOUND" } };

  if (factory.value.organizationId === input.buyerOrganizationId) {
    return { success: false, error: { type: "SELF_INQUIRY_FORBIDDEN" } };
  }
  if (!factory.value.acceptingInquiries) {
    return { success: false, error: { type: "NOT_ACCEPTING_INQUIRIES" } };
  }

  const factoryOrganizationId = factory.value.organizationId;
  const requiredCertifications = [...new Set(input.requiredCertifications)];

  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      const created = await db.transaction(async (transaction) => {
        const occurredAt = new Date();
        const [row] = await transaction
          .insert(commerceManufacturingInquiry)
          .values({
            reference: mintReference(),
            factoryOrganizationId,
            buyerOrganizationId: input.buyerOrganizationId,
            buyerMemberId: input.buyerMemberId,
            createdByUserId: input.createdByUserId,
            state: "draft",
            capabilityKind: input.capabilityKind,
            productDescription: input.productDescription,
            estimatedAnnualQuantity: input.estimatedAnnualQuantity,
            unitLabel: input.unitLabel,
            targetUnitPriceInCents: input.targetUnitPriceInCents,
            currency: input.currency,
            desiredFirstDeliveryAt: input.desiredFirstDeliveryAt,
            notes: input.notes,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning();
        if (!row) throw new Error("Manufacturing inquiry insert returned no row.");

        if (requiredCertifications.length > 0) {
          await transaction.insert(commerceManufacturingInquiryCertification).values(
            requiredCertifications.map((standardCode) => ({
              inquiryId: row.id,
              standardCode,
              createdAt: occurredAt,
            })),
          );
        }

        /**
         * Audited against the BUYER's organization, not the factory's. The factory learns
         * nothing until `send`, and an audit entry on its chain would be the notification
         * this state deliberately withholds.
         */
        const appended = await appendCommerceOrganizationAuditEntry(transaction, {
          organizationId: input.buyerOrganizationId,
          eventKind: "manufacturing_inquiry_created",
          actorUserId: input.createdByUserId,
          actorMemberRoleSnapshot: null,
          targetEntityType: "commerce_manufacturing_inquiry",
          targetEntityId: row.id,
          payload: { reference: row.reference },
          occurredAt,
        });
        if (!appended.success) {
          throw new Error(`Manufacturing inquiry audit append failed: ${appended.error.type}`);
        }

        return row;
      });

      const projected = await projectInquiries([created]);
      const projection = projected[0];
      if (!projection) throw new Error("Manufacturing inquiry projection returned no row.");
      return { success: true, value: projection };
    } catch (error) {
      // Only a reference collision retries. Anything else is a real fault and re-throws.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  throw new Error(
    `Could not mint a unique manufacturing inquiry reference in ${String(REFERENCE_ATTEMPTS)} attempts.`,
  );
}

/**
 * Loads one inquiry for a caller who must be a party to it.
 *
 * NOT_FOUND FOR A NON-PARTY, never FORBIDDEN: §11's anti-enumeration rule, and the same
 * shape every other commerce resolver uses. A distinguishable 403 would turn this route
 * into an oracle for which inquiry ids exist.
 */
async function loadInquiryForParty(input: {
  readonly inquiryId: string;
  readonly organizationId: string;
}): Promise<Result<InquiryRow, CommerceManufacturingInquiryError>> {
  const [row] = await db
    .select()
    .from(commerceManufacturingInquiry)
    .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
    .limit(1);

  if (!row) return { success: false, error: { type: "NOT_FOUND" } };

  const isBuyer = row.buyerOrganizationId === input.organizationId;
  const isFactory = row.factoryOrganizationId === input.organizationId;
  /**
   * A DRAFT IS INVISIBLE TO THE FACTORY. It has not been sent, so as far as the factory is
   * concerned it does not exist — which is the same thing `state = 'draft'` means to the
   * message thread resolver.
   */
  if (!isBuyer && !(isFactory && row.state !== "draft")) {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  return { success: true, value: row };
}

export async function getManufacturingInquiry(input: {
  readonly inquiryId: string;
  readonly organizationId: string;
}): Promise<Result<ManufacturingInquiryProjection, CommerceManufacturingInquiryError>> {
  const row = await loadInquiryForParty(input);
  if (!row.success) return row;

  const projected = await projectInquiries([row.value]);
  const projection = projected[0];
  if (!projection) throw new Error("Manufacturing inquiry projection returned no row.");
  return { success: true, value: projection };
}

/**
 * Sends a draft, and opens the one-to-one thread as it goes.
 *
 * BUYER ONLY, and only from `draft`. Sending twice is an INVALID_STATE rather than a
 * silent no-op, because "we already told them" and "we just told them" are different facts
 * for somebody watching a queue.
 */
export async function sendManufacturingInquiry(input: {
  readonly inquiryId: string;
  readonly organizationId: string;
  readonly memberId: string;
  readonly actorUserId: string;
}): Promise<Result<ManufacturingInquiryProjection, CommerceManufacturingInquiryError>> {
  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(commerceManufacturingInquiry)
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .for("update");

    if (!existing || existing.buyerOrganizationId !== input.organizationId) {
      return { status: "not_found" as const };
    }
    if (existing.state !== "draft") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(commerceManufacturingInquiry)
      .set({ state: "sent", sentAt: occurredAt, updatedAt: occurredAt })
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .returning();
    if (!row) throw new Error("Manufacturing inquiry send returned no row.");

    const appended = await appendCommerceOrganizationAuditEntry(transaction, {
      organizationId: row.factoryOrganizationId,
      eventKind: "manufacturing_inquiry_sent",
      actorUserId: input.actorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_manufacturing_inquiry",
      targetEntityId: row.id,
      payload: { reference: row.reference },
      occurredAt,
    });
    if (!appended.success) {
      throw new Error(`Manufacturing inquiry audit append failed: ${appended.error.type}`);
    }

    return { status: "sent" as const, row };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `An inquiry in state ${outcome.state} cannot be sent.`,
      },
    };
  }

  /**
   * THE THREAD IS OPENED AFTER THE TRANSACTION COMMITS, not inside it.
   *
   * `createOrGetThread` resolves parties by reading the inquiry, and it reads through `db`
   * rather than this transaction — so calling it before the commit would find a row still
   * in `draft` and refuse. The cost of the split is a `sent` inquiry that briefly has no
   * thread, which the projection already models as `threadId: null` and which the next
   * call repairs, because `createOrGetThread` is idempotent on `(resourceKind, resourceId)`.
   */
  const thread = await createOrGetThread({
    resourceKind: "manufacturing_inquiry",
    resourceId: outcome.row.id,
    organizationId: input.organizationId,
    memberId: input.memberId,
    actorUserId: input.actorUserId,
  });
  if (thread.success) {
    await db
      .update(commerceManufacturingInquiry)
      .set({ threadId: thread.value.id })
      .where(eq(commerceManufacturingInquiry.id, outcome.row.id));
  }

  return getManufacturingInquiry({
    inquiryId: outcome.row.id,
    organizationId: input.organizationId,
  });
}

/**
 * The factory marks an inquiry answered.
 *
 * FACTORY ONLY. This is the one transition the other side owns, and it exists so a buyer's
 * `/mine` list can distinguish "nobody has replied" from "they replied in the thread" —
 * which is the whole difference between a queue and a void.
 */
export async function answerManufacturingInquiry(input: {
  readonly inquiryId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
}): Promise<Result<ManufacturingInquiryProjection, CommerceManufacturingInquiryError>> {
  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(commerceManufacturingInquiry)
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .for("update");

    /**
     * A DRAFT IS NOT_FOUND TO THE FACTORY, not INVALID_STATE — the same line
     * `loadInquiryForParty` and `closeManufacturingInquiry` draw. A 409 here would tell a
     * factory that a buyer is drafting an inquiry to it, which is precisely the fact the
     * draft state exists to withhold.
     */
    if (
      !existing ||
      existing.factoryOrganizationId !== input.organizationId ||
      existing.state === "draft"
    ) {
      return { status: "not_found" as const };
    }
    if (existing.state !== "sent") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(commerceManufacturingInquiry)
      .set({ state: "answered", answeredAt: occurredAt, updatedAt: occurredAt })
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .returning();
    if (!row) throw new Error("Manufacturing inquiry answer returned no row.");

    const appended = await appendCommerceOrganizationAuditEntry(transaction, {
      organizationId: row.buyerOrganizationId,
      eventKind: "manufacturing_inquiry_answered",
      actorUserId: input.actorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_manufacturing_inquiry",
      targetEntityId: row.id,
      payload: { reference: row.reference },
      occurredAt,
    });
    if (!appended.success) {
      throw new Error(`Manufacturing inquiry audit append failed: ${appended.error.type}`);
    }

    return { status: "answered" as const, row };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: {
        type: "INVALID_STATE",
        message: `An inquiry in state ${outcome.state} cannot be marked answered.`,
      },
    };
  }
  return getManufacturingInquiry({
    inquiryId: outcome.row.id,
    organizationId: input.organizationId,
  });
}

/** Either party may close, from any state but `closed`. Closing is not a verdict. */
export async function closeManufacturingInquiry(input: {
  readonly inquiryId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
}): Promise<Result<ManufacturingInquiryProjection, CommerceManufacturingInquiryError>> {
  const outcome = await db.transaction(async (transaction) => {
    const occurredAt = new Date();
    const [existing] = await transaction
      .select()
      .from(commerceManufacturingInquiry)
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .for("update");

    const isBuyer = existing?.buyerOrganizationId === input.organizationId;
    const isFactory =
      existing?.factoryOrganizationId === input.organizationId && existing.state !== "draft";
    if (!existing || (!isBuyer && !isFactory)) {
      return { status: "not_found" as const };
    }
    if (existing.state === "closed") {
      return { status: "invalid_state" as const, state: existing.state };
    }

    const [row] = await transaction
      .update(commerceManufacturingInquiry)
      .set({ state: "closed", closedAt: occurredAt, updatedAt: occurredAt })
      .where(eq(commerceManufacturingInquiry.id, input.inquiryId))
      .returning();
    if (!row) throw new Error("Manufacturing inquiry close returned no row.");

    const appended = await appendCommerceOrganizationAuditEntry(transaction, {
      organizationId: input.organizationId,
      eventKind: "manufacturing_inquiry_closed",
      actorUserId: input.actorUserId,
      actorMemberRoleSnapshot: null,
      targetEntityType: "commerce_manufacturing_inquiry",
      targetEntityId: row.id,
      payload: { reference: row.reference },
      occurredAt,
    });
    if (!appended.success) {
      throw new Error(`Manufacturing inquiry audit append failed: ${appended.error.type}`);
    }

    return { status: "closed" as const, row };
  });

  if (outcome.status === "not_found") {
    return { success: false, error: { type: "NOT_FOUND" } };
  }
  if (outcome.status === "invalid_state") {
    return {
      success: false,
      error: { type: "INVALID_STATE", message: "This inquiry is already closed." },
    };
  }
  return getManufacturingInquiry({
    inquiryId: outcome.row.id,
    organizationId: input.organizationId,
  });
}

type InquirySide = "buyer" | "factory";

/**
 * `/mine` and `/received`, keyset on `(createdAt, id)`.
 *
 * WITHOUT THESE A CREATE IS A WRITE INTO A HOLE. `src/hooks/store/factories.ts` records the
 * missing `/mine` as the reason its mutation invalidates nothing — an author who posts an
 * inquiry and cannot list it has no way to learn what happened to it.
 */
async function listInquiries(input: {
  readonly side: InquirySide;
  readonly organizationId: string;
  readonly state?: InquiryRow["state"];
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<ManufacturingInquiryPage, CommerceManufacturingInquiryError>> {
  const decodedCursor = input.cursor === undefined ? null : decodeStoreCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const filters: SQL[] =
    input.side === "buyer"
      ? [eq(commerceManufacturingInquiry.buyerOrganizationId, input.organizationId)]
      : [
          eq(commerceManufacturingInquiry.factoryOrganizationId, input.organizationId),
          // A draft belongs to the buyer alone until it is sent.
          sql`${commerceManufacturingInquiry.state} <> 'draft'`,
        ];

  if (input.state !== undefined) {
    filters.push(eq(commerceManufacturingInquiry.state, input.state));
  }
  if (decodedCursor !== null) {
    const cursorInstant = new Date(decodedCursor.sortKey);
    if (Number.isNaN(cursorInstant.getTime())) {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    const keysetPredicate = or(
      gt(commerceManufacturingInquiry.createdAt, cursorInstant),
      and(
        eq(commerceManufacturingInquiry.createdAt, cursorInstant),
        gt(commerceManufacturingInquiry.id, decodedCursor.id),
      ),
    );
    if (keysetPredicate) filters.push(keysetPredicate);
  }

  const rows = await db
    .select()
    .from(commerceManufacturingInquiry)
    .where(and(...filters))
    .orderBy(asc(commerceManufacturingInquiry.createdAt), asc(commerceManufacturingInquiry.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.length > input.limit;
  const nextCursor =
    hasMore && lastRow
      ? encodeStoreCursor({ sortKey: lastRow.createdAt.toISOString(), id: lastRow.id })
      : null;

  return {
    success: true,
    value: { items: await projectInquiries(pageRows), page: { nextCursor, hasMore } },
  };
}

export async function listBuyerManufacturingInquiries(input: {
  readonly organizationId: string;
  readonly state?: InquiryRow["state"];
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<ManufacturingInquiryPage, CommerceManufacturingInquiryError>> {
  return listInquiries({ ...input, side: "buyer" });
}

export async function listFactoryManufacturingInquiries(input: {
  readonly organizationId: string;
  readonly state?: InquiryRow["state"];
  readonly limit: number;
  readonly cursor?: string;
}): Promise<Result<ManufacturingInquiryPage, CommerceManufacturingInquiryError>> {
  return listInquiries({ ...input, side: "factory" });
}
