import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "#src/db/index.js";
import {
  artifactEvidence,
  claimVerificationRun,
  dailyLog,
  dailyLogExtractedClaim,
  effortClaim,
  physicalWorkReceipt,
  pieBakeEvent,
  projectMember,
  sliceAllocationProposal,
  user,
  verificationStep,
} from "#src/db/schema.js";
import { encodeDateCursor, type DateCursor } from "#src/lib/date-cursor.js";
import {
  cashSliceNumerator,
  computeSlicesAwarded,
  timeSliceNumerator,
} from "#src/lib/slice-math.js";
import { decideClaimVerdict, type VerificationStepStatus } from "#src/lib/verdict.js";
import { enqueueNotifications } from "#src/modules/platform/notifications/notifications.service.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import {
  createVerificationRun,
  enqueueGroundingInTransaction,
  loadStepOutcomes,
  requeueFinalizeVerdict,
} from "#src/modules/rnd/proof-of-effort/verification.service.js";
import { findEffectiveRate } from "#src/services/fair-market-rate.service.js";
import { openAllocationProposal, settleProposal } from "#src/services/slice-allocation.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Effort claims — the request surface of §9's pipeline
 * (R_AND_D_BACKEND_STRUCTURE.md §9.6, §9.7, §11e).
 *
 * WHAT A CLAIM BODY CONTAINS: ids and intent. `{ sourceKind, dailyLogId?,
 * physicalReceiptIds[], claimedForDate, narrative?, idempotencyKey }` — **no minutes, no
 * cash, no verdict, no slices**. Every number is read from rows the server owns: the
 * minutes from §8's extraction or from receipt capture times, the rate from the locked
 * effective-dated row, the slice count from the formula. There is no field to tamper with,
 * which is §0's answer to "what if the client edits the number and posts it back".
 *
 * SUBMIT RETURNS 202, NEVER A VERDICT. The pipeline is minutes of asynchronous work across
 * four stages; a synchronous verdict would be either a lie or a held connection.
 *
 * THE RATE MUST BE LOCKED FIRST (`409 RATE_NOT_LOCKED`). Accepting claims against an
 * unlocked rate would let a founder file work now and choose its price later — the exact
 * ordering SPEC §2 exists to forbid.
 */

export type EffortClaimError =
  | ProjectAccessError
  | { type: "CLAIM_NOT_FOUND"; claimId: string }
  | { type: "STEP_NOT_FOUND"; stepId: string }
  | { type: "DAILY_LOG_NOT_FOUND"; logId: string }
  | { type: "DAILY_LOG_NOT_SUBMITTED" }
  | { type: "NOT_THE_AUTHOR" }
  | { type: "CLAIM_ALREADY_EXISTS"; claimId: string }
  | { type: "RATE_NOT_LOCKED"; claimedForDate: string }
  | { type: "RECEIPT_NOT_FOUND"; receiptId: string }
  | { type: "RECEIPT_ALREADY_CLAIMED"; receiptId: string }
  | { type: "RECEIPTS_REQUIRED" }
  | { type: "CLAIM_DATE_IN_FUTURE"; claimedForDate: string }
  | { type: "CLAIM_SETTLED" }
  | { type: "PIE_ALREADY_BAKED" };

export interface SubmitClaimInput {
  readonly sourceKind: (typeof effortClaim.$inferSelect)["sourceKind"];
  readonly dailyLogId?: string | undefined;
  readonly physicalReceiptIds: readonly string[];
  readonly claimedForDate: string;
  readonly narrative?: string | undefined;
  readonly idempotencyKey: string;
}

export interface ClaimReceipt {
  readonly claimId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  /** Always a pipeline state here, never a verdict — the work is accepted, not finished. */
  readonly verificationStatus: (typeof effortClaim.$inferSelect)["verificationStatus"];
  readonly claimedForDate: string;
}

async function isPieBaked(projectId: string): Promise<boolean> {
  const [baked] = await db
    .select({ id: pieBakeEvent.id })
    .from(pieBakeEvent)
    .where(eq(pieBakeEvent.projectId, projectId));
  return baked !== undefined;
}

/**
 * Aggregates §8's extraction into the two numbers the formula consumes.
 *
 * SUMMED IN SQL, DIVIDED NOWHERE (§4c rule 1). Minutes are capped at a day's worth: a
 * model that reports 3,000 minutes for one day has erred, and the cap fails safe rather
 * than surfacing a plausible-looking slice count.
 */
async function readExtractedTotals(
  dailyLogId: string,
): Promise<{ readonly minutes: number; readonly cashInCents: bigint }> {
  const [row] = await db
    .select({
      minutes: sql<string>`COALESCE(SUM(${dailyLogExtractedClaim.extractedMinutes}), 0)`,
      cashInCents: sql<string>`COALESCE(SUM(${dailyLogExtractedClaim.extractedCashInCents}), 0)`,
    })
    .from(dailyLogExtractedClaim)
    .where(eq(dailyLogExtractedClaim.dailyLogId, dailyLogId));

  return {
    minutes: Math.min(Number(row?.minutes ?? "0"), 1_440),
    cashInCents: BigInt(row?.cashInCents ?? "0"),
  };
}

/**
 * `POST …/effort-claims` — 202, a receipt, and a pipeline in flight.
 *
 * A replayed idempotency key returns the ORIGINAL receipt rather than filing a second
 * claim: a retried submit on a flaky mobile connection must cost nothing (§14).
 */
