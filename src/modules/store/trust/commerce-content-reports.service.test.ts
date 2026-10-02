import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { requirePlatformCapability as RequirePlatformCapability } from "#src/modules/platform/roles/platform-role.service.js";
import type { enqueueProductSearchDocumentRefresh as EnqueueProductSearchDocumentRefresh } from "#src/modules/store/catalog/store-search.service.js";
import type {
  refreshProductQuestionCounters as RefreshProductQuestionCounters,
  refreshQuestionAnswerSummary as RefreshQuestionAnswerSummary,
} from "#src/modules/store/trust/commerce-product-qa.service.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";

stubServerEnvironment();
vi.mock("dotenv/config", () => ({}));

/**
 * What each moderation path WRITES, per target kind — and in particular what its UPDATE MATCHES.
 *
 * The bugs this file pins were all in a WHERE clause: a dismissal that matched a question, answer
 * or review by id alone republished a withdrawn one or overruled a moderator, and a product arm that wrote `approved` with no state
 * condition published unreviewed listings. A test that only checked `.set(...)` values passes
 * against both. So every recorded write carries its WHERE rendered through the real `PgDialect`,
 * and the assertions read the column names and bound parameters out of it.
 *
 * `db` is a chain fake: every builder method returns the chain, and awaiting it yields rows keyed
 * by the TABLE the statement named (`from(...)` for a select, the target for an update or insert)
 * rather than by call order, so a test states "the answer row is X" and not "the third select".
 */
interface RecordedStatement {
  readonly kind: "select" | "update" | "insert";
  readonly table: unknown;
  values: unknown;
  where: SQL | undefined;
}

// Function declarations, not const arrows: `vi.hoisted` below runs before any statement, and a
// declaration is initialized by then.
function buildRecordingChain(
  statement: RecordedStatement,
  resolveRows: (statement: RecordedStatement) => unknown,
): object {
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(resolveRows(statement)).then(resolve, reject);
      }
      return (...methodArguments: unknown[]) => {
        const [firstArgument] = methodArguments;
        if (property === "from") {
          (statement as { table: unknown }).table = firstArgument;
        }
        if (property === "set" || property === "values") statement.values = firstArgument;
        if (property === "where") {
          statement.where = firstArgument instanceof SQL ? firstArgument : undefined;
        }
        return proxy;
      };
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy;
}

const fakeDatabase = vi.hoisted(() => {
  const state: {
    statements: RecordedStatement[];
    selectRowsByTable: Map<unknown, unknown[]>;
    writeRowsByTable: Map<unknown, unknown[]>;
  } = { statements: [], selectRowsByTable: new Map(), writeRowsByTable: new Map() };

  function startStatement(kind: RecordedStatement["kind"], table: unknown): object {
    const statement: RecordedStatement = { kind, table, values: null, where: undefined };
    state.statements.push(statement);
    return buildRecordingChain(statement, (recorded) =>
      recorded.kind === "select"
        ? (state.selectRowsByTable.get(recorded.table) ?? [])
        : (state.writeRowsByTable.get(recorded.table) ?? []),
    );
  }

  const executor = {
    select: () => startStatement("select", undefined),
    update: (table: unknown) => startStatement("update", table),
    insert: (table: unknown) => startStatement("insert", table),
  };

  return {
    state,
    db: {
      ...executor,
      transaction: async (callback: (transaction: typeof executor) => Promise<unknown>) => callback(executor),
    },
  };
});

vi.mock("#src/db/index.js", () => ({ db: fakeDatabase.db, pool: {} }));

const requirePlatformCapability = vi.hoisted(() => vi.fn<typeof RequirePlatformCapability>());
vi.mock("#src/modules/platform/roles/platform-role.service.js", () => ({
  requirePlatformCapability,
}));

