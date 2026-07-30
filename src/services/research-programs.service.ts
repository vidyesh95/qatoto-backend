import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
// `research_program_branch` and `research_program_participant` are referenced only inside
// the raw-SQL count subqueries below, by name.
import {
  researchProgram,
  researchProgramPaper,
  researchProgramPost,
  researchProgramStatSnapshot,
} from "#src/db/schema.js";
import { isUniqueViolation } from "#src/lib/pg-errors.js";
import { escapeLikePattern } from "#src/lib/sql-pattern.js";
import type {
  ProgramAccessError,
  ResearchProgramStatus,
} from "#src/services/research-program-access.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Research programs — the §10 top-level entity (R_AND_D_BACKEND_STRUCTURE.md §10, §11f).
 *
 * A PROGRAM IS NOT A PROJECT. §10 recommends a distinct entity rather than a flag on
 * `research_project`, and the schema section header states why at length. This service is
 * the entity's own lifecycle: propose, review, read, edit.
 *
 * THE REVIEW GATE IS THE WHOLE DESIGN OF `create`. Anyone with a full account may propose
 * a program, and it lands `pending` — absent from the public index, closed to
 * contributions (`requireProgramWritable`), visible only to its creator and to staff. A
 * client-creatable public surface with thousands of open contributors is a spam vector,
 * and this is the same posture `research_category` takes for the same reason. `status` is
 * absent from every request schema, so `.strict()` turns an attempt to self-publish into
 * a 422 rather than letting one extra key bypass the gate.
 */

export type ResearchProgramError =
  | ProgramAccessError
  | { type: "PROGRAM_TITLE_UNUSABLE" }
  | { type: "PROGRAM_ALREADY_DECIDED"; status: ResearchProgramStatus };

/**
 * One program as read back to a client.
 *
 * `contributorCount` and friends are DERIVED on read here rather than taken from the
 * stat snapshot, because the index must show something for a program the nightly job has
 * never seen. The snapshot is for the hero tiles, which carry an `asOf` and may therefore
 * be honest about being stale; a list row cannot.
 */
export interface ResearchProgramSummaryView {
  readonly programId: string;
  readonly slug: string;
  readonly title: string;
  readonly tagline: string;
  readonly status: ResearchProgramStatus;
  readonly branchCount: number;
  readonly participantCount: number;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
}

export interface ResearchProgramDetailView extends ResearchProgramSummaryView {
  readonly missionStatement: string;
  readonly createdByUserId: string | null;
  /** Set only for the creator and for staff — a public reader has no business reading it. */
  readonly reviewerNote: string | null;
  readonly reviewedAt: Date | null;
  /** Whether THIS caller created it. A property of the viewer, never a column. */
  readonly isViewerCreator: boolean;
}

const PROGRAM_SUMMARY_COLUMNS = {
  programId: researchProgram.id,
  slug: researchProgram.slug,
  title: researchProgram.title,
  tagline: researchProgram.tagline,
  status: researchProgram.status,
  publishedAt: researchProgram.publishedAt,
  createdAt: researchProgram.createdAt,
} as const;

/**
 * Counting subqueries, so a list of N programs is ONE query rather than N+1.
 *
 * A correlated scalar subquery per row is the right shape here: both counts hit an index
 * whose leading column is `program_id`, and the alternative — a `LEFT JOIN … GROUP BY` on
 * two tables at once — multiplies rows before it aggregates them and quietly reports
 * `branchCount * participantCount`.
 */
const BRANCH_COUNT_SUBQUERY = sql<number>`(
  SELECT COUNT(*)::int FROM research_program_branch AS program_branch_count
  WHERE program_branch_count.program_id = research_program.id
)`;

const PARTICIPANT_COUNT_SUBQUERY = sql<number>`(
  SELECT COUNT(*)::int FROM research_program_participant AS program_participant_count
  WHERE program_participant_count.program_id = research_program.id
)`;

