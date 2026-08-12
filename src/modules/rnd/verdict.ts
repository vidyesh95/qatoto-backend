/**
 * The claim verdict function (R_AND_D_BACKEND_STRUCTURE.md §9.7; PROOF_OF_EFFORT_SPEC.md §4).
 *
 * ONE FUNCTION, WRITTEN ONCE, PURE. A verdict decided in two places is a verdict that
 * eventually disagrees with itself, and this one gates whether equity is minted — so it
 * takes no database handle, reads no clock, and makes no network call. Given the same four
 * step statuses it returns the same answer forever, which is what lets an auditor re-run a
 * historical claim and get the historical outcome.
 *
 * THE FAILURE MODE IS SAFE BY DEFAULT: a broken pipeline awards ZERO, never a guess
 * (§9.7). Every ordering rule below follows from that single sentence.
 *
 * The four steps are SPEC §4's audit, in order:
 *
 *   1. `claim_extraction`    — what did the member actually claim?
 *   2. `artifact_grounding`  — do deterministic digital receipts back it?
 *   3. `substance_analysis`  — is the work substantive, or 5,000 lines of padding?
 *   4. `temporal_analysis`   — do the timestamps match the hours claimed?
 */

/** The four ordered steps of one verification run. `stepOrder` is this array's index + 1. */
export const VERIFICATION_STEP_KINDS = [
  "claim_extraction",
  "artifact_grounding",
  "substance_analysis",
  "temporal_analysis",
] as const;

export type VerificationStepKind = (typeof VERIFICATION_STEP_KINDS)[number];

/**
 * A step's outcome.
 *
 * `skipped` and `failed` are NOT interchangeable and the difference decides whether
 * someone is paid:
 *
 *   - `skipped` means the step does not apply to this claim at all — AST substance
 *     analysis against a photograph of a sanded chassis has nothing to parse.
 *   - `failed` means the step applied and did not pass. Critically, a claim with NO
 *     digital receipts fails `artifact_grounding`; it does not skip it. SPEC §4 step 2 is
 *     explicit — "no digital receipts → flag Unverified, zero equity slices" — and a
 *     grounding step that skipped its way to `verified` would mint equity for a claim
 *     nothing corroborates.
 */
export type VerificationStepStatus = "pending" | "passed" | "flagged" | "failed" | "skipped";

/**
 * The verdict, in the vocabulary `effort_verification_status` (§4d) uses.
 *
 * `incomplete` is not a persisted verdict — it maps to the enum's `running`. It exists so
 * that calling this function on a half-finished run returns an honest answer instead of a
 * premature `verified`.
 */
export type ClaimVerdict = "verified" | "flagged_for_review" | "unverified" | "incomplete";

export interface VerificationStepOutcome {
  readonly stepKind: VerificationStepKind;
  readonly status: VerificationStepStatus;
  /**
   * A human's override of an AI judgement (§9.1). When present it REPLACES `status` for
   * verdict purposes — that is the entire point of the override, and it is the only
   * hand-edit anywhere in this domain. It edits a judgement, never a number.
   */
  readonly overriddenStatus?: VerificationStepStatus | null | undefined;
}

export interface VerdictDecision {
  readonly verdict: ClaimVerdict;
  /**
   * The step that drove the verdict, so the caller can write a `findingSummary` naming it
   * rather than "verification failed". Null only when every step passed or skipped.
   */
  readonly decidedByStepKind: VerificationStepKind | null;
}

/** A step's status after any human override is applied. */
export function effectiveStepStatus(step: VerificationStepOutcome): VerificationStepStatus {
  return step.overriddenStatus ?? step.status;
}