// Typed to what the service READS off the entry (`id`), not the full chain record: building a
// complete `PlatformAuditEntryRecord` here would be fixture weight that asserts nothing.
const appendPlatformAuditEntry = vi.hoisted(() =>
  vi.fn<(...arguments_: readonly unknown[]) => Promise<{ readonly id: string }>>(),
);
vi.mock("#src/modules/platform/audit/platform-audit.service.js", () => ({
  appendPlatformAuditEntry,
}));

const enqueueProductSearchDocumentRefresh = vi.hoisted(() => vi.fn<typeof EnqueueProductSearchDocumentRefresh>());
vi.mock("#src/modules/store/catalog/store-search.service.js", () => ({
  enqueueProductSearchDocumentRefresh,
}));

const qaRefreshes = vi.hoisted(() => ({
  refreshProductQuestionCounters: vi.fn<typeof RefreshProductQuestionCounters>(),
  refreshQuestionAnswerSummary: vi.fn<typeof RefreshQuestionAnswerSummary>(),
}));
vi.mock("#src/modules/store/trust/commerce-product-qa.service.js", () => qaRefreshes);

const {
  commerceContentReport,
  commerceModerationAction,
  commerceOrganizationAuditEntry,
  commerceOrganizationMember,
  commerceProductAnswer,
  commerceProductQuestion,
  commerceReview,
  product,
} = await import("#src/db/schema.js");
const { decodeTimestampStoreCursor } = await import("#src/modules/store/store-cursor.js");
const { createContentReport, decideContentReport, listWithdrawnProductAnswers, restoreContent } =
  await import("#src/modules/store/trust/commerce-content-reports.service.js");

const pgDialect = new PgDialect();

const MODERATOR_USER_ID = "user_moderator";
const OWNER_ORGANIZATION_ID = "commerce_org_owner";

type ReportTargetKind = (typeof commerceContentReport.$inferSelect)["targetKind"];

function buildReportRow(
  targetKind: ReportTargetKind,
  targetId: string,
  status: "open" | "actioned" | "dismissed" = "open",
) {
  return {
    id: `report_${targetKind}`,
    targetKind,
    productId: targetKind === "product" ? targetId : null,
    reviewId: targetKind === "review" ? targetId : null,
    questionId: targetKind === "question" ? targetId : null,
    answerId: targetKind === "answer" ? targetId : null,
    organizationId: targetKind === "organization" ? targetId : null,
    reason: "spam" as const,
    detailText: null,
    status,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    resolvedAt: null,
  };
}

/** Seeds the rows a decision reads: the report, its target's owner, and no conflicting membership. */
function seedDecisionTarget(targetKind: ReportTargetKind, targetId: string): void {
  fakeDatabase.state.selectRowsByTable.set(commerceContentReport, [buildReportRow(targetKind, targetId)]);
  const ownerRow = [{ ownerOrganizationId: OWNER_ORGANIZATION_ID }];
  fakeDatabase.state.selectRowsByTable.set(commerceProductAnswer, ownerRow);
  fakeDatabase.state.selectRowsByTable.set(commerceReview, ownerRow);
  fakeDatabase.state.selectRowsByTable.set(product, ownerRow);
  // The question arm of `loadTargetOwner` reads `id`; the answer arm's follow-up read reads
  // `productId`. One row serves both.
  fakeDatabase.state.selectRowsByTable.set(commerceProductQuestion, [{ id: "question_1", productId: "product_1" }]);
  fakeDatabase.state.writeRowsByTable.set(commerceProductAnswer, [{ questionId: "question_1" }]);
  fakeDatabase.state.writeRowsByTable.set(commerceProductQuestion, [{ productId: "product_1" }]);
}

function findWrites(kind: "update" | "insert", table: unknown): RecordedStatement[] {
  return fakeDatabase.state.statements.filter((statement) => statement.kind === kind && statement.table === table);
}

function findOnlyUpdate(table: unknown): RecordedStatement {
  const updates = findWrites("update", table);
  expect(updates).toHaveLength(1);
  const [update] = updates;
  if (!update) throw new Error("no update recorded");
  return update;
}