export async function submitEffortClaim(
  context: { readonly projectId: string; readonly memberId: string },
  actorUserId: string,
  actorRoleSnapshot: string,
  input: SubmitClaimInput,
): Promise<Result<ClaimReceipt, EffortClaimError>> {
  if (await isPieBaked(context.projectId)) {
    return { success: false, error: { type: "PIE_ALREADY_BAKED" } };
  }

  // A claim for a day that has not happened cannot be corroborated by anything.
  const todayIsoDate = new Date().toISOString().slice(0, 10);
  if (input.claimedForDate > todayIsoDate) {
    return {
      success: false,
      error: { type: "CLAIM_DATE_IN_FUTURE", claimedForDate: input.claimedForDate },
    };
  }

  const replayed = await findClaimByIdempotencyKey(context.memberId, input.idempotencyKey);
  if (replayed) {
    return { success: true, value: replayed };
  }

  // THE GATE §11e names: no claim exists until a rate does. Resolved for the CLAIMED day,
  // not for today, so effective dating decides the price of historical work.
  const claimedInstant = new Date(`${input.claimedForDate}T23:59:59.999Z`);
  const effectiveRate = await findEffectiveRate(context.memberId, claimedInstant);
  if (!effectiveRate) {
    return {
      success: false,
      error: { type: "RATE_NOT_LOCKED", claimedForDate: input.claimedForDate },
    };
  }

  let extractedMinutes = 0;
  let extractedCashInCents = 0n;

  if (input.sourceKind === "daily_log") {
    const logId = input.dailyLogId ?? "";
    const [log] = await db
      .select()
      .from(dailyLog)
      .where(and(eq(dailyLog.id, logId), eq(dailyLog.projectId, context.projectId)));

    if (!log) {
      return { success: false, error: { type: "DAILY_LOG_NOT_FOUND", logId } };
    }
    if (log.authorMemberId !== context.memberId) {
      return { success: false, error: { type: "NOT_THE_AUTHOR" } };
    }
    if (log.status !== "submitted") {
      // A draft is still editable by its author. Evidence its author can rewrite after
      // filing a claim against it is not evidence (§8).
      return { success: false, error: { type: "DAILY_LOG_NOT_SUBMITTED" } };
    }

    const [existing] = await db
      .select({ id: effortClaim.id })
      .from(effortClaim)
      .where(eq(effortClaim.dailyLogId, logId));
    if (existing) {
      return { success: false, error: { type: "CLAIM_ALREADY_EXISTS", claimId: existing.id } };
    }

    const totals = await readExtractedTotals(logId);
    extractedMinutes = totals.minutes;
    extractedCashInCents = totals.cashInCents;
  }

  if (input.sourceKind === "physical_receipt") {
    if (input.physicalReceiptIds.length === 0) {
      return { success: false, error: { type: "RECEIPTS_REQUIRED" } };
    }

    const receipts = await db
      .select({ id: physicalWorkReceipt.id, claimId: physicalWorkReceipt.claimId })
      .from(physicalWorkReceipt)
      .where(
        and(
          inArray(physicalWorkReceipt.id, [...input.physicalReceiptIds]),
          eq(physicalWorkReceipt.projectId, context.projectId),
          // The uploader's own receipts only. Citing someone else's photograph is the
          // simplest possible forgery and it is blocked here, not in the UI.
          eq(physicalWorkReceipt.memberId, context.memberId),
        ),
      );

    for (const receiptId of input.physicalReceiptIds) {
      const found = receipts.find((receipt) => receipt.id === receiptId);
      if (!found) {
        return { success: false, error: { type: "RECEIPT_NOT_FOUND", receiptId } };
      }
      if (found.claimId !== null) {
        return { success: false, error: { type: "RECEIPT_ALREADY_CLAIMED", receiptId } };
      }
    }
  }

  const created = await db.transaction(async (tx) => {
    const [claim] = await tx
      .insert(effortClaim)
      .values({
        projectId: context.projectId,
        memberId: context.memberId,
        sourceKind: input.sourceKind,
        dailyLogId: input.sourceKind === "daily_log" ? (input.dailyLogId ?? null) : null,
        claimedForDate: input.claimedForDate,
        extractedMinutes: input.sourceKind === "daily_log" ? extractedMinutes : null,
        extractedCashInCents: input.sourceKind === "daily_log" ? extractedCashInCents : null,
        claimSummary:
          input.narrative?.trim() ||
          `Effort claim for ${input.claimedForDate} (${input.sourceKind.replace("_", " ")}).`,
        verificationStatus: "queued",
        // Pinned NOW, so a rate locked later cannot re-price this claim (§9.6).
        fairMarketRateId: effectiveRate.rateId,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();

    if (!claim) {
      throw new Error("submitEffortClaim: insert returned no row");
    }

    if (input.physicalReceiptIds.length > 0) {
      await tx
        .update(physicalWorkReceipt)
        .set({ claimId: claim.id })
        .where(
          and(
            inArray(physicalWorkReceipt.id, [...input.physicalReceiptIds]),
            // Re-asserted inside the transaction: a concurrent claim may have taken the
            // receipt between the check above and this write.
            isNull(physicalWorkReceipt.claimId),
          ),
        );
    }

    const run = await createVerificationRun(tx, {
      claim,
      attemptNumber: 1,
      triggeredByUserId: actorUserId,
      triggerReason: null,
    });

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "claim_submitted",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Submitted an effort claim",
      targetLabel: `claim ${claim.id}`,
      payload: {
        claimId: claim.id,
        runId: run.runId,
        memberId: context.memberId,
        sourceKind: input.sourceKind,
        claimedForDate: input.claimedForDate,
        // The AI-produced inputs, recorded as what they are: what the member SAID.
        extractedMinutes: BigInt(extractedMinutes),
        extractedCashInCents,
        fairMarketRateId: effectiveRate.rateId,
      },
      occurredAt: claim.createdAt,
    });

    await enqueueGroundingInTransaction(tx, run.runId);

    return { claim, runId: run.runId };
  });

  return {
    success: true,
    value: {
      claimId: created.claim.id,
      runId: created.runId,
      attemptNumber: 1,
      verificationStatus: created.claim.verificationStatus,
      claimedForDate: created.claim.claimedForDate,
    },
  };
}

