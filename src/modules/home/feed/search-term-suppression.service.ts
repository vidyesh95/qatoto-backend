import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { searchTermSuppression, user } from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import { normalizeSearchTerm } from "#src/modules/home/feed/search-query-log.js";
import { recordPlatformAction } from "#src/modules/platform/audit/platform-audit.service.js";
import {
  requirePlatformCapability,
  type PlatformAccessError,
} from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Moderator control over "Everyone is searching for" — `moderate_content`, capability FIRST.
 *
 * A slur or a brigaded phrase can clear the five-searcher floor, so a moderator can withhold a term
 * with a reason. Suppression is read by BOTH the hourly job and the watch read, so it takes effect
 * on the next page load. Suppressing an already-suppressed term is IDEMPOTENT and records nothing:
 * the first moderator's reason stands.
 */

export type SearchTermSuppressionError =
  | PlatformAccessError
  | { type: "SEARCH_TERM_NOT_STORABLE" }
  | { type: "SEARCH_TERM_NOT_SUPPRESSED"; term: string }
  | { type: "INVALID_CURSOR" };

export interface SearchTermSuppressionView {
  readonly term: string;
  readonly reason: string;
  readonly suppressedAt: string;
}

function toSuppressionView(
  row: typeof searchTermSuppression.$inferSelect,
): SearchTermSuppressionView {
  return { term: row.term, reason: row.reason, suppressedAt: row.suppressedAt.toISOString() };
}

export async function suppressSearchTerm(
  actorUserId: string,
  input: { readonly term: string; readonly reason: string },
): Promise<Result<SearchTermSuppressionView, SearchTermSuppressionError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  // A term the search log would never store can never trend, so suppressing it means nothing —
  // and storing it here would put an email address or a phone number into a moderator table.
  const normalizedTerm = normalizeSearchTerm(input.term);
  if (normalizedTerm === null)
    return { success: false, error: { type: "SEARCH_TERM_NOT_STORABLE" } };

  const suppressedAt = new Date();
  const inserted = await recordPlatformAction(
    async (tx) => {
      const [row] = await tx
        .insert(searchTermSuppression)
        .values({
          term: normalizedTerm,
          suppressedByUserId: actorUserId,
          reason: input.reason,
          suppressedAt,
        })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },
    (row) =>
      row === null
        ? null
        : {
            eventKind: "search_term_suppressed",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Suppressed a trending search term",
            targetLabel: `search term "${normalizedTerm}"`,
            detailNote: input.reason,
            payload: { term: normalizedTerm },
            occurredAt: suppressedAt,
          },
  );
  if (inserted !== null) return { success: true, value: toSuppressionView(inserted) };

  // Already suppressed: return the standing suppression rather than stamping a second reason.
  const [existing] = await db
    .select()
    .from(searchTermSuppression)
    .where(eq(searchTermSuppression.term, normalizedTerm));
  if (!existing)
    return { success: false, error: { type: "SEARCH_TERM_NOT_SUPPRESSED", term: normalizedTerm } };
  return { success: true, value: toSuppressionView(existing) };
}

export async function unsuppressSearchTerm(
  actorUserId: string,
  term: string,
): Promise<Result<{ readonly term: string }, SearchTermSuppressionError>> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const unsuppressedAt = new Date();
  const deleted = await recordPlatformAction(
    async (tx) => {
      const [row] = await tx
        .delete(searchTermSuppression)
        .where(eq(searchTermSuppression.term, term))
        .returning();
      return row ?? null;
    },
    (row) =>
      row === null
        ? null
        : {
            eventKind: "search_term_unsuppressed",
            actorUserId,
            actorRoleSnapshot: capabilityResult.value.platformRole,
            actionLabel: "Lifted a trending search term suppression",
            targetLabel: `search term "${term}"`,
            payload: { term },
            occurredAt: unsuppressedAt,
          },
  );
  if (deleted === null)
    return { success: false, error: { type: "SEARCH_TERM_NOT_SUPPRESSED", term } };
  return { success: true, value: { term: deleted.term } };
}

/** One standing suppression as the staff list shows it. */
export interface SearchTermSuppressionListItem extends SearchTermSuppressionView {
  /** `null` once the suppressing moderator's account is deleted (`set null`); the row stands. */
  readonly suppressedBy: { readonly userId: string; readonly name: string } | null;
}

/**
 * Standing suppressions, newest first, keyset-paged on `(suppressed_at, term)` — the term is the
 * primary key, so it is the unique tie-breaker the cursor ends in.
 *
 * The keyset compares `suppressed_at` TRUNCATED TO MILLISECONDS, and orders by the same
 * expression: the column is microsecond `timestamp` and the cursor carries epoch milliseconds, so
 * comparing the raw column would skip every unseen row inside the cursor's millisecond. Only
 * `suppressSearchTerm` writes the column today, from a JS `Date`, but the type is not the guarantee.
 *
 * No index serves the order. The table holds one row per moderator decision and stays tiny.
 */
export async function listSearchTermSuppressions(
  actorUserId: string,
  input: { readonly limit: number; readonly cursor?: string | undefined },
): Promise<
  Result<
    {
      readonly items: readonly SearchTermSuppressionListItem[];
      readonly nextCursor: string | null;
    },
    SearchTermSuppressionError
  >
> {
  const capabilityResult = await requirePlatformCapability(actorUserId, "moderate_content");
  if (!capabilityResult.success) return { success: false, error: capabilityResult.error };

  const decodedCursor = input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const suppressedAtMilliseconds = sql<Date>`date_trunc('milliseconds', ${searchTermSuppression.suppressedAt})`;
  // Strictly older, OR the same millisecond with a smaller term: the mirror of an ascending cursor.
  const cursorCondition =
    decodedCursor === null
      ? sql`true`
      : (or(
          lt(suppressedAtMilliseconds, sql`${decodedCursor.instant.toISOString()}::timestamp`),
          and(
            eq(suppressedAtMilliseconds, sql`${decodedCursor.instant.toISOString()}::timestamp`),
            lt(searchTermSuppression.term, decodedCursor.id),
          ),
        ) ?? sql`true`);

  const rows = await db
    .select({
      term: searchTermSuppression.term,
      reason: searchTermSuppression.reason,
      suppressedAt: searchTermSuppression.suppressedAt,
      suppressorUserId: user.id,
      suppressorName: user.name,
    })
    .from(searchTermSuppression)
    // LEFT: the moderator is nulled out when their account goes, and the suppression still stands.
    .leftJoin(user, eq(user.id, searchTermSuppression.suppressedByUserId))
    .where(cursorCondition)
    .orderBy(desc(suppressedAtMilliseconds), desc(searchTermSuppression.term))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        term: row.term,
        reason: row.reason,
        suppressedAt: row.suppressedAt.toISOString(),
        suppressedBy:
          row.suppressorUserId === null || row.suppressorName === null
            ? null
            : { userId: row.suppressorUserId, name: row.suppressorName },
      })),
      nextCursor:
        rows.length > input.limit && lastRow !== undefined
          ? encodeInstantCursor({ instant: lastRow.suppressedAt, id: lastRow.term })
          : null,
    },
  };
}