function renderWhere(statement: RecordedStatement): { sql: string; params: unknown[] } {
  if (!statement.where) throw new Error("statement has no WHERE");
  const query = pgDialect.sqlToQuery(statement.where);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  fakeDatabase.state.statements = [];
  fakeDatabase.state.selectRowsByTable = new Map();
  fakeDatabase.state.writeRowsByTable = new Map();
  requirePlatformCapability.mockReset();
  requirePlatformCapability.mockResolvedValue({
    success: true,
    value: { staffUserId: MODERATOR_USER_ID, platformRole: "moderator" },
  });
  appendPlatformAuditEntry.mockReset();
  appendPlatformAuditEntry.mockResolvedValue({ id: "platform_audit_1" });
  enqueueProductSearchDocumentRefresh.mockReset();
  enqueueProductSearchDocumentRefresh.mockResolvedValue(undefined);
  qaRefreshes.refreshProductQuestionCounters.mockReset();
  qaRefreshes.refreshQuestionAnswerSummary.mockReset();
});

describe("decideContentReport — a dismissal undoes only the automatic hide", () => {
  it.each([
    ["answer", commerceProductAnswer],
    ["question", commerceProductQuestion],
  ] as const)("matches a dismissed %s only while it is hidden_pending_review", async (targetKind, table) => {
    seedDecisionTarget(targetKind, `${targetKind}_1`);

    const result = await decideContentReport(MODERATOR_USER_ID, `report_${targetKind}`, {
      decision: "dismissed",
    });

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(table);
    expect(update.values).toMatchObject({
      visibilityState: "visible",
      hiddenAt: null,
      hiddenByUserId: null,
    });
    // EXACT params, not "does not contain removed_by_author": with the guard missing the WHERE
    // is `id = $1` alone, which contains neither, so an absence check passes against the bug.
    const where = renderWhere(update);
    expect(where.sql).toContain('"visibility_state"');
    expect(where.params).toEqual([`${targetKind}_1`, "hidden_pending_review"]);
  });

  it("does not write the product at all — a product never auto-hides", async () => {
    seedDecisionTarget("product", "product_1");

    const result = await decideContentReport(MODERATOR_USER_ID, "report_product", {
      decision: "dismissed",
    });

    expect(result.success).toBe(true);
    expect(findWrites("update", product)).toHaveLength(0);
    // The report itself is still decided and recorded.
    expect(findWrites("update", commerceContentReport)).toHaveLength(1);
    expect(findOnlyInsertValues(commerceModerationAction)).toMatchObject({
      actionKind: "report_dismissed",
      targetKind: "product",
    });
  });

  it("matches a dismissed review only while it is hidden_pending_review — a moderator's `hidden` survives", async () => {
    seedDecisionTarget("review", "review_1");

    const result = await decideContentReport(MODERATOR_USER_ID, "report_review", { decision: "dismissed" });

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(commerceReview);
    expect(update.values).toEqual({ visibility: "visible" });
    // Exact, for the reason the question/answer case above gives.
    const where = renderWhere(update);
    expect(where.sql).toContain('"visibility"');
    expect(where.params).toEqual(["review_1", "hidden_pending_review"]);
  });

  it("closes every open report on the target, not only the one decided", async () => {
    seedDecisionTarget("answer", "answer_1");

    await decideContentReport(MODERATOR_USER_ID, "report_answer", {
      decision: "dismissed",
      note: "Not spam.",
    });

    const closing = findOnlyUpdate(commerceContentReport);
    expect(closing.values).toMatchObject({
      status: "dismissed",
      resolvedByUserId: MODERATOR_USER_ID,
      resolutionNote: "Not spam.",
    });
    expect(renderWhere(closing).params).toEqual(["answer_1", "open"]);
  });
});

