import { describe, expect, it, vi } from "vitest";

// These modules pull in the db pool and the parsed config at module scope. Nothing below
// touches a database — every function under test is pure — so the pool is stubbed away and
// the environment is stubbed BEFORE the dynamic imports resolve.
vi.mock("#src/db/index.js", () => ({ db: {}, pool: {} }));
vi.mock("pg-boss", () => ({ fromDrizzle: () => ({}) }));

vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("DATABASE_URL", "postgres://user:password@localhost:5432/testdb");
vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-key-minimum-16-chars");
vi.stubEnv("BETTER_AUTH_URL", "http://localhost:8000");
vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
vi.stubEnv("GITHUB_CLIENT_ID", "test-github-client-id");
vi.stubEnv("GITHUB_CLIENT_SECRET", "test-github-client-secret");
// PINNED, not defaulted. `derivePlatformFeeInCents` reads this, and a test that silently
// depended on the schema default would start asserting a different fee the day somebody
// changed it — and would pass, because the expectation would move with the code.
vi.stubEnv("PLATFORM_FEE_BASIS_POINTS", "500");

const { percentageFundedBasisPoints, derivePlatformFeeInCents } =
  await import("#src/services/funding-rounds.service.js");
const { computeVarianceBasisPoints } = await import("#src/services/milestones.service.js");
const { computeConfidenceBasisPoints } = await import("#src/services/investor-confidence.service.js");

/**
 * The §7 arithmetic (R_AND_D_BACKEND_STRUCTURE.md §4b, §4c, §7).
 *
 * Every function here produces a number somebody makes a funding decision on, and §4c's
 * whole argument is that two servers — or one server run twice — must produce BIT-IDENTICAL
 * integers. These are the properties that claim rests on.
 */

describe("percentageFundedBasisPoints", () => {
  it("is FLOOR, not rounding — a round must not read as funded before it is", () => {
    // 99.995% of the goal. Half-away-from-zero would round this to 10000 and render a
    // round as fully funded while it is 5 cents short, on a surface where "funded" is a
    // threshold people act on.
    expect(percentageFundedBasisPoints(99_995n, 100_000n)).toBe(9_999);
    // And the exact boundary still reads exactly.
    expect(percentageFundedBasisPoints(100_000n, 100_000n)).toBe(10_000);
  });

  it("exceeds 10000 when overfunded rather than clamping", () => {
    // §7: "the value may exceed 10000 when overfunded, and the client clamps the WIDTH,
    // not the number". A round at 143% should say 143%.
    expect(percentageFundedBasisPoints(143_000n, 100_000n)).toBe(14_300);
  });

  it("is zero before anything settles", () => {
    expect(percentageFundedBasisPoints(0n, 500_000n)).toBe(0);
  });

  it("holds precision past 2^53, where a JS number would silently round", () => {
    // A goal and a raise beyond Number.MAX_SAFE_INTEGER. `integer` (int4) caps at
    // ±$21,474,836.47 — §4b's reason the columns are `bigint` — and float arithmetic here
    // would lose the last digits without telling anyone.
    const goal = 90_071_992_547_409_930n;
    const raised = 45_035_996_273_704_965n;
    expect(percentageFundedBasisPoints(raised, goal)).toBe(5_000);
  });

  it("throws rather than answering 'what percentage of nothing'", () => {
    // Returning 0 would render as a computed fact. The column CHECK forbids a zero goal,
    // so this is an assertion about a state that should be unreachable.
    expect(() => percentageFundedBasisPoints(100n, 0n)).toThrow("goal must be positive");
  });
});

describe("derivePlatformFeeInCents", () => {
  it("derives the fee from config basis points, never from a request", () => {
    // The default is 500 basis points = 5%.
    expect(derivePlatformFeeInCents(100_000n)).toBe(5_000n);
    expect(derivePlatformFeeInCents(0n)).toBe(0n);
  });

  it("rounds half AWAY FROM ZERO, matching Postgres", () => {
    // 5% of 10 cents is 0.5 cents exactly. `Math.round` and Postgres `round()` disagree on
    // negatives, and JS rounds -0.5 to -0; `divRoundHalfAwayFromZero` is the one rule both
    // sides of the wire follow (§4c).
    expect(derivePlatformFeeInCents(10n)).toBe(1n);
  });

  it("never exceeds the pledge, so the net is never negative", () => {
    // The column CHECK `platform_fee_in_cents <= amount_in_cents` says the same thing. At
    // the 2000-basis-point config ceiling the fee is a fifth of the pledge, so this holds
    // for every reachable configuration.
    for (const amountInCents of [1n, 7n, 99n, 100_000n, 999_999_999_999n]) {
      const fee = derivePlatformFeeInCents(amountInCents);
      expect(fee).toBeLessThanOrEqual(amountInCents);
      expect(fee).toBeGreaterThanOrEqual(0n);
      expect(amountInCents - fee).toBeGreaterThanOrEqual(0n);
    }
  });
});

