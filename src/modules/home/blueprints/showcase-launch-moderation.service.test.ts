import { beforeEach, describe, expect, it, vi } from "vitest";

import { decodeInstantCursor } from "#src/lib/instant-cursor.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

/**
 * UNIT tests for showcase launch moderation — the review queue's paging and the publish/reject
 * decision.
 *
 * WHAT A MOCKED DATABASE CAN AND CANNOT PROVE HERE, stated because the difference is the whole
 * design of this file. It CAN prove the decision ladder (404 before 403 before 409), the slug
 * candidate walk, what the audit entry carries, and that the keyset over-fetches by one. It CANNOT
 * prove that a SAVEPOINT rollback leaves the outer transaction usable, or that the partial unique
 * index is what actually refuses a slug — those are Postgres behaviors, and a stub would agree with
 * whatever the code did. They belong in a verify script against a real database.
 *
 * `slugifyProgramTitle` IS LEFT REAL. It is pure, and the slug a launch gets is its public address —
 * asserting against a stubbed slugifier would test the stub.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));

interface LaunchRow {
  readonly id: string;
  readonly title: string;
  readonly authorUserId: string;
  readonly moderationState: "pending_review" | "published" | "rejected";
}

interface QueueRow {
  readonly launch: Record<string, unknown>;
  readonly authorDisplayName: string;
  readonly authorHandle: string | null;
}

const moderationState = vi.hoisted(
  (): {
    queueRows: QueueRow[];
    teamRows: Record<string, unknown>[];
    imageRows: Record<string, unknown>[];
    lockedLaunch: LaunchRow | null;
    requestedLimit: number | null;
    queueConditionText: string;
    joinedQueryCount: number;
    secondaryQueryCount: number;
    attemptedSlugs: string[];
    slugsAlreadyTaken: Set<string>;
    savepointFailure: unknown;
    rejectionUpdate: { readonly values: Record<string, unknown>; readonly conditionText: string } | null;
    auditEntries: Record<string, unknown>[];
  } => ({
    queueRows: [],
    teamRows: [],
    imageRows: [],
    lockedLaunch: null,
    requestedLimit: null,
    queueConditionText: "",
    joinedQueryCount: 0,
    secondaryQueryCount: 0,
    attemptedSlugs: [],
    slugsAlreadyTaken: new Set<string>(),
    savepointFailure: null,
    rejectionUpdate: null,
    auditEntries: [],
  }),
);

/**
 * Every primitive drizzle bound into a condition, flattened into one searchable string.
 *
 * A DEEP WALK, and `JSON.stringify` is not an option: a drizzle condition holds column objects that
 * point back at their table, so stringifying one throws on the circular reference. Walking with a
 * visited set is both cycle-safe and independent of drizzle's internal layout, which is what keeps
 * this from failing on a patch release that reshapes the chunk tree.
 */
function describeCondition(condition: unknown): string {
  const pending: unknown[] = [condition];
  const visited = new Set<unknown>();
  const boundValues: string[] = [];

  while (pending.length > 0) {
    const node = pending.pop();
    if (node instanceof Date) {
      boundValues.push(`date:${node.toISOString()}`);
      continue;
    }
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      boundValues.push(String(node));
      continue;
    }
    if (typeof node !== "object" || node === null || visited.has(node)) continue;
    visited.add(node);
    for (const value of Object.values(node)) pending.push(value);
  }

  return boundValues.join("|");
}

