/**
 * End-to-end smoke test for the §10 research-program domain, against a REAL database.
 *
 *   pnpm db:smoke-research-programs
 *
 * WHY THIS EXISTS. The vitest suite mocks `#src/db/index.js` wholesale, so it can prove things
 * about arithmetic and nothing about behaviour that spans layers. Everything asserted here is
 * cross-layer, and every one of them is a claim §10 makes that a green typecheck cannot check:
 *
 *   - a `pending` program is 404 to a stranger and readable by its creator, and is CLOSED to
 *     contributions even for that creator (the review gate actually gating something);
 *   - publishing is idempotent-once: a second decision is a 409, not a silent overwrite of who
 *     was accountable for the first;
 *   - a branch claim is idempotent in BOTH directions, so a double-tap cannot inflate
 *     `contributorCount`;
 *   - a re-parent rewrites the whole subtree's `ancestorPath` in one transaction, and a cycle
 *     is refused;
 *   - `PUT …/reaction` twice leaves the count at 1, and `DELETE` twice leaves it at 0 — the
 *     idempotent-by-verb property, seen rather than assumed;
 *   - a reply to a reply is a 409, not a silently-nested third level;
 *   - the same `idempotencyKey` on two effort logs returns the FIRST row rather than
 *     double-counting time;
 *   - `GET …/stats` is a 404 before the job runs and a 200 after — never fabricated zeroes;
 *   - `recompute-branch-signals` derives `missing` for an unclaimed uncovered branch, and
 *     `emerging` once somebody claims it. That job is the map's editorial voice, so its output
 *     is the single most important thing in this file.
 *
 * Creates a disposable user, program, branches and posts; exercises the REAL services; asserts
 * the outcomes; and removes everything it created in a `finally`, so a failed assertion still
 * cleans up. Needs no worker and no HTTP server.
 *
 * Exits non-zero on any failed assertion.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
// Only the two tables this file writes through drizzle. The teardown speaks raw SQL,
// because it has to disable the append-only triggers, which drizzle cannot express.
import {
  researchPaperCategory,
  researchProgramBranch,
  researchProgramModerationAction,
  user,
} from "#src/db/schema.js";
import { stopSendOnlyBoss } from "#src/lib/jobs.js";
import { normalizeToTokenSet } from "#src/lib/text-similarity.js";
import {
  countOverlappingGroups,
  decideBranchStatus,
  recomputeBranchSignalsForProgram,
} from "#src/modules/rnd/programs/research-branch-signals.service.js";
import * as papersService from "#src/modules/rnd/programs/research-papers.service.js";
import {
  requireProgramVisible,
  requireProgramWritable,
} from "#src/modules/rnd/programs/research-program-access.service.js";
import * as branchesService from "#src/modules/rnd/programs/research-program-branches.service.js";
import * as moderationService from "#src/modules/rnd/programs/research-program-moderation.service.js";
import * as participantsService from "#src/modules/rnd/programs/research-program-participants.service.js";
import * as postsService from "#src/modules/rnd/programs/research-program-posts.service.js";
import { recomputeProgramStats } from "#src/modules/rnd/programs/research-program-stats.service.js";
import * as programsService from "#src/modules/rnd/programs/research-programs.service.js";

const SMOKE_PREFIX = "smoke-rnd-program";

interface Assertion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const assertions: Assertion[] = [];

function check(label: string, passed: boolean, detail: string): void {
  assertions.push({ label, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${label} — ${detail}`);
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const creatorUserId = `${SMOKE_PREFIX}-creator-${suffix}`;
  const strangerUserId = `${SMOKE_PREFIX}-stranger-${suffix}`;
  let programId: string | null = null;
  let categoryId: string | null = null;

  try {
    // --- fixtures ---------------------------------------------------------------

    await db.insert(user).values([
      {
        id: creatorUserId,
        name: "Smoke Creator",
        email: `${creatorUserId}@smoke.invalid`,
        emailVerified: true,
      },
      {
        id: strangerUserId,
        name: "Smoke Stranger",
        email: `${strangerUserId}@smoke.invalid`,
        emailVerified: true,
      },
    ]);

    const [staff] = await db
      .select({ id: user.id, platformRole: user.platformRole })
      .from(user)
      .where(isNotNull(user.platformRole))
      .limit(1);

    if (!staff?.platformRole) {
      console.error(
        [
          "",
          "  No platform staff account exists, so the moderation half cannot be exercised.",
          "    pnpm db:grant-platform-role <email> admin",
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
      return;
    }
    const staffContext = { staffUserId: staff.id, platformRole: staff.platformRole } as const;

    console.log("\n--- 1. Create, and the review gate ---");

    const created = await programsService.createResearchProgram({
      title: `Smoke Program ${suffix}`,
      tagline: "A disposable program used to smoke-test the §10 surface.",
      missionStatement:
        "Created by pnpm db:smoke-research-programs and removed again at the end of the run.",
      createdByUserId: creatorUserId,
    });
    check(
      "a proposed program lands `pending`",
      created.success && created.value.status === "pending",
      created.success ? created.value.slug : "create FAILED",
    );
    if (!created.success) return;
    programId = created.value.programId;
    const programSlug = created.value.slug;

    const strangerRead = await requireProgramVisible(programSlug, strangerUserId, false);
    check(
      "a `pending` program is NOT_FOUND to a stranger",
      !strangerRead.success && strangerRead.error.type === "NOT_FOUND",
      strangerRead.success ? "visible — WRONG" : strangerRead.error.type,
    );

    const signedOutRead = await requireProgramVisible(programSlug, null, false);
    check(
      "a `pending` program is NOT_FOUND signed out",
      !signedOutRead.success,
      signedOutRead.success ? "visible — WRONG" : "hidden",
    );

    const creatorRead = await requireProgramVisible(programSlug, creatorUserId, false);
    check(
      "its creator CAN read it",
      creatorRead.success && creatorRead.value.isCreator,
      creatorRead.success ? "visible, isCreator true" : "hidden — WRONG",
    );

    // The gate has to gate something. If a pending program accepted contributions it would be
    // a working forum that merely lacks an index entry, and review would buy nothing.
    const creatorWrite = await requireProgramWritable(programSlug, creatorUserId, false);
    check(
      "even its CREATOR cannot contribute while it is `pending`",
      !creatorWrite.success && creatorWrite.error.type === "PROGRAM_NOT_PUBLISHED",
      creatorWrite.success
        ? "writable — WRONG, the review gate buys nothing"
        : creatorWrite.error.type,
    );

    console.log("\n--- 2. Moderation: publish once, and only once ---");

    const published = await moderationService.decideProgramPublication({
      programSlug,
      decision: "published",
      reviewerNote: "Approved by the smoke test.",
      staff: staffContext,
    });
    check(
      "a moderator can publish it",
      published.success,
      published.success ? "published" : "FAILED",
    );

    const publishedAgain = await moderationService.decideProgramPublication({
      programSlug,
      decision: "rejected",
      reviewerNote: "Second decision must be refused.",
      staff: staffContext,
    });
    check(
      "a SECOND decision is refused, not a silent overwrite of who was accountable",
      !publishedAgain.success && publishedAgain.error.type === "PROGRAM_ALREADY_DECIDED",
      publishedAgain.success ? "overwrote — WRONG" : publishedAgain.error.type,
    );

    const [auditedAction] = await db
      .select({ auditEntryId: researchProgramModerationAction.auditEntryId })
      .from(researchProgramModerationAction)
      .where(eq(researchProgramModerationAction.programId, programId));
    check(
      "the decision wrote a moderation action linked to a platform audit entry",
      auditedAction !== undefined && auditedAction.auditEntryId.length > 0,
      auditedAction ? `audit entry ${auditedAction.auditEntryId.slice(0, 8)}…` : "NO audit row",
    );

    const strangerAfterPublish = await requireProgramWritable(programSlug, strangerUserId, false);
    check(
      "once published, ANY signed-in user may contribute",
      strangerAfterPublish.success,
      strangerAfterPublish.success ? "writable" : "still refused — WRONG",
    );

    console.log("\n--- 3. Branch tree: paths, re-parenting, cycles ---");

    const rootBranch = await branchesService.createProgramBranch({
      programId,
      title: "Smoke root",
      summary: "The root of the disposable tree used by this smoke test.",
      parentBranchId: null,
      createdByUserId: creatorUserId,
    });
    if (!rootBranch.success) {
      check("root branch creates", false, "FAILED");
      return;
    }
    const rootBranchId = rootBranch.value.branchId;

    const childBranch = await branchesService.createProgramBranch({
      programId,
      title: "Smoke child",
      summary: "A child branch, used to prove ancestor paths are derived from the parent chain.",
      parentBranchId: rootBranchId,
      createdByUserId: creatorUserId,
    });
    if (!childBranch.success) {
      check("child branch creates", false, "FAILED");
      return;
    }
    const childBranchId = childBranch.value.branchId;

    const grandchildBranch = await branchesService.createProgramBranch({
      programId,
      title: "Smoke grandchild",
      summary: "A grandchild, so a re-parent has a real subtree to rewrite rather than one row.",
      parentBranchId: childBranchId,
      createdByUserId: creatorUserId,
    });
    if (!grandchildBranch.success) {
      check("grandchild branch creates", false, "FAILED");
      return;
    }
    const grandchildBranchId = grandchildBranch.value.branchId;

    const treeBefore = await branchesService.listProgramBranches(programId, creatorUserId);
    const grandchildBefore = treeBefore.find((row) => row.branchId === grandchildBranchId);
    check(
      "ancestorPath is derived from the parent chain, not supplied",
      grandchildBefore?.ancestorPath === `${rootBranchId}/${childBranchId}/${grandchildBranchId}`,
      grandchildBefore?.ancestorPath ?? "missing",
    );
    check(
      "depth is derived from the path",
      grandchildBefore?.depth === 2,
      `depth ${String(grandchildBefore?.depth)}`,
    );

    // A cycle: re-parenting the child under its own descendant. Caught by a prefix test on the
    // materialized path rather than a recursive walk.
    const cycleAttempt = await branchesService.updateProgramBranch({
      programId,
      branchId: childBranchId,
      parentBranchId: grandchildBranchId,
    });
    check(
      "re-parenting a branch under its own descendant is refused (BRANCH_CYCLE)",
      !cycleAttempt.success && cycleAttempt.error.type === "BRANCH_CYCLE",
      cycleAttempt.success ? "allowed — WRONG, the tree now has a loop" : cycleAttempt.error.type,
    );

    // A legitimate re-parent: the child becomes a second root, and its SUBTREE must move too.
    const reparent = await branchesService.updateProgramBranch({
      programId,
      branchId: childBranchId,
      parentBranchId: null,
    });
    check(
      "a branch can be re-parented to the root",
      reparent.success,
      reparent.success ? "moved" : "FAILED",
    );

    const treeAfter = await branchesService.listProgramBranches(programId, creatorUserId);
    const childAfter = treeAfter.find((row) => row.branchId === childBranchId);
    const grandchildAfter = treeAfter.find((row) => row.branchId === grandchildBranchId);
    check(
      "the re-parented branch's own path is rewritten",
      childAfter?.ancestorPath === childBranchId,
      childAfter?.ancestorPath ?? "missing",
    );
    check(
      "and its WHOLE SUBTREE is rewritten in the same transaction",
      grandchildAfter?.ancestorPath === `${childBranchId}/${grandchildBranchId}`,
      grandchildAfter?.ancestorPath ?? "missing",
    );

    console.log("\n--- 4. Branch claims are idempotent in both directions ---");

    await branchesService.claimProgramBranch({
      programId,
      branchId: rootBranchId,
      userId: strangerUserId,
    });
    await branchesService.claimProgramBranch({
      programId,
      branchId: rootBranchId,
      userId: strangerUserId,
    });
    const afterDoubleClaim = await branchesService.listProgramBranches(programId, strangerUserId);
    const rootAfterClaim = afterDoubleClaim.find((row) => row.branchId === rootBranchId);
    check(
      "claiming twice leaves contributorCount at 1 (a double-tap is harmless)",
      rootAfterClaim?.contributorCount === 1,
      `contributorCount ${String(rootAfterClaim?.contributorCount)}`,
    );
    check(
      "isClaimedByViewer is a per-viewer fact, computed per request",
      rootAfterClaim?.isClaimedByViewer === true,
      String(rootAfterClaim?.isClaimedByViewer),
    );

    await branchesService.releaseProgramBranchClaim({
      programId,
      branchId: rootBranchId,
      userId: strangerUserId,
    });
    const secondRelease = await branchesService.releaseProgramBranchClaim({
      programId,
      branchId: rootBranchId,
      userId: strangerUserId,
    });
    check(
      "releasing an absent claim still succeeds (the end state is what matters)",
      secondRelease.success,
      secondRelease.success ? "idempotent" : "errored — WRONG",
    );

    console.log("\n--- 5. Posts, the depth cap, and idempotent-by-verb reactions ---");

    const idea = await postsService.createProgramPost({
      programId,
      track: "idea",
      title: null,
      bodyText: "A disposable idea, used to prove reactions and the reply depth cap.",
      // Filed against a branch, so the per-branch discussion count has something to count.
      branchId: rootBranchId,
      authorUserId: creatorUserId,
    });
    if (!idea.success) {
      check("an idea posts", false, "FAILED");
      return;
    }
    const ideaPostId = idea.value.postId;

    const reply = await postsService.createPostReply({
      programId,
      parentPostId: ideaPostId,
      bodyText: "A reply at depth 1, which is the deepest a reply may go.",
      authorUserId: strangerUserId,
    });
    check("a reply posts at depth 1", reply.success, reply.success ? "posted" : "FAILED");

    if (reply.success) {
      const nestedReply = await postsService.createPostReply({
        programId,
        parentPostId: reply.value.postId,
        bodyText: "A reply to a reply, which must be refused.",
        authorUserId: creatorUserId,
      });
      check(
        "a reply to a reply is refused (REPLY_DEPTH_EXCEEDED), not silently nested",
        !nestedReply.success && nestedReply.error.type === "REPLY_DEPTH_EXCEEDED",
        nestedReply.success ? "nested — WRONG" : nestedReply.error.type,
      );
    }

    const firstReaction = await postsService.addPostReaction({
      programId,
      postId: ideaPostId,
      userId: strangerUserId,
    });
    const secondReaction = await postsService.addPostReaction({
      programId,
      postId: ideaPostId,
      userId: strangerUserId,
    });
    check(
      "PUT reaction twice leaves the count at 1 — idempotent by verb (§10)",
      firstReaction.success &&
        secondReaction.success &&
        firstReaction.value.reactionCount === 1 &&
        secondReaction.value.reactionCount === 1,
      `${String(firstReaction.success ? firstReaction.value.reactionCount : "?")} then ${String(secondReaction.success ? secondReaction.value.reactionCount : "?")}`,
    );

    const firstRemoval = await postsService.removePostReaction({
      programId,
      postId: ideaPostId,
      userId: strangerUserId,
    });
    const secondRemoval = await postsService.removePostReaction({
      programId,
      postId: ideaPostId,
      userId: strangerUserId,
    });
    check(
      "DELETE reaction twice leaves the count at 0, never negative",
      firstRemoval.success &&
        secondRemoval.success &&
        firstRemoval.value.reactionCount === 0 &&
        secondRemoval.value.reactionCount === 0,
      `${String(firstRemoval.success ? firstRemoval.value.reactionCount : "?")} then ${String(secondRemoval.success ? secondRemoval.value.reactionCount : "?")}`,
    );

    // Reporting is one per user per target, and hiding a post ACTIONS the open reports.
    await postsService.reportProgramContent({
      programId,
      targetKind: "post",
      paperId: null,
      postId: ideaPostId,
      reason: "spam",
      detailText: null,
      reporterUserId: strangerUserId,
    });
    const secondReport = await postsService.reportProgramContent({
      programId,
      targetKind: "post",
      paperId: null,
      postId: ideaPostId,
      reason: "spam",
      detailText: null,
      reporterUserId: strangerUserId,
    });
    check(
      "the same user cannot report the same target twice (ALREADY_REPORTED)",
      !secondReport.success && secondReport.error.type === "ALREADY_REPORTED",
      secondReport.success ? "duplicated — WRONG" : secondReport.error.type,
    );

    const hidden = await moderationService.decidePostVisibility({
      programId,
      postId: ideaPostId,
      decision: "hidden",
      reasonNote: "Hidden by the smoke test.",
      staff: staffContext,
    });
    check("a moderator can hide a post", hidden.success, hidden.success ? "hidden" : "FAILED");

    const hiddenFeed = await postsService.listProgramPosts({
      programId,
      viewerUserId: strangerUserId,
      filter: { track: "idea", limit: 20 },
    });
    const hiddenRow = hiddenFeed.rows.find((row) => row.postId === ideaPostId);
    check(
      "a hidden post's BODY TEXT does not travel — the row stays, the words do not",
      hiddenRow !== undefined &&
        hiddenRow.isHidden &&
        !hiddenRow.bodyText.includes("disposable idea"),
      hiddenRow ? `body: "${hiddenRow.bodyText.slice(0, 40)}"` : "row missing",
    );

    const restored = await moderationService.decidePostVisibility({
      programId,
      postId: ideaPostId,
      decision: "restored",
      reasonNote: "Restored by the smoke test — hiding is reversible by design.",
      staff: staffContext,
    });
    check(
      "hiding is REVERSIBLE, and the restore is its own audited decision",
      restored.success,
      restored.success ? "restored" : "FAILED",
    );

    // The branch panel's discussion count and recent-thread list, which exist because
    // `research_program_post.branchId` does. Without that column the panel would have had to
    // drop both — the mock showed them, so the column is what keeps the feature honest.
    const treeWithDiscussion = await branchesService.listProgramBranches(programId, creatorUserId);
    const rootWithDiscussion = treeWithDiscussion.find((row) => row.branchId === rootBranchId);
    check(
      "a branch-filed thread shows in that branch's discussionCount",
      rootWithDiscussion?.discussionCount === 1,
      `discussionCount ${String(rootWithDiscussion?.discussionCount)}`,
    );
    check(
      "and its recentThreadTitles carry the idea's body, since an idea has no title",
      (rootWithDiscussion?.recentThreadTitles.length ?? 0) === 1 &&
        (rootWithDiscussion?.recentThreadTitles[0] ?? "").startsWith("A disposable idea"),
      `titles ${JSON.stringify(rootWithDiscussion?.recentThreadTitles)}`,
    );
    const unfiledBranch = treeWithDiscussion.find((row) => row.branchId === childBranchId);
    check(
      "a branch with no threads reports 0 and an empty list, not a fabricated count",
      unfiledBranch?.discussionCount === 0 && unfiledBranch.recentThreadTitles.length === 0,
      `discussionCount ${String(unfiledBranch?.discussionCount)}`,
    );

    console.log("\n--- 6. Effort logs: the same key does not double-count ---");

    const joined = await participantsService.joinResearchProgram({
      programId,
      userId: strangerUserId,
      role: "researcher",
      compensationPreference: "equity",
      contributionSummary: null,
      fundingTrancheIndex: null,
      fundingTrancheTotal: null,
    });
    if (!joined.success) {
      check("a contributor joins", false, "FAILED");
      return;
    }
    const participantId = joined.value.participantId;

    const rejoin = await participantsService.joinResearchProgram({
      programId,
      userId: strangerUserId,
      role: "supplier",
      compensationPreference: "salary",
      contributionSummary: null,
      fundingTrancheIndex: null,
      fundingTrancheTotal: null,
    });
    check(
      "joining twice is a 409, not a silently-ignored role change",
      !rejoin.success && rejoin.error.type === "ALREADY_A_PARTICIPANT",
      rejoin.success ? "accepted — WRONG" : rejoin.error.type,
    );

    const trancheMismatch = await participantsService.updateOwnParticipation({
      programId,
      userId: strangerUserId,
      fundingTrancheIndex: 2,
      fundingTrancheTotal: 4,
    });
    check(
      "a funding tranche on a `researcher` is refused (TRANCHE_ROLE_MISMATCH)",
      !trancheMismatch.success && trancheMismatch.error.type === "TRANCHE_ROLE_MISMATCH",
      trancheMismatch.success ? "accepted — WRONG" : trancheMismatch.error.type,
    );

    const sharedKey = `smoke-effort-${suffix}`;
    const firstLog = await participantsService.logResearchEffort({
      programId,
      participantId,
      branchId: rootBranchId,
      minutes: 90,
      loggedForDate: new Date().toISOString().slice(0, 10),
      note: "Ninety minutes, logged once.",
      idempotencyKey: sharedKey,
    });
    const replayedLog = await participantsService.logResearchEffort({
      programId,
      participantId,
      branchId: rootBranchId,
      minutes: 90,
      loggedForDate: new Date().toISOString().slice(0, 10),
      note: "The same submission, retried.",
      idempotencyKey: sharedKey,
    });
    check(
      "the same idempotencyKey returns the FIRST row rather than double-counting time",
      firstLog.success &&
        replayedLog.success &&
        replayedLog.value.wasReplay &&
        firstLog.value.effortLogId === replayedLog.value.effortLogId,
      replayedLog.success ? `wasReplay ${String(replayedLog.value.wasReplay)}` : "FAILED",
    );

    const totalMinutes = await participantsService.sumProgramEffortMinutes(programId);
    check(
      "so the program's effort total is 90, not 180",
      totalMinutes === 90,
      `${String(totalMinutes)} minutes`,
    );

    const futureLog = await participantsService.logResearchEffort({
      programId,
      participantId,
      branchId: null,
      minutes: 60,
      loggedForDate: "2099-01-01",
      note: "Work not yet done.",
      idempotencyKey: `smoke-future-${suffix}`,
    });
    check(
      "logging effort for a FUTURE date is refused",
      !futureLog.success && futureLog.error.type === "EFFORT_DATE_IN_FUTURE",
      futureLog.success ? "accepted — WRONG" : futureLog.error.type,
    );

    console.log("\n--- 7. Contributions are commitments, and typed as such ---");

    const materialWithAmount = await participantsService.recordResearchContribution({
      programId,
      participantId,
      kind: "material",
      amountInCents: 50_000,
      currencyCode: "USD",
      description: "Materials do not carry an amount.",
      idempotencyKey: `smoke-contrib-bad-${suffix}`,
    });
    check(
      "a non-cash contribution carrying an amount is refused",
      !materialWithAmount.success && materialWithAmount.error.type === "CASH_AMOUNT_FORBIDDEN",
      materialWithAmount.success ? "accepted — WRONG" : materialWithAmount.error.type,
    );

    const cashCommitment = await participantsService.recordResearchContribution({
      programId,
      participantId,
      kind: "cash_commitment",
      amountInCents: 25_000_000,
      currencyCode: "USD",
      description: "A quarter of a million committed — recorded, not collected.",
      idempotencyKey: `smoke-contrib-${suffix}`,
    });
    check(
      "a cash COMMITMENT records (no money moves, and nothing here claims it did)",
      cashCommitment.success,
      cashCommitment.success ? "recorded" : "FAILED",
    );

    console.log("\n--- 8. The derived branch signals — the map's editorial voice ---");

    // The rule, checked as a pure function first, so a failure here is unambiguous about
    // whether the DECISION or the QUERY is wrong.
    check(
      "decideBranchStatus: unclaimed and uncovered is `missing`",
      decideBranchStatus({ claimCount: 0, approvedPaperCount: 0, overlappingGroupCount: 0 }) ===
        "missing",
      "pure",
    );
    check(
      "decideBranchStatus: claimed but unpublished is `emerging`",
      decideBranchStatus({ claimCount: 3, approvedPaperCount: 0, overlappingGroupCount: 0 }) ===
        "emerging",
      "pure",
    );
    check(
      "decideBranchStatus: published and uniquely held is `active`",
      decideBranchStatus({ claimCount: 3, approvedPaperCount: 1, overlappingGroupCount: 1 }) ===
        "active",
      "pure",
    );
    check(
      "decideBranchStatus: published with 2+ overlapping neighbours is `contested`",
      decideBranchStatus({ claimCount: 3, approvedPaperCount: 1, overlappingGroupCount: 2 }) ===
        "contested",
      "pure",
    );

    // And the overlap counter, on text that really is near-identical.
    const overlapProbe = countOverlappingGroups([
      {
        branchId: "a",
        comparisonTokens: normalizeToTokenSet("Senolytic clearance of senescent cells in humans"),
      },
      {
        branchId: "b",
        comparisonTokens: normalizeToTokenSet("Clearance of senescent cells in humans, senolytic"),
      },
      {
        branchId: "c",
        comparisonTokens: normalizeToTokenSet("Vitrification and rewarming of donor organs"),
      },
    ]);
    check(
      "countOverlappingGroups pairs near-identical branches and leaves unrelated ones alone",
      overlapProbe.get("a") === 1 && overlapProbe.get("b") === 1 && overlapProbe.get("c") === 0,
      `a=${String(overlapProbe.get("a"))} b=${String(overlapProbe.get("b"))} c=${String(overlapProbe.get("c"))}`,
    );

    // Now the real thing, against real rows. Nothing is claimed and nothing is published, so
    // every branch must come back `missing` — the research gap this surface exists to name.
    const signalsWhenBare = await recomputeBranchSignalsForProgram(programId);
    const allMissing = signalsWhenBare.every((outcome) => outcome.status === "missing");
    check(
      "with no claims and no approved papers, every branch is derived `missing`",
      signalsWhenBare.length === 3 && allMissing,
      `${String(signalsWhenBare.length)} branches, all missing: ${String(allMissing)}`,
    );

    await branchesService.claimProgramBranch({
      programId,
      branchId: rootBranchId,
      userId: strangerUserId,
    });
    const signalsAfterClaim = await recomputeBranchSignalsForProgram(programId);
    const claimedOutcome = signalsAfterClaim.find((outcome) => outcome.branchId === rootBranchId);
    check(
      "claiming a branch moves it from `missing` to `emerging`",
      claimedOutcome?.status === "emerging",
      `status ${String(claimedOutcome?.status)}`,
    );

    // And it is PERSISTED, not just returned.
    const [persistedBranch] = await db
      .select({ status: researchProgramBranch.status })
      .from(researchProgramBranch)
      .where(eq(researchProgramBranch.id, rootBranchId));
    check(
      "the derived status is written to the row, not just returned",
      persistedBranch?.status === "emerging",
      `column reads ${persistedBranch?.status ?? "(no row)"}`,
    );

    console.log("\n--- 9. Stats: 404 before the job, 200 after ---");

    const statsBefore = await programsService.findLatestProgramStats(programId);
    check(
      "GET …/stats has nothing to serve before the job runs (→ 404, never fabricated zeroes)",
      statsBefore === null,
      statsBefore === null ? "null" : "returned a row — WRONG",
    );

    const asOf = new Date("2026-07-30T00:00:00.000Z");
    await recomputeProgramStats(programId, asOf);
    const statsAfter = await programsService.findLatestProgramStats(programId);
    check(
      "after the job it serves a snapshot carrying its own asOf",
      statsAfter !== null && statsAfter.asOf.getTime() === asOf.getTime(),
      statsAfter ? `asOf ${statsAfter.asOf.toISOString()}` : "still null",
    );
    check(
      "the snapshot's counts match the rows this script created",
      statsAfter !== null &&
        statsAfter.branchCount === 3 &&
        statsAfter.participantCount === 1 &&
        statsAfter.totalEffortMinutes === 90 &&
        statsAfter.openGapCount === 2,
      statsAfter
        ? `branches ${String(statsAfter.branchCount)}, participants ${String(statsAfter.participantCount)}, minutes ${String(statsAfter.totalEffortMinutes)}, gaps ${String(statsAfter.openGapCount)}`
        : "no snapshot",
    );

    const replayedStats = await recomputeProgramStats(programId, asOf);
    check(
      "re-running the stats job for the same asOf is a no-op, not a second snapshot",
      replayedStats.wasAlreadyComputed,
      `wasAlreadyComputed ${String(replayedStats.wasAlreadyComputed)}`,
    );

    console.log("\n--- 10. Papers: DOI dedup, and the storage-optional path ---");

    const [smokeCategory] = await db
      .insert(researchPaperCategory)
      .values({
        slug: `smoke-cat-${suffix}`,
        label: `Smoke Category ${suffix}`,
        status: "approved",
      })
      .returning({ id: researchPaperCategory.id });
    if (!smokeCategory) throw new Error("smoke: category insert returned no row");
    categoryId = smokeCategory.id;

    const paper = await papersService.createProgramPaper({
      programId,
      title: `Smoke paper ${suffix}`,
      categoryId,
      branchId: rootBranchId,
      doi: "https://doi.org/10.1234/SMOKE",
      authorAffiliation: "A claimed affiliation, never verified.",
      abstractText: null,
      uploaderUserId: creatorUserId,
    });
    check("a paper's metadata row creates", paper.success, paper.success ? "created" : "FAILED");

    // The DOI is normalized, so the URL form and the bare form are ONE paper.
    const duplicateDoi = await papersService.createProgramPaper({
      programId,
      title: `Smoke paper duplicate ${suffix}`,
      categoryId,
      branchId: null,
      doi: "10.1234/smoke",
      authorAffiliation: null,
      abstractText: null,
      uploaderUserId: strangerUserId,
    });
    check(
      "the same DOI in a different spelling is refused — normalization makes them one paper",
      !duplicateDoi.success && duplicateDoi.error.type === "DUPLICATE_DOI",
      duplicateDoi.success ? "accepted — WRONG, the dedup index sees two" : duplicateDoi.error.type,
    );

    if (paper.success) {
      const pendingModeration = await papersService.listProgramPapers({
        programId,
        viewerUserId: strangerUserId,
        isStaff: false,
        filter: { limit: 20 },
      });
      check(
        "a `queued` paper is invisible to everyone but its uploader and staff",
        pendingModeration.rows.every((row) => row.paperId !== paper.value.paperId),
        `${String(pendingModeration.rows.length)} row(s) visible to a stranger`,
      );

      const uploaderView = await papersService.listProgramPapers({
        programId,
        viewerUserId: creatorUserId,
        isStaff: false,
        filter: { limit: 20 },
      });
      const ownRow = uploaderView.rows.find((row) => row.paperId === paper.value.paperId);
      check(
        "its uploader sees it, and isUploadedByViewer is computed per request",
        ownRow?.isUploadedByViewer === true && !ownRow.hasFile,
        ownRow
          ? `isUploadedByViewer ${String(ownRow.isUploadedByViewer)}, hasFile ${String(ownRow.hasFile)}`
          : "not visible",
      );

      // A paper with no attached file is a REAL state — object storage is optional, and a DOI
      // with no local copy has to be representable.
      const downloadWithoutFile = await papersService.createPaperDownloadUrl({
        programId,
        paperId: paper.value.paperId,
      });
      check(
        "a paper with no file answers PAPER_FILE_MISSING, distinct from PAPER_NOT_FOUND",
        !downloadWithoutFile.success && downloadWithoutFile.error.type === "PAPER_FILE_MISSING",
        downloadWithoutFile.success ? "returned a URL — WRONG" : downloadWithoutFile.error.type,
      );

      const approved = await moderationService.decidePaperModeration({
        programId,
        paperId: paper.value.paperId,
        decision: "approved",
        reviewerNote: "Approved by the smoke test.",
        flagReasons: [],
        staff: staffContext,
      });
      check(
        "a moderator can approve a paper",
        approved.success,
        approved.success ? "approved" : "FAILED",
      );

      const reApprove = await papersService.findProgramPaper({
        programId,
        paperId: paper.value.paperId,
        viewerUserId: strangerUserId,
        isStaff: false,
      });
      check(
        "once approved it becomes visible to everyone",
        reApprove !== null && reApprove.moderationStatus === "approved",
        reApprove ? reApprove.moderationStatus : "still hidden",
      );

      const secondVerdict = await moderationService.decidePaperModeration({
        programId,
        paperId: paper.value.paperId,
        decision: "rejected",
        reviewerNote: "A second verdict must be refused.",
        flagReasons: [],
        staff: staffContext,
      });
      check(
        "a second verdict on one paper is refused",
        !secondVerdict.success && secondVerdict.error.type === "PAPER_ALREADY_REVIEWED",
        secondVerdict.success ? "overwrote — WRONG" : secondVerdict.error.type,
      );

      // An approved paper on a claimed branch makes it `active` rather than `emerging`.
      const signalsAfterPaper = await recomputeBranchSignalsForProgram(programId);
      const rootAfterPaper = signalsAfterPaper.find((outcome) => outcome.branchId === rootBranchId);
      check(
        "an approved paper on a claimed branch derives `active`",
        rootAfterPaper?.status === "active",
        `status ${String(rootAfterPaper?.status)}`,
      );
    }
  } finally {
    console.log("\n--- cleanup ---");
    await teardown({ programId, categoryId, userIds: [creatorUserId, strangerUserId] });
  }

  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(assertions.length)} research-program assertions passed.`
      : `\n${String(failureCount)} of ${String(assertions.length)} research-program assertions FAILED.`,
  );
  if (failureCount > 0) process.exitCode = 1;
}

/**
 * Removes every row this run created.
 *
 * TWO THINGS MAKE THIS MORE THAN A DELETE LOOP:
 *
 *  1. **FK ORDER.** `research_effort_log`, `research_contribution_ledger_entry` and
 *     `research_program_moderation_action` all reference their parents with `restrict`, so the
 *     children must go first — that is the §4f policy working, not an obstacle.
 *
 *  2. **THE APPEND-ONLY TRIGGERS REFUSE DELETE.** Those three tables reject a DELETE with
 *     QT001 by design, so a teardown has to disable the trigger for the span of the cleanup.
 *     That is legitimate for a disposable fixture and must NEVER happen on a production path —
 *     the whole point of the trigger is that no service can do this. It is re-enabled in a
 *     `finally`, so a failure mid-teardown cannot leave the table unprotected.
 */
