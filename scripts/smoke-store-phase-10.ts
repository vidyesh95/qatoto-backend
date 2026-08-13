/**
 * Drives the Phase 10 "public voice" routes over HTTP against a running server.
 *
 *   pnpm run dev                     # separate shell
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-10
 *
 * OVER HTTP, not in-process, for the reason `smoke-store-phases-9-11.ts` gives: Phase 10
 * is mostly guard chains. Who may answer a question, who may vote on a review, who may
 * decide a report, which contact control a viewer is offered — every one of those lives
 * in middleware, session resolution or a capability check that an in-process service call
 * never touches.
 *
 * IT ASSERTS REFUSALS AS HARD AS SUCCESSES. A smoke test that only walks the happy path
 * passes just as well against a backend with every authorization check deleted.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { commerceProductQuestion } from "#src/db/schema.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const CHAIR_PRODUCT_ID = "store_demo_product_chair";
const CHAIR_PRODUCT_SLUG = "banquet-chair-stackable";

interface CheckOutcome {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const outcomes: CheckOutcome[] = [];

function record(label: string, passed: boolean, detail: string): void {
  outcomes.push({ label, passed, detail });
}

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Actor {
  readonly cookie: string;
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke10-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function dataOf(result: ApiResult): Record<string, unknown> {
  return asRecord(result.body["data"]);
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" ? value : null;
}

function arrayField(source: Record<string, unknown>, key: string): readonly unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

async function callApi(
  method: string,
  path: string,
  options: {
    readonly actor?: Actor;
    readonly body?: unknown;
    readonly idempotencyPrefix?: string;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: REQUEST_ORIGIN,
  };
  if (options.actor) headers["cookie"] = options.actor.cookie;
  if (options.idempotencyPrefix !== undefined) {
    headers["idempotency-key"] = nextIdempotencyKey(options.idempotencyPrefix);
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(text === "" ? {} : JSON.parse(text));
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/ready`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `No ready server at ${BASE_URL} after 30s. Start one with \`pnpm run dev\` (and \`pnpm run jobs:install\` once, or /ready stays 503).`,
  );
}

/** Paced: Better Auth rate-limits sign-in to five attempts per ten seconds. */
async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REQUEST_ORIGIN },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `Sign-in failed for ${email} (${String(response.status)}). Run \`pnpm run db:seed-store-demo\` first.`,
    );
  }
  const sessionCookie = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.startsWith("better-auth.session_token="))
    .join("; ");
  if (sessionCookie === "") throw new Error(`No session cookie returned for ${email}.`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return { cookie: sessionCookie };
}

async function activateOrganization(actor: Actor, organizationId: string): Promise<void> {
  const result = await callApi("POST", `/commerce/organizations/${organizationId}/activate`, {
    actor,
    body: {},
    idempotencyPrefix: "activate",
  });
  if (result.status !== 200) {
    throw new Error(
      `Could not activate ${organizationId}: ${String(result.status)} ${JSON.stringify(result.body).slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// A8 — review reads.
// ---------------------------------------------------------------------------

async function smokeReviewReads(): Promise<void> {
  const reviews = await callApi("GET", `/store/products/${CHAIR_PRODUCT_SLUG}/reviews`);
  const reviewData = dataOf(reviews);
  const summary = asRecord(reviewData["summary"]);
  const histogram = asRecord(summary["ratingHistogram"]);
  record(
    "product reviews read returns a summary with a histogram",
    reviews.status === 200 &&
      numberField(summary, "reviewCount") !== null &&
      numberField(histogram, "rating5") !== null,
    `status ${String(reviews.status)}, reviewCount ${String(numberField(summary, "reviewCount"))}`,
  );

  const scoreAverages = asRecord(summary["scoreAverages"]);
  record(
    "review summary carries all three named sub-score axes",
    ["service", "shipping", "quality"].every((axis) => axis in scoreAverages),
    `axes ${Object.keys(scoreAverages).join(",") || "none"}`,
  );

  // Every sort must be a legal cursor shape, not just the default.
  for (const sort of ["recent", "helpful", "rating_high", "rating_low"]) {
    const sorted = await callApi(
      "GET",
      `/store/products/${CHAIR_PRODUCT_SLUG}/reviews?sort=${sort}&limit=2`,
    );
    record(
      `review sort "${sort}" is accepted`,
      sorted.status === 200,
      `status ${String(sorted.status)}`,
    );
  }

  const tampered = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/reviews?sort=helpful&cursor=tampered`,
  );
  record(
    "a tampered review cursor is refused, not silently ignored",
    tampered.status === 422,
    `status ${String(tampered.status)}`,
  );

  // `z.coerce.boolean()` would make the string "false" true; the schema uses an enum.
  const hasMediaFalse = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/reviews?hasMedia=false`,
  );
  const hasMediaGarbage = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/reviews?hasMedia=maybe`,
  );
  record(
    "hasMedia=false parses and hasMedia=maybe is refused",
    hasMediaFalse.status === 200 && hasMediaGarbage.status === 422,
    `false → ${String(hasMediaFalse.status)}, maybe → ${String(hasMediaGarbage.status)}`,
  );

  const organizationReviews = await callApi(
    "GET",
    "/store/organizations/store-demo-furnishings/reviews",
  );
  record(
    "organization reviews read exists (product-less reviews are reachable)",
    organizationReviews.status === 200,
    `status ${String(organizationReviews.status)}`,
  );

  const hiddenProduct = await callApi("GET", "/store/products/not-a-real-slug/reviews");
  record(
    "reviews of an invisible product are 404, not an empty list",
    hiddenProduct.status === 404,
    `status ${String(hiddenProduct.status)}`,
  );
}