function findOnlyInsertValues(table: unknown): unknown {
  const inserts = findWrites("insert", table);
  expect(inserts).toHaveLength(1);
  return inserts[0]?.values;
}

describe("decideContentReport — actioning", () => {
  it("hides an answer as the moderator with NO state condition, overriding a withdrawal", async () => {
    seedDecisionTarget("answer", "answer_1");

    const result = await decideContentReport(MODERATOR_USER_ID, "report_answer", {
      decision: "actioned",
    });

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(commerceProductAnswer);
    expect(update.values).toMatchObject({
      visibilityState: "hidden_by_moderator",
      hiddenByUserId: MODERATOR_USER_ID,
    });
    expect(update.values).toHaveProperty("hiddenAt", expect.any(Date));
    expect(renderWhere(update).params).toEqual(["answer_1"]);
    expect(qaRefreshes.refreshQuestionAnswerSummary).toHaveBeenCalledWith(expect.anything(), "question_1");
    expect(qaRefreshes.refreshProductQuestionCounters).toHaveBeenCalledWith(expect.anything(), "product_1");
  });

  it("hides a review as a moderator's `hidden`, matched by id alone so it overrides an automatic hide", async () => {
    seedDecisionTarget("review", "review_1");

    await decideContentReport(MODERATOR_USER_ID, "report_review", { decision: "actioned" });

    const update = findOnlyUpdate(commerceReview);
    expect(update.values).toEqual({ visibility: "hidden" });
    expect(renderWhere(update).params).toEqual(["review_1"]);
  });

  it("suspends a product and refreshes its search document after commit", async () => {
    seedDecisionTarget("product", "product_1");

    await decideContentReport(MODERATOR_USER_ID, "report_product", { decision: "actioned" });

    expect(findOnlyUpdate(product).values).toEqual({ moderationState: "suspended" });
    expect(enqueueProductSearchDocumentRefresh).toHaveBeenCalledWith("product_1");
  });

  it("audits the decision against the moderator's role", async () => {
    seedDecisionTarget("answer", "answer_1");

    await decideContentReport(MODERATOR_USER_ID, "report_answer", { decision: "actioned" });

    expect(appendPlatformAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventKind: "commerce_content_hidden",
        actorUserId: MODERATOR_USER_ID,
        actorRoleSnapshot: "moderator",
        targetLabel: "answer:answer_1",
      }),
    );
  });
});

describe("decideContentReport — refusals write nothing", () => {
  it("refuses a caller without moderate_commerce before reading the report", async () => {
    requirePlatformCapability.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const result = await decideContentReport("user_not_staff", "report_answer", {
      decision: "dismissed",
    });

    expect(result).toEqual({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });
    expect(fakeDatabase.state.statements).toHaveLength(0);
  });

  it("refuses a report that is no longer open", async () => {
    seedDecisionTarget("answer", "answer_1");
    fakeDatabase.state.selectRowsByTable.set(commerceContentReport, [buildReportRow("answer", "answer_1", "actioned")]);

    const result = await decideContentReport(MODERATOR_USER_ID, "report_answer", {
      decision: "dismissed",
    });

    expect(result).toEqual({ success: false, error: { type: "REPORT_ALREADY_RESOLVED" } });
    expect(fakeDatabase.state.statements.some((statement) => statement.kind !== "select")).toBe(false);
  });

  it("refuses a moderator who belongs to the organization that owns the target", async () => {
    seedDecisionTarget("answer", "answer_1");
    fakeDatabase.state.selectRowsByTable.set(commerceOrganizationMember, [{ id: "member_1" }]);

    const result = await decideContentReport(MODERATOR_USER_ID, "report_answer", {
      decision: "dismissed",
    });

    expect(result).toEqual({ success: false, error: { type: "MODERATOR_IS_PARTY" } });
    expect(fakeDatabase.state.statements.some((statement) => statement.kind !== "select")).toBe(false);
  });

  it("answers NOT_FOUND for a report that does not exist", async () => {
    const result = await decideContentReport(MODERATOR_USER_ID, "report_missing", {
      decision: "dismissed",
    });

    expect(result).toEqual({ success: false, error: { type: "NOT_FOUND" } });
  });
});