async function teardown(input: {
  readonly programId: string | null;
  readonly categoryId: string | null;
  readonly userIds: readonly string[];
}): Promise<void> {
  const client = await pool.connect();
  const appendOnlyTables = [
    "research_effort_log",
    "research_contribution_ledger_entry",
    "research_program_moderation_action",
  ] as const;

  try {
    if (input.programId !== null) {
      for (const tableName of appendOnlyTables) {
        await client.query(`ALTER TABLE ${tableName} DISABLE TRIGGER ${tableName}_append_only`);
      }

      try {
        // Children first, in dependency order.
        await client.query(`DELETE FROM research_effort_log WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(`DELETE FROM research_contribution_ledger_entry WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(`DELETE FROM research_program_moderation_action WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(`DELETE FROM research_program_content_report WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(
          `DELETE FROM research_program_post_reaction WHERE post_id IN
             (SELECT id FROM research_program_post WHERE program_id = $1)`,
          [input.programId],
        );
        // Replies before their parents — `parent_post_id` cascades, but deleting depth-1 rows
        // first keeps the delete order explicit rather than relying on the cascade.
        await client.query(
          `DELETE FROM research_program_post WHERE program_id = $1 AND depth = 1`,
          [input.programId],
        );
        await client.query(`DELETE FROM research_program_post WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(`DELETE FROM research_program_participant WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(`DELETE FROM research_program_stat_snapshot WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(
          `DELETE FROM research_program_product_opportunity WHERE program_id = $1`,
          [input.programId],
        );
        await client.query(`DELETE FROM research_program_paper WHERE program_id = $1`, [
          input.programId,
        ]);
        await client.query(
          `DELETE FROM research_program_branch_claim WHERE branch_id IN
             (SELECT id FROM research_program_branch WHERE program_id = $1)`,
          [input.programId],
        );
        // Deepest branches first: `parent_branch_id` is `restrict`, so a parent cannot go
        // while a child points at it. Ordering by path length descending is depth-descending.
        await client.query(
          `DELETE FROM research_program_branch WHERE program_id = $1
             AND id IN (SELECT id FROM research_program_branch WHERE program_id = $1
                        ORDER BY length(ancestor_path) DESC)`,
          [input.programId],
        );
        await client.query(`DELETE FROM research_program WHERE id = $1`, [input.programId]);
      } finally {
        // Re-enabled even if a delete failed — leaving an append-only table unprotected is a
        // worse outcome than a stranded fixture row.
        for (const tableName of appendOnlyTables) {
          await client.query(`ALTER TABLE ${tableName} ENABLE TRIGGER ${tableName}_append_only`);
        }
      }
    }

    if (input.categoryId !== null) {
      await client.query(`DELETE FROM research_paper_category WHERE id = $1`, [input.categoryId]);
    }
    if (input.userIds.length > 0) {
      await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[...input.userIds]]);
    }
    console.log("  removed every row this run created; append-only triggers re-enabled.");
  } finally {
    client.release();
  }
}

main()
  .then(async () => {
    await stopSendOnlyBoss();
    await pool.end();
    return undefined;
  })
  .catch(async (error: unknown) => {
    console.error("Research program smoke test failed to run:", error);
    await stopSendOnlyBoss();
    await pool.end();
    process.exit(1);
  });