// ---------------------------------------------------------------------------
// A11 — engagement.
// ---------------------------------------------------------------------------

async function smokeEngagement(buyer: Actor): Promise<void> {
  const anonymousDetail = await callApi("GET", `/store/products/${CHAIR_PRODUCT_SLUG}`);
  const anonymousEngagement = asRecord(dataOf(anonymousDetail)["engagement"]);
  record(
    "anonymous viewer gets engagement.viewer = null, not a fabricated false",
    anonymousDetail.status === 200 && anonymousEngagement["viewer"] === null,
    `viewer ${JSON.stringify(anonymousEngagement["viewer"])}`,
  );
  record(
    "engagement counters are integers on the wire",
    numberField(anonymousEngagement, "likeCount") !== null &&
      numberField(anonymousEngagement, "questionCount") !== null,
    `likeCount ${String(numberField(anonymousEngagement, "likeCount"))}`,
  );
  record(
    "commentCount is absent — A10 has no table and a zero would look wired",
    !("commentCount" in anonymousEngagement),
    `keys ${Object.keys(anonymousEngagement).join(",")}`,
  );

  const liked = await callApi("PUT", `/store/products/${CHAIR_PRODUCT_SLUG}/like`, {
    actor: buyer,
  });
  const likedOnce = numberField(dataOf(liked), "likeCount");
  const likedTwice = await callApi("PUT", `/store/products/${CHAIR_PRODUCT_SLUG}/like`, {
    actor: buyer,
  });
  const likedAgain = numberField(dataOf(likedTwice), "likeCount");
  record(
    "like is idempotent by verb — a second PUT does not double-count",
    liked.status === 200 && likedOnce !== null && likedOnce === likedAgain,
    `first ${String(likedOnce)}, second ${String(likedAgain)}`,
  );

  const viewerState = asRecord(dataOf(likedTwice)["viewer"]);
  record(
    "the signed-in viewer sees its own like state",
    viewerState["hasLiked"] === true,
    `viewer ${JSON.stringify(viewerState)}`,
  );

  const cleared = await callApi("DELETE", `/store/products/${CHAIR_PRODUCT_SLUG}/like`, {
    actor: buyer,
  });
  const clearedTwice = await callApi("DELETE", `/store/products/${CHAIR_PRODUCT_SLUG}/like`, {
    actor: buyer,
  });
  record(
    "un-like is idempotent and never drives the counter negative",
    cleared.status === 200 &&
      clearedTwice.status === 200 &&
      (numberField(dataOf(clearedTwice), "likeCount") ?? -1) >= 0,
    `count ${String(numberField(dataOf(clearedTwice), "likeCount"))}`,
  );

  const anonymousShare = await callApi("POST", `/store/products/${CHAIR_PRODUCT_SLUG}/share`);
  record(
    "an anonymous visitor may record a share",
    anonymousShare.status === 200,
    `status ${String(anonymousShare.status)}`,
  );

  const unauthenticatedLike = await callApi("PUT", `/store/products/${CHAIR_PRODUCT_SLUG}/like`);
  record(
    "liking requires a session",
    unauthenticatedLike.status === 401,
    `status ${String(unauthenticatedLike.status)}`,
  );
}