/**
 * Server-derives a slug from a title.
 *
 * AUTO-SUFFIXES ON COLLISION (`-2`, `-3`), matching `research_project.slug` and
 * deliberately UNLIKE `research_category.slug`, which 409s. Two programs may legitimately
 * be named similarly; two taxonomy nodes may not. Exported for the seed script, which
 * needs to predict the slug it is about to insert.
 */
export function slugifyProgramTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
}

/**
 * Proposes a program. Lands `pending`.
 *
 * The slug race is resolved by LETTING THE INSERT TRY and translating 23505, never by
 * check-then-insert — that is a TOCTOU race, and `isUniqueViolation` exists precisely so
 * uniqueness is decided by the database. Bounded retries because each attempt narrows the
 * space: `-2` taken means try `-3`.
 */
export async function createResearchProgram(input: {
  readonly title: string;
  readonly tagline: string;
  readonly missionStatement: string;
  readonly createdByUserId: string;
}): Promise<Result<ResearchProgramDetailView, ResearchProgramError>> {
  const baseSlug = slugifyProgramTitle(input.title);
  if (baseSlug.length < 3) {
    // A title of pure punctuation or emoji cannot produce a usable public URL.
    return { success: false, error: { type: "PROGRAM_TITLE_UNUSABLE" } };
  }

  const MAX_SLUG_ATTEMPTS = 12;
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidateSlug = attempt === 1 ? baseSlug : `${baseSlug}-${String(attempt)}`;
    try {
      const [created] = await db
        .insert(researchProgram)
        .values({
          slug: candidateSlug,
          title: input.title,
          tagline: input.tagline,
          missionStatement: input.missionStatement,
          // Explicit rather than relying on the column default, so reading this call
          // answers "what state does a new program start in" without opening schema.ts.
          status: "pending",
          createdByUserId: input.createdByUserId,
        })
        .returning();

      if (!created) throw new Error("createResearchProgram: insert returned no row");

      return {
        success: true,
        value: {
          programId: created.id,
          slug: created.slug,
          title: created.title,
          tagline: created.tagline,
          missionStatement: created.missionStatement,
          status: created.status,
          branchCount: 0,
          participantCount: 0,
          publishedAt: created.publishedAt,
          createdAt: created.createdAt,
          createdByUserId: created.createdByUserId,
          reviewerNote: created.reviewerNote,
          reviewedAt: created.reviewedAt,
          isViewerCreator: true,
        },
      };
    } catch (insertError: unknown) {
      if (!isUniqueViolation(insertError)) throw insertError;
      // Slug taken — next attempt appends a higher suffix.
    }
  }

  // Twelve collisions on one title means something is generating them, not a coincidence.
  return { success: false, error: { type: "PROGRAM_TITLE_UNUSABLE" } };
}

export interface ListProgramsFilter {
  readonly page: number;
  readonly limit: number;
  /** Free-text over title and tagline. Server-side; never a client-side filter over a page. */
  readonly searchText?: string | undefined;
}

/**
 * The PUBLIC index — `published` and `archived` only.
 *
 * `pending` and `rejected` are excluded HERE, in SQL, rather than filtered after the
 * fetch: a page-limited query that filters afterwards returns short pages and eventually
 * an empty one that is not the end of the list.
 */