async function findClaimByIdempotencyKey(
  memberId: string,
  idempotencyKey: string,
): Promise<ClaimReceipt | null> {
  const [row] = await db
    .select({ claim: effortClaim, run: claimVerificationRun })
    .from(effortClaim)
    .leftJoin(claimVerificationRun, eq(claimVerificationRun.claimId, effortClaim.id))
    .where(and(eq(effortClaim.memberId, memberId), eq(effortClaim.idempotencyKey, idempotencyKey)))
    .orderBy(desc(claimVerificationRun.attemptNumber))
    .limit(1);

  if (!row) return null;

  return {
    claimId: row.claim.id,
    runId: row.run?.id ?? "",
    attemptNumber: row.run?.attemptNumber ?? 1,
    verificationStatus: row.claim.verificationStatus,
    claimedForDate: row.claim.claimedForDate,
  };
}

export interface VerificationStepView {
  readonly id: string;
  readonly stepOrder: number;
  readonly stepKind: (typeof verificationStep.$inferSelect)["stepKind"];
  readonly status: VerificationStepStatus;
  /** When present this REPLACES `status` for the verdict. It edits a judgement, never a number. */
  readonly overriddenStatus: VerificationStepStatus | null;
  readonly findingSummary: string | null;
  readonly scoreBps: number | null;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
  readonly confidenceBps: number | null;
  readonly reviewedByUserId: string | null;
  readonly overrideReason: string | null;
  readonly reviewedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface ClaimDetailView {
  readonly id: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly sourceKind: (typeof effortClaim.$inferSelect)["sourceKind"];
  readonly dailyLogId: string | null;
  readonly claimedForDate: string;
  readonly claimSummary: string;
  /** What the member SAID. Not effort, not grounded, and it pays nobody (§9.6). */
  readonly extractedMinutes: number | null;
  readonly extractedCashInCents: string | null;
  /** What the ARTIFACTS PROVE. This, or its override, is what the ledger prices. */
  readonly groundedMinutes: number | null;
  readonly groundedCashInCents: string | null;
  readonly overriddenMinutes: number | null;
  readonly overrideReason: string | null;
  readonly verificationStatus: (typeof effortClaim.$inferSelect)["verificationStatus"];
  readonly verdictReachedAt: Date | null;
  readonly fairMarketRateId: string | null;
  readonly runs: readonly {
    readonly id: string;
    readonly attemptNumber: number;
    readonly verdict: (typeof claimVerificationRun.$inferSelect)["verdict"];
    readonly triggerReason: string | null;
    readonly scopedWindowStartsAt: Date | null;
    readonly scopedWindowEndsAt: Date | null;
    readonly startedAt: Date;
    readonly completedAt: Date | null;
    readonly steps: readonly VerificationStepView[];
  }[];
  readonly evidence: readonly {
    readonly provider: (typeof artifactEvidence.$inferSelect)["provider"];
    readonly externalId: string;
    readonly label: string;
    readonly externalUrl: string | null;
    readonly payloadSha256: string;
    readonly signatureStatus: (typeof artifactEvidence.$inferSelect)["signatureStatus"];
    readonly artifactOccurredAt: Date;
    readonly countsTowardSlices: boolean;
    /** False once a consent revocation purged the payload. The proof survives; the copy does not. */
    readonly evidenceRetained: boolean;
  }[];
}

/**
 * One row of `GET …/effort-claims` (§11j.2).
 *
 * DELIBERATELY NOT `ClaimDetailView`. That view fans out to runs, steps and evidence — four
 * queries per claim — which is right for one claim and catastrophic for a page of twenty.
 * A verification-tab index needs who, when, how much and what the verdict was; the moment a
 * reader opens one, the detail read supplies the rest.
 */
export interface ClaimSummaryView {
  readonly id: string;
  readonly memberId: string;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly sourceKind: (typeof effortClaim.$inferSelect)["sourceKind"];
  readonly claimedForDate: string;
  readonly claimSummary: string;
  readonly groundedMinutes: number | null;
  readonly groundedCashInCents: string | null;
  readonly overriddenMinutes: number | null;
  readonly verificationStatus: (typeof effortClaim.$inferSelect)["verificationStatus"];
  readonly verdictReachedAt: Date | null;
  readonly createdAt: Date;
}

export interface ListClaimsFilter {
  readonly status?: (typeof effortClaim.$inferSelect)["verificationStatus"] | undefined;
  readonly memberUserId?: string | undefined;
  readonly page: number;
  readonly limit: number;
  /** Keyset mode. Decoded by the controller (CLAUDE.md §3.1); wins over `page`. */
  readonly cursor?: DateCursor | undefined;
}

export interface ClaimPage {
  readonly rows: readonly ClaimSummaryView[];
  /**
   * OFFSET MODE ONLY, and null in keyset mode rather than 0 — a keyset page does not know
   * the size of the set it is walking, and reporting 0 would render as "no claims" beneath
   * a list of claims. The controller omits the `pagination` block when this is null.
   */
  readonly total: number | null;
  /** The `cursor` to ask for next, or null at the end. Always null in offset mode. */
  readonly nextCursor: string | null;
}

/**
 * `GET …/effort-claims` — the project's claims, newest claimed-date first (§11j.2).
 *
 * ANY MEMBER SEES ANY MEMBER'S CLAIMS, which matches `listAllocationProposals` and §9's
 * transparency posture: the whole point of Proof of Effort is that the people sharing a pie
 * can audit what everyone else was credited for. The filter is `memberUserId` — the public
 * user id, as on `…/members/:memberUserId/fair-market-rate` — not the internal `memberId`.
 *
 * `effort_claim_projectId_claimedForDate_idx` on (projectId, claimedForDate, id) matches
 * this ORDER BY exactly — declared ASC and scanned backwards, which Postgres can do because
 * both columns run the same direction.
 *
 * KEYSET WHEN GIVEN A CURSOR, OFFSET OTHERWISE (§11l.2 item 4). `page` stays for back-compat
 * and loses to `cursor` when both arrive: offset paging drifts under concurrent inserts, so a
 * client that has adopted the cursor must not be silently dropped back onto the old
 * behaviour. The COUNT is skipped entirely in keyset mode — it is the more expensive half of
 * this read and answers a question the caller did not ask.
 *
 * `nextCursor` IS RETURNED IN BOTH MODES, and that is what makes the cursor reachable at all.
 * A first request carries no cursor by definition, so gating the cursor on having received
 * one left keyset mode with no entrance — see the `.limit()` note below.
 */
export async function listClaims(projectId: string, filter: ListClaimsFilter): Promise<ClaimPage> {
  const conditions = [eq(effortClaim.projectId, projectId)];
  if (filter.status !== undefined) {
    conditions.push(eq(effortClaim.verificationStatus, filter.status));
  }
  if (filter.memberUserId !== undefined) {
    // Filtered on the join, not with a second query: `projectMember` is already joined to
    // resolve the display name.
    conditions.push(eq(projectMember.userId, filter.memberUserId));
  }
  // The COUNT's predicate, fixed before the cursor term is added below: a keyset page has no
  // total, and counting the rows AFTER the cursor would answer a question nobody asked.
  const countPredicate = and(...conditions);

  const isKeyset = filter.cursor !== undefined;
  if (filter.cursor !== undefined) {
    // The two-term row comparison: a strictly earlier claimed-date, OR the same date with a
    // smaller id. Many claims share one date — it is the day the work is claimed FOR — so the
    // tiebreaker is doing real work here, not guarding a theoretical collision.
    conditions.push(
      or(
        lt(effortClaim.claimedForDate, filter.cursor.calendarDate),
        and(
          eq(effortClaim.claimedForDate, filter.cursor.calendarDate),
          lt(effortClaim.id, filter.cursor.id),
        ),
      ) ?? sql`true`,
    );
  }
  const predicate = and(...conditions);

  const baseQuery = db
    .select({ claim: effortClaim, memberUserId: projectMember.userId, memberName: user.name })
    .from(effortClaim)
    .innerJoin(projectMember, eq(projectMember.id, effortClaim.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId));

  const [selectedRows, totalRows] = await Promise.all([
    baseQuery
      .where(predicate)
      // §4c rule 4 — ends in a unique column.
      .orderBy(desc(effortClaim.claimedForDate), desc(effortClaim.id))
      // One extra row ALWAYS, purely to answer "is there another page?" without a COUNT —
      // the same probe the ledger and the inbox use. Fetched in offset mode too, because a
      // cursor a caller cannot obtain is a cursor nobody can use: `hasMore` used to be
      // gated on `isKeyset`, so a first request — which by definition carries no cursor —
      // got `nextCursor: null` and could never bootstrap into keyset mode. The
      // keyset-ONLY reads in this repo never had that gate (`daily-logs.service.ts`,
      // `notifications.service.ts`, `project-audit.service.ts`), which is why the
      // daily-log feed could page and this read could not.
      .limit(filter.limit + 1)
      .offset(isKeyset ? 0 : (filter.page - 1) * filter.limit),
    isKeyset
      ? undefined
      : db
          .select({ total: sql<number>`count(*)::int` })
          .from(effortClaim)
          .innerJoin(projectMember, eq(projectMember.id, effortClaim.memberId))
          // JOINED TO `user` LIKE THE ROW QUERY ABOVE. Without it the two predicates range
          // over different row sets, so a claim whose user row is missing is counted but
          // never listed — `total` over-reports and the last page renders empty.
          .innerJoin(user, eq(user.id, projectMember.userId))
          .where(countPredicate),
  ]);

  const totalRow = totalRows?.[0];
  const rows = selectedRows.slice(0, filter.limit);
  const lastRow = rows.at(-1);
  // NOT gated on `isKeyset`. Offset mode returns `nextCursor` alongside its `pagination`
  // block, and both are honest at once: offset mode runs the COUNT, so `total` is real, and
  // the extra row above makes `hasMore` real. Keyset mode still drops `pagination` — that is
  // a separate ruling (see the controller) and it is unchanged, because the block's
  // `total`/`totalPages` need the COUNT keyset mode deliberately skips.
  const hasMore = selectedRows.length > filter.limit && lastRow !== undefined;

  return {
    rows: rows.map((row) => ({
      id: row.claim.id,
      memberId: row.claim.memberId,
      memberUserId: row.memberUserId,
      memberName: row.memberName,
      sourceKind: row.claim.sourceKind,
      claimedForDate: row.claim.claimedForDate,
      claimSummary: row.claim.claimSummary,
      groundedMinutes: row.claim.groundedMinutes,
      // §4b — bigint crosses the wire as a decimal string, never a JSON number.
      groundedCashInCents: row.claim.groundedCashInCents?.toString() ?? null,
      overriddenMinutes: row.claim.overriddenMinutes,
      verificationStatus: row.claim.verificationStatus,
      verdictReachedAt: row.claim.verdictReachedAt,
      createdAt: row.claim.createdAt,
    })),
    total: isKeyset ? null : (totalRow?.total ?? 0),
    nextCursor: hasMore
      ? encodeDateCursor({ calendarDate: lastRow.claim.claimedForDate, id: lastRow.claim.id })
      : null,
  };
}

/** `GET …/effort-claims/:claimId` — claim + all runs + steps in `stepOrder` + evidence. */
export async function findClaimDetail(
  projectId: string,
  claimId: string,
): Promise<ClaimDetailView | null> {
  const [row] = await db
    .select({ claim: effortClaim, memberName: user.name })
    .from(effortClaim)
    .innerJoin(projectMember, eq(projectMember.id, effortClaim.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    // BOTH columns: a claim id from another project must read as absent, not as forbidden.
    .where(and(eq(effortClaim.id, claimId), eq(effortClaim.projectId, projectId)));

  if (!row) return null;

  const runs = await db
    .select()
    .from(claimVerificationRun)
    .where(eq(claimVerificationRun.claimId, claimId))
    .orderBy(asc(claimVerificationRun.attemptNumber));

  const steps =
    runs.length === 0
      ? []
      : await db
          .select()
          .from(verificationStep)
          .where(
            inArray(
              verificationStep.runId,
              runs.map((run) => run.id),
            ),
          )
          // Canonical ordering (§9.4): by run, then by stepOrder — never by insertion.
          .orderBy(asc(verificationStep.runId), asc(verificationStep.stepOrder));

  const evidence = await db
    .select()
    .from(artifactEvidence)
    .where(eq(artifactEvidence.claimId, claimId))
    .orderBy(asc(artifactEvidence.artifactOccurredAt), asc(artifactEvidence.id));

  return {
    id: row.claim.id,
    memberId: row.claim.memberId,
    memberName: row.memberName,
    sourceKind: row.claim.sourceKind,
    dailyLogId: row.claim.dailyLogId,
    claimedForDate: row.claim.claimedForDate,
    claimSummary: row.claim.claimSummary,
    extractedMinutes: row.claim.extractedMinutes,
    extractedCashInCents: row.claim.extractedCashInCents?.toString() ?? null,
    groundedMinutes: row.claim.groundedMinutes,
    groundedCashInCents: row.claim.groundedCashInCents?.toString() ?? null,
    overriddenMinutes: row.claim.overriddenMinutes,
    overrideReason: row.claim.overrideReason,
    verificationStatus: row.claim.verificationStatus,
    verdictReachedAt: row.claim.verdictReachedAt,
    fairMarketRateId: row.claim.fairMarketRateId,
    runs: runs.map((run) => ({
      id: run.id,
      attemptNumber: run.attemptNumber,
      verdict: run.verdict,
      triggerReason: run.triggerReason,
      scopedWindowStartsAt: run.scopedWindowStartsAt,
      scopedWindowEndsAt: run.scopedWindowEndsAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      steps: steps.filter((step) => step.runId === run.id),
    })),
    evidence: evidence.map((artifact) => ({
      provider: artifact.provider,
      externalId: artifact.externalId,
      label: artifact.label,
      externalUrl: artifact.externalUrl,
      payloadSha256: artifact.payloadSha256,
      signatureStatus: artifact.signatureStatus,
      artifactOccurredAt: artifact.artifactOccurredAt,
      countsTowardSlices: artifact.countsTowardSlices,
      evidenceRetained: artifact.evidenceRetained,
    })),
  };
}

/**
 * `POST …/effort-claims/:claimId/reverify` — a NEW run, never an edit to the old one.
 *
 * `409 CLAIM_SETTLED` once the window has locked: at that point slices are in an
 * append-only ledger, and the correction mechanism is a reversal, not a re-run.
 */
export async function requestReverification(
  context: { readonly projectId: string },
  claimId: string,
  reason: string,
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<ClaimReceipt, EffortClaimError>> {
  const [claim] = await db
    .select()
    .from(effortClaim)
    .where(and(eq(effortClaim.id, claimId), eq(effortClaim.projectId, context.projectId)));

  if (!claim) {
    return { success: false, error: { type: "CLAIM_NOT_FOUND", claimId } };
  }

  const [proposal] = await db
    .select({ status: sliceAllocationProposal.status })
    .from(sliceAllocationProposal)
    .where(eq(sliceAllocationProposal.claimId, claimId));

  if (proposal && (proposal.status === "locked" || proposal.status === "consensus_reached")) {
    return { success: false, error: { type: "CLAIM_SETTLED" } };
  }

  const [latestRun] = await db
    .select({ attemptNumber: claimVerificationRun.attemptNumber })
    .from(claimVerificationRun)
    .where(eq(claimVerificationRun.claimId, claimId))
    .orderBy(desc(claimVerificationRun.attemptNumber))
    .limit(1);

  const attemptNumber = (latestRun?.attemptNumber ?? 0) + 1;

  const runId = await db.transaction(async (tx) => {
    const run = await createVerificationRun(tx, {
      claim,
      attemptNumber,
      triggeredByUserId: actorUserId,
      triggerReason: reason,
    });

    await tx
      .update(effortClaim)
      .set({ verificationStatus: "queued", verdictReachedAt: null })
      .where(eq(effortClaim.id, claimId));

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "claim_reverification_requested",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Requested re-verification",
      targetLabel: `claim ${claimId}`,
      detailNote: reason,
      payload: { claimId, runId: run.runId, attemptNumber: BigInt(attemptNumber) },
      occurredAt: new Date(),
    });

    await enqueueGroundingInTransaction(tx, run.runId);
    return run.runId;
  });

  return {
    success: true,
    value: {
      claimId,
      runId,
      attemptNumber,
      verificationStatus: "queued",
      claimedForDate: claim.claimedForDate,
    },
  };
}

/**
 * Not paginated by page number: a queue that needs a second page is a backlog, and the
 * answer to a backlog is to work it, not to scroll it. A cap keeps one project's flood from
 * becoming an unbounded response.
 */
const DEFAULT_OVERRIDE_QUEUE_LIMIT = 50;
const MAXIMUM_OVERRIDE_QUEUE_LIMIT = 200;

/**
 * One row of `GET …/override-queue` — a step a human has been asked to look at and has not
 * yet answered.
 */
export interface OverrideQueueRow {
  readonly stepId: string;
  readonly claimId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  readonly memberUserId: string;
  readonly memberName: string;
  readonly stepKind: (typeof verificationStep.$inferSelect)["stepKind"];
  readonly stepOrder: number;
  /** Why the pipeline stopped short of passing it. Null when the step recorded no finding. */
  readonly findingSummary: string | null;
  readonly scoreBps: number | null;
  readonly confidenceBps: number | null;
  readonly claimedForDate: string;
  readonly claimSummary: string;
  /** The claim's current verdict — `flagged_for_review` for every row here, by construction. */
  readonly verificationStatus: (typeof effortClaim.$inferSelect)["verificationStatus"];
  /** When the step finished and became a question for a person. Ends the sort. */
  readonly flaggedAt: Date;
}

/**
 * `GET …/:projectSlug/override-queue` — the human-oversight queue (§11l, Appendix D3).
 *
 * **THE RULING THIS SETTLES.** §11l.1 asked whether a distinct "a human was asked to look at
 * this and has not yet answered" entity was needed for EU AI Act Art. 14, or whether the
 * flagged-claims filter was already it. It is a PREDICATE, not an entity, and this read is
 * that predicate stated once:
 *
 *   `verification_step.status = 'flagged'` AND `overridden_status IS NULL`
 *
 * A request for review is not an event somebody files — it is the pipeline flagging a step,
 * which is already an append-only fact with a timestamp, an author (the model, named in
 * `modelName`/`promptVersion`) and a finding. Adding a `VerificationOverrideRequest` table
 * would duplicate all four and introduce the one failure a queue must not have: a row saying
 * review is pending when the step it points at was answered.
 *
 * **It is per STEP, not per claim**, which is what `?status=flagged_for_review` on the claims
 * list could not express: a claim with four steps can have one answered and one waiting, and
 * a reviewer needs the one still waiting rather than the claim it belongs to. Answering a
 * step removes it from this read in the same statement that records the answer, because the
 * override quartet moves atomically (`verification_step_override_ck`).
 *
 * Oldest first: a queue is worked from the front, and the oldest unanswered flag is the one
 * whose member has been waiting longest on equity that is not being minted. Ends in a unique
 * column (§4c rule 4).
 */
export async function listOverrideQueue(
  projectId: string,
  options: { readonly limit?: number | undefined } = {},
): Promise<readonly OverrideQueueRow[]> {
  const limit = Math.min(
    options.limit ?? DEFAULT_OVERRIDE_QUEUE_LIMIT,
    MAXIMUM_OVERRIDE_QUEUE_LIMIT,
  );

  const rows = await db
    .select({
      stepId: verificationStep.id,
      claimId: effortClaim.id,
      runId: claimVerificationRun.id,
      attemptNumber: claimVerificationRun.attemptNumber,
      memberUserId: projectMember.userId,
      memberName: user.name,
      stepKind: verificationStep.stepKind,
      stepOrder: verificationStep.stepOrder,
      findingSummary: verificationStep.findingSummary,
      scoreBps: verificationStep.scoreBps,
      confidenceBps: verificationStep.confidenceBps,
      claimedForDate: effortClaim.claimedForDate,
      claimSummary: effortClaim.claimSummary,
      verificationStatus: effortClaim.verificationStatus,
      // `completedAt` is when the step became a question for a person; `createdAt` is when
      // it was queued to run. COALESCE rather than either alone: a step flagged by a
      // pipeline that crashed before stamping `completedAt` still belongs in the queue.
      flaggedAt: sql<Date>`coalesce(${verificationStep.completedAt}, ${verificationStep.createdAt})`,
    })
    .from(verificationStep)
    .innerJoin(claimVerificationRun, eq(claimVerificationRun.id, verificationStep.runId))
    .innerJoin(effortClaim, eq(effortClaim.id, claimVerificationRun.claimId))
    .innerJoin(projectMember, eq(projectMember.id, effortClaim.memberId))
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(
      and(
        eq(effortClaim.projectId, projectId),
        eq(verificationStep.status, "flagged"),
        // The whole definition of "still waiting". An answered step keeps its `flagged`
        // status forever — the override REPLACES it for the verdict rather than editing it
        // (§9.1) — so filtering on status alone would show answered work as pending.
        isNull(verificationStep.overriddenStatus),
      ),
    )
    .orderBy(asc(verificationStep.createdAt), asc(verificationStep.id))
    .limit(limit);

  return rows;
}

/**
 * `PATCH …/effort-claims/:claimId/steps/:stepId/override` — **the only hand-edit in the
 * domain, and it edits an AI JUDGEMENT, not a number.**
 *
 * The override writes the quartet (status, reviewer, reason, instant) and re-runs
 * finalization. The slice count is then recomputed BY THE FORMULA from the new verdict —
 * which is exactly §9.1's correction model: change an input, let the formula recompute,
 * never UPDATE an output.
 */
export async function overrideVerificationStep(
  context: { readonly projectId: string },
  claimId: string,
  stepId: string,
  input: {
    readonly overriddenStatus: Exclude<VerificationStepStatus, "pending">;
    readonly overrideReason: string;
  },
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<VerificationStepView, EffortClaimError>> {
  const [row] = await db
    .select({ step: verificationStep, runId: claimVerificationRun.id })
    .from(verificationStep)
    .innerJoin(claimVerificationRun, eq(claimVerificationRun.id, verificationStep.runId))
    .innerJoin(effortClaim, eq(effortClaim.id, claimVerificationRun.claimId))
    .where(
      and(
        eq(verificationStep.id, stepId),
        eq(effortClaim.id, claimId),
        eq(effortClaim.projectId, context.projectId),
      ),
    );

  if (!row) {
    return { success: false, error: { type: "STEP_NOT_FOUND", stepId } };
  }

  const [proposal] = await db
    .select({ status: sliceAllocationProposal.status })
    .from(sliceAllocationProposal)
    .where(eq(sliceAllocationProposal.claimId, claimId));

  if (proposal && (proposal.status === "locked" || proposal.status === "consensus_reached")) {
    return { success: false, error: { type: "CLAIM_SETTLED" } };
  }

  const reviewedAt = new Date();

  const updated = await db.transaction(async (tx) => {
    const [next] = await tx
      .update(verificationStep)
      .set({
        overriddenStatus: input.overriddenStatus,
        reviewedByUserId: actorUserId,
        overrideReason: input.overrideReason,
        reviewedAt,
      })
      .where(eq(verificationStep.id, stepId))
      .returning();

    if (!next) {
      throw new Error("overrideVerificationStep: update returned no row");
    }

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "verification_step_overridden",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Overrode a verification step",
      targetLabel: `step ${stepId}`,
      detailNote: input.overrideReason,
      payload: {
        claimId,
        runId: row.runId,
        stepKind: next.stepKind,
        // Both, so an auditor sees what the machine said AND what the human decided.
        machineStatus: next.status,
        overriddenStatus: input.overriddenStatus,
      },
      occurredAt: reviewedAt,
    });

    return next;
  });

  // Re-finalize OUTSIDE the transaction: the override is committed either way, and a
  // queue hiccup must not roll back a human's review. The generation makes this enqueue
  // distinct from the run's first finalization inside pg-boss's dedup window.
  await requeueFinalizeVerdict(row.runId, Math.floor(reviewedAt.getTime() / 1_000));

  return {
    success: true,
    value: {
      id: updated.id,
      stepOrder: updated.stepOrder,
      stepKind: updated.stepKind,
      status: updated.status,
      overriddenStatus: updated.overriddenStatus,
      findingSummary: updated.findingSummary,
      scoreBps: updated.scoreBps,
      modelName: updated.modelName,
      promptVersion: updated.promptVersion,
      confidenceBps: updated.confidenceBps,
      reviewedByUserId: updated.reviewedByUserId,
      overrideReason: updated.overrideReason,
      reviewedAt: updated.reviewedAt,
      completedAt: updated.completedAt,
    },
  };
}

/**
 * STAGE 5 — the verdict, and the moment a window opens (§9.7, §9.8).
 *
 * Everything here happens in ONE transaction: the run completes, the claim takes its
 * verdict, `daily_log.effortVerificationStatus` finally moves off `not_run` (the column §8
 * shipped and left to §9), and a proposal opens with `proposedSlices` frozen on it.
 *
 * **NOTHING IS WRITTEN TO THE LEDGER HERE.** No slices exist until the window locks.
 *
 * A `pending` step at this point means a stage never ran — a deploy mid-pipeline, a
 * dead-lettered job. It resolves to `failed`, not to a retry loop: §9.7's rule is that the
 * pipeline always reaches a verdict, and a broken pipeline awards zero.
 */
export async function finalizeClaimVerdict(runId: string): Promise<void> {
  const [row] = await db
    .select({ run: claimVerificationRun, claim: effortClaim })
    .from(claimVerificationRun)
    .innerJoin(effortClaim, eq(effortClaim.id, claimVerificationRun.claimId))
    .where(eq(claimVerificationRun.id, runId));

  if (!row) return;

  const outcomes = await loadStepOutcomes(runId);
  const stragglers = outcomes.filter(
    (step) => (step.overriddenStatus ?? step.status) === "pending",
  );

  if (stragglers.length > 0) {
    await db
      .update(verificationStep)
      .set({
        status: "failed",
        findingSummary:
          "This step never completed. The pipeline reaches a verdict regardless, and an incomplete audit awards zero (§9.7).",
        completedAt: new Date(),
      })
      .where(and(eq(verificationStep.runId, runId), eq(verificationStep.status, "pending")));
  }

  const decision = decideClaimVerdict(await loadStepOutcomes(runId));
  const verdict =
    decision.verdict === "incomplete"
      ? // Unreachable after the straggler sweep above; kept because "award zero" is the
        // only safe reading of a verdict function that could not decide.
        ("unverified" as const)
      : decision.verdict;

  const { claim } = row;
  const priced = await priceClaim(claim, verdict);

  await db.transaction(async (tx) => {
    // A second finalization of the same run — an override, a redelivery — must not open a
    // second window. `slice_allocation_proposal_claimId_unq` would reject it anyway; this
    // makes the no-op explicit and cheap.
    const [existingProposal] = await tx
      .select({ id: sliceAllocationProposal.id, status: sliceAllocationProposal.status })
      .from(sliceAllocationProposal)
      .where(eq(sliceAllocationProposal.claimId, claim.id))
      .for("update");

    await tx
      .update(claimVerificationRun)
      .set({ verdict, completedAt: new Date() })
      .where(eq(claimVerificationRun.id, runId));

    await tx
      .update(effortClaim)
      .set({ verificationStatus: verdict, verdictReachedAt: new Date() })
      .where(eq(effortClaim.id, claim.id));

    // THE COLUMN §8 SHIPPED AND LEFT TO US. Until this line ran, nothing in the codebase
    // had ever moved `daily_log.effortVerificationStatus` off `not_run`.
    if (claim.dailyLogId !== null) {
      await tx
        .update(dailyLog)
        .set({ effortVerificationStatus: verdict })
        .where(eq(dailyLog.id, claim.dailyLogId));
    }

    // The claimant. A SYSTEM ACTOR — `actorUserId` is null here, exactly as it is on the
    // audit entry below, because the pipeline reached this verdict and no person did.
    //
    // Sent for EVERY terminal verdict, not only the bad ones: `verified` is the one that
    // opens a 24-hour dispute window (§9.8), and a member who is never told it opened
    // cannot use it. Telling people only about failures is how a contestability right
    // becomes decorative.
    const [claimant] = await tx
      .select({ userId: projectMember.userId })
      .from(projectMember)
      .where(eq(projectMember.id, claim.memberId));

    if (claimant) {
      await enqueueNotifications(tx, null, [
        {
          recipientUserId: claimant.userId,
          kind: "effort_claim_verdict_reached",
          projectId: claim.projectId,
          actorUserId: null,
          payload: { claimId: claim.id, runId, verdict },
        },
      ]);
    }

    await appendAuditEntry(tx, {
      projectId: claim.projectId,
      eventKind: "claim_verdict_reached",
      actorUserId: null,
      actorRoleSnapshot: "system",
      actionLabel: "Reached a verification verdict",
      targetLabel: `claim ${claim.id}`,
      ...(decision.decidedByStepKind === null
        ? {}
        : { detailNote: `Decided by ${decision.decidedByStepKind}.` }),
      payload: {
        claimId: claim.id,
        runId,
        verdict,
        decidedByStepKind: decision.decidedByStepKind,
        proposedTimeSliceNumerator: priced.timeNumerator,
        proposedCashSliceNumerator: priced.cashNumerator,
        proposedSlices: BigInt(priced.proposedSlices),
      },
      occurredAt: new Date(),
    });

    if (existingProposal) {
      // A SECOND finalization of the same claim. Two paths reach here and they settle
      // differently:
      //
      //   - the proposal is still `open` — a human overrode a step, so the window stays
      //     open on its ORIGINAL clock and only the frozen numbers are re-priced;
      //   - the proposal is `disputed` and this run carried a scoped window — a dispute
      //     resolved as `re_verified`, and the re-derived number settles it now (§9.8).
      await tx
        .update(sliceAllocationProposal)
        .set({
          verdict,
          proposedSlices: priced.proposedSlices,
          proposedSliceNumerator: priced.timeNumerator + priced.cashNumerator,
          proposedTimeSliceNumerator: priced.timeNumerator,
          proposedCashSliceNumerator: priced.cashNumerator,
          // Escrow tracks the proposal while it is frozen, so a re-price must move it too
          // or `proposal_disputed_shape` rejects the row.
          ...(existingProposal.status === "disputed"
            ? { escrowedSlices: priced.proposedSlices }
            : {}),
        })
        .where(eq(sliceAllocationProposal.id, existingProposal.id));

      const isScopedReverification =
        existingProposal.status === "disputed" && row.run.scopedWindowStartsAt !== null;

      if (isScopedReverification) {
        const [repriced] = await tx
          .select()
          .from(sliceAllocationProposal)
          .where(eq(sliceAllocationProposal.id, existingProposal.id));

        if (!repriced) {
          throw new Error("finalizeClaimVerdict: re-priced proposal could not be read back");
        }

        await settleProposal(tx, {
          proposal: repriced,
          amounts: {
            timeNumerator: priced.timeNumerator,
            cashNumerator: priced.cashNumerator,
          },
          nextStatus: "consensus_reached",
          actorUserId: null,
          actorRoleSnapshot: "system",
          auditActionLabel: "Settled a re-verified allocation",
          auditDetailNote: `Re-derived from the agreed window ${row.run.scopedWindowStartsAt?.toISOString() ?? ""} – ${row.run.scopedWindowEndsAt?.toISOString() ?? ""}.`,
        });
      }

      return;
    }

    // A FLAGGED OR UNVERIFIED VERDICT STILL OPENS A WINDOW, at zero slices (§9.8). The
    // solar mock's "960 slices withheld" entry is this case: if withheld claims vanished
    // silently, members would lose contributions with no recourse.
    await openAllocationProposal(tx, {
      projectId: claim.projectId,
      claimId: claim.id,
      memberId: claim.memberId,
      runId,
      verdict,
      proposedSlices: priced.proposedSlices,
      proposedSliceNumerator: priced.timeNumerator + priced.cashNumerator,
      proposedTimeSliceNumerator: priced.timeNumerator,
      proposedCashSliceNumerator: priced.cashNumerator,
      fairMarketRateId: priced.fairMarketRateId,
      actorRoleSnapshot: "system",
    });
  });
}

interface PricedClaim {
  readonly timeNumerator: bigint;
  readonly cashNumerator: bigint;
  readonly proposedSlices: number;
  readonly fairMarketRateId: string | null;
}

/**
 * Turns a verdict plus the claim's grounded inputs into frozen numerators.
 *
 * ROUNDED PER CONTRIBUTION KIND, because §9.3 rounds once PER LEDGER ENTRY and settlement
 * writes one entry per kind. Summing the numerators and rounding once would produce a
 * number the ledger can never reproduce.
 *
 * A non-`verified` verdict prices at ZERO — and still opens a window, because the entry
 * that eventually posts at zero is the member's evidence that their work was seen.
 */
async function priceClaim(
  claim: typeof effortClaim.$inferSelect,
  verdict: "verified" | "flagged_for_review" | "unverified",
): Promise<PricedClaim> {
  if (verdict !== "verified") {
    return {
      timeNumerator: 0n,
      cashNumerator: 0n,
      proposedSlices: 0,
      fairMarketRateId: claim.fairMarketRateId,
    };
  }

  const effortMinutes = claim.overriddenMinutes ?? claim.groundedMinutes ?? 0;
  const cashInCents = claim.groundedCashInCents ?? 0n;

  const claimedInstant = new Date(`${claim.claimedForDate}T23:59:59.999Z`);
  const rate = await findEffectiveRate(claim.memberId, claimedInstant);

  // No locked rate covering the claimed day: the time half cannot be priced at all, and
  // guessing one is exactly what this domain exists to prevent. Cash still pays — it
  // needs no rate.
  const timeNumerator =
    rate === null || effortMinutes === 0
      ? 0n
      : timeSliceNumerator(effortMinutes, rate.unpaidRateCentsPerHour);
  const cashNumerator = cashInCents > 0n ? cashSliceNumerator(cashInCents) : 0n;

  return {
    timeNumerator,
    cashNumerator,
    proposedSlices: computeSlicesAwarded(timeNumerator) + computeSlicesAwarded(cashNumerator),
    fairMarketRateId: rate?.rateId ?? claim.fairMarketRateId,
  };
}