// ---------------------------------------------------------------------------
// A9 — Q&A.
// ---------------------------------------------------------------------------

async function smokeQuestionsAndAnswers(buyer: Actor, seller: Actor): Promise<string> {
  const asked = await callApi("POST", `/commerce/products/${CHAIR_PRODUCT_ID}/questions`, {
    actor: buyer,
    body: { bodyText: "Smoke test: does this ship assembled?" },
    idempotencyPrefix: "ask",
  });
  const questionId = stringField(dataOf(asked), "id");
  record(
    "a buyer can ask a public question",
    asked.status === 201 && questionId !== "",
    `status ${String(asked.status)}`,
  );

  const authorKindAttempt = await callApi(
    "POST",
    `/commerce/products/${CHAIR_PRODUCT_ID}/questions`,
    {
      actor: buyer,
      body: { bodyText: "Smoke test: unknown field.", authorKind: "seller" },
      idempotencyPrefix: "ask-strict",
    },
  );
  record(
    "an unknown body field is a loud 422, never silently dropped",
    authorKindAttempt.status === 422,
    `status ${String(authorKindAttempt.status)}`,
  );

  const buyerAnswer = await callApi("POST", `/commerce/questions/${questionId}/answers`, {
    actor: buyer,
    body: { bodyText: "Smoke test: a buyer with no completion answering." },
    idempotencyPrefix: "answer-refused",
  });
  record(
    "a buyer with no completion for this product cannot answer (403, not 404)",
    buyerAnswer.status === 403,
    `status ${String(buyerAnswer.status)}`,
  );

  const sellerAnswer = await callApi("POST", `/commerce/questions/${questionId}/answers`, {
    actor: seller,
    body: { bodyText: "Smoke test: yes, fully assembled." },
    idempotencyPrefix: "answer-seller",
  });
  const answerKind = stringField(dataOf(sellerAnswer), "authorKind");
  record(
    "the owning seller can answer, and authorKind is derived as `seller`",
    sellerAnswer.status === 201 && answerKind === "seller",
    `status ${String(sellerAnswer.status)}, authorKind "${answerKind}"`,
  );

  const secondSellerAnswer = await callApi("POST", `/commerce/questions/${questionId}/answers`, {
    actor: seller,
    body: { bodyText: "Smoke test: a second answer from the same organization." },
    idempotencyPrefix: "answer-dupe",
  });
  record(
    "one answer per organization per question",
    secondSellerAnswer.status === 409,
    `status ${String(secondSellerAnswer.status)}`,
  );

  const publicQuestions = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/questions?limit=5`,
  );
  const questionItems = arrayField(dataOf(publicQuestions), "items");
  const firstQuestion = asRecord(questionItems[0]);
  record(
    "the public question list shows the question with its seller answer preview",
    publicQuestions.status === 200 &&
      questionItems.length > 0 &&
      firstQuestion["hasSellerAnswer"] === true &&
      asRecord(firstQuestion["topAnswer"])["authorKind"] === "seller",
    `status ${String(publicQuestions.status)}, ${String(questionItems.length)} question(s)`,
  );

  const answers = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/questions/${questionId}/answers`,
  );
  record(
    "the answer list is reachable and paginated",
    answers.status === 200 && arrayField(dataOf(answers), "items").length > 0,
    `status ${String(answers.status)}`,
  );

  const foreignAnswers = await callApi(
    "GET",
    `/store/products/bedside-reading-lamp/questions/${questionId}/answers`,
  );
  record(
    "a question id from another product 404s rather than resolving",
    foreignAnswers.status === 404,
    `status ${String(foreignAnswers.status)}`,
  );

  return questionId;
}

// ---------------------------------------------------------------------------
// A12 — reports and moderation.
// ---------------------------------------------------------------------------