describe("restoreContent", () => {
  beforeEach(() => {
    fakeDatabase.state.writeRowsByTable.set(commerceModerationAction, [
      {
        id: "action_1",
        actionKind: "content_restored",
        targetKind: "answer",
        productId: null,
        reviewId: null,
        questionId: null,
        answerId: "answer_1",
        organizationId: null,
        actionSource: "moderator",
        reasonNote: "Wrongly withdrawn.",
        createdAt: new Date("2026-10-02T10:00:00.000Z"),
      },
    ]);
  });

  it("un-withdraws an answer: matched by id alone, so removed_by_author is restorable", async () => {
    seedDecisionTarget("answer", "answer_1");

    const result = await restoreContent(MODERATOR_USER_ID, {
      targetKind: "answer",
      targetId: "answer_1",
      reasonNote: "Wrongly withdrawn.",
    });

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(commerceProductAnswer);
    expect(update.values).toMatchObject({ visibilityState: "visible", hiddenByUserId: null });
    expect(renderWhere(update).params).toEqual(["answer_1"]);
    expect(findOnlyInsertValues(commerceModerationAction)).toMatchObject({
      actionKind: "content_restored",
      reasonNote: "Wrongly withdrawn.",
    });
  });

  it("un-hides a review whichever hide it was — matched by id alone", async () => {
    seedDecisionTarget("review", "review_1");

    await restoreContent(MODERATOR_USER_ID, {
      targetKind: "review",
      targetId: "review_1",
      reasonNote: "Hidden in error.",
    });

    const update = findOnlyUpdate(commerceReview);
    expect(update.values).toEqual({ visibility: "visible" });
    expect(renderWhere(update).params).toEqual(["review_1"]);
  });

  it("approves a product ONLY from suspended, and refreshes search after commit", async () => {
    seedDecisionTarget("product", "product_1");

    await restoreContent(MODERATOR_USER_ID, {
      targetKind: "product",
      targetId: "product_1",
      reasonNote: "Suspension reversed.",
    });

    const update = findOnlyUpdate(product);
    expect(update.values).toEqual({ moderationState: "approved" });
    const where = renderWhere(update);
    expect(where.sql).toContain('"moderation_state"');
    expect(where.params).toEqual(["product_1", "suspended"]);
    expect(enqueueProductSearchDocumentRefresh).toHaveBeenCalledWith("product_1");
  });

  it("refuses a caller without moderate_commerce before reading anything", async () => {
    requirePlatformCapability.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const result = await restoreContent("user_not_staff", {
      targetKind: "product",
      targetId: "product_1",
      reasonNote: "No.",
    });

    expect(result.success).toBe(false);
    expect(fakeDatabase.state.statements).toHaveLength(0);
  });
});

