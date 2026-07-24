import { createHash } from "node:crypto";

import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { fromDrizzle } from "pg-boss";

import { db } from "#src/db/index.js";
import {
  artifactEvidence,
  claimVerificationRun,
  dailyLog,
  dailyLogEvidenceLink,
  effortClaim,
  integrationConsentGrant,
  physicalWorkReceipt,
  verificationStep,
} from "#src/db/schema.js";
import { fetchAuthoredCommits } from "#src/lib/github-integration.js";
import { idempotencyKeyFor, JOB_NAMES, PermanentJobError, sendJob } from "#src/lib/jobs.js";
import { decryptToken } from "#src/lib/token-encryption.js";
import {
  decideClaimVerdict,
  VERIFICATION_STEP_KINDS,
  type VerificationStepKind,
  type VerificationStepStatus,
} from "#src/lib/verdict.js";

/**
 * The four-step verification pipeline (R_AND_D_BACKEND_STRUCTURE.md §9.7;
 * PROOF_OF_EFFORT_SPEC.md §4).
 *
 * NOTHING IN THIS FILE MAY WRITE `slice_ledger_entry`. That is §9.1's first enforcement,
 * and it is why this module does not import slice-ledger.service.ts at all: this file
 * produces JUDGEMENTS, which a human may override; that one produces NUMBERS, which
 * nobody may touch. `finalize-verdict` hands its verdict to
 * `slice-allocation.service.ts`, which opens a window — and only the window locking
 * writes to the ledger.
 *
 * THE FAILURE MODE IS SAFE BY DEFAULT: a broken pipeline awards ZERO, never a guess. A
 * `failed` or `flagged` step STILL enqueues its successor, so the pipeline always reaches
 * a verdict rather than stalling with a claim stuck in `running` forever.
 *
 * WHAT THE ZERO-COST STACK CAN AND CANNOT PROVE, stated plainly because the honest answer
 * shapes every status below:
 *
 *   - §8 already spent the one Gemini call. Transcription and claim extraction are NOT
 *     re-run here — a second call is a second draw against a free quota for tokens we
 *     already have. `claim_extraction` reads §8's output and grades it.
 *   - Without a connected provider, an evidence LINK is a reference with no independently
 *     verifiable timestamp. That is real evidence and it is not proof, so grounding
 *     resolves `flagged` — a human looks — rather than `passed` (which would mint equity
 *     on an unverifiable claim) or `failed` (which would discard a member's real work).
 *   - Physical receipts DO carry a server-measured capture time from EXIF, so a
 *     receipt-backed claim reaches a genuine `passed`/`flagged` on real timestamps.
 *   - AST substance analysis needs a diff. With no connected repository there is nothing
 *     to parse, and the step is `skipped` — structurally inapplicable, which is exactly
 *     what `skipped` means and exactly what `failed` does not.
 */

/** Bumped when a heuristic below changes, so a re-run is distinguishable from a re-read. */
export const VERIFICATION_ANALYZER_VERSION = "poe-analyzer-v1";

/**
 * A claim is flagged for time theft when the artifacts cluster into a window far shorter
 * than the hours claimed — SPEC §4 step 4's "claimed 8 hours but all commits pushed in a
 * 14-minute window at 11:50 PM".
 *
 * Three times the artifact span is deliberately generous: real work produces bursts of
 * artifacts separated by long silent stretches of thinking, reading and testing. This
 * catches the pathological case without flagging every developer who commits at the end
 * of the day.
 */
const TEMPORAL_SPAN_TOLERANCE_MULTIPLE = 3;

/** Below this, a span is noise rather than a signal — two commits a minute apart prove nothing. */
const TEMPORAL_MINIMUM_ARTIFACTS = 2;

type DatabaseExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface StepResolution {
  readonly status: VerificationStepStatus;
  readonly findingSummary: string;
  readonly scoreBps?: number | undefined;
}

/**
 * Creates a run and its four PENDING steps, resolving `claim_extraction` immediately from
 * §8's already-computed analysis.
 *
 * Extraction is graded rather than performed: §8's `analyze-daily-log` made the model call
 * and wrote `daily_log_extracted_claim`. What this step decides is whether that output is
 * usable as an INPUT to the formula — and a claim with no extracted minutes and no
 * extracted cash has nothing to price, so it fails here rather than travelling three more
 * stages to fail anyway.
 */
