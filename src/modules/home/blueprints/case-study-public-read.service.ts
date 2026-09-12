import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  caseStudy,
  caseStudyActionStep,
  caseStudyEvidenceCompany,
  caseStudyOutcomeMetric,
  caseStudyPitfall,
  caseStudyRelatedLesson,
  caseStudySource,
  caseStudyStats,
  user,
} from "#src/db/schema.js";
import { decodeInstantCursor, encodeInstantCursor } from "#src/lib/instant-cursor.js";
import type { Result } from "#src/types/index.js";

/**
 * The PUBLIC reads behind `/blueprints/case-studies` — the index, the options, the prerender slugs
 * and one case study.
 *
 * ⚠️ ONE VISIBILITY GATE, NOT TWO, AND DO NOT COPY THE TEARDOWN SHAPE HERE. A teardown needs LIST
 * (`published, flagged`) and READABLE (those plus `quarantined`) because a quarantine withholds its
 * FILES while leaving its address alive. A case study has no files: a report moves a published row
 * to `flagged`, and nothing on this arm is withheld by STATE. So `published, flagged` is the whole
 * gate, shared by every read below. A second predicate identical to the first would teach the next
 * reader that the difference is meaningful.
 *
 * ⚠️ WHAT *IS* WITHHELD HERE IS ONE FIELD, BY A PER-ROW FLAG: a first-hand writer may keep a
 * company's name from READERS — an NDA is the ordinary reason — and a moderator still sees it. A
 * query cannot express that, so `toPublicCompany` does, and it is the ONLY place in this file that
 * touches a company's name. Every read goes through it.
 *
 * ⚠️ AND THE GUARANTEE IS NARROW, WHICH IS PART OF STATING IT HONESTLY. This nulls one column. The
 * writer could still have named the company in the summary, a step, a tag or a source's publisher
 * label — so `case-study-submission.schemas.ts` sweeps every reader-visible field for a withheld
 * name at submit time. That sweep is the other half; neither half is sufficient alone.
 *
 * NOTHING HERE READS THE CALLER. The payload is identical for every visitor, so these routes take
 * no session. The moderator queue is the one read on this surface that does, and it lives in
 * `case-study-moderation.service.ts` for exactly that reason.
 */

/** Where a case study may appear AND be reached. One list, because this arm needs only one. */
const PUBLICLY_VISIBLE_MODERATION_STATES = ["published", "flagged"] as const;

/**
 * The gate.
 *
 * `flagged` IS IN IT. A report is an allegation nobody has ruled on, and delisting on the strength
 * of one would turn the report control into a takedown control. `pending_review` and `rejected` are
 * not: neither has ever been decided in a reader's favour, and both hold somebody's unpublished
 * work.
 */
function publiclyVisibleCaseStudyCondition(): SQL {
  return inArray(caseStudy.moderationState, [...PUBLICLY_VISIBLE_MODERATION_STATES]);
}

export interface PublicCaseStudyAuthor {
  readonly displayName: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
}

export interface PublicCaseStudyCompany {
  /** `null` WHEN WITHHELD. The real name is in the column; this is what a reader gets. */
  readonly name: string | null;
  readonly locationLabel: string;
  readonly yearLabel: string;
}

export type PublicCaseStudyMetricValue =
  | { readonly kind: "count"; readonly amount: number }
  | { readonly kind: "money"; readonly amountInCents: number; readonly currency: string }
  | { readonly kind: "percentage"; readonly basisPoints: number };

