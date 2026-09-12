import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  accountDeletionRequest,
  anonymizationStepLog,
  handleReservation,
  showcaseLaunch,
  showcaseLaunchWriteUpImage,
  user,
  video,
  videoDocument,
} from "#src/db/schema.js";
import { deleteShowcaseImages, deleteUserAvatar } from "#src/lib/cloudinary.js";
import { PermanentJobError } from "#src/lib/jobs.js";
import { logger } from "#src/lib/logger.js";
import { readSqlStateCode } from "#src/lib/pg-errors.js";
import {
  ANONYMIZATION_MANIFEST,
  DELETE_ROW_KEYS,
  NULL_OUT_KEYS,
  parseUserReferenceKey,
  type UserReferenceKey,
} from "#src/modules/auth/privacy/anonymization-manifest.js";
import {
  ANONYMIZED_EMAIL_DOMAIN,
  REMOVED_AUTHOR_DISPLAY_NAME,
} from "#src/modules/auth/privacy/redaction.js";
import type { Result } from "#src/types/index.js";

/**
 * The erasure itself (Privacy Part 3 — GDPR Art. 17).
 *
 * ## ⚠️ THE SECOND DESTRUCTIVE SCHEDULED JOB IN THIS CODEBASE, AND THE FIRST IRREVERSIBLE ONE
 *
 * `prune-engagement-data` deletes rows a retention policy already declared expired, and
 * every counter it feeds survives. This deletes a named person's identity. There is no
 * re-derivation, no backfill and no second copy — so it is gated behind
 * `ACCOUNT_ANONYMIZATION_ENABLED`, which **defaults to false**. While false it runs the
 * full selection, logs the exact per-table counts it would touch, and writes nothing.
 *
 * ## WHY THIS ITERATES A MANIFEST INSTEAD OF NAMING TABLES
 *
 * Rule R2 classified all 163 foreign keys into `user` for a `DELETE FROM "user"` that
 * never happens — 73 are `restrict` and 54 tables carry BEFORE UPDATE OR DELETE triggers,
 * so the delete cannot succeed and account closure is an anonymization instead. The
 * consequence people miss: `ON DELETE cascade` and `ON DELETE set null` therefore FIRE
 * ZERO TIMES here. All 35 cascades and all 46 remaining set-nulls only happen because
 * this file issues the statement.
 *
 * So the step list is DERIVED from `anonymization-manifest.ts` and no table name is
 * written twice. That is what stops the manifest being right while the job is wrong, and
 * `pnpm db:verify-anonymization-coverage` is what stops the manifest going stale.
 *
 * ## WHY SEVERAL TRANSACTIONS AND NOT ONE
 *
 * One transaction across ~74 statements would hold locks on `video_view_session` and
 * `commerce_order` for the whole run, and would turn a single trigger rejection into a
 * total rollback that retries forever. Instead: one transaction per step, each idempotent,
 * each recorded in `anonymization_step_log`, whose `(request_id, step_name)` unique index
 * is what makes a retry SKIP what already landed rather than redo it.
 *
 * The cost is that a crash lands mid-way. That is why the `user` scrub is LAST — every
 * intermediate state is the same one: deactivated, request still `pending`, resumable.
 */

/**
 * `SET LOCAL` so one stuck lock cannot eat the job's `expireInSeconds` mid-transaction.
 *
 * INLINED AS A LITERAL, NOT BOUND. Postgres does not accept bind parameters in `SET` —
 * `SET LOCAL statement_timeout = $1` is a 42601 syntax error — so this goes through
 * `sql.raw`. Safe precisely because it is a constant in this file and can never be
 * anything else; if it ever becomes configurable it must be validated before it reaches
 * here, not merely passed differently.
 */
const STEP_STATEMENT_TIMEOUT_SQL = sql.raw("SET LOCAL statement_timeout = '30s'");

/**
 * Migration 0010's own append-only SQLSTATE, alongside Postgres's generic `RAISE`.
 *
 * BOTH, because the immutability triggers in this schema do not agree on which they use:
 * 0010's append-only guards raise `QT001` and the later ones raise `P0001`. Checking only
 * one would let half the trigger surface retry for hours against a rejection that can
 * never succeed.
 *
 * Deliberately NOT added as predicates to `src/lib/pg-errors.ts`: that file states, and is
 * right, that a constraint violation reaching the app is a bug to throw on rather than a
 * `Result` to branch on. Here it IS a domain outcome — it means the manifest is wrong —
 * so the check lives at the one call site that has that meaning.
 */
const TRIGGER_RAISE_SQLSTATES: readonly string[] = ["P0001", "QT001"];

export type AnonymizeAccountError =
  | { type: "REQUEST_NOT_FOUND" }
  | { type: "REQUEST_NOT_PENDING"; state: string }
  | { type: "REQUEST_NOT_DUE"; scheduledAnonymizationAt: Date }
  | { type: "STAFF_ACCOUNT_REQUIRES_MANUAL_REVIEW" };

export interface AnonymizeAccountOutcome {
  readonly requestId: string;
  readonly userId: string;
  /** False when `ACCOUNT_ANONYMIZATION_ENABLED` is off — counts only, nothing written. */
  readonly applied: boolean;
  readonly rowsByStep: Readonly<Record<string, number>>;
  readonly totalRowsAffected: number;
}

export interface StepPlan {
  readonly stepName: string;
  readonly tableName: string;
  readonly countSql: ReturnType<typeof sql>;
  readonly applySql: ReturnType<typeof sql>;
}

/**
 * One manifest entry, as a pair of statements.
 *
 * IDENTIFIERS COME FROM THE MANIFEST AND NOWHERE ELSE — never a request — and go through
 * `sql.identifier()`; the user id is bound as a value. This is the idiom
 * `prune-engagement-data.ts:181-213` established and the only executing precedent for
 * table-and-column iteration in this repo.
 */
function planManifestStep(key: UserReferenceKey, userId: string): StepPlan {
  const { tableName, columnName } = parseUserReferenceKey(key);
  const disposition = ANONYMIZATION_MANIFEST[key];
  const table = sql.identifier(tableName);
  const column = sql.identifier(columnName);

  return {
    stepName: key,
    tableName,
    countSql: sql`SELECT count(*)::int AS affected_count FROM ${table} WHERE ${column} = ${userId}`,
    applySql:
      disposition.kind === "delete_rows"
        ? sql`DELETE FROM ${table} WHERE ${column} = ${userId}`
        : sql`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ${userId}`,
  };
}