export async function listPublicResearchPrograms(filter: ListProgramsFilter): Promise<{
  readonly rows: readonly ResearchProgramSummaryView[];
  readonly total: number;
}> {
  const visibleStatuses: readonly ResearchProgramStatus[] = ["published", "archived"];
  const conditions = [inArray(researchProgram.status, [...visibleStatuses])];

  if (filter.searchText !== undefined && filter.searchText.length > 0) {
    // `ilike` with escaped wildcards: an unescaped `%` from a client turns a search box
    // into a full-table scan selector.
    const pattern = `%${escapeLikePattern(filter.searchText)}%`;
    const textMatch = or(
      ilike(researchProgram.title, pattern),
      ilike(researchProgram.tagline, pattern),
    );
    if (textMatch) conditions.push(textMatch);
  }

  const whereClause = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        ...PROGRAM_SUMMARY_COLUMNS,
        branchCount: BRANCH_COUNT_SUBQUERY,
        participantCount: PARTICIPANT_COUNT_SUBQUERY,
      })
      .from(researchProgram)
      .where(whereClause)
      // Newest first, ending in a unique column (§4c rule 4) so two programs published in
      // the same millisecond never swap places between two page reads.
      .orderBy(desc(researchProgram.createdAt), desc(researchProgram.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ total: count() }).from(researchProgram).where(whereClause),
  ]);

  return { rows, total: totalRow?.total ?? 0 };
}

/** A caller's OWN programs, at any status — the only way to see your `pending` submission. */
export async function listOwnResearchPrograms(
  createdByUserId: string,
): Promise<readonly ResearchProgramSummaryView[]> {
  return db
    .select({
      ...PROGRAM_SUMMARY_COLUMNS,
      branchCount: BRANCH_COUNT_SUBQUERY,
      participantCount: PARTICIPANT_COUNT_SUBQUERY,
    })
    .from(researchProgram)
    .where(eq(researchProgram.createdByUserId, createdByUserId))
    .orderBy(desc(researchProgram.createdAt), desc(researchProgram.id));
}

/**
 * The moderator review queue: `pending`, oldest first.
 *
 * Oldest first deliberately — a queue that shows newest first starves its own tail, and
 * the person who has been waiting longest is the one owed an answer.
 */
export async function listProgramsAwaitingReview(filter: {
  readonly page: number;
  readonly limit: number;
}): Promise<{ readonly rows: readonly ResearchProgramSummaryView[]; readonly total: number }> {
  const whereClause = eq(researchProgram.status, "pending");

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        ...PROGRAM_SUMMARY_COLUMNS,
        branchCount: BRANCH_COUNT_SUBQUERY,
        participantCount: PARTICIPANT_COUNT_SUBQUERY,
      })
      .from(researchProgram)
      .where(whereClause)
      .orderBy(asc(researchProgram.createdAt), asc(researchProgram.id))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
    db.select({ total: count() }).from(researchProgram).where(whereClause),
  ]);

  return { rows, total: totalRow?.total ?? 0 };
}

/** Every published slug, for the frontend's `generateStaticParams`. */
export async function listPublishedProgramSlugs(): Promise<readonly string[]> {
  const rows = await db
    .select({ slug: researchProgram.slug })
    .from(researchProgram)
    .where(eq(researchProgram.status, "published"))
    .orderBy(asc(researchProgram.slug));

  return rows.map((row) => row.slug);
}

/**
 * Full detail for one program.
 *
 * `reviewerNote` is withheld from anyone who is not the creator or staff. A rejection
 * reason is a private message to the person who submitted, and a public program page is
 * not where it belongs.
 */
export async function findResearchProgramDetail(
  programId: string,
  viewerUserId: string | null,
  isStaff = false,
): Promise<ResearchProgramDetailView | null> {
  const [row] = await db
    .select({
      ...PROGRAM_SUMMARY_COLUMNS,
      missionStatement: researchProgram.missionStatement,
      createdByUserId: researchProgram.createdByUserId,
      reviewerNote: researchProgram.reviewerNote,
      reviewedAt: researchProgram.reviewedAt,
      branchCount: BRANCH_COUNT_SUBQUERY,
      participantCount: PARTICIPANT_COUNT_SUBQUERY,
    })
    .from(researchProgram)
    .where(eq(researchProgram.id, programId));

  if (!row) return null;

  const isViewerCreator = viewerUserId !== null && row.createdByUserId === viewerUserId;
  const mayReadReview = isViewerCreator || isStaff;

  return {
    ...row,
    reviewerNote: mayReadReview ? row.reviewerNote : null,
    reviewedAt: mayReadReview ? row.reviewedAt : null,
    isViewerCreator,
  };
}

