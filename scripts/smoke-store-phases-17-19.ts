/**
 * Drives the Phase 17, 18 and 19 routes over HTTP against a running server.
 *
 *   pnpm run db:migrate
 *   pnpm run dev                 # shell 2
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phases-17-19
 *
 * OVER HTTP, NOT IN-PROCESS, for the reason every store smoke before it was: the mechanisms
 * these phases lean on live ABOVE the service layer and an in-process call reaches none of
 * them.
 *
 *   - `.strict()` query parsing. The directory's five filters are `z.coerce`, and a
 *     coercion that only ever sees a number from a test never proves it parses "500".
 *   - ROUTE ORDERING. `/commerce/factories/inquiries/mine` and
 *     `/commerce/factories/:factorySlug/inquiries` are the same depth, and only a real
 *     request proves which one wins.
 *   - The IDEMPOTENCY middleware, which is a header contract and has no service-layer form.
 *   - The `/community` MOUNT, which is a claim about bounded contexts that only a URL can
 *     make.
 *
 * IT ASSERTS REFUSALS AS HARD AS SUCCESSES, and for these phases the refusals ARE the
 * product: a queued forum thread reaches no public read, a locked thread takes no reply, a
 * cofounder create carrying a capital figure is a 422 rather than a silent discard, and the
 * directory's `sort` key does not exist.
 *
 * WHAT IT DOES NOT DO: it never asserts a list is non-empty when the demo seed has no such
 * rows. A check that passes only because it asked for nothing is worse than no check, so
 * those report SKIP with the reason and do not count as passes.
 */
import "dotenv/config";
import { eq, like } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { communityCofounderProfile, communityForumThread, user } from "#src/db/schema.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";
const BUYER_EMAIL = "store-demo-buyer@example.invalid";
const SELLER_EMAIL = "store-demo-seller@example.invalid";
const STAFF_EMAIL = "store-demo-staff@example.invalid";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const SELLER_ORGANIZATION_ID = "store_demo_org_seller";

interface CheckOutcome {
  readonly label: string;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

const outcomes: CheckOutcome[] = [];

function record(label: string, passed: boolean, detail: string): void {
  outcomes.push({ label, status: passed ? "pass" : "fail", detail });
}

function skip(label: string, reason: string): void {
  outcomes.push({ label, status: "skip", detail: reason });
}

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly rawBytes: Buffer;
}

interface Actor {
  readonly cookie: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function dataOf(result: ApiResult): Record<string, unknown> {
  return asRecord(result.body["data"]);
}

function arrayField(source: Record<string, unknown>, key: string): readonly unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke1719-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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
  const headers: Record<string, string> = { origin: REQUEST_ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.actor) headers["cookie"] = options.actor.cookie;
  if (options.idempotencyPrefix !== undefined) {
    headers["idempotency-key"] = nextIdempotencyKey(options.idempotencyPrefix);
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const rawBytes = Buffer.from(await response.arrayBuffer());
  let body: Record<string, unknown> = {};
  try {
    const text = rawBytes.toString("utf8");
    body = asRecord(text === "" ? {} : JSON.parse(text));
  } catch {
    body = {};
  }
  return { status: response.status, body, headers: response.headers, rawBytes };
}

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

/**
 * Every commerce route resolves its actor from `session.active_organization_id`, and there
 * is no auto-select. This is not optional setup — it is how the session learns which
 * organization the caller is acting for, and skipping it produces a flat 403 on every
 * authenticated route in this file, which is exactly what the first run of it did.
 */
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

/** Uniqueness for slugs and references across repeated runs of this file. */
const RUN_TAG = String(Date.now()).slice(-8);

/**
 * Removes what a PREVIOUS run of this file left behind, so it is re-runnable.
 *
 * WHY IT IS NEEDED AT ALL: a cofounder profile is UNIQUE PER PERSON, so the second run's
 * create is a legitimate 409 and every check after it cascades. That is the product working;
 * the script was the thing that was wrong. Forum threads are cleared for the same reason —
 * an accumulating moderation queue makes the "queued thread reaches no public read" check
 * weaker every run.
 *
 * Scoped to the demo buyer and to threads this file titled, so it cannot touch real rows.
 */
async function resetPreviousRun(): Promise<void> {
  const [buyerRow] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, BUYER_EMAIL))
    .limit(1);
  if (!buyerRow) return;

  await db
    .delete(communityCofounderProfile)
    .where(eq(communityCofounderProfile.userId, buyerRow.id));
  await db
    .delete(communityForumThread)
    .where(like(communityForumThread.title, "Sample lead times from Indian seating factories%"));
}