describe("computeVarianceBasisPoints", () => {
  it("reproduces the mock's '26% behind' as a signed integer (§15)", () => {
    // 30 planned days, 38 actual — the milestone the mock rendered as `"26% behind"`.
    // NEGATIVE is behind. A client can now sort, compare and localize it.
    expect(computeVarianceBasisPoints(30, 38)).toBe(-2_667);
  });

  it("is positive when ahead of plan", () => {
    expect(computeVarianceBasisPoints(30, 24)).toBe(2_000);
  });

  it("is exactly zero when actual equals planned", () => {
    expect(computeVarianceBasisPoints(30, 30)).toBe(0);
  });

  it("answers 0 for a zero plan rather than throwing or returning infinity", () => {
    // "We planned nothing and it took three days" is a real state of a real milestone.
    // Refusing to store its variance would block the whole update over a division.
    expect(computeVarianceBasisPoints(0, 3)).toBe(0);
  });

  it("clamps to the column's bound instead of producing a row Postgres would reject", () => {
    // `milestone_variance_basis_points_ck` bounds this to ±1,000,000. One day planned,
    // three years actual is −10,940,000 unclamped — a legal (if embarrassing) data entry
    // that would fail the INSERT and surface to the founder as a 500 on a valid request.
    // The six raw integers are stored beside it and stay exact.
    expect(computeVarianceBasisPoints(1, 1_095)).toBe(-1_000_000);
    expect(computeVarianceBasisPoints(1, 5_000)).toBe(-1_000_000);

    // And the bound is never hit by anything realistic: an overrun up to 101× plan still
    // reports its true figure.
    expect(computeVarianceBasisPoints(1, 101)).toBe(-1_000_000);
    expect(computeVarianceBasisPoints(1, 100)).toBe(-990_000);
  });
});

describe("computeConfidenceBasisPoints", () => {
  const noSignal = {
    dailyLogStreakDays: 0,
    verifiedMilestoneCount: 0,
    totalMilestoneCount: 0,
    openDisputeCount: 0,
    resolvedDisputeCount: 0,
  };

  it("is bounded to [0, 10000] across the whole input space", () => {
    // The column CHECK says the same thing; this proves the formula cannot produce a value
    // the column would reject, which is the difference between a constraint that never
    // fires and a constraint that fires in production.
    for (const streak of [0, 1, 15, 30, 400]) {
      for (const total of [0, 1, 5, 50]) {
        for (const verified of [0, 1, 5, 50]) {
          if (verified > total) continue;
          for (const open of [0, 1, 9]) {
            for (const resolved of [0, 1, 9]) {
              const score = computeConfidenceBasisPoints({
                dailyLogStreakDays: streak,
                verifiedMilestoneCount: verified,
                totalMilestoneCount: total,
                openDisputeCount: open,
                resolvedDisputeCount: resolved,
              });
              expect(score).toBeGreaterThanOrEqual(0);
              expect(score).toBeLessThanOrEqual(10_000);
            }
          }
        }
      }
    }
  });

  it("scores an empty roadmap at zero on delivery, not full marks", () => {
    // "Has delivered nothing yet" and "has delivered everything promised" are not the same
    // claim. Treating an empty roadmap as perfect is how a shell project outscores a real
    // one — and the dispute component still pays out, because nobody has objected to
    // anything, so the total is the 3000 basis points that component is worth.
    expect(computeConfidenceBasisPoints(noSignal)).toBe(3_000);
  });

  it("is deterministic — the same inputs give the same integer, every time", () => {
    // §4c's entire argument. Run it a thousand times and assert one value.
    const inputs = {
      dailyLogStreakDays: 17,
      verifiedMilestoneCount: 3,
      totalMilestoneCount: 7,
      openDisputeCount: 1,
      resolvedDisputeCount: 2,
    };
    const first = computeConfidenceBasisPoints(inputs);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expect(computeConfidenceBasisPoints(inputs)).toBe(first);
    }
  });

  it("saturates the streak component at 30 days rather than growing forever", () => {
    const atSaturation = { ...noSignal, dailyLogStreakDays: 30, totalMilestoneCount: 0 };
    const wellPast = { ...noSignal, dailyLogStreakDays: 3_000, totalMilestoneCount: 0 };
    expect(computeConfidenceBasisPoints(wellPast)).toBe(computeConfidenceBasisPoints(atSaturation));
  });

  it("costs more for an open dispute than for a resolved one", () => {
    const withOpen = { ...noSignal, totalMilestoneCount: 1, verifiedMilestoneCount: 1, openDisputeCount: 1 };
    const withResolved = {
      ...noSignal,
      totalMilestoneCount: 1,
      verifiedMilestoneCount: 1,
      resolvedDisputeCount: 1,
    };
    // An unresolved objection is an unanswered question, and the signal should say so.
    expect(computeConfidenceBasisPoints(withOpen)).toBeLessThan(computeConfidenceBasisPoints(withResolved));
  });

  it("gives a clean, fully-delivered project full marks", () => {
    expect(
      computeConfidenceBasisPoints({
        dailyLogStreakDays: 30,
        verifiedMilestoneCount: 4,
        totalMilestoneCount: 4,
        openDisputeCount: 0,
        resolvedDisputeCount: 0,
      }),
    ).toBe(10_000);
  });
});