export async function createVerificationRun(
  tx: DatabaseExecutor,
  input: {
    readonly claim: typeof effortClaim.$inferSelect;
    readonly attemptNumber: number;
    readonly triggeredByUserId: string | null;
    readonly triggerReason: string | null;
    readonly scopedWindowStartsAt?: Date | undefined;
    readonly scopedWindowEndsAt?: Date | undefined;
  },
): Promise<{ readonly runId: string }> {
  const [run] = await tx
    .insert(claimVerificationRun)
    .values({
      claimId: input.claim.id,
      attemptNumber: input.attemptNumber,
      triggeredByUserId: input.triggeredByUserId,
      triggerReason: input.triggerReason,
      ...(input.scopedWindowStartsAt === undefined
        ? {}
        : { scopedWindowStartsAt: input.scopedWindowStartsAt }),
      ...(input.scopedWindowEndsAt === undefined
        ? {}
        : { scopedWindowEndsAt: input.scopedWindowEndsAt }),
    })
    .returning({ id: claimVerificationRun.id });

  if (!run) {
    throw new Error("createVerificationRun: insert returned no row");
  }

  const extraction = resolveClaimExtraction(input.claim);

  await tx.insert(verificationStep).values(
    VERIFICATION_STEP_KINDS.map((stepKind, index) => ({
      runId: run.id,
      stepOrder: index + 1,
      stepKind,
      ...(stepKind === "claim_extraction"
        ? {
            status: extraction.status,
            findingSummary: extraction.findingSummary,
            startedAt: new Date(),
            completedAt: new Date(),
          }
        : { status: "pending" as const }),
    })),
  );

  return { runId: run.id };
}

function resolveClaimExtraction(claim: typeof effortClaim.$inferSelect): StepResolution {
  const hasMinutes = (claim.extractedMinutes ?? 0) > 0;
  const hasCash = (claim.extractedCashInCents ?? 0n) > 0n;

  if (claim.sourceKind === "physical_receipt") {
    // Nothing to transcribe and nothing to parse: a photograph of a sanded chassis is not
    // a claim in words. The minutes come from receipt capture times in grounding, so this
    // step is structurally inapplicable rather than failed.
    return {
      status: "skipped",
      findingSummary:
        "Physical-work claim: effort is derived from receipt capture times, not from a transcript.",
    };
  }

  if (!hasMinutes && !hasCash) {
    return {
      status: "failed",
      findingSummary:
        "The daily log's analysis produced no time or cash claim, so there is nothing for the formula to price.",
    };
  }

  return {
    status: "passed",
    findingSummary: hasMinutes
      ? `Extracted ${claim.extractedMinutes ?? 0} claimed minutes from the log's analysis.`
      : `Extracted a cash claim of ${(claim.extractedCashInCents ?? 0n).toString()} cents.`,
  };
}

interface RunContext {
  readonly run: typeof claimVerificationRun.$inferSelect;
  readonly claim: typeof effortClaim.$inferSelect;
}

/**
 * Loads a run and refuses to act on one that has already reached a verdict.
 *
 * Returns null rather than throwing: pg-boss redelivers, an operator replays, and a
 * second pass over a completed run is an ordinary event that must be a NO-OP, not a
 * dead-lettered failure.
 */
async function loadRunnableContext(runId: string): Promise<RunContext | null> {
  const [row] = await db
    .select({ run: claimVerificationRun, claim: effortClaim })
    .from(claimVerificationRun)
    .innerJoin(effortClaim, eq(effortClaim.id, claimVerificationRun.claimId))
    .where(eq(claimVerificationRun.id, runId));

  if (!row || row.run.completedAt !== null) {
    return null;
  }
  return row;
}

async function writeStepOutcome(
  runId: string,
  stepKind: VerificationStepKind,
  resolution: StepResolution,
): Promise<void> {
  await db
    .update(verificationStep)
    .set({
      status: resolution.status,
      findingSummary: resolution.findingSummary,
      ...(resolution.scoreBps === undefined ? {} : { scoreBps: resolution.scoreBps }),
      modelName: VERIFICATION_ANALYZER_VERSION,
      promptVersion: VERIFICATION_ANALYZER_VERSION,
      startedAt: new Date(),
      completedAt: new Date(),
    })
    .where(and(eq(verificationStep.runId, runId), eq(verificationStep.stepKind, stepKind)));
}