describe("createContentReport — the automatic hide a dismissal reverses", () => {
  it("hides an answer as hidden_pending_review with no moderator once the threshold is met", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceProductAnswer, [{ ownerOrganizationId: OWNER_ORGANIZATION_ID }]);
    fakeDatabase.state.selectRowsByTable.set(commerceContentReport, [{ reporterCount: 3 }]);
    fakeDatabase.state.selectRowsByTable.set(commerceProductQuestion, [{ productId: "product_1" }]);
    fakeDatabase.state.writeRowsByTable.set(commerceContentReport, [buildReportRow("answer", "answer_1")]);
    fakeDatabase.state.writeRowsByTable.set(commerceProductAnswer, [{ questionId: "question_1" }]);

    const result = await createContentReport(
      { reporterUserId: "user_reporter", reporterOrganizationId: null },
      { targetKind: "answer", targetId: "answer_1", reason: "spam" },
    );

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(commerceProductAnswer);
    expect(update.values).toMatchObject({
      visibilityState: "hidden_pending_review",
      hiddenByUserId: null,
    });
    expect(renderWhere(update).params).toEqual(["answer_1"]);
    expect(findOnlyInsertValues(commerceModerationAction)).toMatchObject({
      actionKind: "content_hidden",
      actionSource: "automatic",
    });
  });

  it("hides a review as hidden_pending_review — not a moderator's `hidden` — once the threshold is met", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceReview, [{ ownerOrganizationId: OWNER_ORGANIZATION_ID }]);
    fakeDatabase.state.selectRowsByTable.set(commerceContentReport, [{ reporterCount: 3 }]);
    fakeDatabase.state.writeRowsByTable.set(commerceContentReport, [buildReportRow("review", "review_1")]);

    const result = await createContentReport(
      { reporterUserId: "user_reporter", reporterOrganizationId: null },
      { targetKind: "review", targetId: "review_1", reason: "spam" },
    );

    expect(result.success).toBe(true);
    const update = findOnlyUpdate(commerceReview);
    expect(update.values).toEqual({ visibility: "hidden_pending_review" });
    expect(renderWhere(update).params).toEqual(["review_1"]);
  });

  it("does not hide below the threshold", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceProductAnswer, [{ ownerOrganizationId: OWNER_ORGANIZATION_ID }]);
    fakeDatabase.state.selectRowsByTable.set(commerceContentReport, [{ reporterCount: 2 }]);
    fakeDatabase.state.writeRowsByTable.set(commerceContentReport, [buildReportRow("answer", "answer_1")]);

    await createContentReport(
      { reporterUserId: "user_reporter", reporterOrganizationId: null },
      { targetKind: "answer", targetId: "answer_1", reason: "spam" },
    );

    expect(findWrites("update", commerceProductAnswer)).toHaveLength(0);
  });
});

function buildWithdrawalRow(index: number, payloadJson: string) {
  return {
    auditEntryId: `audit_${String(index)}`,
    withdrawnAt: new Date(`2026-10-0${String(index)}T08:30:00.123Z`),
    payloadJson,
    actorUserId: "user_seller_author",
    actorMemberRoleSnapshot: "owner" as const,
    answerId: `answer_${String(index)}`,
    answerBodyText: "It does leak at the seam.",
    authorKind: "seller" as const,
    answeringOrganizationId: OWNER_ORGANIZATION_ID,
    currentVisibilityState: "removed_by_author" as const,
    questionId: "question_1",
    questionBodyText: "Is it waterproof?",
    productId: "product_1",
    productTitle: "Solar pump",
    productPublicSlug: "solar-pump",
  };
}

const AUTHOR_PAYLOAD = JSON.stringify({ questionId: "question_1", withdrawnBy: "author" });