async function smokeReportsAndModeration(
  buyer: Actor,
  seller: Actor,
  staff: Actor,
  questionId: string,
): Promise<void> {
  const sellerSelfReport = await callApi("POST", "/commerce/reports", {
    actor: seller,
    body: { targetKind: "product", targetId: CHAIR_PRODUCT_ID, reason: "spam" },
    idempotencyPrefix: "report-self",
  });
  record(
    "an organization cannot report its own content",
    sellerSelfReport.status === 422,
    `status ${String(sellerSelfReport.status)}`,
  );

  const report = await callApi("POST", "/commerce/reports", {
    actor: buyer,
    body: {
      targetKind: "question",
      targetId: questionId,
      reason: "off_topic",
      detailText: "Smoke test report.",
    },
    idempotencyPrefix: "report",
  });
  const reportId = stringField(dataOf(report), "id");
  record(
    "a buyer can report a question",
    report.status === 201 && reportId !== "",
    `status ${String(report.status)}`,
  );

  const duplicateReport = await callApi("POST", "/commerce/reports", {
    actor: buyer,
    body: { targetKind: "question", targetId: questionId, reason: "spam" },
    idempotencyPrefix: "report-dupe",
  });
  record(
    "one report per person per target",
    duplicateReport.status === 409,
    `status ${String(duplicateReport.status)}`,
  );

  const buyerQueue = await callApi("GET", "/commerce/admin/content-reports", { actor: buyer });
  record(
    "the moderation queue refuses a caller without moderate_commerce",
    buyerQueue.status === 403,
    `status ${String(buyerQueue.status)}`,
  );

  const staffQueue = await callApi("GET", "/commerce/admin/content-reports?status=open", {
    actor: staff,
  });
  record(
    "staff can read the moderation queue",
    staffQueue.status === 200 && arrayField(dataOf(staffQueue), "items").length > 0,
    `status ${String(staffQueue.status)}`,
  );

  const decided = await callApi(`POST`, `/commerce/admin/content-reports/${reportId}/decisions`, {
    actor: staff,
    body: { decision: "actioned", note: "Smoke test: hidden." },
    idempotencyPrefix: "decide",
  });
  record("staff can action a report", decided.status === 200, `status ${String(decided.status)}`);

  const [hiddenQuestion] = await db
    .select({ visibilityState: commerceProductQuestion.visibilityState })
    .from(commerceProductQuestion)
    .where(eq(commerceProductQuestion.id, questionId))
    .limit(1);
  record(
    "actioning the report actually hid the question",
    hiddenQuestion?.visibilityState === "hidden_by_moderator",
    `state ${hiddenQuestion?.visibilityState ?? "missing"}`,
  );

  const publicAfterHide = await callApi(
    "GET",
    `/store/products/${CHAIR_PRODUCT_SLUG}/questions?limit=20`,
  );
  const remainingIds = arrayField(dataOf(publicAfterHide), "items").map((item) =>
    stringField(asRecord(item), "id"),
  );
  record(
    "a hidden question is gone from the public read",
    !remainingIds.includes(questionId),
    `${String(remainingIds.length)} visible question(s)`,
  );

  const reDecide = await callApi("POST", `/commerce/admin/content-reports/${reportId}/decisions`, {
    actor: staff,
    body: { decision: "dismissed" },
    idempotencyPrefix: "decide-again",
  });
  record(
    "a resolved report cannot be decided twice",
    reDecide.status === 409,
    `status ${String(reDecide.status)}`,
  );

  const restored = await callApi("POST", "/commerce/admin/content/restore", {
    actor: staff,
    body: {
      targetKind: "question",
      targetId: questionId,
      reasonNote: "Smoke test: restoring.",
    },
    idempotencyPrefix: "restore",
  });
  record(
    "staff can restore hidden content",
    restored.status === 200,
    `status ${String(restored.status)}`,
  );

  const actionLog = await callApi("GET", "/commerce/admin/moderation-actions", { actor: staff });
  record(
    "the moderation action log records both decisions",
    actionLog.status === 200 && arrayField(dataOf(actionLog), "items").length >= 2,
    `${String(arrayField(dataOf(actionLog), "items").length)} action(s)`,
  );
}

// ---------------------------------------------------------------------------
// A14 — pre-sales inquiries.
// ---------------------------------------------------------------------------

