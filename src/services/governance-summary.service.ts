import { and, eq, inArray, max, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  compensationPeriod,
  compensationPeriodLine,
  fundingRound,
  investorConfidenceSnapshot,
  projectMember,
  researchProject,
} from "#src/db/schema.js";
import { GROSS_ONLY_NOTICE } from "#src/services/compensation-periods.service.js";

/**
 * The cross-project governance aggregate (R_AND_D_BACKEND_STRUCTURE.md §11h, Appendix B3).
 *
 * THE PRIVACY DECISION, and it decided the whole endpoint. A month-end statement line
 * names a person and what they are owed. Pay data is personal data under the GDPR and is
 * treated as specially sensitive in several member states; §7A already keeps account
 * numbers out of the system entirely. Publishing per-member cash figures to anyone holding
 * a URL is not a scoping detail — so this surface renders AGGREGATES AND MECHANICS, NEVER
 * PEOPLE:
 *
 *   - Per-member statement lines stay on the per-project tab (§5.5), behind membership,
 *     with the finalize / countersign / record-payment / confirm / export actions. Nothing
 *     moved.
 *   - This read returns per-project COUNTS by status and aggregate committed funding. No
 *     name, no user id, no member id, no per-member amount appears in the projection.
 *   - THE CALLER'S OWN LINES ARE THE ONE EXCEPTION. A member may always see their own, on
 *     any surface — `callerOpenLines` below, joined through their OWN `project_member`
 *     rows and nobody else's.
 *
 * THE WORKED EXAMPLE THE FRONTEND SPEC WANTS IS AUTHORED SAMPLE DATA, NOT A REAL ROW. The
 * backend is deliberately not asked to supply a real member for it and does not.
 *
 * READ-ONLY, AND THERE ARE NO ACTIONS HERE. No `/finalize`, `/countersign`, `/payments` or
 * `/export` hangs off this router; each is actor-scoped and belongs where the actor's role
 * is already resolved.
 *
 * NO `Result`. A summary with no rows is a successful empty summary, not a failure — the
 * §6 catalogue convention.
 */

/**
 * The three §7A.6 copy rules, shipped WITH THE PAYLOAD rather than only in the UI.
 *
 * KEYS, NOT ENGLISH SENTENCES. Shipping prose from the server forces three native clients
 * to render un-localizable strings — the same argument that replaced `earnedAsLabel` with
 * an enum (§4d). The client maps each key to its own localized copy.
 *
 * No field on this page may imply a rail, a hold, a charge or a fee, and these keys are
 * what say so out loud: Qatoto holds no funds and charges nobody · a verification verdict
 * never reduces cash · a statement is gross only.
 */
export const GOVERNANCE_DISCLOSURE_KEYS = [
  "platform_holds_no_funds",
  "verification_never_reduces_cash",
  "statement_is_gross_only",
] as const;

export interface GovernancePeriodCounts {
  readonly openPeriodCount: number;
  readonly finalizedPeriodCount: number;
  readonly supersededPeriodCount: number;
  /** Orthogonal to status: a finalized period may or may not have been countersigned yet. */
  readonly countersignedPeriodCount: number;
}

export interface GovernanceProjectRollup extends GovernancePeriodCounts {
  readonly projectSlug: string;
  readonly projectName: string;
  readonly projectCoverImageUrl: string | null;
  readonly projectStage: (typeof researchProject.$inferSelect)["stage"];
  readonly currency: string;
  /**
   * The sum of COMMITTED pledges, as a decimal string (§4b — a total past 2^53 loses
   * precision the moment JSON.stringify touches it).
   *
   * COMMITTED, not collected, not held, not charged. Qatoto operates no money rail; the
   * field name says so and `GOVERNANCE_DISCLOSURE_KEYS` says so again.
   */
  readonly committedFundingInCents: string;
  /**
   * NULL when no snapshot has ever been computed for this project — never a fabricated
   * zero. §11g's `investor-confidence` 404s in that case for the same reason, and an
   * aggregate that coerced it to 0 would publish "no confidence" as a finding.
   */
  readonly investorConfidenceBasisPoints: number | null;
  readonly investorConfidenceAsOf: Date | null;
}

/** One of the CALLER'S OWN lines. No other member's line is ever shaped into this. */
export interface GovernanceCallerLine {
  readonly projectSlug: string;
  readonly periodId: string;
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly kind: (typeof compensationPeriodLine.$inferSelect)["kind"];
  /** Decimal string, or null on an equity line — equity is not money and is never summed with it. */
  readonly grossAmountInCents: string | null;
  readonly currency: string | null;
  readonly effortMinutes: number | null;
  /** SIGNED. A negative delta is the model working, not a bug (§7A.3). */
  readonly equityBasisPointsDelta: number | null;
}