describe("listWithdrawnProductAnswers", () => {
  it("refuses a caller without moderate_commerce before any read", async () => {
    requirePlatformCapability.mockResolvedValue({
      success: false,
      error: { type: "PLATFORM_CAPABILITY_REQUIRED", capability: "moderate_commerce" },
    });

    const result = await listWithdrawnProductAnswers("user_not_staff", {
      state: "all",
      limit: 20,
    });

    expect(result.success).toBe(false);
    expect(fakeDatabase.state.statements).toHaveLength(0);
  });

  it("reads only product_answer_withdrawn events, and still_withdrawn adds removed_by_author", async () => {
    await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "still_withdrawn", limit: 20 });
    const [stillWithdrawnRead] = fakeDatabase.state.statements;
    if (!stillWithdrawnRead) throw new Error("no read");
    expect(stillWithdrawnRead.table).toBe(commerceOrganizationAuditEntry);
    expect(renderWhere(stillWithdrawnRead).params).toEqual([
      "product_answer_withdrawn",
      "commerce_product_answer",
      "removed_by_author",
    ]);

    fakeDatabase.state.statements = [];
    await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "all", limit: 20 });
    const [allRead] = fakeDatabase.state.statements;
    if (!allRead) throw new Error("no read");
    expect(renderWhere(allRead).params).toEqual(["product_answer_withdrawn", "commerce_product_answer"]);
  });

  it("refuses an unparseable cursor before reading", async () => {
    const result = await listWithdrawnProductAnswers(MODERATOR_USER_ID, {
      state: "all",
      limit: 20,
      cursor: "nonsense",
    });

    expect(result).toEqual({ success: false, error: { type: "INVALID_CURSOR" } });
    expect(fakeDatabase.state.statements).toHaveLength(0);
  });

  it("pages with limit + 1 and a cursor that round-trips to the last row's millisecond and id", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceOrganizationAuditEntry, [
      buildWithdrawalRow(2, AUTHOR_PAYLOAD),
      buildWithdrawalRow(1, AUTHOR_PAYLOAD),
    ]);

    const result = await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "all", limit: 1 });

    if (!result.success) throw new Error(result.error.type);
    expect(result.value.items.map((item) => item.auditEntryId)).toEqual(["audit_2"]);
    expect(result.value.page.hasMore).toBe(true);
    const nextCursor = result.value.page.nextCursor;
    if (nextCursor === null) throw new Error("no cursor");
    expect(decodeTimestampStoreCursor(nextCursor)).toEqual({
      sortKey: new Date("2026-10-02T08:30:00.123Z"),
      id: "audit_2",
    });

    fakeDatabase.state.statements = [];
    await listWithdrawnProductAnswers(MODERATOR_USER_ID, {
      state: "all",
      limit: 1,
      cursor: nextCursor,
    });
    const [nextRead] = fakeDatabase.state.statements;
    if (!nextRead) throw new Error("no read");
    const where = renderWhere(nextRead);
    expect(where.sql).toContain("date_trunc('milliseconds'");
    expect(where.params).toContain("2026-10-02T08:30:00.123Z");
    expect(where.params).toContain("audit_2");
  });

  it("answers a final page with no cursor", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceOrganizationAuditEntry, [buildWithdrawalRow(1, AUTHOR_PAYLOAD)]);

    const result = await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "all", limit: 20 });

    if (!result.success) throw new Error(result.error.type);
    expect(result.value.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it.each([
    ["the author", AUTHOR_PAYLOAD, "author"],
    [
      "a teammate",
      JSON.stringify({ questionId: "question_1", withdrawnBy: "organization_member" }),
      "organization_member",
    ],
    ["malformed JSON", "{not json", null],
    ["an unknown value", JSON.stringify({ withdrawnBy: "moderator" }), null],
    ["a missing field", JSON.stringify({ questionId: "question_1" }), null],
  ] as const)("reads withdrawnBy from %s", async (_label, payloadJson, expectedWithdrawnBy) => {
    fakeDatabase.state.selectRowsByTable.set(commerceOrganizationAuditEntry, [buildWithdrawalRow(1, payloadJson)]);

    const result = await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "all", limit: 20 });

    if (!result.success) throw new Error(result.error.type);
    expect(result.value.items[0]?.withdrawnBy).toBe(expectedWithdrawnBy);
  });

  it("does not put the raw audit payload on the wire", async () => {
    fakeDatabase.state.selectRowsByTable.set(commerceOrganizationAuditEntry, [buildWithdrawalRow(1, AUTHOR_PAYLOAD)]);

    const result = await listWithdrawnProductAnswers(MODERATOR_USER_ID, { state: "all", limit: 20 });

    if (!result.success) throw new Error(result.error.type);
    const [item] = result.value.items;
    expect(item).not.toHaveProperty("payloadJson");
    expect(item).toMatchObject({
      answerId: "answer_1",
      answerBodyText: "It does leak at the seam.",
      currentVisibilityState: "removed_by_author",
      productPublicSlug: "solar-pump",
    });
  });
});