/** The read side: a joined, ordered, limited select for the queue, then two `IN` selects. */
const queueLimitMock = vi.fn<(limit: number) => Promise<QueueRow[]>>(async (limit) => {
  moderationState.requestedLimit = limit;
  return moderationState.queueRows;
});
const queueOrderByMock = vi.fn<() => { limit: typeof queueLimitMock }>(() => ({ limit: queueLimitMock }));
const secondaryOrderByMock = vi.fn<() => Promise<Record<string, unknown>[]>>(async () =>
  moderationState.secondaryQueryCount++ === 0 ? moderationState.teamRows : moderationState.imageRows,
);
const queueWhereMock = vi.fn<(condition: unknown) => { orderBy: typeof queueOrderByMock }>((condition) => {
  moderationState.queueConditionText = describeCondition(condition);
  return { orderBy: queueOrderByMock };
});
const secondaryWhereMock = vi.fn<() => { orderBy: typeof secondaryOrderByMock }>(() => ({
  orderBy: secondaryOrderByMock,
}));
const innerJoinMock = vi.fn<() => { where: typeof queueWhereMock }>(() => ({ where: queueWhereMock }));
const readFromMock = vi.fn<() => { innerJoin: typeof innerJoinMock; where: typeof secondaryWhereMock }>(() => {
  // Only the queue query joins; the team and image queries select straight from their table.
  moderationState.joinedQueryCount += 1;
  return { innerJoin: innerJoinMock, where: secondaryWhereMock };
});
const readSelectMock = vi.fn<() => { from: typeof readFromMock }>(() => ({ from: readFromMock }));

/** The decision side: a locking read, an update, and nested transactions for the slug savepoints. */
const forUpdateMock = vi.fn<() => Promise<LaunchRow[]>>(async () =>
  moderationState.lockedLaunch === null ? [] : [moderationState.lockedLaunch],
);
const lockWhereMock = vi.fn<() => { for: typeof forUpdateMock }>(() => ({ for: forUpdateMock }));
const lockFromMock = vi.fn<() => { where: typeof lockWhereMock }>(() => ({ where: lockWhereMock }));
const lockSelectMock = vi.fn<() => { from: typeof lockFromMock }>(() => ({ from: lockFromMock }));

const updateWhereMock = vi.fn<(condition: unknown) => Promise<undefined>>(async (condition) => {
  const values = updateValuesCapture.at(-1) ?? {};
  const publicSlug = values.publicSlug;
  if (typeof publicSlug === "string") {
    moderationState.attemptedSlugs.push(publicSlug);
    if (moderationState.savepointFailure !== null) throw moderationState.savepointFailure;
    if (moderationState.slugsAlreadyTaken.has(publicSlug)) {
      throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    }
  } else {
    moderationState.rejectionUpdate = {
      values,
      conditionText: describeCondition(condition),
    };
  }
  return undefined;
});
const updateValuesCapture: Record<string, unknown>[] = [];
const setMock = vi.fn<(values: Record<string, unknown>) => { where: typeof updateWhereMock }>((values) => {
  updateValuesCapture.push(values);
  return { where: updateWhereMock };
});
const updateMock = vi.fn<() => { set: typeof setMock }>(() => ({ set: setMock }));

/** A savepoint: drizzle's nested `transaction`, which is what makes a collision recoverable. */
const savepointExecutor = { update: updateMock, select: lockSelectMock };
const nestedTransactionMock = vi.fn<(callback: (savepoint: unknown) => Promise<unknown>) => Promise<unknown>>(
  async (callback) => callback(savepointExecutor),
);
const transactionExecutor = {
  select: lockSelectMock,
  update: updateMock,
  transaction: nestedTransactionMock,
};
const transactionMock = vi.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(async (callback) =>
  callback(transactionExecutor),
);

vi.mock("#src/db/index.js", () => ({
  db: { select: readSelectMock, transaction: transactionMock },
}));

const appendPlatformAuditEntry = vi.fn<(tx: unknown, entry: Record<string, unknown>) => Promise<void>>(
  async (_tx, entry) => {
    moderationState.auditEntries.push(entry);
  },
);
vi.mock("#src/modules/platform/audit/platform-audit.service.js", () => ({
  appendPlatformAuditEntry: (tx: unknown, entry: Record<string, unknown>) => appendPlatformAuditEntry(tx, entry),
}));

const MODERATOR = { staffUserId: "user_moderator", platformRole: "admin" } as const;