/**
 * The reference hash for a link-shaped artifact.
 *
 * Hashes the REFERENCE, not the bytes — the backend never fetches a linked file, so
 * claiming a content hash would be a fabricated fact. What this proves is "this exact
 * reference was cited by this claim", which is what dedup needs and all a link can honestly
 * support. §8 says the same thing about `workshop_file.sizeBytes` staying NULL.
 */
function referenceSha256(provider: string, reference: string): string {
  return createHash("sha256").update(`${provider} ${reference}`, "utf8").digest("hex");
}

/**
 * STAGE 2 — artifact grounding (SPEC §4 step 2, the one that decides whether anyone is paid).
 *
 * Collects every deterministic artifact the claim can point at, records each as
 * `artifact_evidence`, and derives `groundedMinutes` — WHAT THE ARTIFACTS PROVE, as
 * opposed to `extractedMinutes`, which is what the member said. The ledger prices
 * `COALESCE(overriddenMinutes, groundedMinutes)` and never touches `extractedMinutes`.
 *
 * NO DIGITAL RECEIPTS → `failed`, ZERO SLICES. Not `skipped`: a step that skipped its way
 * to `verified` would mint equity for a claim nothing corroborates, and SPEC §4 step 2 is
 * explicit about this case.
 */
export async function runGroundArtifacts(runId: string): Promise<void> {
  const context = await loadRunnableContext(runId);
  if (!context) return;

  const { run, claim } = context;
  const artifacts = await collectAndRecordArtifacts(claim);
  const timestampedArtifacts = artifacts.filter((artifact) => artifact.hasVerifiableTimestamp);

  const resolution = await resolveGrounding(run, claim, artifacts, timestampedArtifacts);
  await writeStepOutcome(runId, "artifact_grounding", resolution.step);

  await db
    .update(effortClaim)
    .set({
      groundedMinutes: resolution.groundedMinutes,
      groundedCashInCents: resolution.groundedCashInCents,
      verificationStatus: "running",
    })
    .where(eq(effortClaim.id, claim.id));

  await enqueueStage(JOB_NAMES.analyzeSubstance, runId);
}

interface CollectedArtifact {
  readonly provider: (typeof artifactEvidence.$inferSelect)["provider"];
  readonly externalId: string;
  readonly label: string;
  readonly externalUrl: string | null;
  readonly occurredAt: Date;
  /**
   * True only when the instant came from a source the member cannot author freely —
   * EXIF written by a camera, or a provider API. A pasted link's "timestamp" is the
   * moment we saw it, which proves nothing about when the work happened.
   */
  readonly hasVerifiableTimestamp: boolean;
  readonly isCodeBearing: boolean;
  readonly signatureStatus: (typeof artifactEvidence.$inferSelect)["signatureStatus"];
  /** Set only for provider-fetched artifacts; a revocation purges through this link. */
  readonly consentGrantId: string | null;
  /** The payload a revocation NULLs. Null for a link, which has no payload to hold. */
  readonly rawPayloadJson: string | null;
}

/**
 * Gathers artifacts and writes them to `artifact_evidence`, idempotently.
 *
 * `onConflictDoNothing` leans on `artifact_evidence_project_claim_unq`: ONE COMMIT MUST
 * NOT FUND TWO MEMBERS' CLAIMS (§9.6). A retried job re-inserting the same artifact is a
 * no-op; a DIFFERENT claim citing an artifact already counted elsewhere is silently not
 * counted here, which is exactly the intent.
 *
 * THREE SOURCES, in ascending order of what they prove: the evidence links §8 already
 * stored (a reference, no verifiable instant), physical receipts (EXIF capture time, which
 * a camera wrote), and a connected provider (an instant and a signature the member could
 * not author). With no grant the third simply contributes nothing, and everything
 * downstream degrades honestly rather than pretending.
 */