async function smokeInquiries(buyer: Actor, seller: Actor): Promise<void> {
  const anonymousDetail = await callApi("GET", `/store/products/${CHAIR_PRODUCT_SLUG}`);
  record(
    "an anonymous viewer is offered sign_in",
    stringField(dataOf(anonymousDetail), "contactAffordance") === "sign_in",
    `affordance "${stringField(dataOf(anonymousDetail), "contactAffordance")}"`,
  );

  const sellerDetail = await callApi("GET", `/store/products/${CHAIR_PRODUCT_SLUG}`, {
    actor: seller,
  });
  record(
    "the seller of the listing is not offered chat with itself",
    stringField(dataOf(sellerDetail), "contactAffordance") === "ask_question",
    `affordance "${stringField(dataOf(sellerDetail), "contactAffordance")}"`,
  );

  const buyerDetail = await callApi("GET", `/store/products/${CHAIR_PRODUCT_SLUG}`, {
    actor: buyer,
  });
  record(
    "an active buyer organization is offered chat",
    stringField(dataOf(buyerDetail), "contactAffordance") === "chat",
    `affordance "${stringField(dataOf(buyerDetail), "contactAffordance")}"`,
  );

  const inquiry = await callApi("POST", `/commerce/products/${CHAIR_PRODUCT_ID}/inquiries`, {
    actor: buyer,
    idempotencyPrefix: "inquiry",
  });
  const inquiryId = stringField(dataOf(inquiry), "id");
  const thread = asRecord(dataOf(inquiry)["thread"]);
  record(
    "opening an inquiry creates it and its thread",
    inquiry.status === 201 &&
      inquiryId !== "" &&
      stringField(thread, "resourceKind") === "product_inquiry",
    `status ${String(inquiry.status)}, resourceKind "${stringField(thread, "resourceKind")}"`,
  );

  const repeated = await callApi("POST", `/commerce/products/${CHAIR_PRODUCT_ID}/inquiries`, {
    actor: buyer,
    idempotencyPrefix: "inquiry-again",
  });
  record(
    "pressing Chat now twice reaches the same conversation, never a fork",
    repeated.status === 201 && stringField(dataOf(repeated), "id") === inquiryId,
    `same id ${String(stringField(dataOf(repeated), "id") === inquiryId)}`,
  );

  const sellerInquiry = await callApi("POST", `/commerce/products/${CHAIR_PRODUCT_ID}/inquiries`, {
    actor: seller,
    idempotencyPrefix: "inquiry-self",
  });
  record(
    "a seller cannot open an inquiry on its own listing",
    sellerInquiry.status === 422 || sellerInquiry.status === 403,
    `status ${String(sellerInquiry.status)}`,
  );

  const threadId = stringField(thread, "id");
  const message = await callApi("POST", `/commerce/threads/${threadId}/messages`, {
    actor: buyer,
    body: { bodyText: "Smoke test: what is your lead time on 200 units?" },
    idempotencyPrefix: "inquiry-message",
  });
  record(
    "the buyer can send into the inquiry thread",
    message.status === 201,
    `status ${String(message.status)}`,
  );

  const sellerRead = await callApi("GET", `/commerce/threads/${threadId}/messages`, {
    actor: seller,
  });
  record(
    "the seller can read the inquiry thread it is party to",
    sellerRead.status === 200,
    `status ${String(sellerRead.status)}`,
  );

  const sellerInbox = await callApi("GET", "/commerce/inquiries?side=seller", { actor: seller });
  record(
    "the seller inquiry inbox lists it",
    sellerInbox.status === 200 && arrayField(dataOf(sellerInbox), "items").length > 0,
    `${String(arrayField(dataOf(sellerInbox), "items").length)} inquiry(ies)`,
  );
}

async function main(): Promise<void> {
  await waitForServer();

  const seller = await signIn("store-demo-seller@example.invalid");
  const buyer = await signIn("store-demo-buyer@example.invalid");
  const staff = await signIn("store-demo-staff@example.invalid");

  await activateOrganization(seller, SELLER_ORGANIZATION_ID);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);

  await smokeReviewReads();
  await smokeEngagement(buyer);
  const questionId = await smokeQuestionsAndAnswers(buyer, seller);
  await smokeInquiries(buyer, seller);
  await smokeReportsAndModeration(buyer, seller, staff, questionId);

  let hasFailure = false;
  for (const outcome of outcomes) {
    const mark = outcome.passed ? "PASS" : "FAIL";
    console.log(`[${mark}] ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) hasFailure = true;
  }

  await pool.end();
  if (hasFailure) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void pool.end();
});