function buildQueueLaunch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "launch_1",
    createdAt: new Date("2026-09-10T08:00:00.000Z"),
    acceptedLaunchStatementIds: ["built_it_ourselves", "results_are_our_own"],
    title: "Solar cold storage unit",
    tagline: "Keeps produce cold on four hours of sun.",
    summary: "A 200-litre evaporative store.",
    writeUp: null,
    headingImageUrl: "https://cdn.test/heading.avif",
    launchedAt: new Date("2026-08-01T00:00:00.000Z"),
    difficulty: "intermediate",
    billOfMaterialsMinimumCents: null,
    billOfMaterialsMaximumCents: null,
    billOfMaterialsCurrency: null,
    tags: ["solar"],
    builtFromBlueprintSlug: null,
    callToActionLabel: null,
    callToActionUrl: null,
    ...overrides,
  };
}

function buildQueueRow(overrides: Record<string, unknown> = {}): QueueRow {
  return {
    launch: buildQueueLaunch(overrides),
    authorDisplayName: "Amara",
    authorHandle: "amara-builds",
  };
}

function resetModerationState(): void {
  moderationState.queueRows = [];
  moderationState.teamRows = [];
  moderationState.imageRows = [];
  moderationState.lockedLaunch = null;
  moderationState.requestedLimit = null;
  moderationState.queueConditionText = "";
  moderationState.joinedQueryCount = 0;
  moderationState.secondaryQueryCount = 0;
  moderationState.attemptedSlugs = [];
  moderationState.slugsAlreadyTaken = new Set<string>();
  moderationState.savepointFailure = null;
  moderationState.rejectionUpdate = null;
  moderationState.auditEntries = [];
  updateValuesCapture.length = 0;
}

describe("listShowcaseReviewQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModerationState();
  });

  /** One row more than asked for is how "is there another page" is answered without a count(*). */
  it("over-fetches one row beyond the requested limit", async () => {
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(moderationState.requestedLimit).toBe(21);
  });

  it("trims the over-fetched row and reports that more remain", async () => {
    moderationState.queueRows = Array.from({ length: 3 }, (_unused, index) =>
      buildQueueRow({ id: `launch_${String(index + 1)}` }),
    );
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 2, cursor: undefined });

    expect(page.items).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);
  });

  it("reports no more pages and no cursor for a short page", async () => {
    moderationState.queueRows = [buildQueueRow()];
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
  });

  /**
   * THE CURSOR NAMES THE LAST ROW RETURNED, not the extra one read to detect the next page. Encoding
   * the over-fetched row would skip a launch on every page boundary — a launch that waits forever
   * because no page ever contains it.
   */
  it("encodes the cursor from the last returned row, not the over-fetched one", async () => {
    moderationState.queueRows = [
      buildQueueRow({ id: "launch_1", createdAt: new Date("2026-09-10T08:00:00.000Z") }),
      buildQueueRow({ id: "launch_2", createdAt: new Date("2026-09-10T09:00:00.000Z") }),
      buildQueueRow({ id: "launch_3", createdAt: new Date("2026-09-10T10:00:00.000Z") }),
    ];
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 2, cursor: undefined });
    const decoded = page.page.nextCursor === null ? null : decodeInstantCursor(page.page.nextCursor);

    expect(decoded).toEqual({ instant: new Date("2026-09-10T09:00:00.000Z"), id: "launch_2" });
  });

  it("adds a keyset condition only when a cursor is given", async () => {
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });
    const withoutCursor = moderationState.queueConditionText;
    await listShowcaseReviewQueue({
      staff: MODERATOR,
      limit: 20,
      cursor: { instant: new Date("2026-09-10T08:00:00.000Z"), id: "launch_1" },
    });
    const withCursor = moderationState.queueConditionText;

    expect(withoutCursor, "the queue always filters on pending_review").toContain("pending_review");
    expect(withoutCursor, "no cursor means no bound instant").not.toContain("date:");
    expect(withCursor).toContain("date:2026-09-10T08:00:00.000Z");
    expect(withCursor).toContain("launch_1");
  });

  /** Two `IN` queries, not one per launch — and none at all when there is nothing to look up. */
  it("makes no team or image queries for an empty page", async () => {
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(page.items).toEqual([]);
    expect(moderationState.secondaryQueryCount).toBe(0);
  });

  it("groups team members and write-up images onto their own launch", async () => {
    moderationState.queueRows = [buildQueueRow({ id: "launch_1" }), buildQueueRow({ id: "launch_2" })];
    moderationState.teamRows = [
      { launchId: "launch_1", position: 0, displayName: "Amara", handle: "amara-builds", role: "Thermal" },
      { launchId: "launch_2", position: 0, displayName: "Bo", handle: "bo-makes", role: "Welding" },
    ];
    moderationState.imageRows = [
      {
        launchId: "launch_2",
        url: "https://cdn.test/two.avif",
        widthPx: 1200,
        heightPx: 800,
        blurDataUrl: "data:image/webp;base64,AAAA",
      },
    ];
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(page.items[0]?.team.map((member) => member.handle)).toEqual(["amara-builds"]);
    expect(page.items[0]?.writeUpImages).toEqual([]);
    expect(page.items[1]?.team.map((member) => member.handle)).toEqual(["bo-makes"]);
    expect(page.items[1]?.writeUpImages).toHaveLength(1);
  });

  /** Absence is not zero: a partial cost range is no range at all, never a range of nulls. */
  it.each([
    [
      "all three columns set",
      { billOfMaterialsMinimumCents: 1, billOfMaterialsMaximumCents: 2, billOfMaterialsCurrency: "USD" },
      true,
    ],
    ["only a minimum", { billOfMaterialsMinimumCents: 1 }, false],
    [
      "a minimum and a maximum but no currency",
      { billOfMaterialsMinimumCents: 1, billOfMaterialsMaximumCents: 2 },
      false,
    ],
  ] as const)("reports a cost range for %s", async (_label, overrides, expectsRange) => {
    moderationState.queueRows = [buildQueueRow(overrides)];
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(page.items[0]?.billOfMaterialsCostRange === null).toBe(!expectsRange);
  });

  it.each([
    ["both halves set", { callToActionLabel: "Order", callToActionUrl: "https://maker.test" }, true],
    ["only a label", { callToActionLabel: "Order" }, false],
    ["only a url", { callToActionUrl: "https://maker.test" }, false],
  ] as const)("reports a call to action for %s", async (_label, overrides, expectsCallToAction) => {
    moderationState.queueRows = [buildQueueRow(overrides)];
    const { listShowcaseReviewQueue } =
      await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const page = await listShowcaseReviewQueue({ staff: MODERATOR, limit: 20, cursor: undefined });

    expect(page.items[0]?.callToAction === null).toBe(!expectsCallToAction);
  });
});

