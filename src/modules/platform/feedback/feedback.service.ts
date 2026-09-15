import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import { platformFeedback, user } from "#src/db/schema.js";
import {
  decodeInstantCursor,
  encodeInstantCursor,
  type InstantCursor,
} from "#src/lib/instant-cursor.js";
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
 * ## NOTHING HERE IS A VERDICT, AND THAT SURVIVED TRIAGE LANDING
 *
 * Reading the queue writes no audit entry and changes no row. Feedback is not a moderation
 * action taken about a person, so there is no decision for the chain to record.
 *
 * ⚠️ `decidePlatformFeedback` BELOW DOES CHANGE A ROW, AND STILL APPENDS NOTHING. It moves a
 * triage flag on the staff's own queue: no equity, no money, no consequence for the person who
 * wrote in beyond a word changing on their own page. The audit event-kind pgEnum has no
 * `platform_feedback_*` label precisely because there is no decision about anybody to record,
 * and that is why the route takes no `idempotency()` either — the report queues require a key
 * because a retry would append a second chain entry claiming two decisions were taken. Setting
 * a flag twice sets it once.
 *
 * ## TWO LISTS, TWO DIRECTIONS, AND THAT IS NOT AN INCONSISTENCY
 *
 * The staff queue is OLDEST first — the longest-waiting note is the most urgent one. The
 * submitter's own list is NEWEST first, because what they came to check is the thing they just
 * sent. Support's two lists disagree the same way and for the same reason.
 */

export type PlatformFeedbackError =
  | { readonly type: "INVALID_CURSOR" }
  | { readonly type: "PLATFORM_FEEDBACK_NOT_FOUND" }
  | { readonly type: "PLATFORM_CAPABILITY_REQUIRED"; readonly capability: "moderate_content" };

/**
 * What the person who wrote the note can read back.
 *
 * NO `userAgent` AND NO AUTHOR. The browser string was captured from a header the server read,
 * so handing it back tells somebody nothing about themselves that they did not already know,
 * and the author is whoever is asking. `status` IS here: it is the only thing on the row that
 * can change after they send it, and a list that hid it would be a list with no reason to exist.
 */
export interface OwnPlatformFeedbackItem {
  readonly feedbackId: string;
  readonly category: typeof platformFeedback.$inferSelect.category;
  readonly message: string;
  readonly pagePath: string;
  readonly status: typeof platformFeedback.$inferSelect.status;
  readonly createdAt: Date;
}

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

  /**
   * ⚠️ THIS WAS A HAND-ROLLED DECODER AND THE LIB IS STRICTER, WHICH IS THE WHOLE REASON FOR
   * THE SWAP. The old block ran the epoch prefix through `Number()`, which accepts far more
   * than digits: `1e5_abc` parsed as 100000, `0x10_abc` as 16 and `"  12_abc"` as 12, so three
   * malformed cursors each paged from a silently invented instant instead of answering 422.
   * `decodeInstantCursor` tests `/^\d+$/` BEFORE converting. Same wire format either way —
   * `<epochMillis>_<id>`, split on the FIRST separator with the id as the unbounded tail, so an
   * id containing an underscore still pages correctly rather than from a truncated one.
   */
  const decodedCursor: InstantCursor | null =
    input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  // Strictly newer, OR the same instant with a larger id — the two-term row comparison that
  // keeps a page boundary from duplicating or skipping a row. Ascending here; the submitter's
  // own list below is the mirror of it.
  const cursorCondition =
    decodedCursor === null
      ? sql`true`
      : (or(
          gt(platformFeedback.createdAt, decodedCursor.instant),
          and(
            eq(platformFeedback.createdAt, decodedCursor.instant),
            gt(platformFeedback.id, decodedCursor.id),
          ),
        ) ?? sql`true`);

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
      ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.feedbackId })
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