export interface PublicCaseStudyView {
  readonly id: string;
  readonly slug: string;
  readonly category: "case_study";
  readonly title: string;
  readonly summary: string;
  readonly author: PublicCaseStudyAuthor;
  readonly viewCount: number;
  readonly likeCount: number;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly moderationState: "published" | "flagged";
  readonly discipline: (typeof caseStudy.$inferSelect)["discipline"];
  readonly oneLineAction: string;
  readonly outcomeSummary: string | null;
  readonly sector: string;
  readonly authorRelationship: (typeof caseStudy.$inferSelect)["authorRelationship"];
  readonly evidenceCompanies: readonly PublicCaseStudyCompany[];
  readonly problem: string;
  readonly context: string;
  readonly actionSteps: readonly string[];
  readonly pitfalls: readonly string[];
  readonly timelineLabel: string | null;
  readonly capitalRaised: { readonly amountInCents: number; readonly currency: string } | null;
  readonly outcomeMetrics: readonly {
    readonly label: string;
    readonly value: PublicCaseStudyMetricValue;
  }[];
  readonly sources: readonly {
    readonly label: string;
    readonly publisherLabel: string;
    readonly url: string;
  }[];
  /** The slugs the AUTHOR named, in their order. Resolution is `relatedLessons` on the detail read. */
  readonly relatedLessonSlugs: readonly string[];
}