async function collectAndRecordArtifacts(
  claim: typeof effortClaim.$inferSelect,
): Promise<readonly CollectedArtifact[]> {
  const collected: CollectedArtifact[] = [];

  if (claim.dailyLogId !== null) {
    const [log] = await db
      .select({ submittedAt: dailyLog.submittedAt, createdAt: dailyLog.createdAt })
      .from(dailyLog)
      .where(eq(dailyLog.id, claim.dailyLogId));

    const links = await db
      .select()
      .from(dailyLogEvidenceLink)
      .where(eq(dailyLogEvidenceLink.dailyLogId, claim.dailyLogId))
      .orderBy(asc(dailyLogEvidenceLink.id));

    for (const link of links) {
      collected.push({
        provider: mapEvidenceLinkProvider(link.provider),
        externalId: link.externalId ?? link.externalUrl,
        label: link.externalUrl,
        externalUrl: link.externalUrl,
        // The only instant we honestly have: when the log carrying this link was filed.
        occurredAt: log?.submittedAt ?? log?.createdAt ?? claim.createdAt,
        hasVerifiableTimestamp: false,
        isCodeBearing: link.provider === "github" || link.provider === "gitlab",
        signatureStatus: "unknown",
        consentGrantId: null,
        rawPayloadJson: null,
      });
    }
  }

  const receipts = await db
    .select()
    .from(physicalWorkReceipt)
    .where(eq(physicalWorkReceipt.claimId, claim.id))
    .orderBy(asc(physicalWorkReceipt.id));

  for (const receipt of receipts) {
    collected.push({
      provider: "physical_receipt",
      externalId: receipt.contentSha256,
      label: `${receipt.receiptKind} ${receipt.contentSha256.slice(0, 12)}`,
      externalUrl: receipt.storedImageUrl,
      occurredAt: receipt.capturedAt ?? receipt.createdAt,
      // EXIF capture time is written by the camera, not by the uploader — the one
      // verifiable instant this stack has without an external API.
      hasVerifiableTimestamp: receipt.capturedAt !== null,
      isCodeBearing: false,
      signatureStatus: "unknown",
      consentGrantId: null,
      rawPayloadJson: null,
    });
  }

  const providerArtifacts = await collectProviderArtifacts(claim);
  collected.push(...providerArtifacts.artifacts);

  for (const artifact of collected) {
    await db
      .insert(artifactEvidence)
      .values({
        projectId: claim.projectId,
        claimId: claim.id,
        provider: artifact.provider,
        externalId: artifact.externalId,
        label: artifact.label.slice(0, 500),
        externalUrl: artifact.externalUrl,
        payloadSha256: referenceSha256(artifact.provider, artifact.externalId),
        signatureStatus: artifact.signatureStatus,
        artifactOccurredAt: artifact.occurredAt,
        ...(artifact.consentGrantId === null ? {} : { consentGrantId: artifact.consentGrantId }),
        ...(artifact.rawPayloadJson === null ? {} : { rawPayloadJson: artifact.rawPayloadJson }),
      })
      .onConflictDoNothing();
  }

  return collected;
}

/**
 * Artifacts fetched from a connected provider, scoped to the member's own grant.
 *
 * THE SCOPE IS THE GRANT'S, NOT THE CALLER'S. Repositories come from
 * `allowedResourceIds` — the narrowed list the member consented to — and the author is the
 * account they connected. A claim cannot reach a repository nobody granted access to, on
 * this project or any other, because the grant is a (project, member, provider) TRIPLE.
 *
 * A permanent provider failure is rethrown as a {@link PermanentJobError} so grounding
 * dead-letters immediately: §9.7 names 401 (consent revoked upstream) and 404 (artifact
 * deleted) as permanent, and burning five exponential backoff attempts on either just
 * delays the signal by half an hour. Everything else returns no artifacts and lets the
 * link-only path decide, because a rate limit must not zero a member's honest day.
 */