export interface GovernanceSummary {
  /** When this rollup was assembled. Every count below is as of this instant, not "now". */
  readonly asOf: Date;
  readonly platformTotals: GovernancePeriodCounts;
  readonly projects: readonly GovernanceProjectRollup[];
  readonly projectsTotal: number;
  /** Empty for a signed-out caller. Never populated from anyone else's membership. */
  readonly callerOpenLines: readonly GovernanceCallerLine[];
  readonly disclosureKeys: readonly (typeof GOVERNANCE_DISCLOSURE_KEYS)[number][];
  readonly grossOnlyNotice: string;
}

export interface GovernanceSummaryFilter {
  readonly page: number;
  readonly limit: number;
}

/**
 * The four conditional aggregates, declared once so the platform total and the per-project
 * rollup can never drift apart by counting differently.
 */
const PERIOD_COUNT_COLUMNS = {
  openPeriodCount: sql<number>`count(*) filter (where ${compensationPeriod.status} = 'open')::int`,
  finalizedPeriodCount: sql<number>`count(*) filter (where ${compensationPeriod.status} = 'finalized')::int`,
  supersededPeriodCount: sql<number>`count(*) filter (where ${compensationPeriod.status} = 'superseded')::int`,
  countersignedPeriodCount: sql<number>`count(*) filter (where ${compensationPeriod.countersignedAt} is not null)::int`,
} as const;

/** Committed pledge totals for one page of projects, in one query rather than N. */
async function loadCommittedFundingByProject(
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (projectIds.length === 0) return new Map();

  const rows = await db
    .select({
      projectId: fundingRound.projectId,
      // `raisedAmountInCents` is a counter column moved inside the pledge transaction, and
      // a pledge is a COMMITMENT — no card, no custody. Summed in SQL as raw integers;
      // no division and no rounding happens here (§4c rule 1).
      committedFundingInCents: sql<string>`coalesce(sum(${fundingRound.raisedAmountInCents}), 0)::bigint`,
    })
    .from(fundingRound)
    .where(inArray(fundingRound.projectId, [...projectIds]))
    .groupBy(fundingRound.projectId);

  return new Map(rows.map((row) => [row.projectId, row.committedFundingInCents]));
}

interface LatestConfidence {
  readonly confidenceBasisPoints: number;
  readonly asOf: Date;
}

/**
 * The newest confidence snapshot per project, for one page.
 *
 * PROJECTS WITH NO SNAPSHOT ARE ABSENT FROM THE MAP, not present with a zero. The caller
 * renders `null` for them.
 */
