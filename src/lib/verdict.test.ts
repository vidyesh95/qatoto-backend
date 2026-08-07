import { describe, expect, it } from "vitest";

import {
  decideClaimVerdict,
  effectiveStepStatus,
  VERIFICATION_STEP_KINDS,
  verdictAwardsSlices,
  type ClaimVerdict,
  type VerificationStepOutcome,
  type VerificationStepStatus,
} from "#src/lib/verdict.js";

const ALL_STATUSES: readonly VerificationStepStatus[] = [
  "pending",
  "passed",
  "flagged",
  "failed",
  "skipped",
];

function stepsWith(statuses: readonly VerificationStepStatus[]): VerificationStepOutcome[] {
  return VERIFICATION_STEP_KINDS.map((stepKind, index) => ({
    stepKind,
    // Non-null by construction: callers pass exactly four statuses.
    status: statuses[index] ?? "pending",
  }));
}

/**
 * The exhaustive table R_AND_D_BACKEND_STRUCTURE.md §9.7 asks for: "unit-tested over all
 * 5⁴ combinations". Five statuses across four ordered steps is 625 runs, and the
 * independently-computed expectation below is what makes this a real check rather than a
 * restatement of the implementation.
 */
function expectedVerdict(statuses: readonly VerificationStepStatus[]): ClaimVerdict {
  if (statuses.includes("failed")) return "unverified";
  if (statuses.includes("pending")) return "incomplete";
  if (statuses.includes("flagged")) return "flagged_for_review";
  return "verified";
}

describe("decideClaimVerdict over all 5^4 step combinations", () => {
  const allCombinations: VerificationStepStatus[][] = [];
  for (const first of ALL_STATUSES) {
    for (const second of ALL_STATUSES) {
      for (const third of ALL_STATUSES) {
        for (const fourth of ALL_STATUSES) {
          allCombinations.push([first, second, third, fourth]);
        }
      }
    }
  }

  it("covers exactly 625 combinations", () => {
    expect(allCombinations).toHaveLength(625);
  });

  it("agrees with the precedence rule on every one of them", () => {
    const disagreements = allCombinations.filter(
      (statuses) => decideClaimVerdict(stepsWith(statuses)).verdict !== expectedVerdict(statuses),
    );
    expect(disagreements).toEqual([]);
  });

  it("never returns `verified` when any step failed", () => {
    // The one property that mints equity, stated on its own so a regression here cannot
    // hide inside the table above.
    const withAFailure = allCombinations.filter((statuses) => statuses.includes("failed"));
    expect(withAFailure).not.toHaveLength(0);
    for (const statuses of withAFailure) {
      expect(decideClaimVerdict(stepsWith(statuses)).verdict).toBe("unverified");
    }
  });
});

describe("decideClaimVerdict precedence", () => {
  it("prefers `failed` over a still-pending step — zero is the safe direction", () => {
    const decision = decideClaimVerdict(stepsWith(["passed", "failed", "pending", "pending"]));
    expect(decision).toEqual({ verdict: "unverified", decidedByStepKind: "artifact_grounding" });
  });

  it("reports incomplete while a step is still in flight", () => {
    const decision = decideClaimVerdict(stepsWith(["passed", "passed", "pending", "pending"]));
    expect(decision).toEqual({ verdict: "incomplete", decidedByStepKind: "substance_analysis" });
  });

  it("flags for review when nothing failed but something was flagged", () => {
    const decision = decideClaimVerdict(stepsWith(["passed", "passed", "flagged", "passed"]));
    expect(decision).toEqual({
      verdict: "flagged_for_review",
      decidedByStepKind: "substance_analysis",
    });
  });

  it("verifies when every step passed or was skipped", () => {
    const decision = decideClaimVerdict(stepsWith(["passed", "passed", "skipped", "skipped"]));
    expect(decision).toEqual({ verdict: "verified", decidedByStepKind: null });
  });

  it("names the step in canonical order, not in the caller's array order", () => {
    // Both steps are flagged; the verdict must name the earlier one whichever way the
    // caller happened to build the array (§4c rule 4).
    const forwards = decideClaimVerdict(stepsWith(["passed", "flagged", "flagged", "passed"]));
    const shuffled = decideClaimVerdict(
      [...stepsWith(["passed", "flagged", "flagged", "passed"])].toReversed(),
    );
    expect(forwards.decidedByStepKind).toBe("artifact_grounding");
    expect(shuffled.decidedByStepKind).toBe("artifact_grounding");
  });
});

describe("overrides", () => {
  it("lets a human override rescue a flagged step", () => {
    const steps: VerificationStepOutcome[] = stepsWith([
      "passed",
      "passed",
      "flagged",
      "passed",
    ]).map((step) =>
      step.stepKind === "substance_analysis" ? { ...step, overriddenStatus: "passed" } : step,
    );

    expect(decideClaimVerdict(steps).verdict).toBe("verified");
  });

  it("lets a human override sink a passing step", () => {
    // The override edits an AI JUDGEMENT, never a number — this is the whole of §9.1's
    // one permitted hand-edit.
    const steps: VerificationStepOutcome[] = stepsWith([
      "passed",
      "passed",
      "passed",
      "passed",
    ]).map((step) =>
      step.stepKind === "temporal_analysis" ? { ...step, overriddenStatus: "failed" } : step,
    );

    expect(decideClaimVerdict(steps).verdict).toBe("unverified");
  });

  it("treats a null override as absent", () => {
    expect(
      effectiveStepStatus({
        stepKind: "artifact_grounding",
        status: "flagged",
        overriddenStatus: null,
      }),
    ).toBe("flagged");
  });
});

describe("run integrity", () => {
  it("throws when a step is missing rather than treating it as passing", () => {
    const threeSteps = stepsWith(["passed", "passed", "passed", "passed"]).slice(0, 3);
    expect(() => decideClaimVerdict(threeSteps)).toThrow(/missing the temporal_analysis step/);
  });

  it("throws on a duplicated step kind", () => {
    const duplicated: VerificationStepOutcome[] = [
      { stepKind: "claim_extraction", status: "passed" },
      { stepKind: "claim_extraction", status: "failed" },
      { stepKind: "artifact_grounding", status: "passed" },
      { stepKind: "substance_analysis", status: "passed" },
    ];
    expect(() => decideClaimVerdict(duplicated)).toThrow(/duplicate step kinds/);
  });
});

describe("verdictAwardsSlices", () => {
  it("awards only on `verified`", () => {
    expect(verdictAwardsSlices("verified")).toBe(true);
  });

  it("withholds on `flagged_for_review` — the entry is still written, at zero", () => {
    expect(verdictAwardsSlices("flagged_for_review")).toBe(false);
  });

  it("withholds on `unverified` and `incomplete`", () => {
    expect(verdictAwardsSlices("unverified")).toBe(false);
    expect(verdictAwardsSlices("incomplete")).toBe(false);
  });
});