/**
 * Tombstones authored free text BEFORE the manifest severs its authorship.
 *
 * ORDER IS LOAD-BEARING. `video_comment.author_user_id` is a `null_out` in the manifest,
 * so once that step runs there is no way left to find this person's comments. Everything
 * that needs the author link must happen here, first.
 */
export function planFreeTextSteps(userId: string): readonly StepPlan[] {
  return [
    {
      /**
       * `video_comment` ALREADY HAS THE MECHANISM and a CHECK that enforces it —
       * `video_comment_body_ck` permits a body only while `is_deleted` is false, and
       * demands the empty string once it is true. So the text genuinely leaves the table
       * rather than being hidden by a rendering convention the next reader can forget.
       */
      stepName: "tombstone:video_comment",
      tableName: "video_comment",
      countSql: sql`SELECT count(*)::int AS affected_count FROM video_comment
                    WHERE author_user_id = ${userId} AND is_deleted = false`,
      applySql: sql`UPDATE video_comment
                    SET is_deleted = true, deleted_at = now(), body_text = ''
                    WHERE author_user_id = ${userId} AND is_deleted = false`,
    },
    {
      /**
       * `community_forum_reply` HAS NO TOMBSTONE, and cannot be given one from a job.
       * `body` is NOT NULL with `char_length BETWEEN 2 AND 10000`, so it cannot be
       * emptied; and its `hidden` state is paired by CHECK with a `hidden_by_user_id`
       * that a scheduled job does not have and must not invent.
       *
       * `'[removed]'` is therefore the honest maximum here. A proper `removed` state that
       * needs no moderator is a follow-up, and until it exists this asymmetry with
       * `video_comment` above is real rather than an oversight.
       */
      stepName: "tombstone:community_forum_reply",
      tableName: "community_forum_reply",
      countSql: sql`SELECT count(*)::int AS affected_count FROM community_forum_reply
                    WHERE author_user_id = ${userId} AND body <> '[removed]'`,
      applySql: sql`UPDATE community_forum_reply SET body = '[removed]'
                    WHERE author_user_id = ${userId} AND body <> '[removed]'`,
    },
    {
      /**
       * THE ORIGINAL POST, AND THE ONE THIS FILE ORIGINALLY MISSED.
       *
       * `community_forum_thread.author_user_id` is a `null_out` in the manifest like the
       * two above, so the same "find it before the link is severed" rule applies — but it
       * was not in this list, which meant a departing person's opening posts kept their
       * `title` and `body` forever. Threads are worse than replies for this: longer, more
       * self-identifying, and the title is duplicated into a UNIQUE, publicly-routable
       * `slug`, so leaving it would keep the text in a URL as well as in a column.
       *
       * THREE COLUMNS, THREE DIFFERENT CONSTRAINTS, and each literal below is chosen to
       * satisfy one:
       *   - `title` — CHECK `char_length BETWEEN 8 AND 200`. `'[removed]'` is 9.
       *   - `body`  — CHECK `char_length BETWEEN 20 AND 20000`, so `'[removed]'` is too
       *     short and a sentence is required.
       *   - `slug`  — UNIQUE globally, CHECK `^[a-z0-9]+(-[a-z0-9]+)*$`, 3..120 chars.
       *     Derived from the row's own uuid, which is already lowercase hex and hyphens:
       *     unique by construction, valid by construction, and it carries none of the
       *     title it replaces.
       */
      stepName: "tombstone:community_forum_thread",
      tableName: "community_forum_thread",
      countSql: sql`SELECT count(*)::int AS affected_count FROM community_forum_thread
                    WHERE author_user_id = ${userId} AND title <> '[removed]'`,
      applySql: sql`UPDATE community_forum_thread
                    SET title = '[removed]',
                        body = '[This post was removed at its author''s request.]',
                        slug = 'removed-' || id
                    WHERE author_user_id = ${userId} AND title <> '[removed]'`,
    },
    {
      /**
       * ⚠️ THE AUTO-PROVISIONED ORGANIZATION SHELL, WHICH *IS* THE PERSON.
       *
       * `mintBuyerWorkspace` (commerce-buyer-workspace.service.ts:85-96) writes `user.name`
       * into `legal_name`, `normalized_legal_name` AND `display_name` — because "a shell
       * borrows the account holder's name because that is the only true thing the server
       * knows about who is buying". Correct at mint time, and it means three NOT NULL columns
       * on a table with NO `user` foreign key hold a real name that no FK walk can find.
       *
       * IT IS NOT MERELY STORED. `community-forum.service.ts` joins
       * `commerce_organization.display_name` and renders it as `authorOrganizationName` on
       * `GET /store/forum/threads`, which is a public read. Leaving this would keep publishing
       * a departed person's name on somebody else's forum page.
       *
       * SCOPED TO `auto_provisioned`, AND THAT SCOPE IS THE WHOLE SAFETY ARGUMENT. A
       * `self_declared` row is a real company other people trade with, whose name is not this
       * person's to erase — `provisioning_origin` is exactly the column that distinguishes
       * them, and `scripts/smoke-privacy.ts` asserts a `self_declared` row comes out unchanged.
       *
       * A FIXED LITERAL IS SAFE HERE, which needed checking rather than assuming: there is no
       * unique index on `normalized_legal_name`, and the table's only other unique index is
       * `commerce_organization_auto_provisioned_owner_uidx` on the owner column, which this
       * does not touch. `commerce_organization_name_ck` caps all three at 200 characters.
       *
       * `lower()` rather than a second literal: `normalizeLegalName` is NFKC + trim + collapse
       * + lowercase, and for this constant all three of the first steps are no-ops.
       */
      stepName: "tombstone:commerce_organization",
      tableName: "commerce_organization",
      countSql: sql`SELECT count(*)::int AS affected_count FROM commerce_organization
                    WHERE created_by_user_id = ${userId}
                      AND provisioning_origin = 'auto_provisioned'
                      AND display_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
      applySql: sql`UPDATE commerce_organization
                    SET display_name = ${REMOVED_AUTHOR_DISPLAY_NAME},
                        legal_name = ${REMOVED_AUTHOR_DISPLAY_NAME},
                        normalized_legal_name = lower(${REMOVED_AUTHOR_DISPLAY_NAME}),
                        updated_at = now()
                    WHERE created_by_user_id = ${userId}
                      AND provisioning_origin = 'auto_provisioned'
                      AND display_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
    },
    {
      /**
       * THE SEARCH INDEX THE SHELL ABOVE FEEDS — three columns, and the one the pattern scan
       * would never have caught is `title`.
       *
       * `refreshOrganizationSearchDocument` (store-search.service.ts:1786-1806) sets
       * `title = row.displayName`, `organization_display_name = row.displayName`, and
       * `search_text = displayName + legalName + summary + category names`. All three are
       * inside the GENERATED `search_document` tsvector — `title` at weight A,
       * `organization_display_name` at B, `search_text` at C — behind
       * `store_search_document_fts_idx`, which is a NON-PARTIAL GIN index.
       *
       * ⚠️ BE PRECISE ABOUT THE EXPOSURE, BECAUSE THE FIRST VERSION OF THIS COMMENT WAS NOT.
       * Every `/store/search` query filters `is_eligible = true` (store-search.service.ts:286),
       * and an auto-provisioned shell is `pending` + `private`, so `is_eligible` is false and
       * the document is NOT returned today. What is true: the name sits in three columns and in
       * a GIN index, eligibility is a mutable flag rather than a guarantee, and the same name
       * on the parent row IS served publicly by the forum read named in the step above.
       *
       * `title` IS SCRUBBED ONLY ON THE ORGANIZATION DOCUMENT. On a product document the title
       * is the product's name and has nothing to do with the seller.
       *
       * `search_text` IS A TARGETED REPLACE, NOT AN OVERWRITE, because on a product document
       * it also carries the product and its categories, which are not this person's data and
       * must stay searchable. The `char_length >= 3` arm exists because `user.name` carries no
       * length CHECK: a one-character name would make `replace` shred every other term, so
       * below that threshold the column is overwritten wholesale instead.
       *
       * RUNS AFTER THE SHELL STEP so a later refresh rebuilds from an already-scrubbed parent
       * and converges on the same value. `store_search_document_preserve_discovery_score` is
       * the only trigger here and it restores `discovery_score_points` /
       * `discovery_score_computed_at` and nothing else — verified, because a trigger that
       * rejected the write would dead-letter the job instead of failing loudly.
       */
      stepName: "tombstone:store_search_document",
      tableName: "store_search_document",
      countSql: sql`SELECT count(*)::int AS affected_count FROM store_search_document
                    WHERE organization_id IN (
                            SELECT id FROM commerce_organization
                            WHERE created_by_user_id = ${userId}
                              AND provisioning_origin = 'auto_provisioned')
                      AND organization_display_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
      applySql: sql`UPDATE store_search_document AS document
                    SET organization_display_name = ${REMOVED_AUTHOR_DISPLAY_NAME},
                        title = CASE WHEN document.document_kind = 'organization'
                                     THEN ${REMOVED_AUTHOR_DISPLAY_NAME}
                                     ELSE document.title END,
                        search_text = CASE WHEN char_length(subject.name) >= 3
                                           THEN replace(document.search_text, subject.name,
                                                        ${REMOVED_AUTHOR_DISPLAY_NAME})
                                           ELSE ${REMOVED_AUTHOR_DISPLAY_NAME} END,
                        updated_at = now()
                    FROM "user" AS subject
                    WHERE subject.id = ${userId}
                      AND document.organization_id IN (
                            SELECT id FROM commerce_organization
                            WHERE created_by_user_id = ${userId}
                              AND provisioning_origin = 'auto_provisioned')
                      AND document.organization_display_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
    },
    {
      /**
       * A VIDEO INVITE ON SOMEBODY ELSE'S VIDEO, which is the case the FK cannot cover.
       *
       * `video_collaborator.user_id` is a `null_out` in the manifest, so after that step the
       * row reads as an un-accepted invite — one that still carries a live, unique-indexed
       * email address. The creator's own videos are gone by then (`video.creator_id` is
       * `delete_rows`); what survives is every invite somebody else sent this person.
       *
       * ⚠️ IT MATCHES ON THE ADDRESS AS WELL AS THE FK, and that second arm is not belt-and-
       * braces. An invite that was NEVER ACCEPTED has `user_id IS NULL` from the start, so no
       * FK walk in this codebase has ever been able to see it. `invited_email` is `citext`, so
       * both the comparison and the `NOT LIKE` guard below are case-insensitive.
       *
       * DERIVED FROM THE ROW ID, on `user.email`'s precedent, because `invited_email` is NOT
       * NULL under a unique `(video_id, invited_email)` index — a fixed literal would collide
       * the moment one person had two invites on the same video.
       */
      stepName: "tombstone:video_collaborator",
      tableName: "video_collaborator",
      countSql: sql`SELECT count(*)::int AS affected_count FROM video_collaborator
                    WHERE (user_id = ${userId}
                           OR invited_email = (SELECT email FROM "user" WHERE id = ${userId}))
                      AND invited_email NOT LIKE ${`%@${ANONYMIZED_EMAIL_DOMAIN}`}`,
      applySql: sql`UPDATE video_collaborator
                    SET invited_email = 'anonymized+' || id || ${`@${ANONYMIZED_EMAIL_DOMAIN}`}
                    WHERE (user_id = ${userId}
                           OR invited_email = (SELECT email FROM "user" WHERE id = ${userId}))
                      AND invited_email NOT LIKE ${`%@${ANONYMIZED_EMAIL_DOMAIN}`}`,
    },
    {
      /**
       * A CREDIT ON SOMEBODY ELSE'S VIDEO. `studio.ts:719` says `linked_user_id` is set null
       * "because deleting a user must never erase the credit itself" — which is right about
       * the credit and wrong about the name. `member_name` is NOT NULL free text, so the
       * credit stays and the name goes, which is the same trade the forum reads already make.
       */
      stepName: "tombstone:video_team_member",
      tableName: "video_team_member",
      countSql: sql`SELECT count(*)::int AS affected_count FROM video_team_member
                    WHERE linked_user_id = ${userId}
                      AND member_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
      applySql: sql`UPDATE video_team_member SET member_name = ${REMOVED_AUTHOR_DISPLAY_NAME}
                    WHERE linked_user_id = ${userId}
                      AND member_name <> ${REMOVED_AUTHOR_DISPLAY_NAME}`,
    },
    {
      /**
       * ⚠️ THE ONE WITH NO FOREIGN KEY AT ALL, AND THEREFORE THE ONE NOTHING COULD HAVE FOUND.
       *
       * A maker lists their team on a showcase launch by typing a `display_name` and a
       * `handle` by hand — `showcase_launch_team_member` references `showcase_launch` and
       * nothing else. So a launch this person AUTHORED takes its credits with it (cascade from
       * a `delete_rows` row), and a launch somebody ELSE authored keeps their name and handle
       * on a public page forever.
       *
       * MATCHED BY HANDLE, WHICH IS EXACT RATHER THAN FUZZY: handles are unique platform-wide,
       * `handle_normalized` is `lower(handle)` on both sides, and the `burn_handle` step parks
       * the matched string at `'infinity'` so nobody else can ever hold it. A NULL subquery
       * result — a person who never set a handle — matches nothing, which is the correct
       * outcome rather than a special case.
       *
       * THE REPLACEMENT SATISFIES BOTH CONSTRAINTS BY CONSTRUCTION.
       * `showcase_launch_team_member_text_ck` demands `char_length(handle) BETWEEN 1 AND 64`
       * and `handle ~ '^[A-Za-z0-9_.-]+$'`; `id` is a `randomUUID()`, so `'removed-' || id` is
       * 44 characters of hex and hyphens. It is also globally unique, which the
       * `(launch_id, handle_normalized)` unique index needs.
       */
      stepName: "tombstone:showcase_launch_team_member",
      tableName: "showcase_launch_team_member",
      countSql: sql`SELECT count(*)::int AS affected_count FROM showcase_launch_team_member
                    WHERE handle_normalized = (SELECT lower(handle) FROM "user" WHERE id = ${userId})
                      AND handle NOT LIKE 'removed-%'`,
      applySql: sql`UPDATE showcase_launch_team_member
                    SET display_name = ${REMOVED_AUTHOR_DISPLAY_NAME}, handle = 'removed-' || id
                    WHERE handle_normalized = (SELECT lower(handle) FROM "user" WHERE id = ${userId})
                      AND handle NOT LIKE 'removed-%'`,
    },
  ];
}

/**
 * Every step name this job can plan, for `db:verify-text-pii-coverage` to resolve
 * `TEXT_PII_REGISTER`'s `scrub` entries against.
 *
 * ⚠️ DERIVED, NOT LISTED. A hand-written second list would be a copy that can disagree with
 * the first — which is the exact failure `anonymization-manifest.ts` exists to prevent one
 * level up. `planFreeTextSteps` is called with a placeholder id purely to read its shape;
 * nothing is executed.
 *
 * The `purge_*`, `burn_handle` and `scrub_user` names are added by hand because they are not
 * `StepPlan`s: they are whole functions with their own transactions, and their names appear as
 * literals in the `anonymization_step_log` inserts at the end of each. The manifest keys are
 * spread in from the manifest itself, for the same no-second-copy reason.
 */
export const PLANNED_ANONYMIZATION_STEP_NAMES: readonly string[] = [
  ...planFreeTextSteps("step-name-probe").map((step) => step.stepName),
  "purge_video_document_objects",
  "purge_showcase_launch_images",
  "purge_data_exports",
  ...DELETE_ROW_KEYS,
  ...NULL_OUT_KEYS,
  "burn_handle",
  "scrub_user",
];

type CountRow = { readonly affected_count: number };

export async function anonymizeAccount(
  requestId: string,
): Promise<Result<AnonymizeAccountOutcome, AnonymizeAccountError>> {
  const isEnabled = config.ACCOUNT_ANONYMIZATION_ENABLED;

  // --- 1. The guard.
  const guarded = await db.transaction(async (tx) => {
    /**
     * `FOR UPDATE` HERE SETTLES ALMOST NOTHING, AND AN EARLIER VERSION OF THIS COMMENT
     * CLAIMED OTHERWISE. The lock is released when this transaction commits, a few
     * milliseconds from now — every one of the 74 steps below runs unlocked. So the
     * sign-in hook can still cancel this request mid-run.
     *
     * What actually protects the account is the `assertStillPending` check before each
     * step, plus the predicate on the final `user` UPDATE. This lock only makes the
     * ENTRY decision atomic: two concurrent deliveries of the same job cannot both read
     * `pending` and both start.
     */
    const [request] = await tx
      .select({
        id: accountDeletionRequest.id,
        userId: accountDeletionRequest.userId,
        state: accountDeletionRequest.state,
        scheduledAnonymizationAt: accountDeletionRequest.scheduledAnonymizationAt,
      })
      .from(accountDeletionRequest)
      .where(eq(accountDeletionRequest.id, requestId))
      .for("update");

    if (!request) return { success: false, error: { type: "REQUEST_NOT_FOUND" } } as const;

    if (request.state !== "pending") {
      // Redelivery after a completed run, or a sign-in that cancelled it. Neither is an
      // error worth retrying, and re-running a completed scrub must be impossible.
      return {
        success: false,
        error: { type: "REQUEST_NOT_PENDING", state: request.state },
      } as const;
    }

    if (request.scheduledAnonymizationAt > new Date()) {
      return {
        success: false,
        error: {
          type: "REQUEST_NOT_DUE",
          scheduledAnonymizationAt: request.scheduledAnonymizationAt,
        },
      } as const;
    }

    const [subject] = await tx
      .select({ platformRole: user.platformRole, handle: user.handle, email: user.email })
      .from(user)
      .where(eq(user.id, request.userId))
      .limit(1);

    if (!subject) return { success: false, error: { type: "REQUEST_NOT_FOUND" } } as const;

    if (subject.platformRole !== null) {
      /**
       * The route already refuses staff, so reaching here means a platform role was
       * GRANTED during the grace window. Scrubbing anyway would silently drop it, and
       * with it the only named actor on every moderation action and audit entry that
       * person signed — rows which are `restrict` and therefore outlive the name.
       */
      return { success: false, error: { type: "STAFF_ACCOUNT_REQUIRES_MANUAL_REVIEW" } } as const;
    }

    return {
      success: true,
      value: { userId: request.userId, handle: subject.handle, email: subject.email },
    } as const;
  });

  if (!guarded.success) return guarded;

  const { userId, handle: originalHandle, email: originalEmail } = guarded.value;

  // --- 2. The step list. Free text first, then the manifest.
  const steps: readonly StepPlan[] = [
    ...planFreeTextSteps(userId),
    ...[...DELETE_ROW_KEYS, ...NULL_OUT_KEYS].map((key) => planManifestStep(key, userId)),
  ];

  const completedSteps = await readCompletedSteps(requestId);

  /**
   * THE DRY RUN REPORTS ONCE, THEN LEAVES THE ACCOUNT ALONE.
   *
   * With the flag off nothing is written, so the request stays `pending` and keeps matching
   * `account_deletion_request_due_idx` — which meant the sweep re-enqueued it EVERY NIGHT
   * FOREVER, re-running ~76 `count(*)` scans against `video_view_session` and
   * `commerce_order` per due account, with the set only ever growing. A year of dry-run
   * operation would mean every account that ever asked to be deleted re-scanned nightly.
   *
   * The step log is the marker: a dry run records one row saying it reported, and every
   * later dry run for the same request sees it and returns immediately. Turning the flag on
   * ignores this entirely — `isEnabled` runs the real steps, which have their own log rows.
   */
  const DRY_RUN_MARKER = "dry_run_reported";
  if (!isEnabled && completedSteps.has(DRY_RUN_MARKER)) {
    logger.info("account anonymization DRY RUN already reported; skipping", { requestId, userId });
    return {
      success: true,
      value: { requestId, userId, applied: false, rowsByStep: {}, totalRowsAffected: 0 },
    };
  }

  const rowsByStep: Record<string, number> = {};

  /**
   * --- 1.5. The video documents' BYTES, before the loop below deletes the rows that name them.
   *
   * ⚠️ POSITION IS THE WHOLE POINT, AND IT IS NOT NEGOTIABLE. `video_document` cascades from
   * `video`, which cascades from `user`, so the manifest loop below deletes every one of this
   * creator's documents as a side effect of deleting their videos. SQL cannot reach object
   * storage, so after that loop there is no row left naming the object keys and no way to find
   * them again — the decks and whitepapers would sit in the bucket forever while every row in
   * the database read as correctly anonymized.
   *
   * That is the exact failure mode step 4's comment describes for the export archives, which is
   * why this is shaped like step 4 rather than like the post-commit avatar delete: a logged,
   * resumable step, guarded by `assertStillPending`, run while the request is still `pending`.
   *
   * ⚠️ AND IT IS WHY `video_document` HAS NO MANIFEST ENTRY. The manifest is keyed on foreign-key
   * columns into `user`, and this table has none — it reaches a person only through
   * `video.creator_id`. An entry would fail the verifier's check 2 as stale. The obligation is
   * real and the manifest is simply not where it can live.
   */
  if (!completedSteps.has("purge_video_document_objects")) {
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    rowsByStep["purge_video_document_objects"] = await purgeVideoDocumentObjects(
      requestId,
      userId,
      isEnabled,
    );
  }

  /**
   * --- 1.6. Showcase launch images, before the loop below deletes the rows that name them.
   *
   * THE SAME POSITION ARGUMENT AS 1.5. `showcase_launch` and `showcase_launch_write_up_image` are
   * `delete_rows` in the manifest, so after the loop no row is left carrying these public ids and
   * the heading images and write-up screenshots would sit on Cloudinary forever.
   *
   * NOT THE `deleteUserAvatar` SHAPE, although that is also a Cloudinary delete: an avatar's
   * public id is derived from the user id, so it can be found after the rows are gone. These
   * cannot.
   *
   * A CDN FAILURE DOES NOT STOP THE ERASURE. The step logs the failure and records itself done;
   * once the rows are deleted the assets have no row naming them, and the daily
   * `sweep-orphan-showcase-images` job deletes them. An erasure stuck behind an image host would
   * be the worse outcome for the person asking for it.
   */
  if (!completedSteps.has("purge_showcase_launch_images")) {
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    rowsByStep["purge_showcase_launch_images"] = await purgeShowcaseLaunchImages(
      requestId,
      userId,
      isEnabled,
    );
  }

  for (const step of steps) {
    if (completedSteps.has(step.stepName)) continue;

    /**
     * ⚠️ THE CHECK THAT STOPS A CANCELLED DELETION FROM ERASING ANYWAY.
     *
     * The guard's row lock is long gone (see its comment), so between any two steps the
     * subject may have signed in and had this request moved to `cancelled`. Without this
     * read, the loop would keep deleting — and the account would end up half-erased,
     * marked `cancelled`, with the retry logging "anonymization skipped". The system
     * would report success over destroyed data.
     *
     * One indexed primary-key read per step. That is the correct price for an operation
     * with no undo, and it is the only thing standing between a mid-run sign-in and
     * irreversible loss.
     */
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    const affected = await runStep(requestId, step, isEnabled);
    // NON-ZERO ONLY. Most of the 74 steps touch nothing for most accounts, and a summary
    // listing them all buries the handful that mattered. `anonymization_step_log` keeps
    // the complete record, zeros included — this is the line a human reads.
    if (affected > 0) rowsByStep[step.stepName] = affected;
  }

  // --- 3. Burn the handle, and only now — the manifest's `handle_reservations.user_id`
  //        delete above has just cleared this user's own reservations, so a tombstone
  //        written earlier would have been deleted by it.
  if (originalHandle !== null && !completedSteps.has("burn_handle")) {
    rowsByStep["burn_handle"] = await burnHandle(requestId, userId, originalHandle, isEnabled);
  }

  /**
   * --- 4. The archives, BEFORE the point of no return.
   *
   * THIS USED TO RUN AFTER `scrubUserAndComplete`, WHICH MADE IT SKIPPABLE. Once the
   * request reads `completed`, every retry aborts at the guard — so a worker that crashed
   * or a pod that rotated between the scrub and this call meant the purge NEVER ran, and a
   * complete PII dump (name, email, IP addresses, user agents, watch history, comment
   * bodies) sat in the bucket forever while every row in the database read as correctly
   * anonymized. Precisely the failure this step exists to prevent.
   *
   * Now it is a logged, resumable step like the other 75, positioned so that "the request
   * is still pending" and "the archives are gone" cannot disagree.
   */
  if (!completedSteps.has("purge_data_exports")) {
    const stillPending = await assertStillPending(requestId);
    if (!stillPending.success) return stillPending;

    rowsByStep["purge_data_exports"] = await purgeExportArchives(requestId, userId, isEnabled);
  }

  // --- 5. The identity itself, last.
  if (isEnabled) {
    await scrubUserAndComplete(requestId, userId);
  }

  const totalRowsAffected = Object.values(rowsByStep).reduce((sum, count) => sum + count, 0);

  // The marker that stops tomorrow's sweep re-scanning this account. Written only in dry
  // run; a real run leaves `state = 'completed'`, which the guard refuses on its own.
  if (!isEnabled) {
    await db.insert(anonymizationStepLog).values({
      requestId,
      stepName: DRY_RUN_MARKER,
      tableName: "(dry run)",
      rowsAffected: totalRowsAffected,
    });
  }

  logger.info(isEnabled ? "account anonymized" : "account anonymization DRY RUN", {
    requestId,
    userId,
    applied: isEnabled,
    totalRowsAffected,
    steps: JSON.stringify(rowsByStep),
  });

  if (isEnabled) {
    // Post-commit and best effort. A CDN or mailer outage must not unwind an erasure that
    // has already happened — a half-rolled-back scrub is strictly worse than an orphaned
    // avatar. Each is logged so an operator can finish it by hand.
    await sendCompletionEmail(originalEmail).catch((emailError: unknown) => {
      logger.error("failed to send the anonymization-complete email", {
        requestId,
        cause: describeCause(emailError),
      });
    });

    const avatarDeleted = await deleteUserAvatar(userId);
    if (!avatarDeleted.success) {
      logger.error("failed to delete the avatar of an anonymized account", {
        userId,
        cause: avatarDeleted.error.type,
      });
    }

    // THE ARCHIVE PURGE IS NOT HERE ANY MORE. It used to be, after the request was already
    // `completed` — which meant a crash at the wrong moment skipped it forever and left a
    // full PII dump in the bucket. It is now step 4 above: logged, resumable, and executed
    // while the request is still `pending`.
  }

  return {
    success: true,
    value: { requestId, userId, applied: isEnabled, rowsByStep, totalRowsAffected },
  };
}

/**
 * Deletes every subject-access archive this person ever had built, and records it.
 *
 * WHY THIS IS A STEP AND NOT A POST-COMMIT COURTESY. An archive is a complete copy of
 * everything the other 75 steps just erased. If it survives, the erasure did not happen —
 * it merely stopped being visible through the database. So it gets the same treatment as
 * every destructive step: a `pending` precondition, a step-log row, and resumability.
 *
 * The import stays lazy so a dry-run worker never constructs an S3 client it will not use.
 */
/**
 * Deletes every stored video-document object this creator owns, and reports how many.
 *
 * DRY RUN COUNTS RATHER THAN DELETES, exactly like `purgeExportArchives`: with the flag off the
 * operator must be able to see what an erasure WOULD remove without removing it.
 *
 * The import is deferred for the same reason step 4's is — `videos.service.ts` pulls in the studio
 * dependency graph, and the privacy module must not carry it at load time.
 */
async function purgeVideoDocumentObjects(
  requestId: string,
  userId: string,
  isEnabled: boolean,
): Promise<number> {
  const [countRow] = await db
    .select({ documentCount: sql<number>`count(*)::int` })
    .from(videoDocument)
    .innerJoin(video, eq(video.id, videoDocument.videoId))
    .where(eq(video.creatorId, userId));
  const documentCount = countRow?.documentCount ?? 0;

  if (!isEnabled) return documentCount;

  const { deleteStoredVideoDocumentsForCreator } =
    await import("#src/modules/studio/videos/videos.service.js");
  await deleteStoredVideoDocumentsForCreator(userId);

  await db.insert(anonymizationStepLog).values({
    requestId,
    stepName: "purge_video_document_objects",
    tableName: "video_document",
    rowsAffected: documentCount,
  });

  if (documentCount > 0) {
    logger.info("purged video document objects during anonymization", { userId, documentCount });
  }

  return documentCount;
}

/**
 * Deletes every showcase launch heading image and write-up image this person uploaded, and
 * reports how many. DRY RUN COUNTS RATHER THAN DELETES, like the step above.
 */
async function purgeShowcaseLaunchImages(
  requestId: string,
  userId: string,
  isEnabled: boolean,
): Promise<number> {
  const [headingImageRows, writeUpImageRows] = await Promise.all([
    db
      .select({ publicId: showcaseLaunch.headingImagePublicId })
      .from(showcaseLaunch)
      .where(eq(showcaseLaunch.authorUserId, userId)),
    db
      .select({ publicId: showcaseLaunchWriteUpImage.publicId })
      .from(showcaseLaunchWriteUpImage)
      .where(eq(showcaseLaunchWriteUpImage.uploadedByUserId, userId)),
  ]);
  const imagePublicIds = [...headingImageRows, ...writeUpImageRows].map(
    (imageRow) => imageRow.publicId,
  );

  if (!isEnabled) return imagePublicIds.length;

  const deleteResult = await deleteShowcaseImages(imagePublicIds);
  if (!deleteResult.success) {
    logger.error(
      "showcase launch images not deleted during anonymization; the orphan sweep removes them",
      { userId, imageCount: imagePublicIds.length, errorType: deleteResult.error.type },
    );
  }

  await db.insert(anonymizationStepLog).values({
    requestId,
    stepName: "purge_showcase_launch_images",
    tableName: "showcase_launch",
    rowsAffected: imagePublicIds.length,
  });

  return imagePublicIds.length;
}

async function purgeExportArchives(
  requestId: string,
  userId: string,
  isEnabled: boolean,
): Promise<number> {
  const { purgeDataExportsForUser, countDataExportsForUser } =
    await import("#src/modules/auth/privacy/data-export.service.js");

  if (!isEnabled) return countDataExportsForUser(userId);

  const purgedArchiveCount = await purgeDataExportsForUser(userId);

  await db.insert(anonymizationStepLog).values({
    requestId,
    stepName: "purge_data_exports",
    tableName: "data_export_request",
    rowsAffected: purgedArchiveCount,
  });

  if (purgedArchiveCount > 0) {
    logger.info("purged data export archives during anonymization", {
      userId,
      purgedArchiveCount,
    });
  }

  return purgedArchiveCount;
}

/**
 * Is this request still ours to act on?
 *
 * Called before EVERY step, because the guard's `FOR UPDATE` lock does not outlive the
 * guard's own transaction and the sign-in hook can cancel a request at any moment. The
 * returned error is the same shape the guard produces, so the caller's abort path is one
 * branch rather than two.
 */
async function assertStillPending(requestId: string): Promise<Result<true, AnonymizeAccountError>> {
  const [request] = await db
    .select({ state: accountDeletionRequest.state })
    .from(accountDeletionRequest)
    .where(eq(accountDeletionRequest.id, requestId))
    .limit(1);

  if (!request) return { success: false, error: { type: "REQUEST_NOT_FOUND" } };
  if (request.state !== "pending") {
    return { success: false, error: { type: "REQUEST_NOT_PENDING", state: request.state } };
  }
  return { success: true, value: true };
}

/** Which steps a previous attempt already committed. Empty on a first run. */
async function readCompletedSteps(requestId: string): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ stepName: anonymizationStepLog.stepName })
    .from(anonymizationStepLog)
    .where(eq(anonymizationStepLog.requestId, requestId));
  return new Set(rows.map((row) => row.stepName));
}

/**
 * One step, one transaction: count, act, record.
 *
 * COUNTED BEFORE IT ACTS so the number is legible even in a dry run — and so the log says
 * what was there rather than what the driver reported afterwards. `0` is a real answer and
 * is recorded as one; most of the 74 steps touch nothing for most accounts.
 */
async function runStep(requestId: string, step: StepPlan, isEnabled: boolean): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(STEP_STATEMENT_TIMEOUT_SQL);

      const [counted] = (await tx.execute<CountRow>(step.countSql)).rows;
      const affectedCount = counted?.affected_count ?? 0;

      if (!isEnabled) return affectedCount;

      if (affectedCount > 0) await tx.execute(step.applySql);

      await tx.insert(anonymizationStepLog).values({
        requestId,
        stepName: step.stepName,
        tableName: step.tableName,
        rowsAffected: affectedCount,
      });

      return affectedCount;
    });
  } catch (error: unknown) {
    const sqlState = readSqlStateCode(error);

    if (sqlState !== undefined && TRIGGER_RAISE_SQLSTATES.includes(sqlState)) {
      /**
       * AN IMMUTABILITY TRIGGER REFUSED THE WRITE, AND NO RETRY CAN CHANGE THAT.
       *
       * `PermanentJobError` makes `runJob` write a `job_failure` row naming this step.
       *
       * IT DOES NOT SKIP THE RETRIES — an earlier version of this comment claimed it did.
       * `runJob` records the failure and then rethrows UNCONDITIONALLY, so pg-boss applies
       * the queue's full ladder regardless. What stops the ladder here is the handler:
       * `anonymize-account.job.ts` catches this error, marks the request `failed`, and
       * returns without throwing, so the doomed step is attempted exactly once.
       *
       * THE FIX IS ALWAYS A MANIFEST CHANGE — this entry becomes `retain` with a lawful
       * basis — and NEVER a trigger change. The triggers are what make the ledgers and
       * the hash chains worth anything.
       */
      throw new PermanentJobError(
        "ANONYMIZATION_STEP_REFUSED_BY_TRIGGER",
        `anonymize-account: ${step.stepName} raised ${sqlState}; the manifest entry must ` +
          `become "retain" with a lawful basis. Original: ${describeCause(error)}`,
      );
    }

    throw error;
  }
}

/**
 * Parks the released handle forever, rather than freeing it.
 *
 * `expires_at = 'infinity'` because `handle.service.ts` reads availability as
 * `expires_at > now()`, so an infinite reservation reads as permanently taken through the
 * existing code path — no new branch, no new column.
 *
 * WHY BURN RATHER THAN RELEASE. Every historical `@handle` mention in every comment, post
 * and thread still says that string. Handing it to the next claimant gives a stranger the
 * accumulated identity of somebody who left, which is the opposite of what erasing them
 * was for.
 */
async function burnHandle(
  requestId: string,
  userId: string,
  originalHandle: string,
  isEnabled: boolean,
): Promise<number> {
  if (!isEnabled) return 1;

  return db.transaction(async (tx) => {
    const reserved = await tx
      .insert(handleReservation)
      .values({
        reservedHandle: originalHandle,
        /**
         * STILL OWNED BY THE ANONYMIZED ROW, because `handle_reservations.user_id` is NOT
         * NULL. That is not a compromise: the row it points at is now "Deleted user" with
         * an unroutable address, so the reservation names nobody while remaining a valid
         * foreign key.
         *
         * `onConflictDoNothing` because a retry re-reaches this after the manifest's own
         * `handle_reservations.user_id` delete step has been skipped as already-done.
         */
        userId,
        expiresAt: sql`'infinity'::timestamp`,
      })
      .onConflictDoNothing()
      .returning({ reservedHandle: handleReservation.reservedHandle });

    /**
     * THE REAL COUNT, NOT A HARDCODED 1. `onConflictDoNothing` means this can legitimately
     * write nothing — and `anonymization_step_log` is the table the schema calls "THE ONLY
     * EVIDENCE", where "`rows_affected` of 0 is a real answer and is recorded as one".
     * This step was the single one lying to it.
     */
    const rowsAffected = reserved.length;

    await tx.insert(anonymizationStepLog).values({
      requestId,
      stepName: "burn_handle",
      tableName: "handle_reservations",
      rowsAffected,
    });

    return rowsAffected;
  });
}

/**
 * Every column the identity scrub overwrites, as one object.
 *
 * ⚠️ EXPORTED SO THERE IS ONE COPY. `db:verify-text-pii-coverage` applies these exact values
 * to a probe row inside a rolled-back transaction and then asks Postgres whether the probe's
 * name, handle or address survived anywhere. A verifier holding its own list of columns would
 * pass while this function quietly stopped nulling one of them, which is the whole failure
 * `TEXT_PII_REGISTER` exists to make impossible.
 */
export function buildAnonymizedUserColumns(userId: string) {
  return {
    name: "Deleted user",
    /**
     * `email` is citext NOT NULL UNIQUE, so it needs a VALUE rather than a NULL.
     * Derived from the id, which is already opaque, so uniqueness is free; `.invalid`
     * is RFC 2606's reserved TLD, so a misconfigured mailer fails to resolve it
     * rather than delivering somebody's erasure notice to a real stranger.
     *
     * The real address is released by this, which is correct: the person may sign up
     * again, and they inherit nothing when they do.
     */
    email: sql`'anonymized+' || ${userId} || '@deleted.qatoto.invalid'`,
    emailVerified: false,
    nameSetByUser: false,
    image: null,
    imageSource: null,
    handle: null,
    handleUpdatedAt: null,
    handleChangeCount: 0,
    handleWindowStartedAt: null,
    locationLabel: null,
    /**
     * ⚠️ INVISIBLE TO THE FK MANIFEST, AND THE COLUMN THAT PROMPTED A SECOND REGISTER.
     * `anonymization-manifest.ts` is keyed on FOREIGN KEYS into `user`, and `bio` is a
     * scalar — so `db:verify-anonymization-coverage` cannot see it and stays green if this
     * line is deleted. It is public free text the person wrote about themselves.
     *
     * IT NOW HAS A GUARD: `TEXT_PII_REGISTER` classifies it `scrub` with
     * `stepName: "scrub_user"`, and `db:verify-text-pii-coverage` applies this very object
     * to a probe row and asks Postgres whether the probe's text survived. Deleting this line
     * turns that script red. `scripts/smoke-privacy.ts` still asserts it end to end.
     */
    bio: null,
    /**
     * ⚠️ THE SAME BLIND SPOT AS `bio` DIRECTLY ABOVE, and covered the same new way: a scalar
     * column cannot appear in a foreign-key-keyed manifest, so
     * `db:verify-anonymization-coverage` stays green whether or not this line exists, and
     * `TEXT_PII_REGISTER` is what now names it.
     *
     * IT IS NOT COSMETIC. `GET /channels` reads this flag to build the public sitemap, so
     * leaving it `true` would keep advertising a handle to search engines for a person who
     * asked to be erased — an erasure that ends with the subject still being indexed. The
     * handle itself is nulled two lines up, which makes the row unreachable, but consent to be
     * listed is its own fact and it dies with the account.
     */
    isChannelListed: false,
    anonymizedAt: new Date(),
  } as const;
}

/**
 * The identity, and the request's terminal state, in one transaction.
 *
 * LAST, ALWAYS. Every step before this is resumable because the account still reads as
 * "deactivated, request pending"; the moment `anonymized_at` is stamped that stops being
 * true. Doing it first would leave a crash halfway with an unrecognizable row and no way
 * to tell what had already been cleaned.
 */
async function scrubUserAndComplete(requestId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(STEP_STATEMENT_TIMEOUT_SQL);

    /**
     * RE-ASSERTED INSIDE THIS TRANSACTION, so the request row and the `user` row are
     * decided together rather than separately. Locked, because between this read and the
     * UPDATE below the sign-in hook could otherwise slip in and cancel.
     */
    const [stillPending] = await tx
      .select({ state: accountDeletionRequest.state })
      .from(accountDeletionRequest)
      .where(eq(accountDeletionRequest.id, requestId))
      .for("update");

    if (stillPending?.state !== "pending") {
      throw new Error(
        `anonymize-account: refusing to scrub ${userId} — request ${requestId} is ` +
          `${stillPending?.state ?? "missing"}, not pending. A sign-in cancelled it mid-run.`,
      );
    }

    const scrubbed = await tx
      .update(user)
      .set(buildAnonymizedUserColumns(userId))
      /**
       * THE PREDICATE IS THE LAST LINE OF DEFENCE, and its absence was the defect this
       * whole function was rewritten for.
       *
       * `user_lifecycle_ck` forbids `anonymized_at` on a row whose `deactivated_at` is
       * NULL. Without these two clauses, a sign-in that cleared `deactivated_at` mid-run
       * made this UPDATE raise 23514 — which aborted THIS transaction while leaving the
       * 74 destructive steps already committed. Half-erased account, request reading
       * `cancelled`, retry logging "skipped": data destroyed and success reported.
       *
       * Matching zero rows is now the signal, not an exception, and the check below turns
       * it into a loud failure before the request is marked `completed`.
       */
      .where(and(eq(user.id, userId), isNotNull(user.deactivatedAt), isNull(user.anonymizedAt)))
      .returning({ id: user.id });

    if (scrubbed.length === 0) {
      throw new Error(
        `anonymize-account: the scrub matched no row for ${userId} — it was reactivated or ` +
          `already anonymized. Refusing to mark ${requestId} completed.`,
      );
    }

    await tx
      .update(accountDeletionRequest)
      .set({ state: "completed", completedAt: new Date() })
      .where(
        and(eq(accountDeletionRequest.id, requestId), eq(accountDeletionRequest.state, "pending")),
      );

    await tx.insert(anonymizationStepLog).values({
      requestId,
      stepName: "scrub_user",
      tableName: "user",
      rowsAffected: 1,
    });
  });
}

/**
 * The last message this address will ever receive.
 *
 * SENT FROM AN ADDRESS CAPTURED BEFORE THE SCRUB, because after it there is none — the
 * column holds an `@deleted.qatoto.invalid` placeholder that resolves nowhere.
 */
async function sendCompletionEmail(originalEmail: string): Promise<void> {
  const { sendTransactionalEmail } = await import("#src/lib/email.js");

  await sendTransactionalEmail({
    toEmail: originalEmail,
    subject: "Your Qatoto account has been deleted",
    htmlContent:
      `<p>Your Qatoto account has been permanently deleted, as you asked.</p>` +
      `<p>Your name, email address, photo and handle have been erased and cannot be ` +
      `restored. Records we are required to keep — orders, payments, and the shared ` +
      `equity records of work done with other people — remain, with no name attached.</p>` +
      `<p>This address is now free. If you sign up again it will be a new account, ` +
      `carrying nothing from this one.</p>`,
    textContent:
      `Your Qatoto account has been permanently deleted, as you asked.\n\n` +
      `Your name, email address, photo and handle have been erased and cannot be ` +
      `restored. Records we are required to keep — orders, payments, and the shared ` +
      `equity records of work done with other people — remain, with no name attached.\n\n` +
      `This address is now free. If you sign up again it will be a new account, carrying ` +
      `nothing from this one.\n`,
  });
}

function describeCause(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