/**
 * Creator-only edit. Carries no `status` field, by construction — publishing is a
 * moderator's decision and lives in `research-program-moderation.service.ts`.
 */
export async function updateResearchProgram(
  programId: string,
  input: {
    readonly title?: string | undefined;
    readonly tagline?: string | undefined;
    readonly missionStatement?: string | undefined;
  },
): Promise<void> {
  // An all-absent patch is a no-op rather than an error: `.strict()` already rejected
  // unknown keys, so the only way to get here is `{}`, and refusing that tells a client
  // nothing it can act on.
  if (
    input.title === undefined &&
    input.tagline === undefined &&
    input.missionStatement === undefined
  ) {
    return;
  }

  await db
    .update(researchProgram)
    .set({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.tagline === undefined ? {} : { tagline: input.tagline }),
      ...(input.missionStatement === undefined ? {} : { missionStatement: input.missionStatement }),
      // The SLUG IS NEVER REGENERATED from a new title. It is a public URL that has been
      // linked, bookmarked and cited the moment the program was published — the same
      // ruling the wire-casing table makes about slugs being unwritable after creation.
    })
    .where(eq(researchProgram.id, programId));
}

/**
 * The four hero tiles, from the latest snapshot.
 *
 * Returns null when the job has never run, and the controller answers **404** — never a
 * fabricated set of zeroes. Four zeroes render as "this program has nobody and nothing",
 * when the truth is "nobody has counted yet". Same ruling §7 makes for investor
 * confidence, and the same reason `project_stats` leaves its §8/§9 fields NULL.
 */
export interface ResearchProgramStatsView {
  readonly asOf: Date;
  readonly participantCount: number;
  readonly paperCount: number;
  readonly branchCount: number;
  readonly postCount: number;
  readonly openGapCount: number;
  readonly overlapFlagCount: number;
  readonly totalEffortMinutes: number;
}

export async function findLatestProgramStats(
  programId: string,
): Promise<ResearchProgramStatsView | null> {
  const [row] = await db
    .select({
      asOf: researchProgramStatSnapshot.asOf,
      participantCount: researchProgramStatSnapshot.participantCount,
      paperCount: researchProgramStatSnapshot.paperCount,
      branchCount: researchProgramStatSnapshot.branchCount,
      postCount: researchProgramStatSnapshot.postCount,
      openGapCount: researchProgramStatSnapshot.openGapCount,
      overlapFlagCount: researchProgramStatSnapshot.overlapFlagCount,
      totalEffortMinutes: researchProgramStatSnapshot.totalEffortMinutes,
    })
    .from(researchProgramStatSnapshot)
    .where(eq(researchProgramStatSnapshot.programId, programId))
    .orderBy(desc(researchProgramStatSnapshot.asOf), desc(researchProgramStatSnapshot.id))
    .limit(1);

  return row ?? null;
}

/**
 * Counts a program's posts, for the stats job.
 *
 * Hidden posts are EXCLUDED: the tile says how much public discussion there is, and a
 * moderated-away post is not public discussion. Replies count — a thread of substance is
 * discussion whether or not it started a new topic.
 */
export async function countProgramPosts(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramPost)
    .where(
      and(eq(researchProgramPost.programId, programId), eq(researchProgramPost.isHidden, false)),
    );

  return row?.total ?? 0;
}

/** Counts a program's APPROVED papers. A queued paper is not yet part of the library. */
export async function countApprovedProgramPapers(programId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(researchProgramPaper)
    .where(
      and(
        eq(researchProgramPaper.programId, programId),
        eq(researchProgramPaper.moderationStatus, "approved"),
      ),
    );

  return row?.total ?? 0;
}