async function collectProviderArtifacts(
  claim: typeof effortClaim.$inferSelect,
): Promise<{ readonly artifacts: readonly CollectedArtifact[] }> {
  const [grant] = await db
    .select()
    .from(integrationConsentGrant)
    .where(
      and(
        eq(integrationConsentGrant.projectId, claim.projectId),
        eq(integrationConsentGrant.memberId, claim.memberId),
        eq(integrationConsentGrant.provider, "github"),
        eq(integrationConsentGrant.status, "active"),
      ),
    );

  if (!grant?.encryptedAccessToken || grant.allowedResourceIds.length === 0) {
    return { artifacts: [] };
  }

  const accessToken = decryptToken(grant.encryptedAccessToken);
  if (!accessToken.success) {
    // A key rotation that left this row behind. Permanent: retrying decrypts the same
    // bytes with the same key and fails identically.
    throw new PermanentJobError(
      "INTEGRATION_TOKEN_UNDECRYPTABLE",
      `ground-artifacts: grant ${grant.id} could not be decrypted`,
    );
  }

  const authorLogin = grant.externalAccountLabel;
  if (!authorLogin) {
    return { artifacts: [] };
  }

  const dayStart = new Date(`${claim.claimedForDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const artifacts: CollectedArtifact[] = [];

  for (const repositoryFullName of grant.allowedResourceIds) {
    const commits = await fetchAuthoredCommits(
      { repositoryFullName, authorLogin, since: dayStart, until: dayEnd },
      accessToken.value,
    );

    if (!commits.success) {
      if (commits.error.type === "GITHUB_UNAUTHORIZED") {
        throw new PermanentJobError(
          "INTEGRATION_CONSENT_REVOKED",
          `ground-artifacts: GitHub rejected the token on grant ${grant.id}`,
        );
      }
      // A missing repository, a rate limit, a network fault: this repository contributes
      // nothing and the others still get their chance.
      continue;
    }

    for (const commit of commits.value) {
      artifacts.push({
        provider: "github",
        externalId: commit.sha,
        label: `${repositoryFullName}@${commit.sha.slice(0, 12)} — ${commit.message.split("\n")[0] ?? ""}`,
        externalUrl: commit.htmlUrl,
        occurredAt: commit.authoredAt,
        // THE WHOLE POINT OF A CONNECTED PROVIDER: an instant GitHub recorded, which the
        // member could not have authored. This is what lets grounding reach `passed` and
        // temporal analysis run at all.
        hasVerifiableTimestamp: true,
        isCodeBearing: true,
        signatureStatus: commit.signatureStatus,
        consentGrantId: grant.id,
        // Retained until a revocation NULLs it, at which point the hash, the sha and the
        // instant still prove the claim (§9.10).
        rawPayloadJson: JSON.stringify({
          sha: commit.sha,
          message: commit.message,
          authoredAt: commit.authoredAt.toISOString(),
        }),
      });
    }
  }

  return { artifacts };
}

/** §8's link providers map onto §9's wider artifact vocabulary. */
function mapEvidenceLinkProvider(
  provider: (typeof dailyLogEvidenceLink.$inferSelect)["provider"],
): (typeof artifactEvidence.$inferSelect)["provider"] {
  switch (provider) {
    case "github":
      return "github";
    case "gitlab":
      return "gitlab";
    case "figma":
      return "figma";
    case "notion":
      return "notion";
    case "google_docs":
      return "google_docs";
    case "other":
      return "daily_log_link";
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`mapEvidenceLinkProvider: unhandled ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

interface GroundingResolution {
  readonly step: StepResolution;
  readonly groundedMinutes: number;
  readonly groundedCashInCents: bigint;
}

async function resolveGrounding(
  run: typeof claimVerificationRun.$inferSelect,
  claim: typeof effortClaim.$inferSelect,
  artifacts: readonly CollectedArtifact[],
  timestampedArtifacts: readonly CollectedArtifact[],
): Promise<GroundingResolution> {
  if (artifacts.length === 0) {
    return {
      step: {
        status: "failed",
        findingSummary:
          "No digital receipts back this claim. SPEC §4 step 2: an unverifiable claim earns zero slices.",
        scoreBps: 0,
      },
      groundedMinutes: 0,
      groundedCashInCents: 0n,
    };
  }

  // §9.12 option (a): a dispute resolved as `re_verified` narrows a WINDOW, and the server
  // re-derives minutes from artifact overlap inside it. The resolver never states a
  // number — this is the whole reason `consensusAdjustedMinutes` does not exist.
  if (run.scopedWindowStartsAt !== null && run.scopedWindowEndsAt !== null) {
    return resolveScopedGrounding(run.scopedWindowStartsAt, run.scopedWindowEndsAt, claim);
  }

  const claimedMinutes = deriveClaimedMinutes(claim, timestampedArtifacts);
  const groundedCashInCents = claim.extractedCashInCents ?? 0n;

  if (timestampedArtifacts.length === 0) {
    return {
      step: {
        status: "flagged",
        findingSummary: `${artifacts.length} artifact reference(s) cited, none with an independently verifiable timestamp. Connect an integration or attach a receipt to reach a verified grounding.`,
        scoreBps: 5_000,
      },
      // Evidence exists, so the claim is not zeroed — it is WITHHELD pending a human,
      // and the proposal still opens so the member can see and challenge it (§9.8).
      groundedMinutes: claimedMinutes,
      groundedCashInCents,
    };
  }

  return {
    step: {
      status: "passed",
      findingSummary: `${timestampedArtifacts.length} of ${artifacts.length} artifact(s) carry a verifiable timestamp.`,
      scoreBps: 10_000,
    },
    groundedMinutes: claimedMinutes,
    groundedCashInCents,
  };
}

/**
 * Minutes for a claim, from the only sources the server owns.
 *
 * A daily-log claim uses §8's extracted count — what the member said, which grounding
 * either corroborates or does not. A PHYSICAL claim has no transcript at all, so its
 * minutes come from the span between the first and last receipt capture time: the only
 * effort signal a camera can produce. Fewer than two timestamped receipts prove no
 * duration, and the honest answer there is zero rather than a guess.
 */
function deriveClaimedMinutes(
  claim: typeof effortClaim.$inferSelect,
  timestampedArtifacts: readonly CollectedArtifact[],
): number {
  if (claim.sourceKind === "daily_log") {
    return claim.extractedMinutes ?? 0;
  }

  if (timestampedArtifacts.length < 2) {
    return 0;
  }

  const instants = timestampedArtifacts
    .map((artifact) => artifact.occurredAt.getTime())
    .toSorted((left, right) => left - right);
  const earliest = instants.at(0) ?? 0;
  const latest = instants.at(-1) ?? 0;

  // Integer division on epoch milliseconds, floored — never `Math.round` on a duration
  // (§4c rule 2). A partial minute is not a minute.
  return Math.min(Number(BigInt(latest - earliest) / 60_000n), 1_440);
}

/**
 * Re-derivation inside a narrowed window (§9.12 option (a)).
 *
 * The number comes from two server-owned facts — the window's length and whether any
 * artifact actually falls inside it — never from anything a resolver typed. An empty
 * window re-derives to ZERO, which is the honest reading of "we agreed the work did not
 * happen then".
 */
async function resolveScopedGrounding(
  windowStartsAt: Date,
  windowEndsAt: Date,
  claim: typeof effortClaim.$inferSelect,
): Promise<GroundingResolution> {
  const inWindow = await db
    .select({ id: artifactEvidence.id })
    .from(artifactEvidence)
    .where(
      and(
        eq(artifactEvidence.claimId, claim.id),
        eq(artifactEvidence.countsTowardSlices, true),
        gte(artifactEvidence.artifactOccurredAt, windowStartsAt),
        lte(artifactEvidence.artifactOccurredAt, windowEndsAt),
      ),
    );

  if (inWindow.length === 0) {
    return {
      step: {
        status: "failed",
        findingSummary: `No artifact falls inside the re-verification window ${windowStartsAt.toISOString()} – ${windowEndsAt.toISOString()}.`,
        scoreBps: 0,
      },
      groundedMinutes: 0,
      groundedCashInCents: 0n,
    };
  }

  const windowMinutes = Number(BigInt(windowEndsAt.getTime() - windowStartsAt.getTime()) / 60_000n);
  const groundedMinutes = Math.min(claim.extractedMinutes ?? windowMinutes, windowMinutes, 1_440);

  return {
    step: {
      status: "passed",
      findingSummary: `Re-derived ${groundedMinutes} minutes from ${inWindow.length} artifact(s) inside the agreed window.`,
      scoreBps: 10_000,
    },
    groundedMinutes,
    // A narrowed window re-times effort; it says nothing about money already spent.
    groundedCashInCents: claim.groundedCashInCents ?? claim.extractedCashInCents ?? 0n,
  };
}

/**
 * STAGE 3 — substantive analysis (SPEC §4 step 3, which defeats line-count cheating).
 *
 * `skipped`, in both of its branches, because AST complexity analysis of a photograph is
 * not a weaker check — it is not a check at all, and neither is analysis of a commit whose
 * diff this server cannot read. Reporting either as `passed` would put a green tick on an
 * audit that never ran.
 *
 * WHY NOT `flagged` FOR THE SECOND BRANCH. Flagging it would make every link-citing claim
 * carry two flags for one underlying fact — nothing here is independently verifiable
 * without a connected provider — and a human would have to override both to release a
 * single claim. Grounding already flags exactly that fact, so review has ONE gate rather
 * than three. The finding text is what carries the difference; the status carries the
 * decision.
 *
 * The real diff analysis needs a connected repository (9D).
 */
export async function runAnalyzeSubstance(runId: string): Promise<void> {
  const context = await loadRunnableContext(runId);
  if (!context) return;

  const codeArtifacts = await db
    .select({ id: artifactEvidence.id })
    .from(artifactEvidence)
    .where(
      and(
        eq(artifactEvidence.claimId, context.claim.id),
        sql`${artifactEvidence.provider} IN ('github', 'gitlab')`,
        eq(artifactEvidence.countsTowardSlices, true),
      ),
    );

  await writeStepOutcome(
    runId,
    "substance_analysis",
    codeArtifacts.length === 0
      ? {
          status: "skipped",
          findingSummary:
            "No code artifact to analyze. Diff-substance analysis does not apply to this claim.",
        }
      : {
          status: "skipped",
          findingSummary: `${codeArtifacts.length} code reference(s) cited, but no repository is connected, so diff substance could not be measured. Artifact grounding carries the review flag for this claim.`,
        },
  );

  await enqueueStage(JOB_NAMES.analyzeTemporal, runId);
}

/**
 * STAGE 4 — temporal anomaly detection (SPEC §4 step 4, which defeats time theft).
 *
 * Two deterministic signals, both integer arithmetic over instants the server owns:
 *   1. An artifact outside the claimed calendar day. Work credited to Tuesday whose only
 *      evidence is Thursday's is a mismatch a human should see.
 *   2. Hours claimed far exceeding the span the artifacts cover — "claimed 8 hours, all
 *      commits inside a 14-minute window at 11:50 PM".
 *
 * `skipped` without at least two verifiable instants: one timestamp describes a moment,
 * not a duration, and a check that cannot fail is not a check.
 */
export async function runAnalyzeTemporal(runId: string): Promise<void> {
  const context = await loadRunnableContext(runId);
  if (!context) return;

  const { claim } = context;
  const artifacts = await db
    .select({ occurredAt: artifactEvidence.artifactOccurredAt })
    .from(artifactEvidence)
    .where(
      and(
        eq(artifactEvidence.claimId, claim.id),
        eq(artifactEvidence.countsTowardSlices, true),
        eq(artifactEvidence.signatureStatus, "unknown"),
      ),
    )
    .orderBy(asc(artifactEvidence.artifactOccurredAt));

  await writeStepOutcome(runId, "temporal_analysis", resolveTemporal(claim, artifacts));
  await enqueueStage(JOB_NAMES.finalizeVerdict, runId);
}

function resolveTemporal(
  claim: typeof effortClaim.$inferSelect,
  artifacts: readonly { readonly occurredAt: Date }[],
): StepResolution {
  const claimedMinutes = claim.overriddenMinutes ?? claim.groundedMinutes ?? 0;

  if (artifacts.length < TEMPORAL_MINIMUM_ARTIFACTS || claimedMinutes === 0) {
    return {
      status: "skipped",
      findingSummary:
        "Fewer than two independently timed artifacts: no duration can be checked against the claim.",
    };
  }

  const dayStart = new Date(`${claim.claimedForDate}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const strays = artifacts.filter(
    (artifact) => artifact.occurredAt < dayStart || artifact.occurredAt >= dayEnd,
  );

  if (strays.length > 0) {
    return {
      status: "flagged",
      findingSummary: `${strays.length} of ${artifacts.length} artifact(s) fall outside the claimed day ${claim.claimedForDate}.`,
      scoreBps: 2_500,
    };
  }

  const earliest = artifacts.at(0)?.occurredAt.getTime() ?? 0;
  const latest = artifacts.at(-1)?.occurredAt.getTime() ?? 0;
  const spanMinutes = Number(BigInt(latest - earliest) / 60_000n);

  if (spanMinutes * TEMPORAL_SPAN_TOLERANCE_MULTIPLE < claimedMinutes) {
    return {
      status: "flagged",
      findingSummary: `${claimedMinutes} minutes claimed, but every artifact falls inside a ${spanMinutes}-minute window.`,
      scoreBps: 1_000,
    };
  }

  return {
    status: "passed",
    findingSummary: `${claimedMinutes} minutes claimed across a ${spanMinutes}-minute artifact span, on the claimed day.`,
    scoreBps: 10_000,
  };
}

/**
 * Reads a run's four steps in canonical order, with any human override applied.
 *
 * Ordered by `stepOrder` ASC (§9.4's canonical ordering), never by insertion order.
 */
export async function loadStepOutcomes(runId: string): Promise<
  readonly {
    readonly stepKind: VerificationStepKind;
    readonly status: VerificationStepStatus;
    readonly overriddenStatus: VerificationStepStatus | null;
  }[]
> {
  return db
    .select({
      stepKind: verificationStep.stepKind,
      status: verificationStep.status,
      overriddenStatus: verificationStep.overriddenStatus,
    })
    .from(verificationStep)
    .where(eq(verificationStep.runId, runId))
    .orderBy(asc(verificationStep.stepOrder));
}

/** The verdict a run's steps currently imply, without writing anything. */
export async function peekVerdict(runId: string): Promise<ReturnType<typeof decideClaimVerdict>> {
  return decideClaimVerdict(await loadStepOutcomes(runId));
}

/**
 * Enqueues the next stage, enlisted in no transaction.
 *
 * A stage that cannot enqueue its successor THROWS, so pg-boss retries the whole stage
 * rather than leaving a claim stuck in `running` with nothing scheduled to move it. Every
 * stage is idempotent, so re-running one is cheap.
 */
async function enqueueStage(
  jobName:
    | typeof JOB_NAMES.groundArtifacts
    | typeof JOB_NAMES.analyzeSubstance
    | typeof JOB_NAMES.analyzeTemporal
    | typeof JOB_NAMES.finalizeVerdict,
  runId: string,
  options: { readonly generation?: number | undefined } = {},
): Promise<void> {
  const idempotencyKey =
    jobName === JOB_NAMES.finalizeVerdict
      ? idempotencyKeyFor.finalizeVerdict(runId, options.generation ?? 0)
      : jobName === JOB_NAMES.groundArtifacts
        ? idempotencyKeyFor.groundArtifacts(runId)
        : jobName === JOB_NAMES.analyzeSubstance
          ? idempotencyKeyFor.analyzeSubstance(runId)
          : idempotencyKeyFor.analyzeTemporal(runId);

  const enqueued = await sendJob(jobName, { runId }, { idempotencyKey });
  if (!enqueued.success) {
    throw new Error(
      `verification: run ${runId} could not enqueue ${jobName} (${enqueued.error.type})`,
    );
  }
}

/** Enqueues the FIRST stage from inside the transaction that created the run. */
export async function enqueueGroundingInTransaction(
  tx: DatabaseExecutor,
  runId: string,
): Promise<void> {
  const enqueued = await sendJob(
    JOB_NAMES.groundArtifacts,
    { runId },
    {
      idempotencyKey: idempotencyKeyFor.groundArtifacts(runId),
      // The job row and the claim commit or roll back together: a claim nobody ever
      // verifies is invisible, with no error surface anywhere.
      db: fromDrizzle(tx, sql),
    },
  );

  if (!enqueued.success) {
    throw new Error(
      `verification: run ${runId} could not enqueue grounding (${enqueued.error.type})`,
    );
  }
}

/** Re-runs finalization after a human override, with a fresh idempotency generation. */
export async function requeueFinalizeVerdict(runId: string, generation: number): Promise<void> {
  await enqueueStage(JOB_NAMES.finalizeVerdict, runId, { generation });
}