describe("decideShowcaseLaunch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModerationState();
  });

  function pendingLaunch(overrides: Partial<LaunchRow> = {}): LaunchRow {
    return {
      id: "launch_1",
      title: "Solar cold storage unit",
      authorUserId: "user_maker",
      moderationState: "pending_review",
      ...overrides,
    };
  }

  it("locks the launch row for update before deciding anything", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(forUpdateMock).toHaveBeenCalled();
  });

  it("answers SHOWCASE_LAUNCH_NOT_FOUND when no row is locked", async () => {
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: "launch_missing",
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(result).toEqual({ success: false, error: { type: "SHOWCASE_LAUNCH_NOT_FOUND" } });
    expect(moderationState.auditEntries).toHaveLength(0);
  });

  /**
   * SELF-MODERATION IS CHECKED BEFORE THE STATE, and the order is what this asserts: the row here is
   * BOTH the moderator's own and already published. Answering "already decided" would tell a
   * moderator to refresh when the real answer is that they may never decide this launch at all.
   */
  it("refuses self-moderation ahead of reporting an already-decided launch", async () => {
    moderationState.lockedLaunch = pendingLaunch({
      authorUserId: MODERATOR.staffUserId,
      moderationState: "published",
    });
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(result).toEqual({
      success: false,
      error: { type: "SHOWCASE_LAUNCH_SELF_MODERATION_FORBIDDEN" },
    });
  });

  it.each(["published", "rejected"] as const)(
    "reports an already-%s launch with the state it found",
    async (alreadyState) => {
      moderationState.lockedLaunch = pendingLaunch({ moderationState: alreadyState });
      const { decideShowcaseLaunch } =
        await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

      const result = await decideShowcaseLaunch({
        submissionId: "launch_1",
        decision: { decision: "published", moderatorNote: null },
        staff: MODERATOR,
      });

      expect(result).toEqual({
        success: false,
        error: { type: "SHOWCASE_LAUNCH_ALREADY_DECIDED", moderationState: alreadyState },
      });
    },
  );

  it("publishes under a slug derived from the title", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(result.success && result.value.publicSlug).toBe("solar-cold-storage-unit");
    expect(result.success && result.value.moderationState).toBe("published");
  });

  /** A title of punctuation or emoji slugifies to nothing, which is not an address. */
  it("falls back to an id-derived slug when the title slugifies too short", async () => {
    moderationState.lockedLaunch = pendingLaunch({ title: "!!! ☀", id: "0198fabc-dead-beef-0000-000000000001" });
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: "0198fabc-dead-beef-0000-000000000001",
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(result.success && result.value.publicSlug).toBe("launch-0198fabc");
  });

  /** A reserved slug would be shadowed by the literal route already at that address. */
  it.each(["new", "mine", "write-up-images"])(
    "falls back to an id-derived slug for the reserved title %o",
    async (reservedTitle) => {
      moderationState.lockedLaunch = pendingLaunch({
        title: reservedTitle,
        id: "0198fabc-dead-beef-0000-000000000001",
      });
      const { decideShowcaseLaunch } =
        await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

      const result = await decideShowcaseLaunch({
        submissionId: "0198fabc-dead-beef-0000-000000000001",
        decision: { decision: "published", moderatorNote: null },
        staff: MODERATOR,
      });

      expect(result.success && result.value.publicSlug).toBe("launch-0198fabc");
    },
  );

  /**
   * THE CANDIDATE LADDER: the bare slug, then `-2` through `-11`, then one suffixed with the launch
   * id, which cannot collide with another title's base. Twelve in all. Each attempt is its own
   * savepoint so a collision does not poison the transaction the audit append still has to use.
   */
  it("walks the slug candidates in order and lands on the id-suffixed one", async () => {
    const launchId = "0198fabc-dead-beef-0000-000000000001";
    moderationState.lockedLaunch = pendingLaunch({ id: launchId });
    moderationState.slugsAlreadyTaken = new Set([
      "solar-cold-storage-unit",
      ...Array.from({ length: 10 }, (_unused, index) => `solar-cold-storage-unit-${String(index + 2)}`),
    ]);
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: launchId,
      decision: { decision: "published", moderatorNote: null },
      staff: MODERATOR,
    });

    expect(moderationState.attemptedSlugs).toHaveLength(12);
    expect(moderationState.attemptedSlugs[0]).toBe("solar-cold-storage-unit");
    expect(moderationState.attemptedSlugs[1]).toBe("solar-cold-storage-unit-2");
    expect(moderationState.attemptedSlugs[10]).toBe("solar-cold-storage-unit-11");
    expect(result.success && result.value.publicSlug).toBe("solar-cold-storage-unit-0198fabc");
    expect(nestedTransactionMock).toHaveBeenCalledTimes(12);
  });

  it("throws when every slug candidate is taken, because that is not a coincidence", async () => {
    const launchId = "0198fabc-dead-beef-0000-000000000001";
    moderationState.lockedLaunch = pendingLaunch({ id: launchId });
    moderationState.slugsAlreadyTaken = new Set([
      "solar-cold-storage-unit",
      ...Array.from({ length: 10 }, (_unused, index) => `solar-cold-storage-unit-${String(index + 2)}`),
      "solar-cold-storage-unit-0198fabc",
    ]);
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await expect(
      decideShowcaseLaunch({
        submissionId: launchId,
        decision: { decision: "published", moderatorNote: null },
        staff: MODERATOR,
      }),
    ).rejects.toThrow(/every slug candidate/);
  });

  /**
   * ONLY A UNIQUE VIOLATION MEANS "TAKEN". Treating any failure as a collision would walk all twelve
   * candidates while the real fault — a not-null violation, a dropped connection — is swallowed, and
   * the launch would publish under a slug chosen by an unrelated error.
   */
  it("rethrows a non-unique-violation from a savepoint instead of trying the next slug", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    moderationState.savepointFailure = Object.assign(new Error("null value in column"), {
      code: "23502",
    });
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await expect(
      decideShowcaseLaunch({
        submissionId: "launch_1",
        decision: { decision: "published", moderatorNote: null },
        staff: MODERATOR,
      }),
    ).rejects.toThrow(/null value in column/);
    expect(moderationState.attemptedSlugs).toHaveLength(1);
  });

  it("records a rejection with its note and no public address", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    const result = await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "rejected", moderatorNote: "Add a build photo." },
      staff: MODERATOR,
    });

    expect(result).toEqual({
      success: true,
      value: {
        submissionId: "launch_1",
        moderationState: "rejected",
        publicSlug: null,
        decidedAt: expect.any(Date),
      },
    });
    expect(moderationState.rejectionUpdate?.values).toMatchObject({
      moderationState: "rejected",
      reviewedByUserId: MODERATOR.staffUserId,
      moderatorNote: "Add a build photo.",
    });
  });

  /** A published note that trims to nothing is no note, and the column CHECK says the same. */
  it("stores an empty published note as null", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "published", moderatorNote: "" },
      staff: MODERATOR,
    });

    expect(updateValuesCapture.at(-1)?.moderatorNote).toBeNull();
    expect(moderationState.auditEntries[0]?.payload).toMatchObject({ hasModeratorNote: false });
  });

  /**
   * THE UPDATE GUARDS ON `pending_review` AS WELL AS THE ID, so the lock and the predicate agree on
   * what undecided means — the row cannot be decided twice even if the lock were ever lost.
   */
  it("guards the rejection update on the pending state, not only the id", async () => {
    moderationState.lockedLaunch = pendingLaunch();
    const { decideShowcaseLaunch } = await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

    await decideShowcaseLaunch({
      submissionId: "launch_1",
      decision: { decision: "rejected", moderatorNote: "Add a build photo." },
      staff: MODERATOR,
    });

    expect(moderationState.rejectionUpdate?.conditionText).toContain("pending_review");
  });

  describe("the audit entry", () => {
    it.each([
      ["published", "showcase_launch_published"],
      ["rejected", "showcase_launch_rejected"],
    ] as const)("labels a %s decision as %s", async (decision, expectedEventKind) => {
      moderationState.lockedLaunch = pendingLaunch();
      const { decideShowcaseLaunch } =
        await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

      await decideShowcaseLaunch({
        submissionId: "launch_1",
        decision:
          decision === "published"
            ? { decision: "published", moderatorNote: null }
            : { decision: "rejected", moderatorNote: "Add a build photo." },
        staff: MODERATOR,
      });

      expect(moderationState.auditEntries).toHaveLength(1);
      expect(moderationState.auditEntries[0]?.eventKind).toBe(expectedEventKind);
      expect(moderationState.auditEntries[0]?.actorUserId).toBe(MODERATOR.staffUserId);
    });

    /**
     * IDS AND FLAGS ONLY. The chain is hash-linked and kept forever; a moderator's note to a maker is
     * correspondence, and it lives on the launch row where an erasure request can actually reach it.
     * An audit entry quoting the note would make it unerasable.
     */
    it("carries ids and a flag, never the note text", async () => {
      moderationState.lockedLaunch = pendingLaunch();
      const { decideShowcaseLaunch } =
        await import("#src/modules/home/blueprints/showcase-launch-moderation.service.js");

      await decideShowcaseLaunch({
        submissionId: "launch_1",
        decision: { decision: "rejected", moderatorNote: "This reads like an advert." },
        staff: MODERATOR,
      });

      const entry = moderationState.auditEntries[0];
      expect(entry?.payload).toEqual({
        launchId: "launch_1",
        decision: "rejected",
        hasModeratorNote: true,
      });
      expect(JSON.stringify(entry)).not.toContain("advert");
    });
  });
});