export interface CaseStudyIndexPage {
  readonly items: readonly PublicCaseStudyView[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** One choice in the composer's "Related lessons" select. */
export interface CaseStudyOption {
  readonly slug: string;
  readonly title: string;
}

/**
 * The detail read's payload.
 *
 * ⚠️ AN ENVELOPE, NOT A WIDENED CASE STUDY, and that is deliberate. Putting `relatedLessons` on
 * `PublicCaseStudyView` would also put it on every index row, where nothing renders it — forcing
 * `relatedLessons: []` on rows that have related lessons, which is a lie the type would make
 * unavoidable. The envelope keeps `relatedLessonSlugs` honest ("what the author named") beside the
 * resolution.
 */
export interface PublicCaseStudyDetail {
  readonly caseStudy: PublicCaseStudyView;
  readonly relatedLessons: readonly CaseStudyOption[];
}

export type CaseStudyIndexError = { readonly type: "CASE_STUDY_INDEX_CURSOR_MALFORMED" };
export type CaseStudyDetailError = { readonly type: "CASE_STUDY_NOT_FOUND" };

type CaseStudyRow = typeof caseStudy.$inferSelect;
type CaseStudyJoinedRow = {
  readonly caseStudy: CaseStudyRow;
  readonly accountDisplayName: string | null;
  readonly accountHandle: string | null;
  readonly accountAvatarUrl: string | null;
};

type CaseStudyChildRows = {
  readonly statsRows: readonly (typeof caseStudyStats.$inferSelect)[];
  readonly stepRows: readonly (typeof caseStudyActionStep.$inferSelect)[];
  readonly pitfallRows: readonly (typeof caseStudyPitfall.$inferSelect)[];
  readonly companyRows: readonly (typeof caseStudyEvidenceCompany.$inferSelect)[];
  readonly metricRows: readonly (typeof caseStudyOutcomeMetric.$inferSelect)[];
  readonly sourceRows: readonly (typeof caseStudySource.$inferSelect)[];
  readonly relatedRows: readonly (typeof caseStudyRelatedLesson.$inferSelect)[];
};

/**
 * ⚠️ THE ONE PLACE A COMPANY'S NAME IS SERIALIZED FOR A READER. Every public read calls this; the
 * moderator queue deliberately does not, and `/mine` carries no companies at all so there is nothing
 * for it to get wrong.
 *
 * It is a function rather than a ternary at each call site so that "does this read withhold?" has
 * ONE answer to check, and so a new read that forgets it is a missing call rather than a subtly
 * different expression. `case-study-withheld-name.test.ts` sweeps raw response bytes on the
 * assumption that this is the only gate — if that ever stops being true, that test is what fails.
 */
function toPublicCompany(
  companyRow: typeof caseStudyEvidenceCompany.$inferSelect,
): PublicCaseStudyCompany {
  return {
    name: companyRow.isNameWithheld ? null : companyRow.name,
    locationLabel: companyRow.locationLabel,
    yearLabel: companyRow.yearLabel,
  };
}

/**
 * The byline, from whichever arm the row carries.
 *
 * ⚠️ AN EXPLICIT BRANCH, NOT A `??` CHAIN. `user.name ?? row.authorDisplayName` would hide which arm
 * produced the byline and would silently paper over a joined account that came back empty — which
 * `case_study_author_arm_ck` says cannot happen, and a throw is the honest answer if it ever does.
 */
function buildAuthor(joinedRow: CaseStudyJoinedRow): PublicCaseStudyAuthor {
  if (joinedRow.caseStudy.authorUserId !== null) {
    if (joinedRow.accountDisplayName === null) {
      throw new Error(
        `case_study ${joinedRow.caseStudy.id} names an account with no display name; the foreign key says that is impossible.`,
      );
    }
    return {
      displayName: joinedRow.accountDisplayName,
      handle: joinedRow.accountHandle,
      avatarUrl: joinedRow.accountAvatarUrl,
    };
  }

  // The seeded arm. The CHECK guarantees a display name whenever there is no account.
  if (joinedRow.caseStudy.authorDisplayName === null) {
    throw new Error(
      `case_study ${joinedRow.caseStudy.id} has neither an account nor a byline; case_study_author_arm_ck should have refused it.`,
    );
  }
  return {
    displayName: joinedRow.caseStudy.authorDisplayName,
    handle: joinedRow.caseStudy.authorHandle,
    avatarUrl: joinedRow.caseStudy.authorAvatarUrl,
  };
}

/** The stored state, narrowed to the two a reader can ever see. */
function toVisibleModerationState(
  moderationState: CaseStudyRow["moderationState"],
): PublicCaseStudyView["moderationState"] {
  if (moderationState === "published" || moderationState === "flagged") return moderationState;
  /*
   * Unreachable twice over — the gate admits two states and the table CHECK admits four — and a
   * throw is the correct failure if either narrowing is ever loosened, because the alternative is
   * publishing somebody's rejected work.
   */
  throw new Error(`A ${moderationState} case study must never reach a public read.`);
}

function buildMetricValue(
  metricRow: typeof caseStudyOutcomeMetric.$inferSelect,
): PublicCaseStudyMetricValue {
  switch (metricRow.kind) {
    case "count":
      if (metricRow.countAmount === null) break;
      return { kind: "count", amount: metricRow.countAmount };
    case "money":
      if (metricRow.moneyAmountCents === null || metricRow.moneyCurrency === null) break;
      return {
        kind: "money",
        amountInCents: metricRow.moneyAmountCents,
        currency: metricRow.moneyCurrency,
      };
    case "percentage":
      if (metricRow.basisPoints === null) break;
      return { kind: "percentage", basisPoints: metricRow.basisPoints };
    default: {
      const exhaustiveCheck: never = metricRow.kind;
      throw new Error(`Unhandled case study metric kind: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
  // `case_study_outcome_metric_kind_ck` ties each kind to its own columns, so this cannot happen.
  throw new Error(
    `case_study_outcome_metric ${metricRow.id} is a ${metricRow.kind} with no value; its CHECK should have refused it.`,
  );
}

/** The select list every read of a whole case study shares, so they cannot drift apart. */
const PUBLIC_CASE_STUDY_COLUMNS = {
  caseStudy,
  /*
   * A LEFT JOIN, because a seeded row names no account. The three account columns are `null` for
   * exactly those rows, and `buildAuthor` branches on `author_user_id` rather than on their
   * emptiness — so a missing join is a throw rather than a silently blank byline.
   */
  accountDisplayName: user.name,
  accountHandle: user.handle,
  accountAvatarUrl: user.image,
};

function buildCaseStudyView(
  joinedRow: CaseStudyJoinedRow,
  childRows: CaseStudyChildRows,
): PublicCaseStudyView {
  const row = joinedRow.caseStudy;
  const statsRow = childRows.statsRows.find((candidate) => candidate.caseStudyId === row.id);
  const ownChildren = <TChild extends { readonly caseStudyId: string }>(
    rows: readonly TChild[],
  ): readonly TChild[] => rows.filter((candidate) => candidate.caseStudyId === row.id);

  return {
    id: row.id,
    // Non-null for every visible row: the decision CHECK ties the slug to `published`/`flagged`.
    slug: row.publicSlug ?? row.id,
    category: "case_study",
    title: row.title,
    summary: row.summary,
    author: buildAuthor(joinedRow),
    // The seed writes a row per case study, so a missing sidecar is a bug — but 0 is still honest.
    viewCount: statsRow?.viewCount ?? 0,
    likeCount: statsRow?.likeCount ?? 0,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
    moderationState: toVisibleModerationState(row.moderationState),
    discipline: row.discipline,
    oneLineAction: row.oneLineAction,
    outcomeSummary: row.outcomeSummary,
    sector: row.sector,
    authorRelationship: row.authorRelationship,
    evidenceCompanies: ownChildren(childRows.companyRows).map(toPublicCompany),
    problem: row.problem,
    context: row.context,
    actionSteps: ownChildren(childRows.stepRows).map((stepRow) => stepRow.body),
    pitfalls: ownChildren(childRows.pitfallRows).map((pitfallRow) => pitfallRow.body),
    timelineLabel: row.timelineLabel,
    capitalRaised:
      row.capitalRaisedAmountCents !== null && row.capitalRaisedCurrency !== null
        ? { amountInCents: row.capitalRaisedAmountCents, currency: row.capitalRaisedCurrency }
        : null,
    outcomeMetrics: ownChildren(childRows.metricRows).map((metricRow) => ({
      label: metricRow.label,
      value: buildMetricValue(metricRow),
    })),
    sources: ownChildren(childRows.sourceRows).map((sourceRow) => ({
      label: sourceRow.label,
      publisherLabel: sourceRow.publisherLabel,
      url: sourceRow.url,
    })),
    relatedLessonSlugs: ownChildren(childRows.relatedRows).map(
      (relatedRow) => relatedRow.relatedPublicSlug,
    ),
  };
}

/** Loads every child a page of case studies needs — seven queries for N rows, never 7N. */
async function loadCaseStudyChildren(caseStudyIds: readonly string[]): Promise<CaseStudyChildRows> {
  if (caseStudyIds.length === 0) {
    return {
      statsRows: [],
      stepRows: [],
      pitfallRows: [],
      companyRows: [],
      metricRows: [],
      sourceRows: [],
      relatedRows: [],
    };
  }
  const ids = [...caseStudyIds];

  // Every child is ordered by `position`, because the author's arrangement is the answer.
  const [statsRows, stepRows, pitfallRows, companyRows, metricRows, sourceRows, relatedRows] =
    await Promise.all([
      db.select().from(caseStudyStats).where(inArray(caseStudyStats.caseStudyId, ids)),
      db
        .select()
        .from(caseStudyActionStep)
        .where(inArray(caseStudyActionStep.caseStudyId, ids))
        .orderBy(asc(caseStudyActionStep.caseStudyId), asc(caseStudyActionStep.position)),
      db
        .select()
        .from(caseStudyPitfall)
        .where(inArray(caseStudyPitfall.caseStudyId, ids))
        .orderBy(asc(caseStudyPitfall.caseStudyId), asc(caseStudyPitfall.position)),
      db
        .select()
        .from(caseStudyEvidenceCompany)
        .where(inArray(caseStudyEvidenceCompany.caseStudyId, ids))
        .orderBy(asc(caseStudyEvidenceCompany.caseStudyId), asc(caseStudyEvidenceCompany.position)),
      db
        .select()
        .from(caseStudyOutcomeMetric)
        .where(inArray(caseStudyOutcomeMetric.caseStudyId, ids))
        .orderBy(asc(caseStudyOutcomeMetric.caseStudyId), asc(caseStudyOutcomeMetric.position)),
      db
        .select()
        .from(caseStudySource)
        .where(inArray(caseStudySource.caseStudyId, ids))
        .orderBy(asc(caseStudySource.caseStudyId), asc(caseStudySource.position)),
      db
        .select()
        .from(caseStudyRelatedLesson)
        .where(inArray(caseStudyRelatedLesson.caseStudyId, ids))
        .orderBy(asc(caseStudyRelatedLesson.caseStudyId), asc(caseStudyRelatedLesson.position)),
    ]);

  return { statsRows, stepRows, pitfallRows, companyRows, metricRows, sourceRows, relatedRows };
}

/**
 * The index page.
 *
 * ⚠️ THE KEYSET IS MIXED-DIRECTION — `created_at DESC, id ASC` — because the frontend's comparator
 * breaks ties on the id ascending. The predicate mirrors the ORDER BY pair for pair, or a page
 * boundary landing mid-tie skips or repeats a case study. `case_study_public_newest_idx` is declared
 * in the same directions and partial on this exact gate.
 *
 * NO SORT CONTROL AND NO TAG FACETS on this surface, so `instant-cursor.ts` is reused rather than a
 * codec minted, and there is no facet query to gate.
 */
export async function listPublicCaseStudies(input: {
  readonly discipline: CaseStudyRow["discipline"] | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
}): Promise<Result<CaseStudyIndexPage, CaseStudyIndexError>> {
  const conditions: SQL[] = [publiclyVisibleCaseStudyCondition()];

  if (input.discipline !== undefined) {
    conditions.push(eq(caseStudy.discipline, input.discipline));
  }

  if (input.cursor !== undefined) {
    const cursor = decodeInstantCursor(input.cursor);
    // A cursor this server did not mint. Refused, never a silent first page: a list that quietly
    // restarts shows the reader duplicates and reads as a backend bug.
    if (cursor === null) {
      return { success: false, error: { type: "CASE_STUDY_INDEX_CURSOR_MALFORMED" } };
    }
    const keysetCondition = or(
      lt(caseStudy.createdAt, cursor.instant),
      and(eq(caseStudy.createdAt, cursor.instant), gt(caseStudy.id, cursor.id)),
    );
    if (keysetCondition === undefined) {
      return { success: false, error: { type: "CASE_STUDY_INDEX_CURSOR_MALFORMED" } };
    }
    conditions.push(keysetCondition);
  }

  const joinedRows = await db
    .select(PUBLIC_CASE_STUDY_COLUMNS)
    .from(caseStudy)
    .leftJoin(user, eq(user.id, caseStudy.authorUserId))
    .where(and(...conditions))
    .orderBy(desc(caseStudy.createdAt), asc(caseStudy.id))
    // One more than asked for, so "is there another page" needs no second count query.
    .limit(input.limit + 1);

  const hasMore = joinedRows.length > input.limit;
  const pageRows = hasMore ? joinedRows.slice(0, input.limit) : joinedRows;
  const childRows = await loadCaseStudyChildren(pageRows.map((row) => row.caseStudy.id));
  const items = pageRows.map((row) => buildCaseStudyView(row, childRows));

  // Minted from the last RETURNED row, never the over-fetched one: encoding the extra row would
  // skip a case study on every page boundary.
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeInstantCursor({ instant: lastRow.caseStudy.createdAt, id: lastRow.caseStudy.id })
      : null;

  return { success: true, value: { items, page: { nextCursor, hasMore } } };
}

/**
 * One visible case study, with its related lessons resolved.
 *
 * ⚠️ THE RELATED LESSONS ARE RESOLVED THROUGH THE SAME GATE AND THE AUTHOR'S ORDER IS KEPT. An edge
 * whose target is `rejected` or `pending_review` is DROPPED rather than rendered as a dead row —
 * which is what the frontend already promises — and nothing here ranks them: `relatedLessonSlugs`
 * is an authored list, so a "relevance" sort would be this layer inventing an opinion the row does
 * not carry.
 */
export async function getPublicCaseStudyBySlug(
  slug: string,
): Promise<Result<PublicCaseStudyDetail, CaseStudyDetailError>> {
  const [joinedRow] = await db
    .select(PUBLIC_CASE_STUDY_COLUMNS)
    .from(caseStudy)
    .leftJoin(user, eq(user.id, caseStudy.authorUserId))
    .where(and(publiclyVisibleCaseStudyCondition(), eq(caseStudy.publicSlug, slug)))
    .limit(1);

  if (!joinedRow) return { success: false, error: { type: "CASE_STUDY_NOT_FOUND" } };

  const childRows = await loadCaseStudyChildren([joinedRow.caseStudy.id]);
  const view = buildCaseStudyView(joinedRow, childRows);
  const relatedLessons = await resolveRelatedLessons(view.relatedLessonSlugs);

  return { success: true, value: { caseStudy: view, relatedLessons } };
}

/** Resolves an authored slug list to titles, keeping the author's order and dropping the invisible. */
async function resolveRelatedLessons(
  relatedSlugs: readonly string[],
): Promise<readonly CaseStudyOption[]> {
  if (relatedSlugs.length === 0) return [];

  const resolvedRows = await db
    .select({ slug: caseStudy.publicSlug, title: caseStudy.title })
    .from(caseStudy)
    .where(
      and(publiclyVisibleCaseStudyCondition(), inArray(caseStudy.publicSlug, [...relatedSlugs])),
    );

  const titleBySlug = new Map(
    resolvedRows.flatMap((row) => (row.slug === null ? [] : [[row.slug, row.title] as const])),
  );
  // The AUTHOR'S order, so the list reads as they arranged it rather than as the query returned it.
  return relatedSlugs.flatMap((relatedSlug) => {
    const title = titleBySlug.get(relatedSlug);
    return title === undefined ? [] : [{ slug: relatedSlug, title }];
  });
}

/**
 * Every visible slug, for the frontend's `generateStaticParams`.
 *
 * Unpaged on purpose: one short string per case study, and the caller needs all of them at once to
 * prerender. A cursor here would mean a build step that pages.
 */
export async function listPublicCaseStudySlugs(): Promise<readonly string[]> {
  const slugRows = await db
    .select({ slug: caseStudy.publicSlug })
    .from(caseStudy)
    .where(publiclyVisibleCaseStudyCondition())
    .orderBy(desc(caseStudy.createdAt), asc(caseStudy.id));

  return slugRows.flatMap((slugRow) => (slugRow.slug === null ? [] : [slugRow.slug]));
}

/**
 * Every visible case study as a slug and a title, for the composer's "Related lessons" select.
 *
 * Sorted by title to match the frontend's `localeCompare`, so the select's order does not change the
 * day this stops being a fixture read. A lesson a moderator has withheld from every index must not
 * come back through a new case study's links, which is why this uses the gate rather than listing
 * everything.
 */
export async function listCaseStudyOptions(): Promise<readonly CaseStudyOption[]> {
  const optionRows = await db
    .select({ slug: caseStudy.publicSlug, title: caseStudy.title })
    .from(caseStudy)
    .where(publiclyVisibleCaseStudyCondition())
    .orderBy(asc(caseStudy.title), asc(caseStudy.publicSlug));

  return optionRows.flatMap((optionRow) =>
    optionRow.slug === null ? [] : [{ slug: optionRow.slug, title: optionRow.title }],
  );
}

/**
 * Whether every slug in a list names a case study a reader can reach.
 *
 * ⚠️ USED BY THE WRITE PATH, NOT BY A READ, and it lives here because the gate does. A related
 * lesson is a recommendation the new case study makes to its readers, so pointing at something
 * nobody may read is a dead link the author cannot see. The foreign key proves the row EXISTS; only
 * a query can prove it is visible, which is why `moderation_state` is deliberately not in that key.
 */
export async function findUnresolvableRelatedSlugs(
  relatedSlugs: readonly string[],
): Promise<readonly string[]> {
  if (relatedSlugs.length === 0) return [];

  const visibleRows = await db
    .select({ slug: caseStudy.publicSlug })
    .from(caseStudy)
    .where(
      and(publiclyVisibleCaseStudyCondition(), inArray(caseStudy.publicSlug, [...relatedSlugs])),
    );

  const visibleSlugs = new Set(visibleRows.flatMap((row) => (row.slug === null ? [] : [row.slug])));
  return relatedSlugs.filter((relatedSlug) => !visibleSlugs.has(relatedSlug));
}
