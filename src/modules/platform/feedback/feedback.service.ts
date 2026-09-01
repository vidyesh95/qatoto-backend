import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { platformFeedback, user } from "#src/db/schema.js";
import { requirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Site feedback — writing one note, and reading the queue of them.
 *
 * ## THE WRITE HAS NO `Result`, BECAUSE IT HAS NO WAY TO FAIL
 *
 * There is no subject to find, no uniqueness to violate and no state to be in the wrong
 * one. `requireAuth` proved the session, the check constraints and the Zod schema agree on
 * the lengths, and what is left is an insert. A `Result` with one arm would be ceremony
 * that teaches the next reader to expect a failure mode that does not exist.
 *
 * ## THE CAPABILITY IS CHECKED INSIDE, FIRST, AND BEFORE ANY QUERY
 *
 * Same reasoning as `user-reports.service.ts`: a route-level guard makes the capability
 * probeable, and middleware cannot return a `Result` so it could not join the controller's
 * exhaustive switch.
 *
 * ## NOTHING HERE IS A VERDICT
 *
 * Reading the queue writes no audit entry and changes no row. Feedback is not a moderation
 * action taken about a person, so there is no decision for the chain to record.
 */

export type PlatformFeedbackError =
  | { readonly type: "INVALID_CURSOR" }
  | { readonly type: "PLATFORM_CAPABILITY_REQUIRED"; readonly capability: "moderate_content" };

export interface PlatformFeedbackQueueItem {
  readonly feedbackId: string;
  readonly category: typeof platformFeedback.$inferSelect.category;
  readonly message: string;
  readonly pagePath: string;
  readonly userAgent: string | null;
  readonly status: typeof platformFeedback.$inferSelect.status;
  readonly createdAt: Date;
  /**
   * Null for feedback whose author has since been anonymized — the manifest nulls the
   * attribution and keeps the note. A queue row with no author is not a broken row.
   */
  readonly author: {
    readonly userId: string;
    readonly handle: string | null;
    readonly name: string;
  } | null;
}

/** Records one note. Returns the id so the client can say a row exists, and nothing more. */
export async function createPlatformFeedback(
  authorUserId: string,
  input: {
    readonly category: typeof platformFeedback.$inferSelect.category;
    readonly message: string;
    readonly pagePath: string;
    readonly userAgent: string | null;
  },
): Promise<{ readonly feedbackId: string }> {
  const [created] = await db
    .insert(platformFeedback)
    .values({
      userId: authorUserId,
      category: input.category,
      message: input.message,
      pagePath: input.pagePath,
      userAgent: input.userAgent,
    })
    .returning({ id: platformFeedback.id });

  if (!created) {
    // Unreachable: an insert with no conflict target either returns its row or throws.
    // Asserted rather than assumed, so a future `onConflictDoNothing` cannot make this
    // function quietly return a fabricated id.
    throw new Error("Feedback insert returned no row.");
  }
  return { feedbackId: created.id };
}

/** The staff queue, oldest first, keyset-paginated. */
export async function listPlatformFeedback(
  staffUserId: string,
  input: {
    readonly status?: typeof platformFeedback.$inferSelect.status | undefined;
    readonly limit: number;
    readonly cursor?: string | undefined;
  },
): Promise<
  Result<
    { readonly items: readonly PlatformFeedbackQueueItem[]; readonly nextCursor: string | null },
    PlatformFeedbackError
  >
> {
  const capability = await requirePlatformCapability(staffUserId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }

  let cursorCondition = sql`true`;
  if (input.cursor !== undefined) {
    /**
     * SPLIT ON THE FIRST SEPARATOR, WITH THE ID AS THE UNBOUNDED TAIL — the shape
     * `user-reports.service.ts` records: taking element `[1]` of a `split("_")` discards
     * the rest, so an id containing an underscore pages from a truncated id and returns
     * the WRONG ROWS rather than refusing. The epoch prefix is digits only and can never
     * contain `_`, so the first separator is always the real one.
     */
    const separatorIndex = input.cursor.indexOf("_");
    const rawInstant = separatorIndex === -1 ? "" : input.cursor.slice(0, separatorIndex);
    const rawId = separatorIndex === -1 ? "" : input.cursor.slice(separatorIndex + 1);
    const cursorInstant = rawInstant === "" ? Number.NaN : Number(rawInstant);
    if (!Number.isInteger(cursorInstant) || cursorInstant < 0 || rawId === "") {
      return { success: false, error: { type: "INVALID_CURSOR" } };
    }
    const cursorDate = new Date(cursorInstant);
    cursorCondition = sql`(${platformFeedback.createdAt}, ${platformFeedback.id}) > (${cursorDate}, ${rawId})`;
  }

  const rows = await db
    .select({
      feedbackId: platformFeedback.id,
      category: platformFeedback.category,
      message: platformFeedback.message,
      pagePath: platformFeedback.pagePath,
      userAgent: platformFeedback.userAgent,
      status: platformFeedback.status,
      createdAt: platformFeedback.createdAt,
      authorUserId: user.id,
      authorHandle: user.handle,
      authorName: user.name,
    })
    .from(platformFeedback)
    // LEFT, not inner: `user_id` is null once the author is anonymized, and an inner join
    // would silently drop their feedback out of the queue instead of showing it unattributed.
    .leftJoin(user, eq(user.id, platformFeedback.userId))
    .where(
      and(
        input.status === undefined ? sql`true` : eq(platformFeedback.status, input.status),
        cursorCondition,
      ),
    )
    .orderBy(asc(platformFeedback.createdAt), asc(platformFeedback.id))
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? `${String(lastRow.createdAt.getTime())}_${lastRow.feedbackId}`
      : null;

  return {
    success: true,
    value: {
      items: pageRows.map((row) => ({
        feedbackId: row.feedbackId,
        category: row.category,
        message: row.message,
        pagePath: row.pagePath,
        userAgent: row.userAgent,
        status: row.status,
        createdAt: row.createdAt,
        // Both halves checked, not just the id: the left join types every `user` column as
        // nullable, and the foreign key — not the type system — is what makes the two agree.
        author:
          row.authorUserId === null || row.authorName === null
            ? null
            : { userId: row.authorUserId, handle: row.authorHandle, name: row.authorName },
      })),
      nextCursor,
    },
  };
}