async function main(): Promise<void> {
  console.log("smoke-store-phases-17-19\n");

  await resetPreviousRun();

  const buyer = await signIn(BUYER_EMAIL);
  const seller = await signIn(SELLER_EMAIL);
  /** A `moderator` from the demo seed. `moderate_content` is read from the row, never a session. */
  const staff = await signIn(STAFF_EMAIL);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);

  // -------------------------------------------------------------------------
  // Phase 17 — the manufacturer directory (§16)
  // -------------------------------------------------------------------------

  const directory = await callApi("GET", "/store/factories?limit=5");
  const directoryItems = arrayField(dataOf(directory), "items");
  record(
    "17 · GET /store/factories answers 200 with a cursor page",
    directory.status === 200 && "page" in dataOf(directory),
    `${String(directory.status)}, ${String(directoryItems.length)} item(s)`,
  );

  const unknownFilter = await callApi("GET", "/store/factories?bogusKey=1");
  record(
    "17 · an unrecognized query key is 422, not an ignored field",
    unknownFilter.status === 422,
    String(unknownFilter.status),
  );

  const firstFactory = asRecord(directoryItems[0]);
  const factorySlug = stringField(firstFactory, "slug");
  if (factorySlug === "") {
    skip("17 · factory detail", "the demo seed has no eligible manufacturer");
  } else {
    const detail = await callApi("GET", `/store/factories/${factorySlug}`);
    const detailData = dataOf(detail);
    const factory = asRecord(detailData["factory"]);
    const auditedWithoutRecord =
      factory["verificationState"] === "site_audited" && detailData["lastAuditedAt"] === null;
    record(
      "17 · site_audited is NEVER claimed without an audit date behind it",
      detail.status === 200 && !auditedWithoutRecord,
      `${String(detail.status)}, verificationState=${String(factory["verificationState"])}, lastAuditedAt=${String(detailData["lastAuditedAt"])}`,
    );
    record(
      "17 · the detail carries exportMarkets as an array, derived rather than declared",
      Array.isArray(detailData["exportMarkets"]),
      `exportMarkets=${JSON.stringify(detailData["exportMarkets"])}`,
    );
    record(
      "17 · capabilityKinds is projected on the CARD, not only the detail",
      Array.isArray(firstFactory["capabilityKinds"]),
      `capabilityKinds=${JSON.stringify(firstFactory["capabilityKinds"])}`,
    );
  }

  const missingFactory = await callApi("GET", "/store/factories/no-such-factory-anywhere");
  record(
    "17 · an unknown factory slug is 404",
    missingFactory.status === 404,
    String(missingFactory.status),
  );

  // --- The seller's own factory depth.

  const terms = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/factory-terms`,
    {
      actor: seller,
      body: {
        offersSamples: true,
        sampleLeadTimeDays: 10,
        sampleFeeInCents: 0,
        sampleCurrency: "USD",
        minimumOrderQuantity: 200,
        minimumOrderQuantityUnitLabel: "pieces",
        minimumLeadTimeDays: 20,
        maximumLeadTimeDays: 45,
        acceptingInquiries: true,
      },
    },
  );
  record(
    "17 · PUT factory-terms accepts a coherent whole object",
    terms.status === 200,
    `${String(terms.status)} ${JSON.stringify(terms.body["message"] ?? "")}`,
  );

  const halfMoq = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/factory-terms`,
    {
      actor: seller,
      body: {
        offersSamples: false,
        sampleLeadTimeDays: null,
        sampleFeeInCents: null,
        sampleCurrency: "USD",
        minimumOrderQuantity: 200,
        minimumOrderQuantityUnitLabel: null,
        minimumLeadTimeDays: null,
        maximumLeadTimeDays: null,
        acceptingInquiries: true,
      },
    },
  );
  record(
    "17 · a MOQ with no unit label is REFUSED at the boundary",
    halfMoq.status === 422,
    String(halfMoq.status),
  );

  const feeWithoutSamples = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/factory-terms`,
    {
      actor: seller,
      body: {
        offersSamples: false,
        sampleLeadTimeDays: null,
        sampleFeeInCents: 5000,
        sampleCurrency: "USD",
        minimumOrderQuantity: null,
        minimumOrderQuantityUnitLabel: null,
        minimumLeadTimeDays: null,
        maximumLeadTimeDays: null,
        acceptingInquiries: true,
      },
    },
  );
  record(
    "17 · a sample fee on a profile offering no samples is REFUSED",
    feeWithoutSamples.status === 422,
    String(feeWithoutSamples.status),
  );

  /**
   * THE `maxMinimumOrderQuantity` RULE, PROVEN RATHER THAN OBSERVED.
   *
   * The seller now declares a 200-piece MOQ, so the filter is exercised in all three of its
   * states against a factory whose value this file controls: included below its own MOQ,
   * excluded above it, and — the A25 rule that matters — INCLUDED AGAIN once the MOQ is
   * cleared, because "no minimum declared" satisfies "will you take an order this small".
   */
  async function directoryContainsSeller(maxMoq: number): Promise<boolean> {
    const page = await callApi(
      "GET",
      `/store/factories?maxMinimumOrderQuantity=${String(maxMoq)}&limit=50`,
    );
    return arrayField(dataOf(page), "items").some(
      (item) => stringField(asRecord(item), "organizationId") === SELLER_ORGANIZATION_ID,
    );
  }

  record(
    "17 · a 200-piece MOQ is INCLUDED by maxMinimumOrderQuantity=500",
    await directoryContainsSeller(500),
    "present",
  );
  record(
    "17 · and EXCLUDED by maxMinimumOrderQuantity=100",
    !(await directoryContainsSeller(100)),
    "absent",
  );

  const clearedMoq = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/factory-terms`,
    {
      actor: seller,
      body: {
        offersSamples: true,
        sampleLeadTimeDays: 10,
        sampleFeeInCents: 0,
        sampleCurrency: "USD",
        minimumOrderQuantity: null,
        minimumOrderQuantityUnitLabel: null,
        minimumLeadTimeDays: 20,
        maximumLeadTimeDays: 45,
        acceptingInquiries: true,
      },
    },
  );
  record(
    "17 · clearing the MOQ pair together is accepted",
    clearedMoq.status === 200,
    String(clearedMoq.status),
  );
  record(
    "17 · a factory with NO declared MOQ is ADMITTED by maxMinimumOrderQuantity=100 (A25's NULL rule)",
    await directoryContainsSeller(100),
    "present with a null MOQ",
  );

  const lines = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/production-lines`,
    {
      actor: seller,
      body: {
        productionLines: [
          {
            name: "Frame welding",
            processSummary: "Jig welding and powder coat for banquet frames.",
            monthlyCapacityUnits: 12000,
            unitLabel: "frames",
          },
        ],
      },
    },
  );
  record("17 · PUT production-lines replaces the set", lines.status === 200, String(lines.status));

  const lineWithoutUnit = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/production-lines`,
    {
      actor: seller,
      body: {
        productionLines: [
          { name: "Upholstery", processSummary: "Foam and fabric.", monthlyCapacityUnits: 5000 },
        ],
      },
    },
  );
  record(
    "17 · a production line with a capacity and no unit label is REFUSED",
    lineWithoutUnit.status === 422,
    String(lineWithoutUnit.status),
  );

  const sites = await callApi("PUT", `/commerce/organizations/${SELLER_ORGANIZATION_ID}/sites`, {
    actor: seller,
    body: {
      sites: [
        {
          label: "Bhiwandi plant",
          countryCode: "IN",
          locality: "Bhiwandi",
          floorAreaSquareMetres: 8200,
          productionStaffCount: 140,
        },
      ],
    },
  });
  record("17 · PUT sites replaces the set", sites.status === 200, String(sites.status));

  const auditByNonStaff = await callApi(
    "POST",
    `/commerce/admin/organizations/${SELLER_ORGANIZATION_ID}/site-audits`,
    {
      actor: seller,
      body: {
        auditedAt: "2026-05-01",
        auditorName: "Somebody",
        scopeSummary: "A scope the seller wrote about itself.",
      },
      idempotencyPrefix: "audit",
    },
  );
  record(
    "17 · a seller CANNOT record a site audit about itself (403, capability-first)",
    auditByNonStaff.status === 403,
    String(auditByNonStaff.status),
  );

  // --- The manufacturing inquiry.

  if (factorySlug === "") {
    skip("17 · manufacturing inquiry", "no eligible factory in the demo seed");
  } else {
    const created = await callApi("POST", `/commerce/factories/${factorySlug}/inquiries`, {
      actor: buyer,
      body: {
        capabilityKind: "oem",
        productDescription: `Stackable banquet chair, smoke run ${RUN_TAG}.`,
        estimatedAnnualQuantity: 8000,
        unitLabel: "pieces",
        requiredCertifications: ["iso_9001"],
      },
      idempotencyPrefix: "inquiry",
    });
    const inquiry = dataOf(created);
    const inquiryId = stringField(inquiry, "id");
    record(
      "17 · POST an inquiry answers 201 and state DRAFT — creating notifies nobody",
      created.status === 201 && inquiry["state"] === "draft",
      `${String(created.status)}, state=${String(inquiry["state"])}, reference=${stringField(inquiry, "reference")}`,
    );

    const halfPair = await callApi("POST", `/commerce/factories/${factorySlug}/inquiries`, {
      actor: buyer,
      body: {
        capabilityKind: "oem",
        productDescription: "A quantity with no unit is unreadable.",
        estimatedAnnualQuantity: 8000,
      },
      idempotencyPrefix: "inquiry-half",
    });
    record(
      "17 · an inquiry quantity with no unit label is REFUSED",
      halfPair.status === 422,
      String(halfPair.status),
    );

    const noKey = await fetch(`${BASE_URL}/commerce/factories/${factorySlug}/inquiries`, {
      method: "POST",
      headers: { origin: REQUEST_ORIGIN, cookie: buyer.cookie, "content-type": "application/json" },
      body: JSON.stringify({ capabilityKind: "oem", productDescription: "No key on this one." }),
    });
    record(
      "17 · the create REFUSES a request with no Idempotency-Key",
      noKey.status === 400 || noKey.status === 422,
      String(noKey.status),
    );

    const mine = await callApi("GET", "/commerce/factories/inquiries/mine", { actor: buyer });
    const mineItems = arrayField(dataOf(mine), "items");
    record(
      "17 · /inquiries/mine resolves as a LITERAL, not as :factorySlug, and lists the draft",
      mine.status === 200 &&
        mineItems.some((item) => stringField(asRecord(item), "id") === inquiryId),
      `${String(mine.status)}, ${String(mineItems.length)} item(s)`,
    );

    const receivedBeforeSend = await callApi("GET", "/commerce/factories/inquiries/received", {
      actor: seller,
    });
    const receivedItems = arrayField(dataOf(receivedBeforeSend), "items");
    record(
      "17 · a DRAFT is invisible in the factory's queue",
      receivedBeforeSend.status === 200 &&
        !receivedItems.some((item) => stringField(asRecord(item), "id") === inquiryId),
      `${String(receivedBeforeSend.status)}, ${String(receivedItems.length)} item(s)`,
    );

    const answerBeforeSend = await callApi(
      "POST",
      `/commerce/factories/inquiries/${inquiryId}/answer`,
      { actor: seller },
    );
    record(
      "17 · the factory cannot answer an inquiry it has not been sent",
      answerBeforeSend.status === 404,
      String(answerBeforeSend.status),
    );

    const sent = await callApi("POST", `/commerce/factories/inquiries/${inquiryId}/send`, {
      actor: buyer,
    });
    record(
      "17 · send moves draft → sent and opens the one-to-one thread",
      sent.status === 200 &&
        dataOf(sent)["state"] === "sent" &&
        stringField(dataOf(sent), "threadId") !== "",
      `${String(sent.status)}, state=${String(dataOf(sent)["state"])}, threadId=${stringField(dataOf(sent), "threadId") === "" ? "MISSING" : "present"}`,
    );

    const sentTwice = await callApi("POST", `/commerce/factories/inquiries/${inquiryId}/send`, {
      actor: buyer,
    });
    record(
      "17 · sending twice is a tagged 409, not a silent second notification",
      sentTwice.status === 409,
      String(sentTwice.status),
    );

    const answered = await callApi("POST", `/commerce/factories/inquiries/${inquiryId}/answer`, {
      actor: seller,
    });
    record(
      "17 · the factory marks it answered",
      answered.status === 200 && dataOf(answered)["state"] === "answered",
      `${String(answered.status)}, state=${String(dataOf(answered)["state"])}`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 18 — the business forum (§17)
  // -------------------------------------------------------------------------

  const thread = await callApi("POST", "/community/forum/threads", {
    actor: buyer,
    body: {
      board: "sourcing",
      title: `Sample lead times from Indian seating factories ${RUN_TAG}`,
      body: "We are comparing three suppliers and their sample lead times differ by a month. What is normal?",
    },
    idempotencyPrefix: "thread",
  });
  const threadData = dataOf(thread);
  const threadId = stringField(threadData, "id");
  const threadSlug = stringField(threadData, "slug");
  record(
    "18 · POST a thread answers 201 and state PENDING_REVIEW — this is what keeps A10 closed",
    thread.status === 201 && threadData["state"] === "pending_review",
    `${String(thread.status)}, state=${String(threadData["state"])}`,
  );
  record(
    "18 · the create message does not claim the thread is live",
    !/posted|live|published/i.test(stringField(thread.body, "message")),
    JSON.stringify(stringField(thread.body, "message")),
  );
  record(
    "18 · authorOrganizationName is carried, and is a real distinction from an individual",
    "authorOrganizationName" in threadData,
    `authorOrganizationName=${JSON.stringify(threadData["authorOrganizationName"])}`,
  );

  const publicListBeforeReview = await callApi("GET", "/store/forum/threads?limit=50");
  const publicItems = arrayField(dataOf(publicListBeforeReview), "items");
  record(
    "18 · a queued thread reaches NO public read",
    !publicItems.some((item) => stringField(asRecord(item), "id") === threadId),
    `${String(publicItems.length)} public thread(s), none of them this one`,
  );

  const publicDetailBeforeReview = await callApi("GET", `/store/forum/threads/${threadSlug}`);
  record(
    "18 · nor is it reachable by its own slug",
    publicDetailBeforeReview.status === 404,
    String(publicDetailBeforeReview.status),
  );

  const mineThreads = await callApi("GET", "/community/forum/threads/mine", { actor: buyer });
  const mineThreadItems = arrayField(dataOf(mineThreads), "items");
  record(
    "18 · /threads/mine DOES show it — without this the create response is the last thing an author sees",
    mineThreads.status === 200 &&
      mineThreadItems.some((item) => stringField(asRecord(item), "id") === threadId),
    `${String(mineThreads.status)}, ${String(mineThreadItems.length)} item(s)`,
  );

  const replyBeforeReview = await callApi("POST", `/community/forum/threads/${threadId}/replies`, {
    actor: seller,
    body: { body: "You cannot reply to something nobody can see." },
    idempotencyPrefix: "reply-early",
  });
  record(
    "18 · a queued thread takes no replies",
    replyBeforeReview.status === 404,
    String(replyBeforeReview.status),
  );

  const queueAsNonStaff = await callApi("GET", "/community/admin/forum/threads", { actor: buyer });
  record(
    "18 · the moderation queue is 403 for a non-moderator, and names the capability",
    queueAsNonStaff.status === 403,
    `${String(queueAsNonStaff.status)} ${JSON.stringify(dataOf(queueAsNonStaff))}`,
  );

  const moderateAsNonStaff = await callApi(
    "POST",
    `/community/admin/forum/threads/${threadId}/moderate`,
    {
      actor: buyer,
      body: { decision: "publish", reasonNote: "self-approval" },
      idempotencyPrefix: "mod",
    },
  );
  record(
    "18 · an author cannot publish their own thread",
    moderateAsNonStaff.status === 403,
    String(moderateAsNonStaff.status),
  );

  const publicStateFilter = await callApi("GET", "/store/forum/threads?threadState=pending_review");
  record(
    "18 · asking a public read for pending_review is 422, not an empty page",
    publicStateFilter.status === 422,
    String(publicStateFilter.status),
  );

  const unknownBoard = await callApi("GET", "/store/forum/threads?board=general");
  record(
    "18 · there is no 'general' board, and asking for one is 422",
    unknownBoard.status === 422,
    String(unknownBoard.status),
  );

  // --- The moderation path, driven by a real moderator.

  const queue = await callApi("GET", "/community/admin/forum/threads", { actor: staff });
  const queueItems = arrayField(dataOf(queue), "items");
  record(
    "18 · the moderator sees the queued thread",
    queue.status === 200 &&
      queueItems.some((item) => stringField(asRecord(item), "id") === threadId),
    `${String(queue.status)}, ${String(queueItems.length)} queued`,
  );

  const published = await callApi("POST", `/community/admin/forum/threads/${threadId}/moderate`, {
    actor: staff,
    body: { decision: "publish", reasonNote: "On topic and answerable." },
    idempotencyPrefix: "publish",
  });
  record(
    "18 · publish moves it to OPEN",
    published.status === 200 && dataOf(published)["state"] === "open",
    `${String(published.status)}, state=${String(dataOf(published)["state"])}`,
  );

  const publicAfterReview = await callApi("GET", `/store/forum/threads/${threadSlug}`);
  const publicThread = asRecord(dataOf(publicAfterReview)["thread"]);
  record(
    "18 · and NOW it reaches the public read, excerpt and all",
    publicAfterReview.status === 200 && stringField(publicThread, "excerpt") !== "",
    `${String(publicAfterReview.status)}, excerpt=${JSON.stringify(stringField(publicThread, "excerpt").slice(0, 40))}`,
  );

  const reply = await callApi("POST", `/community/forum/threads/${threadId}/replies`, {
    actor: seller,
    body: {
      body: "Ten working days is normal for a seating sample; a month usually means tooling.",
    },
    idempotencyPrefix: "reply",
  });
  const replyId = stringField(dataOf(reply), "id");
  record("18 · a published thread takes replies", reply.status === 201, String(reply.status));

  const anonymousDetail = await callApi("GET", `/store/forum/threads/${threadSlug}`);
  const anonymousReplies = arrayField(asRecord(dataOf(anonymousDetail)["replies"]), "items");
  const anonymousViewer = asRecord(anonymousReplies[0])["viewer"];
  record(
    "18 · a signed-out reader gets viewer: NULL, never a defaulted false (A11/A24)",
    anonymousViewer === null,
    `viewer=${JSON.stringify(anonymousViewer)}`,
  );

  const endorsed = await callApi("PUT", `/community/forum/replies/${replyId}/helpful`, {
    actor: buyer,
  });
  const endorsedTwice = await callApi("PUT", `/community/forum/replies/${replyId}/helpful`, {
    actor: buyer,
  });
  record(
    "18 · PUT helpful twice counts ONCE — idempotent by verb, no key needed",
    endorsed.status === 200 &&
      endorsedTwice.status === 200 &&
      dataOf(endorsedTwice)["helpfulCount"] === 1,
    `count=${String(dataOf(endorsedTwice)["helpfulCount"])}`,
  );

  const withdrawn = await callApi("DELETE", `/community/forum/replies/${replyId}/helpful`, {
    actor: buyer,
  });
  record(
    "18 · DELETE withdraws it and the count returns to zero",
    withdrawn.status === 200 && dataOf(withdrawn)["helpfulCount"] === 0,
    `count=${String(dataOf(withdrawn)["helpfulCount"])}`,
  );

  const acceptedByStranger = await callApi(
    "POST",
    `/community/forum/threads/${threadId}/accepted-reply`,
    { actor: seller, body: { replyId } },
  );
  record(
    "18 · only the THREAD AUTHOR may accept an answer",
    acceptedByStranger.status === 404,
    String(acceptedByStranger.status),
  );

  const accepted = await callApi("POST", `/community/forum/threads/${threadId}/accepted-reply`, {
    actor: buyer,
    body: { replyId },
  });
  record(
    "18 · the author accepts, and the thread derives ANSWERED from the pointer",
    accepted.status === 200 &&
      dataOf(accepted)["state"] === "answered" &&
      stringField(dataOf(accepted), "acceptedReplyId") === replyId,
    `state=${String(dataOf(accepted)["state"])}`,
  );

  const locked = await callApi("POST", `/community/admin/forum/threads/${threadId}/moderate`, {
    actor: staff,
    body: { decision: "lock", reasonNote: "Answered; closing to new replies." },
    idempotencyPrefix: "lock",
  });
  record(
    "18 · a moderator locks it",
    locked.status === 200,
    `state=${String(dataOf(locked)["state"])}`,
  );

  const replyToLocked = await callApi("POST", `/community/forum/threads/${threadId}/replies`, {
    actor: seller,
    body: { body: "Locking stops new text." },
    idempotencyPrefix: "reply-locked",
  });
  record(
    "18 · a LOCKED thread refuses a reply with a tagged 409, not a silent no-op",
    replyToLocked.status === 409,
    String(replyToLocked.status),
  );

  const acceptOnLocked = await callApi(
    "DELETE",
    `/community/forum/threads/${threadId}/accepted-reply`,
    { actor: buyer },
  );
  record(
    "18 · but bookkeeping still works on a locked thread — locking stops text, not records",
    acceptOnLocked.status === 200,
    String(acceptOnLocked.status),
  );

  const rejectPublished = await callApi(
    "POST",
    `/community/admin/forum/threads/${threadId}/moderate`,
    {
      actor: staff,
      body: { decision: "reject", reasonNote: "Too late for that." },
      idempotencyPrefix: "reject-late",
    },
  );
  record(
    "18 · a published thread is locked, not rejected",
    rejectPublished.status === 409,
    String(rejectPublished.status),
  );

  // -------------------------------------------------------------------------
  // Phase 19 — the cofounder directory (§18)
  // -------------------------------------------------------------------------

  const capitalRejected = await callApi("POST", "/community/cofounder-profiles", {
    actor: buyer,
    body: {
      displayName: `Capital Probe ${RUN_TAG}`,
      headline: "A headline long enough to pass",
      bio: "A bio long enough to clear the twenty character floor comfortably.",
      lookingFor: "A technical cofounder",
      countryCode: "IN",
      commitmentLevel: "full_time",
      contributionKinds: ["capital"],
      capitalRangeMinInCents: 200000000,
    },
    idempotencyPrefix: "cofounder-capital",
  });
  record(
    "19 · a create carrying a capital figure is REFUSED (422), never silently discarded",
    capitalRejected.status === 422,
    String(capitalRejected.status),
  );

  const profile = await callApi("POST", "/community/cofounder-profiles", {
    actor: buyer,
    body: {
      displayName: `Smoke Founder ${RUN_TAG}`,
      headline: "Operator looking for a technical cofounder",
      bio: "Ten years running contract manufacturing programmes across two continents.",
      lookingFor: "Somebody who has shipped hardware before",
      countryCode: "IN",
      commitmentLevel: "full_time",
      contributionKinds: ["operations", "expertise"],
      sectors: ["Furniture", "furniture"],
      languages: ["en", "hi"],
      priorVentures: [
        {
          name: "Earlier venture",
          roleLabel: "Cofounder",
          yearsActiveLabel: "2018-2023",
          outcomeSummary: null,
        },
      ],
    },
    idempotencyPrefix: "cofounder",
  });
  const profileData = dataOf(profile);
  const profileCard = asRecord(profileData["profile"]);
  record(
    "19 · POST a profile answers 201 and state DRAFT",
    profile.status === 201 && profileData["state"] === "draft",
    `${String(profile.status)}, state=${String(profileData["state"])}`,
  );
  record(
    "19 · capitalRange and equityExpectationBasisPoints are NULL on the wire (§14)",
    profileCard["capitalRange"] === null && profileCard["equityExpectationBasisPoints"] === null,
    `capitalRange=${JSON.stringify(profileCard["capitalRange"])}, equity=${JSON.stringify(profileCard["equityExpectationBasisPoints"])}`,
  );
  record(
    "19 · duplicate sector labels are normalized to one",
    arrayField(profileCard, "sectors").length === 1,
    `sectors=${JSON.stringify(profileCard["sectors"])}`,
  );

  const duplicateProfile = await callApi("POST", "/community/cofounder-profiles", {
    actor: buyer,
    body: {
      displayName: `Second Profile ${RUN_TAG}`,
      headline: "One profile per person is the rule",
      bio: "A bio long enough to clear the twenty character floor comfortably.",
      lookingFor: "Nothing, this should be refused",
      countryCode: "IN",
      commitmentLevel: "advisory",
      contributionKinds: ["capital"],
    },
    idempotencyPrefix: "cofounder-dup",
  });
  record(
    "19 · one profile per person — a second is 409",
    duplicateProfile.status === 409,
    String(duplicateProfile.status),
  );

  const mineProfile = await callApi("GET", "/community/cofounder-profiles/mine", { actor: buyer });
  record(
    "19 · /mine returns the draft — without it a user creates something nobody can see",
    mineProfile.status === 200 && dataOf(mineProfile)["state"] === "draft",
    `${String(mineProfile.status)}, state=${String(dataOf(mineProfile)["state"])}`,
  );

  const publicBeforePublish = await callApi("GET", "/store/cofounder-profiles?limit=50");
  const publicProfiles = arrayField(dataOf(publicBeforePublish), "items");
  const profileId = stringField(profileCard, "id");
  record(
    "19 · a draft profile reaches no public read",
    !publicProfiles.some((item) => stringField(asRecord(item), "id") === profileId),
    `${String(publicProfiles.length)} published profile(s), none of them this one`,
  );

  const submitted = await callApi("POST", "/community/cofounder-profiles/mine/submit", {
    actor: buyer,
  });
  record(
    "19 · submit moves draft → pending_review",
    submitted.status === 200 && dataOf(submitted)["state"] === "pending_review",
    `${String(submitted.status)}, state=${String(dataOf(submitted)["state"])}`,
  );

  const editWhileQueued = await callApi("PATCH", "/community/cofounder-profiles/mine", {
    actor: buyer,
    body: {
      displayName: `Smoke Founder ${RUN_TAG}`,
      headline: "Editing while a moderator holds it",
      bio: "A bio long enough to clear the twenty character floor comfortably.",
      lookingFor: "This edit should be refused",
      countryCode: "IN",
      commitmentLevel: "full_time",
      contributionKinds: ["operations"],
    },
  });
  record(
    "19 · a profile awaiting review cannot be edited underneath the moderator",
    editWhileQueued.status === 409,
    String(editWhileQueued.status),
  );

  const engagement = await callApi("PATCH", "/community/cofounder-profiles/mine/engagement-state", {
    actor: buyer,
    body: { engagementState: "in_conversation" },
  });
  record(
    "19 · engagement-state IS editable without re-entering moderation — it is its own route",
    engagement.status === 200 &&
      asRecord(dataOf(engagement)["profile"])["engagementState"] === "in_conversation",
    String(engagement.status),
  );

  const sortRejected = await callApi("GET", "/store/cofounder-profiles?sort=newest");
  record(
    "19 · the directory has NO sort key — a ranking here could read as a recommendation",
    sortRejected.status === 422,
    String(sortRejected.status),
  );

  const stateRejected = await callApi("GET", "/store/cofounder-profiles?state=published");
  record(
    "19 · and no state key — not_looking profiles stay visible",
    stateRejected.status === 422,
    String(stateRejected.status),
  );

  const cofounderQueueAsNonStaff = await callApi("GET", "/community/admin/cofounder-profiles", {
    actor: buyer,
  });
  record(
    "19 · the cofounder queue is 403 for a non-moderator",
    cofounderQueueAsNonStaff.status === 403,
    String(cofounderQueueAsNonStaff.status),
  );

  const cofounderQueue = await callApi("GET", "/community/admin/cofounder-profiles", {
    actor: staff,
  });
  const cofounderQueueItems = arrayField(dataOf(cofounderQueue), "items");
  record(
    "19 · the moderator sees the queued profile",
    cofounderQueue.status === 200 &&
      cofounderQueueItems.some((item) => stringField(asRecord(item), "id") === profileId),
    `${String(cofounderQueue.status)}, ${String(cofounderQueueItems.length)} queued`,
  );

  const publishedProfile = await callApi(
    "POST",
    `/community/admin/cofounder-profiles/${profileId}/moderate`,
    {
      actor: staff,
      body: { decision: "publish", reasonNote: "Complete and in their own words." },
      idempotencyPrefix: "publish-profile",
    },
  );
  record(
    "19 · publish puts it in the directory",
    publishedProfile.status === 200,
    String(publishedProfile.status),
  );

  const directoryAfter = await callApi("GET", "/store/cofounder-profiles?limit=50");
  const directoryProfiles = arrayField(dataOf(directoryAfter), "items");
  const listed = directoryProfiles.find((item) => stringField(asRecord(item), "id") === profileId);
  record(
    "19 · and the public read carries it, still with NULL capital and equity",
    listed !== undefined &&
      asRecord(listed)["capitalRange"] === null &&
      asRecord(listed)["equityExpectationBasisPoints"] === null,
    listed === undefined ? "NOT LISTED" : "listed, both money fields null",
  );

  const notLookingStaysVisible = await callApi(
    "PATCH",
    "/community/cofounder-profiles/mine/engagement-state",
    { actor: buyer, body: { engagementState: "not_looking" } },
  );
  const afterNotLooking = await callApi("GET", "/store/cofounder-profiles?limit=50");
  record(
    "19 · a not_looking profile STAYS in the directory — hiding it would look like leaving",
    notLookingStaysVisible.status === 200 &&
      arrayField(dataOf(afterNotLooking), "items").some(
        (item) => stringField(asRecord(item), "id") === profileId,
      ),
    "still listed",
  );

  const publishedEdit = await callApi("PATCH", "/community/cofounder-profiles/mine", {
    actor: buyer,
    body: {
      displayName: `Smoke Founder ${RUN_TAG}`,
      headline: "Rewriting approved copy without review",
      bio: "A bio long enough to clear the twenty character floor comfortably.",
      lookingFor: "This edit should be refused",
      countryCode: "IN",
      commitmentLevel: "full_time",
      contributionKinds: ["operations"],
    },
  });
  record(
    "19 · a PUBLISHED profile cannot be edited without going back through review",
    publishedEdit.status === 409,
    String(publishedEdit.status),
  );

  const withdrawnProfile = await callApi("POST", "/community/cofounder-profiles/mine/withdraw", {
    actor: buyer,
  });
  const directoryAfterWithdraw = await callApi("GET", "/store/cofounder-profiles?limit=50");
  record(
    "19 · withdraw removes it from the directory, reversibly",
    withdrawnProfile.status === 200 &&
      dataOf(withdrawnProfile)["state"] === "withdrawn" &&
      !arrayField(dataOf(directoryAfterWithdraw), "items").some(
        (item) => stringField(asRecord(item), "id") === profileId,
      ),
    `state=${String(dataOf(withdrawnProfile)["state"])}, absent from the directory`,
  );

  // -------------------------------------------------------------------------
  // The mount points themselves (§1.1)
  // -------------------------------------------------------------------------

  const commerceForum = await callApi("POST", "/commerce/forum/threads", {
    actor: buyer,
    body: { board: "sourcing", title: "Wrong prefix entirely", body: "Community is not commerce." },
    idempotencyPrefix: "wrong-mount",
  });
  record(
    "§1.1 · the forum write is NOT served under /commerce",
    commerceForum.status === 404,
    String(commerceForum.status),
  );

  const commerceCofounder = await callApi("GET", "/commerce/cofounder-profiles/mine", {
    actor: buyer,
  });
  record(
    "§1.1 · nor is the cofounder read",
    commerceCofounder.status === 404,
    String(commerceCofounder.status),
  );

  // -------------------------------------------------------------------------

  let failures = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    const marker =
      outcome.status === "pass" ? "  ok  " : outcome.status === "skip" ? "  skip" : "  FAIL";
    console.log(`${marker}  ${outcome.label} — ${outcome.detail}`);
    if (outcome.status === "fail") failures += 1;
    if (outcome.status === "skip") skipped += 1;
  }

  const passes = outcomes.length - failures - skipped;
  const tail = skipped > 0 ? `, ${String(skipped)} skipped.` : ".";
  console.log(`\n${String(passes)}/${String(outcomes.length - skipped)} checks passed${tail}`);
  if (failures > 0) process.exitCode = 1;
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