/**
 * Decides a claim's verdict from its four step outcomes.
 *
 * PRECEDENCE, and why it is in this order:
 *
 *   1. Any `failed` → `unverified`. Terminal and unconditional, even alongside a `pending`
 *      step, because zero is always the safe direction and §9.7 requires the pipeline to
 *      reach a verdict rather than stall.
 *   2. Any `pending` → `incomplete`. The run is still in flight; concluding now would
 *      award on evidence not yet gathered.
 *   3. Any `flagged` → `flagged_for_review`. Allocation is withheld pending a human, but
 *      a proposal still OPENS (§9.8) — a flagged claim posts to the transparency ledger
 *      rather than vanishing, or members would lose contributions with no recourse.
 *   4. Everything `passed` or `skipped` → `verified`.
 *
 * @throws if a step kind is missing or duplicated — an unrecoverable programmer error
 *         (CLAUDE.md §3.3). A verdict computed over three steps is not this function's
 *         verdict, and silently treating an absent step as passing is exactly the bug
 *         rule 1 exists to prevent.
 */
export function decideClaimVerdict(steps: readonly VerificationStepOutcome[]): VerdictDecision {
  const seenKinds = new Set(steps.map((step) => step.stepKind));
  if (seenKinds.size !== steps.length) {
    throw new Error("decideClaimVerdict: duplicate step kinds in one run");
  }
  for (const requiredKind of VERIFICATION_STEP_KINDS) {
    if (!seenKinds.has(requiredKind)) {
      throw new Error(`decideClaimVerdict: run is missing the ${requiredKind} step`);
    }
  }

  // Evaluated in the canonical step order, never in the caller's array order, so the step
  // NAMED in `decidedByStepKind` is stable across two callers who built the array
  // differently (§4c rule 4).
  const orderedSteps = VERIFICATION_STEP_KINDS.map((stepKind) => {
    const step = steps.find((candidate) => candidate.stepKind === stepKind);
    if (step === undefined) {
      throw new Error(`decideClaimVerdict: run is missing the ${stepKind} step`);
    }
    return { stepKind, status: effectiveStepStatus(step) };
  });

  const findFirst = (
    status: VerificationStepStatus,
  ): { readonly stepKind: VerificationStepKind } | undefined =>
    orderedSteps.find((step) => step.status === status);

  const failedStep = findFirst("failed");
  if (failedStep) {
    return { verdict: "unverified", decidedByStepKind: failedStep.stepKind };
  }

  const pendingStep = findFirst("pending");
  if (pendingStep) {
    return { verdict: "incomplete", decidedByStepKind: pendingStep.stepKind };
  }

  const flaggedStep = findFirst("flagged");
  if (flaggedStep) {
    return { verdict: "flagged_for_review", decidedByStepKind: flaggedStep.stepKind };
  }

  for (const step of orderedSteps) {
    switch (step.status) {
      case "passed":
      case "skipped":
        continue;
      case "failed":
      case "pending":
      case "flagged":
        // Unreachable: each was returned above. Kept so that adding a status to
        // VerificationStepStatus without deciding what it means breaks the build here
        // rather than silently falling through to `verified` (CLAUDE.md §3.2).
        throw new Error(`decideClaimVerdict: ${step.status} survived its own guard`);
      default: {
        const exhaustiveCheck: never = step.status;
        throw new Error(
          `decideClaimVerdict: unhandled step status ${JSON.stringify(exhaustiveCheck)}`,
        );
      }
    }
  }

  return { verdict: "verified", decidedByStepKind: null };
}

/**
 * Whether a verdict permits any slices at all.
 *
 * `verified` alone awards. `flagged_for_review` opens a window and posts to the ledger at
 * ZERO — the solar mock's "960 slices withheld" entry is exactly this case (§9.8).
 */
export function verdictAwardsSlices(verdict: ClaimVerdict): boolean {
  switch (verdict) {
    case "verified":
      return true;
    case "flagged_for_review":
    case "unverified":
    case "incomplete":
      return false;
    default: {
      const exhaustiveCheck: never = verdict;
      throw new Error(`verdictAwardsSlices: unhandled verdict ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
