import { and, count, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { db } from "#src/db/index.js";
import { notification, researchProject, user } from "#src/db/schema.js";
import {
  decodeInstantCursor,
  encodeInstantCursor,
  type InstantCursor,
} from "#src/lib/instant-cursor.js";
import { idempotencyKeyFor, JOB_NAMES, sendJob } from "#src/lib/jobs.js";
import type { Result } from "#src/types/index.js";

/**
 * Notifications (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 1).
 *
 * WHAT THIS IS FOR. §11j.2 built `GET /invites/mine` on the argument that an invite nobody
 * can find is an invite nobody can accept. An invite nobody is TOLD ABOUT is in the same
 * position one step earlier, and so is every other transition that concerns somebody other
 * than the actor — an accepted application, a proposed rate, a dispute that froze a
 * member's slices, and above all a finalized statement of what a person is owed.
 *
 * TWO RULES THIS MODULE ENFORCES, both of which outrank convenience:
 *
 *   1. **A notification is written in the SAME TRANSACTION as the fact it announces.** A
 *      fan-out that runs after the commit can announce a state that was rolled back, and a
 *      fan-out that runs before it can be lost. Every enqueue takes the caller's `tx`.
 *   2. **The row carries keys and ids, never prose.** `kind` plus a payload of ids and
 *      integers; the client renders the sentence (§1, §4d). This is the same decision
 *      §11h's `disclosureKeys` records, and it is what keeps three clients localizable.
 *
 * DELIVERY IS SOMEBODY ELSE'S JOB, literally: this module writes the row and queues
 * `deliver-notification`. Whether an email goes out, and what happens when the provider is
 * unconfigured or down, is decided in `src/jobs/deliver-notification.ts` — because a
 * fan-out that awaited an HTTP call would put a third-party outage inside the transaction
 * that finalizes a compensation statement.
 */

/** A `db` handle that may be a transaction — the idiom `project-audit.service.ts` sets. */
type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationKind = (typeof notification.$inferSelect)["kind"];

/**
 * Ids and integers only.
 *
 * `string | number | boolean | null` rather than `unknown`: a payload holding a nested
 * object is one a client has to walk, and a payload holding a pre-formatted amount is the
 * thing this design exists to prevent.
 */
export type NotificationPayload = Readonly<Record<string, string | number | boolean | null>>;

export interface NotificationInput {
  readonly recipientUserId: string;
  readonly kind: NotificationKind;
  readonly projectId?: string | null;
  /** NULL for a system actor — a nightly job, or the verification pipeline. */
  readonly actorUserId?: string | null;
  readonly payload?: NotificationPayload;
}

export interface NotificationView {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly projectId: string | null;
  readonly projectSlug: string | null;
  readonly projectName: string | null;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  /** Parsed from `payloadJson`. Ids and integers; the client composes the sentence. */
  readonly payload: NotificationPayload;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface NotificationPage {
  readonly notifications: readonly NotificationView[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

export type NotificationError =
  | { type: "CURSOR_MALFORMED" }
  | { type: "NOTIFICATION_NOT_FOUND"; notificationId: string };

const DEFAULT_PAGE_SIZE = 20;
const MAXIMUM_PAGE_SIZE = 50;

/**
 * Writes the rows and queues their delivery, inside the caller's transaction.
 *
 * SELF-NOTIFICATION IS DROPPED, not refused. A founder who proposes an agreement to
 * themselves, or a member who confirms their own payment, would otherwise be told about
 * something they just did — and making that an error would force every call site to
 * special-case a legitimate action. Filtering is the only behaviour that keeps both the
 * action and the inbox sensible.
 *
 * A FAILED ENQUEUE THROWS, rolling the caller's transaction back. That is the same
 * contract `submitDailyLog` uses for `analyze-daily-log`: a row that says a statement was
 * finalized, with nothing queued to tell anyone, is worse than a failed finalize the
 * founder can retry.
 */
export async function enqueueNotifications(
  tx: DatabaseExecutor,
  actorUserId: string | null,
  inputs: readonly NotificationInput[],
): Promise<readonly string[]> {
  const deliverable = inputs.filter((input) => input.recipientUserId !== actorUserId);
  if (deliverable.length === 0) return [];

  const inserted = await tx
    .insert(notification)
    .values(
      deliverable.map((input) => ({
        recipientUserId: input.recipientUserId,
        kind: input.kind,
        projectId: input.projectId ?? null,
        actorUserId: input.actorUserId === undefined ? actorUserId : input.actorUserId,
        payloadJson: JSON.stringify(input.payload ?? {}),
      })),
    )
    .returning({ id: notification.id });

  for (const row of inserted) {
    const enqueued = await sendJob(
      JOB_NAMES.deliverNotification,
      { notificationId: row.id },
      {
        idempotencyKey: idempotencyKeyFor.deliverNotification(row.id),
        db: fromDrizzle(tx, sql),
      },
    );

    if (!enqueued.success) {
      throw new Error(
        `enqueueNotifications: could not queue delivery for ${row.id}: ${enqueued.error.type}`,
      );
    }
  }

  return inserted.map((row) => row.id);
}

/**
 * `GET /notifications` — the caller's own inbox, keyset-paginated.
 *
 * ROOT-MOUNTED and caller-scoped in SQL, for the reason `/applications/mine` is: a person's
 * inbox holds no project slug, and the recipient filter is `req.user.id` rather than
 * anything a client can send. There is no `?userId=` and there must never be one (§0).
 */
export async function listNotifications(
  recipientUserId: string,
  options: { readonly cursor?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<Result<NotificationPage, NotificationError>> {
  const pageSize = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAXIMUM_PAGE_SIZE);

  const decodedCursor: InstantCursor | null =
    options.cursor === undefined ? null : decodeInstantCursor(options.cursor);
  if (options.cursor !== undefined && decodedCursor === null) {
    return { success: false, error: { type: "CURSOR_MALFORMED" } };
  }

  const conditions = [eq(notification.recipientUserId, recipientUserId)];
  if (decodedCursor !== null) {
    // The two-term row comparison: strictly older, OR the same instant with a smaller id.
    conditions.push(
      or(
        lt(notification.createdAt, decodedCursor.instant),
        and(
          eq(notification.createdAt, decodedCursor.instant),
          lt(notification.id, decodedCursor.id),
        ),
      ) ?? sql`true`,
    );
  }

  const [rows, unreadCount] = await Promise.all([
    db
      .select({
        id: notification.id,
        kind: notification.kind,
        projectId: notification.projectId,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        actorUserId: notification.actorUserId,
        actorName: user.name,
        payloadJson: notification.payloadJson,
        readAt: notification.readAt,
        createdAt: notification.createdAt,
      })
      .from(notification)
      // LEFT joins, both of them: a notification about no project has no project, and an
      // actor whose account was deleted is `set null` by design. An inner join would make
      // either case silently disappear from the inbox.
      .leftJoin(researchProject, eq(researchProject.id, notification.projectId))
      .leftJoin(user, eq(user.id, notification.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(notification.createdAt), desc(notification.id))
      // One extra row, to answer "is there another page?" without a COUNT.
      .limit(pageSize + 1),
    countUnread(recipientUserId),
  ]);

  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows.at(-1);
  const hasMore = rows.length > pageSize && lastRow !== undefined;

  return {
    success: true,
    value: {
      notifications: pageRows.map(toNotificationView),
      nextCursor: hasMore
        ? encodeInstantCursor({ instant: lastRow.createdAt, id: lastRow.id })
        : null,
      unreadCount,
    },
  };
}

/** `GET /notifications/unread-count` — the badge, on its own partial index. */
export async function countUnread(recipientUserId: string): Promise<number> {
  const [row] = await db
    .select({ unread: count() })
    .from(notification)
    .where(and(eq(notification.recipientUserId, recipientUserId), isNull(notification.readAt)));

  return row?.unread ?? 0;
}

/**
 * `POST /notifications/read` — marks everything up to and including one notification read.
 *
 * THROUGH an id rather than a list of ids, and the name is `throughNotificationId` because
 * that is what the workshop chat read state already calls the same idea. A client that has
 * scrolled to a row has seen everything above it; sending the ids individually makes the
 * request grow with the backlog and races with anything that arrived meanwhile.
 *
 * Scoped to the caller in the WHERE clause, so another person's id marks nothing and reads
 * as absent — never as forbidden.
 */
export async function markReadThrough(
  recipientUserId: string,
  throughNotificationId: string,
): Promise<Result<{ readonly markedCount: number }, NotificationError>> {
  const [boundary] = await db
    .select({ createdAt: notification.createdAt, id: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.id, throughNotificationId),
        eq(notification.recipientUserId, recipientUserId),
      ),
    )
    .limit(1);

  if (!boundary) {
    return {
      success: false,
      error: { type: "NOTIFICATION_NOT_FOUND", notificationId: throughNotificationId },
    };
  }

  const readAt = new Date();
  const marked = await db
    .update(notification)
    .set({ readAt })
    .where(
      and(
        eq(notification.recipientUserId, recipientUserId),
        isNull(notification.readAt),
        // The same ordering the feed uses, so "everything above this row" means the same
        // thing to the write as it did to the read the client was looking at.
        or(
          lt(notification.createdAt, boundary.createdAt),
          and(eq(notification.createdAt, boundary.createdAt), lt(notification.id, boundary.id)),
          eq(notification.id, boundary.id),
        ),
      ),
    )
    .returning({ id: notification.id });

  return { success: true, value: { markedCount: marked.length } };
}

function toNotificationView(row: {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly projectId: string | null;
  readonly projectSlug: string | null;
  readonly projectName: string | null;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly payloadJson: string;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    payload: parsePayload(row.payloadJson),
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/**
 * A payload that will not parse is a bug in whatever wrote it, and it must not take the
 * whole inbox down with it. The row still renders — `kind` alone is enough for a client to
 * say something happened — with an empty payload rather than a thrown 500.
 */
function parsePayload(payloadJson: string): NotificationPayload {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const payload: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        payload[key] = value;
      }
    }
    return payload;
  } catch {
    return {};
  }
}
