import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * The bake's REPLAY branch — the reason `pie_bake_event.idempotency_key` exists.
 *
 * `pie_bake_event_project_unq` already makes a second bake impossible; it does not decide
 * what a repeat attempt is TOLD. This is that decision, and it is the whole feature:
 *
 *   - the same request twice (a founder retrying after the connection dropped on the one
 *     irreversible action in the product) gets THEIR BAKE BACK, indistinguishable from the
 *     first answer;
 *   - anyone else — a different key, no key, or a bake that predates the column — still
 *     gets `PIE_ALREADY_BAKED`, which for them is the truth.
 *
 * Every case here short-circuits at the first `alreadyBaked` read, so the db stub only has
 * to serve `select().from().where()`. The gates below that point are the route suite's and
 * the existing service behaviour's business, not this file's.
 */

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

const whereMock = vi.fn<(...args: readonly unknown[]) => Promise<readonly unknown[]>>();
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock("#src/db/index.js", () => ({ db: { select: selectMock } }));

const findSnapshot = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/funding/equity-snapshot.service.js", () => ({
  findSnapshot: (...args: readonly unknown[]) => findSnapshot(...args),
  recomputeEquitySnapshot: vi.fn(),
}));

const { bakePie, PIE_BAKE_ACKNOWLEDGEMENT } = await import("#src/modules/rnd/funding/pie-bake.service.js");

const PROJECT = { projectId: "project_1" };
const SNAPSHOT = { id: "snapshot_1", totalSlices: "100", memberCount: "3", shares: [] };

/** A valid bake request; `idempotencyKey` is layered on per case. */
const BAKE_INPUT = {
  trigger: "priced_round" as const,
  triggerEvidenceNote: "Series A closed.",
  acknowledgement: PIE_BAKE_ACKNOWLEDGEMENT,
  expectedSnapshotId: "11111111-1111-4111-8111-111111111111",
};

/** The already-baked row the first `select` finds, with whatever key it was baked under. */
function stubExistingBake(storedKey: string | null): void {
  whereMock.mockResolvedValueOnce([{ id: "bake_1", idempotencyKey: storedKey }]);
  // The read-back inside `findPieBake`, only reached on a genuine replay.
  whereMock.mockResolvedValueOnce([
    {
      id: "bake_1",
      snapshotId: "snapshot_1",
      trigger: "priced_round",
      valuationCents: 1_200_000_000n,
      bakedAt: new Date("2026-03-01T00:00:00.000Z"),
      idempotencyKey: storedKey,
    },
  ]);
  findSnapshot.mockResolvedValue(SNAPSHOT);
}

describe("bakePie — replaying a founder's own retry", () => {
  beforeEach(() => {
    // `resetAllMocks`, not `clearAllMocks`: only a reset drains queued `…Once` values, and
    // these cases queue them. Clearing alone leaves an unconsumed row to be picked up as
    // the NEXT case's `alreadyBaked` probe, which silently inverts its outcome.
    vi.resetAllMocks();
    selectMock.mockImplementation(() => ({ from: fromMock }));
    fromMock.mockImplementation(() => ({ where: whereMock }));
  });

  it("returns the original bake when the key matches the one it was baked under", async () => {
    stubExistingBake("bake-key-0001");

    const result = await bakePie(
      PROJECT,
      { ...BAKE_INPUT, idempotencyKey: "bake-key-0001" },
      "user_founder",
      "founder",
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.bakeEventId).toBe("bake_1");
    expect(result.value.snapshot).toEqual(SNAPSHOT);
  });

  it("refuses a different key with PIE_ALREADY_BAKED — that caller is not retrying", async () => {
    stubExistingBake("bake-key-0001");

    const result = await bakePie(
      PROJECT,
      { ...BAKE_INPUT, idempotencyKey: "someone-elses-key" },
      "user_founder",
      "founder",
    );

    expect(result).toEqual({ success: false, error: { type: "PIE_ALREADY_BAKED" } });
  });

  it("refuses a caller that sent no key at all", async () => {
    stubExistingBake("bake-key-0001");

    const result = await bakePie(PROJECT, BAKE_INPUT, "user_founder", "founder");

    expect(result).toEqual({ success: false, error: { type: "PIE_ALREADY_BAKED" } });
  });

  /**
   * A pie baked before the column existed carries NULL, and a null must never match — not
   * even another null. Otherwise the first keyless retry after the migration would be
   * handed a bake it did not make.
   */
  it("never treats a null stored key as a match, even for a keyless caller", async () => {
    stubExistingBake(null);

    const keyless = await bakePie(PROJECT, BAKE_INPUT, "user_founder", "founder");
    stubExistingBake(null);
    const keyed = await bakePie(PROJECT, { ...BAKE_INPUT, idempotencyKey: "bake-key-0001" }, "user_founder", "founder");

    expect(keyless).toEqual({ success: false, error: { type: "PIE_ALREADY_BAKED" } });
    expect(keyed).toEqual({ success: false, error: { type: "PIE_ALREADY_BAKED" } });
  });

  /**
   * The acknowledgement gate is checked BEFORE the replay lookup, so a retry that somehow
   * lost its typed phrase is still refused rather than replayed on the strength of its key.
   */
  it("still requires the typed acknowledgement, key or no key", async () => {
    const result = await bakePie(
      PROJECT,
      { ...BAKE_INPUT, acknowledgement: "bake the pie", idempotencyKey: "bake-key-0001" },
      "user_founder",
      "founder",
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe("ACKNOWLEDGEMENT_MISMATCH");
    expect(selectMock).not.toHaveBeenCalled();
  });
});