async function loadLatestConfidenceByProject(
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, LatestConfidence>> {
  if (projectIds.length === 0) return new Map();

  // `(projectId, asOf)` is unique on this table, so joining back on the per-project MAX
  // selects exactly one row per project — no ordering tiebreak needed and none available.
  const newestPerProject = db
    .select({
      projectId: investorConfidenceSnapshot.projectId,
      latestAsOf: max(investorConfidenceSnapshot.asOf).as("latest_as_of"),
    })
    .from(investorConfidenceSnapshot)
    .where(inArray(investorConfidenceSnapshot.projectId, [...projectIds]))
    .groupBy(investorConfidenceSnapshot.projectId)
    .as("newest_confidence_per_project");

  const rows = await db
    .select({
      projectId: investorConfidenceSnapshot.projectId,
      confidenceBasisPoints: investorConfidenceSnapshot.confidenceBasisPoints,
      asOf: investorConfidenceSnapshot.asOf,
    })
    .from(investorConfidenceSnapshot)
    .innerJoin(
      newestPerProject,
      and(
        eq(newestPerProject.projectId, investorConfidenceSnapshot.projectId),
        eq(newestPerProject.latestAsOf, investorConfidenceSnapshot.asOf),
      ),
    );

  return new Map(
    rows.map((row) => [
      row.projectId,
      { confidenceBasisPoints: row.confidenceBasisPoints, asOf: row.asOf },
    ]),
  );
}

/**
 * The caller's OWN open statement lines, across every project they are an active member of.
 *
 * The membership join is the authorization: `projectMember.userId = callerUserId` is the
 * only way a line reaches this projection, so there is no filter a client could widen and
 * no id it could substitute. Restricted to `open` periods because that is what the page
 * calls "what you are currently accruing"; a finalized statement is read on the project's
 * own tab where the hash and the countersignature live.
 */
async function loadCallerOpenLines(
  callerUserId: string,
): Promise<readonly GovernanceCallerLine[]> {
  const rows = await db
    .select({
      projectSlug: researchProject.slug,
      periodId: compensationPeriod.id,
      periodStartDate: compensationPeriod.periodStartDate,
      periodEndDate: compensationPeriod.periodEndDate,
      kind: compensationPeriodLine.kind,
      grossAmountInCents: compensationPeriodLine.grossAmountInCents,
      currency: compensationPeriodLine.currency,
      effortMinutes: compensationPeriodLine.effortMinutes,
      equityBasisPointsDelta: compensationPeriodLine.equityBasisPointsDelta,
    })
    .from(compensationPeriodLine)
    .innerJoin(projectMember, eq(projectMember.id, compensationPeriodLine.memberId))
    .innerJoin(compensationPeriod, eq(compensationPeriod.id, compensationPeriodLine.periodId))
    .innerJoin(researchProject, eq(researchProject.id, compensationPeriodLine.projectId))
    .where(
      and(
        eq(projectMember.userId, callerUserId),
        eq(projectMember.status, "active"),
        eq(compensationPeriod.status, "open"),
      ),
    )
    // Ends in a unique column (§4c rule 4).
    .orderBy(compensationPeriod.periodStartDate, compensationPeriodLine.id);

  return rows.map((row) => ({
    ...row,
    // bigint → decimal string at the boundary (§4b).
    grossAmountInCents: row.grossAmountInCents === null ? null : row.grossAmountInCents.toString(),
  }));
}

/**
 * The `/governance` page in one read.
 *
 * `callerUserId` is null for a signed-out visitor: the aggregates and the copy rules still
 * render — this page states them publicly — and `callerOpenLines` is empty.
 */
export async function getGovernanceSummary(
  callerUserId: string | null,
  filter: GovernanceSummaryFilter,
): Promise<GovernanceSummary> {
  const offset = (filter.page - 1) * filter.limit;

  // Only ACTIVE projects. A draft or archived project is not a public surface (§5), and
  // this predicate is applied identically to the page, the total and the platform rollup.
  const activeProjectPredicate = eq(researchProject.status, "active");

  const [platformTotalsRow] = await db
    .select(PERIOD_COUNT_COLUMNS)
    .from(compensationPeriod)
    .innerJoin(researchProject, eq(researchProject.id, compensationPeriod.projectId))
    .where(activeProjectPredicate);

  const [projectRows, [projectsTotalRow]] = await Promise.all([
    db
      .select({
        projectId: researchProject.id,
        projectSlug: researchProject.slug,
        projectName: researchProject.name,
        projectCoverImageUrl: researchProject.coverImageUrl,
        projectStage: researchProject.stage,
        currency: researchProject.currency,
        ...PERIOD_COUNT_COLUMNS,
      })
      .from(compensationPeriod)
      .innerJoin(researchProject, eq(researchProject.id, compensationPeriod.projectId))
      .where(activeProjectPredicate)
      .groupBy(
        researchProject.id,
        researchProject.slug,
        researchProject.name,
        researchProject.coverImageUrl,
        researchProject.stage,
        researchProject.currency,
      )
      // Ends in a unique column (§4c rule 4), or the page boundary drops a project.
      .orderBy(researchProject.name, researchProject.id)
      .limit(filter.limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(distinct ${compensationPeriod.projectId})::int` })
      .from(compensationPeriod)
      .innerJoin(researchProject, eq(researchProject.id, compensationPeriod.projectId))
      .where(activeProjectPredicate),
  ]);

  const pageProjectIds = projectRows.map((row) => row.projectId);

  const [committedFundingByProject, latestConfidenceByProject, callerOpenLines] = await Promise.all([
    loadCommittedFundingByProject(pageProjectIds),
    loadLatestConfidenceByProject(pageProjectIds),
    callerUserId === null ? Promise.resolve([]) : loadCallerOpenLines(callerUserId),
  ]);

  return {
    asOf: new Date(),
    platformTotals: platformTotalsRow ?? {
      openPeriodCount: 0,
      finalizedPeriodCount: 0,
      supersededPeriodCount: 0,
      countersignedPeriodCount: 0,
    },
    projects: projectRows.map(({ projectId, ...project }) => {
      const latestConfidence = latestConfidenceByProject.get(projectId);

      return {
        ...project,
        committedFundingInCents: committedFundingByProject.get(projectId) ?? "0",
        investorConfidenceBasisPoints: latestConfidence?.confidenceBasisPoints ?? null,
        investorConfidenceAsOf: latestConfidence?.asOf ?? null,
      };
    }),
    projectsTotal: projectsTotalRow?.total ?? 0,
    callerOpenLines,
    disclosureKeys: GOVERNANCE_DISCLOSURE_KEYS,
    grossOnlyNotice: GROSS_ONLY_NOTICE,
  };
}