/**
 * The submitter's own notes, newest first.
 *
 * SCOPED IN THE WHERE CLAUSE to `authorUserId`, which comes from the session. There is no
 * `?userId=` and there must never be one — the rule `listOwnSupportCases` states, and the
 * reason this read needs no capability check: the only rows it can reach are the caller's.
 *
 * ⚠️ AN ANONYMIZED AUTHOR CANNOT REACH THEIR OLD NOTES, AND THAT IS CORRECT RATHER THAN A GAP.
 * The manifest nulls `user_id` and keeps the note, so an erased account matches nothing here.
 * A `userId IS NULL` arm would hand every erased row to whoever asked next.
 */
export async function listOwnPlatformFeedback(
  authorUserId: string,
  input: {
    readonly status?: typeof platformFeedback.$inferSelect.status | undefined;
    readonly limit: number;
    readonly cursor?: string | undefined;
  },
): Promise<
  Result<
    { readonly items: readonly OwnPlatformFeedbackItem[]; readonly nextCursor: string | null },
    PlatformFeedbackError
  >
> {
  const decodedCursor: InstantCursor | null =
    input.cursor === undefined ? null : decodeInstantCursor(input.cursor);
  if (input.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "INVALID_CURSOR" } };
  }

  const conditions = [eq(platformFeedback.userId, authorUserId)];
  if (input.status !== undefined) conditions.push(eq(platformFeedback.status, input.status));
  if (decodedCursor !== null) {
    // Strictly older, OR the same instant with a smaller id — the mirror of the staff queue's
    // comparison above, because this list runs newest first.
    conditions.push(
      or(
        lt(platformFeedback.createdAt, decodedCursor.instant),
        and(
          eq(platformFeedback.createdAt, decodedCursor.instant),
          lt(platformFeedback.id, decodedCursor.id),
        ),
      ) ?? sql`true`,
    );
  }

  const rows = await db
    .select({
      feedbackId: platformFeedback.id,
      category: platformFeedback.category,
      message: platformFeedback.message,
      pagePath: platformFeedback.pagePath,
      status: platformFeedback.status,
      createdAt: platformFeedback.createdAt,
    })
    .from(platformFeedback)
    .where(and(...conditions))
    .orderBy(desc(platformFeedback.createdAt), desc(platformFeedback.id))
    // One extra row, to answer "is there another page?" without a COUNT.
    .limit(input.limit + 1);

  const pageRows = rows.slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor =
    rows.length > input.limit && lastRow !== undefined
      ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.feedbackId })
      : null;

  return { success: true, value: { items: pageRows, nextCursor } };
}

/**
 * Moves a note's triage flag.
 *
 * ⚠️ IT IS A FLAG ON THE STAFF'S OWN QUEUE, NOT A VERDICT ABOUT THE PERSON. Nothing is
 * appended to the audit chain and nobody is notified — see the second heading at the top of
 * this file for why both absences are deliberate rather than unfinished.
 *
 * NO `.for("update")` AND NO TRANSACTION, unlike `decideSupportCase`. That write holds a row
 * lock because it reads a message count, appends a message and a chain entry, and updates the
 * row, and two staff racing would interleave those. This is a single `UPDATE … WHERE id`:
 * last writer wins, and both writers wrote the same kind of thing.
 *
 * THE UPDATE IS THE EXISTENCE CHECK. Reading the row first and then updating it would be two
 * round trips and a window between them; `.returning()` on zero matched rows is the 404.
 */
export async function decidePlatformFeedback(
  staffUserId: string,
  feedbackId: string,
  input: { readonly decision: "reviewed" | "closed" },
): Promise<Result<OwnPlatformFeedbackItem, PlatformFeedbackError>> {
  const capability = await requirePlatformCapability(staffUserId, "moderate_content");
  if (!capability.success) {
    return {
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_content" },
    };
  }

  const [updated] = await db
    .update(platformFeedback)
    .set({ status: input.decision })
    .where(eq(platformFeedback.id, feedbackId))
    .returning({
      feedbackId: platformFeedback.id,
      category: platformFeedback.category,
      message: platformFeedback.message,
      pagePath: platformFeedback.pagePath,
      status: platformFeedback.status,
      createdAt: platformFeedback.createdAt,
    });

  if (!updated) return { success: false, error: { type: "PLATFORM_FEEDBACK_NOT_FOUND" } };
  return { success: true, value: updated };
}
