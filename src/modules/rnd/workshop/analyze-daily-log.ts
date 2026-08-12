import { eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import {
  dailyLog,
  dailyLogAiSummaryChip,
  dailyLogEvidenceLink,
  dailyLogExtractedClaim,
  dailyLogTranscriptSegment,
} from "#src/db/schema.js";
import {
  JOB_NAMES,
  JOB_PAYLOAD_SCHEMAS,
  PermanentJobError,
  parseJobPayload,
} from "#src/lib/jobs.js";
import { parseExternalLink, extractExternalId } from "#src/modules/rnd/external-link.js";
import {
  analyzeDailyLog,
  type DailyLogAnalysis,
  type GeminiError,
} from "#src/modules/rnd/gemini.js";

/**
 * The daily-log analysis job (R_AND_D_BACKEND_STRUCTURE.md §8, §4e).
 *
 * ONE Gemini call per submitted log produces the transcript, the summary chips, the
 * extracted claims and the evidence links, and this handler writes all four in ONE
 * transaction that first deletes whatever a previous run wrote. That is what makes the job
 * safely re-runnable: every row it owns is a derivative of `(log, model, prompt)` and is
 * regenerated wholesale rather than merged.
 *
 * WHAT THIS JOB MAY NEVER DO — and the reason it is worth stating in a comment nobody can
 * delete without noticing:
 *
 *   - It must not write `effort_verification_status`. That column is §9's verdict, and a
 *     transcription job reaching it would make "we heard you say four hours" and "four
 *     hours are proven" the same fact.
 *   - It must not invent a chip, a claim or a minute when the model is unavailable. Every
 *     failure path below leaves the log's derived rows EMPTY and its status honest.
 *
 * THE FAILURE POLICY, matching §9.7's line for the verification pipeline:
 *   retryable  → rethrow, and pg-boss backs off (2^attempt × 30s, capped at 30 min).
 *   permanent  → PermanentJobError, which dead-letters immediately AND records a
 *                `job_failure` row, after the log has been marked `failed` with a reason
 *                a human can read.
 */

/** Bounds what one log can write, independently of what the model returned. */
const MAX_TRANSCRIPT_SEGMENTS = 400;

/** The three outcomes no retry can improve on. Each dead-letters; each explains itself. */
type PermanentAnalysisError = Extract<
  GeminiError,
  { type: "GEMINI_INPUT_REJECTED" | "GEMINI_OUTPUT_TRUNCATED" | "GEMINI_SCHEMA_INVALID" }
>;

/**
 * The sentence a member reads on a failed log, and the one an operator triages from.
 *
 * THE THREE ARE KEPT DISTINCT because they send a reader to three different places: a
 * rejected input is about the video, a truncation is about our own output ceiling, and
 * invalid output is about the model. Collapsing them — as an earlier version did, folding
 * truncation into "could not read this log" — sends an operator to inspect a video that
 * was never the problem. No environment variable is named here: this string reaches
 * clients through `GET …/daily-logs/:logId`.
 */
function failureReasonFor(error: PermanentAnalysisError): string {
  switch (error.type) {
    case "GEMINI_INPUT_REJECTED":
      return `The analysis provider could not read this log (${error.detail}).`;
    case "GEMINI_OUTPUT_TRUNCATED":
      return (
        "The analysis provider's response was cut off before it finished, at this " +
        `environment's ${error.maxOutputTokens}-token output limit. Nothing was recorded; ` +
        "the log can be re-analyzed once the limit is raised."
      );
    case "GEMINI_SCHEMA_INVALID":
      return `The analysis provider returned output that could not be read (${error.issues.join("; ")}).`;
    default: {
      const exhaustiveCheck: never = error;
      throw new Error(`Unhandled analysis failure: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function handleAnalyzeDailyLog(rawPayload: unknown): Promise<void> {
  const payload = parseJobPayload(
    JOB_NAMES.analyzeDailyLog,
    JOB_PAYLOAD_SCHEMAS[JOB_NAMES.analyzeDailyLog],
    rawPayload,
  );

  const [log] = await db
    .select({
      id: dailyLog.id,
      status: dailyLog.status,
      analysisStatus: dailyLog.analysisStatus,
      logDate: dailyLog.logDate,
      narrative: dailyLog.narrative,
      youtubeVideoId: dailyLog.youtubeVideoId,
    })
    .from(dailyLog)
    .where(eq(dailyLog.id, payload.dailyLogId));

  if (!log) {
    // The log was deleted between enqueue and dequeue — possible only for a draft, and
    // therefore not an error worth retrying or alarming on.
    return;
  }
  if (log.status !== "submitted") {
    throw new PermanentJobError(
      "LOG_NOT_SUBMITTED",
      `analyze-daily-log: log ${log.id} is ${log.status}, not submitted`,
    );
  }
  if (log.analysisStatus === "succeeded") {
    // A duplicate delivery after the dedup window. Re-running would spend a free-tier
    // request to produce the rows that are already there.
    return;
  }

  await db.update(dailyLog).set({ analysisStatus: "running" }).where(eq(dailyLog.id, log.id));

  const analysis = await analyzeDailyLog(
    {
      youtubeVideoId: log.youtubeVideoId,
      narrative: log.narrative,
      logDate: log.logDate,
    },
    {
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      timeoutMs: config.GEMINI_TIMEOUT_MS,
      maxOutputTokens: config.GEMINI_MAX_OUTPUT_TOKENS,
    },
  );

  if (!analysis.success) {
    switch (analysis.error.type) {
      case "GEMINI_UNAVAILABLE":
        // Retryable. The log goes BACK to `queued` rather than staying `running`, so a
        // worker that dies mid-call does not leave a log stuck in a state no sweep clears.
        await db
          .update(dailyLog)
          .set({ analysisStatus: "queued", analysisFailureReason: analysis.error.detail })
          .where(eq(dailyLog.id, log.id));
        throw new Error(`analyze-daily-log: provider unavailable (${analysis.error.detail})`);

      case "GEMINI_NOT_CONFIGURED":
        // The key was removed between submit and dequeue. Not a failure of the log.
        await db
          .update(dailyLog)
          .set({
            analysisStatus: "skipped_unconfigured",
            analysisCompletedAt: new Date(),
            analysisFailureReason: "No analysis provider is configured for this environment.",
          })
          .where(eq(dailyLog.id, log.id));
        return;

      case "GEMINI_INPUT_REJECTED":
      case "GEMINI_OUTPUT_TRUNCATED":
      case "GEMINI_SCHEMA_INVALID": {
        const reason = failureReasonFor(analysis.error);

        await db
          .update(dailyLog)
          .set({
            analysisStatus: "failed",
            analysisCompletedAt: new Date(),
            analysisFailureReason: reason,
          })
          .where(eq(dailyLog.id, log.id));

        // The log keeps its narrative and its video; only the derived rows are absent.
        // A member loses nothing, and §9 sees a claim with no grounding rather than a
        // fabricated one.
        throw new PermanentJobError(analysis.error.type, `analyze-daily-log: ${reason}`);
      }

      default: {
        const exhaustiveCheck: never = analysis.error;
        throw new Error(`Unhandled analysis error: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  await writeAnalysis(log.id, analysis.value.analysis, {
    modelName: analysis.value.modelName,
    modelVersion: analysis.value.modelVersion,
    promptVersion: analysis.value.promptVersion,
  });
}

interface AnalysisProvenance {
  readonly modelName: string;
  readonly modelVersion: string | null;
  readonly promptVersion: string;
}

/**
 * Replaces every derived row for one log, in one transaction.
 *
 * DELETE-THEN-INSERT rather than upsert, deliberately: these rows have no identity of
 * their own — a re-analysis with a newer prompt produces a different NUMBER of segments
 * and a different set of chips, and merging them would leave a log carrying two prompts'
 * output at once with no way to tell which sentence came from which.
 */
async function writeAnalysis(
  dailyLogId: string,
  analysis: DailyLogAnalysis,
  provenance: AnalysisProvenance,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(dailyLogTranscriptSegment)
      .where(eq(dailyLogTranscriptSegment.dailyLogId, dailyLogId));
    await tx.delete(dailyLogAiSummaryChip).where(eq(dailyLogAiSummaryChip.dailyLogId, dailyLogId));
    await tx
      .delete(dailyLogExtractedClaim)
      .where(eq(dailyLogExtractedClaim.dailyLogId, dailyLogId));
    await tx.delete(dailyLogEvidenceLink).where(eq(dailyLogEvidenceLink.dailyLogId, dailyLogId));

    const segments = analysis.transcriptSegments.slice(0, MAX_TRANSCRIPT_SEGMENTS);
    if (segments.length > 0) {
      await tx.insert(dailyLogTranscriptSegment).values(
        segments.map((segment, index) => ({
          dailyLogId,
          sequenceNumber: index,
          startOffsetSeconds: segment.startOffsetSeconds,
          endOffsetSeconds: segment.endOffsetSeconds,
          speakerLabel: segment.speakerLabel,
          segmentText: segment.segmentText,
        })),
      );
    }

    if (analysis.summaryChips.length > 0) {
      await tx.insert(dailyLogAiSummaryChip).values(
        analysis.summaryChips.map((chip, index) => ({
          dailyLogId,
          sequenceNumber: index,
          kind: chip.kind,
          label: chip.label,
          confidenceBps: chip.confidenceBps,
          generatedByModel: provenance.modelVersion ?? provenance.modelName,
          promptVersion: provenance.promptVersion,
        })),
      );
    }

    if (analysis.extractedClaims.length > 0) {
      await tx.insert(dailyLogExtractedClaim).values(
        analysis.extractedClaims.map((claim, index) => ({
          dailyLogId,
          sequenceNumber: index,
          claimKind: claim.claimKind,
          extractedMinutes: claim.extractedMinutes,
          extractedCashInCents:
            claim.extractedCashInCents === null ? null : BigInt(claim.extractedCashInCents),
          claimSummary: claim.claimSummary,
          confidenceBps: claim.confidenceBps,
          generatedByModel: provenance.modelVersion ?? provenance.modelName,
          promptVersion: provenance.promptVersion,
        })),
      );
    }

    // The model's URLs get the SAME allowlist treatment a member's do (§0 applied to a
    // model): a hallucinated or hostile link would otherwise be stored and rendered as an
    // anchor a teammate clicks. Anything outside the allowlist is DROPPED rather than
    // failing the analysis — an unrecognized host grounds nothing in §9 anyway.
    const acceptedLinks = analysis.evidenceLinks
      .map((link) => parseExternalLink(link.externalUrl))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.value);

    // Deduplicated on the NORMALIZED url, because the unique index is — two spellings of
    // one link in a transcript must not fail the whole insert.
    const uniqueLinks = new Map(acceptedLinks.map((link) => [link.normalizedUrl, link]));

    if (uniqueLinks.size > 0) {
      await tx.insert(dailyLogEvidenceLink).values(
        [...uniqueLinks.values()].map((link) => ({
          dailyLogId,
          provider: link.provider,
          sourceKind: "ai_extracted" as const,
          externalUrl: link.normalizedUrl,
          externalHost: link.host,
          externalId: extractExternalId(link),
          generatedByModel: provenance.modelVersion ?? provenance.modelName,
          promptVersion: provenance.promptVersion,
        })),
      );
    }

    await tx
      .update(dailyLog)
      .set({
        analysisStatus: "succeeded",
        analysisCompletedAt: new Date(),
        analysisFailureReason: null,
        analysisModelName: provenance.modelName,
        analysisModelVersion: provenance.modelVersion,
        analysisPromptVersion: provenance.promptVersion,
        // effortVerificationStatus is NOT set here, and must never be. See the module
        // comment: a transcript is not a verdict.
      })
      .where(eq(dailyLog.id, dailyLogId));
  });
}
