/**
 * Drives the Phase 15 routes over HTTP against a running server.
 *
 *   pnpm run db:migrate && pnpm run jobs:install
 *   pnpm run dev            # shell 2
 *   pnpm run dev:worker     # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:backfill-store-search-documents
 *   pnpm run db:smoke-store-phase-15
 *
 * OVER HTTP, NOT IN-PROCESS, for the reason every store smoke before it was: the
 * mechanisms this phase leans on live ABOVE the service layer and an in-process call
 * reaches none of them.
 *
 *   - `.strict()` query parsing. Six of A25's seven new filters are `z.coerce`, and a
 *     coercion that only ever sees a number from a test never proves it parses "1000".
 *   - The MULTIPART middleware on A30's upload, including the file-size cap and the
 *     magic-byte check — Phase 12 found a flat 422 from a multer field cap this way.
 *   - The RESPONSE HEADERS on A30's download. `Content-Disposition` and
 *     `Cache-Control: no-store` are the whole privacy contract of that route and no
 *     service call has headers at all.
 *   - Route ORDERING. `/commerce/provider/shipments` sits beside
 *     `/commerce/shipments/:shipmentId`, and only a real request proves which one wins.
 *
 * IT ASSERTS REFUSALS AS HARD AS SUCCESSES, and for this phase the refusals are most of
 * the product: a stranger cannot read a dispute, an unknown filter key is a 422 rather
 * than a silently-ignored field, and a `pending_scan` document cannot be downloaded by
 * anybody — including the organization that uploaded it.
 *
 * WHAT IT DOES NOT DO: it never asserts that a list is non-empty when the demo seed has
 * no such rows. A check that passes only because it asked for nothing is worse than no
 * check, so those report SKIP with the reason and do not count as passes.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";
const BUYER_EMAIL = "store-demo-buyer@example.invalid";
const SELLER_EMAIL = "store-demo-seller@example.invalid";
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
  return `smoke15-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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

/** Multipart by hand, because the point is to exercise the real multer middleware. */
async function uploadFile(
  actor: Actor,
  path: string,
  file: { readonly bytes: Buffer; readonly fileName: string; readonly mediaType: string },
): Promise<ApiResult> {
  const form = new FormData();
  form.append(
    "evidence",
    new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
    file.fileName,
  );

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { origin: REQUEST_ORIGIN, cookie: actor.cookie },
    body: form,
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

/** A real PNG, so the decoded-byte check has something honest to accept. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

// ---------------------------------------------------------------------------
// A23 — a required customization option is now readable before it is enforced.
// ---------------------------------------------------------------------------

async function smokeCustomizationRead(): Promise<void> {
  const productRow = await db.execute<{ public_slug: string; slot_key: string }>(sql`
    SELECT p.public_slug, option.slot_key
      FROM commerce_product_customization_option AS option
      JOIN product AS p ON p.id = option.product_id
     WHERE option.state = 'active' AND p.public_slug IS NOT NULL
     LIMIT 1`);
  const seeded = productRow.rows[0];
  if (!seeded) {
    skip(
      "A23 · customization options reach the public product detail",
      "no product carries an active customization option in this database",
    );
    return;
  }

  const detail = await callApi("GET", `/store/products/${seeded.public_slug}`);
  const options = arrayField(dataOf(detail), "customizationOptions");
  const slotKeys = options.map((option) => stringField(asRecord(option), "slotKey"));

  record(
    "A23 · customization options reach the public product detail",
    detail.status === 200 && slotKeys.includes(seeded.slot_key),
    `status=${String(detail.status)} slots=${JSON.stringify(slotKeys)}`,
  );

  // The buyer wire carries no `state`: the read is active-only, so the column would be a
  // constant, and a retired slot is not a thing a buyer can choose.
  const leaksState = options.some((option) => "state" in asRecord(option));
  record(
    "A23 · the public option projection does not leak `state`",
    !leaksState,
    leaksState ? "a `state` field reached the buyer wire" : "absent",
  );
}

// ---------------------------------------------------------------------------
// A24 — answer votes, and viewer state on a public read.
// ---------------------------------------------------------------------------

async function smokeAnswerVotes(buyer: Actor): Promise<void> {
  const answerRow = await db.execute<{
    answer_id: string;
    question_id: string;
    public_slug: string;
  }>(sql`
    SELECT answer.id AS answer_id, question.id AS question_id, p.public_slug
      FROM commerce_product_answer AS answer
      JOIN commerce_product_question AS question ON question.id = answer.question_id
      JOIN product AS p ON p.id = question.product_id
     WHERE answer.visibility_state = 'visible' AND p.public_slug IS NOT NULL
     LIMIT 1`);
  const seeded = answerRow.rows[0];
  if (!seeded) {
    skip("A24 · answer helpful votes", "no visible product answer in this database");
    skip("A24 · viewer vote state on the public answer read", "same");
    return;
  }

  const voted = await callApi("PUT", `/commerce/answers/${seeded.answer_id}/helpful`, {
    actor: buyer,
  });
  const votedCount = dataOf(voted)["helpfulCount"];
  record(
    "A24 · a vote is recorded and returns the new count",
    voted.status === 200 && typeof votedCount === "number",
    `status=${String(voted.status)} helpfulCount=${String(votedCount)}`,
  );

  // Idempotent by verb: voting twice is one vote, so the count must not move.
  const repeated = await callApi("PUT", `/commerce/answers/${seeded.answer_id}/helpful`, {
    actor: buyer,
  });
  record(
    "A24 · a repeated vote does not inflate the count",
    repeated.status === 200 && dataOf(repeated)["helpfulCount"] === votedCount,
    `status=${String(repeated.status)} helpfulCount=${String(dataOf(repeated)["helpfulCount"])}`,
  );

  const answersPath = `/store/products/${seeded.public_slug}/questions/${seeded.question_id}/answers`;

  const signedInRead = await callApi("GET", answersPath, { actor: buyer });
  const signedInAnswer = asRecord(
    arrayField(dataOf(signedInRead), "items").find(
      (item) => stringField(asRecord(item), "id") === seeded.answer_id,
    ),
  );
  const signedInViewer = asRecord(signedInAnswer["viewer"]);
  record(
    "A24 · the signed-in read carries the caller's own vote",
    signedInRead.status === 200 && signedInViewer["hasVotedHelpful"] === true,
    `viewer=${JSON.stringify(signedInAnswer["viewer"])}`,
  );

  // `null`, never a defaulted `false` — "you have not voted" and "we do not know who you
  // are" are different facts, and A11 settled that they must look different.
  const anonymousRead = await callApi("GET", answersPath);
  const anonymousAnswer = asRecord(
    arrayField(dataOf(anonymousRead), "items").find(
      (item) => stringField(asRecord(item), "id") === seeded.answer_id,
    ),
  );
  record(
    "A24 · the anonymous read reports a null viewer, not a defaulted false",
    anonymousRead.status === 200 && anonymousAnswer["viewer"] === null,
    `viewer=${JSON.stringify(anonymousAnswer["viewer"])} helpfulCount=${String(anonymousAnswer["helpfulCount"])}`,
  );

  const cleared = await callApi("DELETE", `/commerce/answers/${seeded.answer_id}/helpful`, {
    actor: buyer,
  });
  record(
    "A24 · a vote can be withdrawn",
    cleared.status === 200 && dataOf(cleared)["isHelpful"] === false,
    `status=${String(cleared.status)} helpfulCount=${String(dataOf(cleared)["helpfulCount"])}`,
  );
}

// ---------------------------------------------------------------------------
// A25 — the supplier directory, the filters, and the ancestor trail.
// ---------------------------------------------------------------------------

async function smokeSearchDepth(): Promise<void> {
  const organizations = await callApi("GET", "/store/search?documentKind=organization&limit=5");
  const organizationItems = arrayField(dataOf(organizations), "items");
  record(
    "A25 · organizations are searchable",
    organizations.status === 200 && organizationItems.length > 0,
    `status=${String(organizations.status)} results=${String(organizationItems.length)}`,
  );

  const kindsReturned = new Set(
    organizationItems.map((item) => stringField(asRecord(item), "documentKind")),
  );
  record(
    "A25 · the documentKind filter returns only organizations",
    organizationItems.length === 0 ||
      (kindsReturned.size === 1 && kindsReturned.has("organization")),
    `kinds=${JSON.stringify([...kindsReturned])}`,
  );

  // Every value here arrives as a STRING on the query string; `z.coerce` is what makes
  // them numbers, and only a real request proves that.
  const filtered = await callApi(
    "GET",
    "/store/search?documentKind=product&stockState=in_stock&samplePolicy=unavailable" +
      "&condition=new&priceMinInCents=1&priceMaxInCents=100000000&leadTimeMaxDays=3650&limit=5",
  );
  const filteredItems = arrayField(dataOf(filtered), "items");
  const allMatch = filteredItems.every((item) => {
    const hit = asRecord(item);
    return hit["stockState"] === "in_stock" && hit["condition"] === "new";
  });
  record(
    "A25 · every facet filter parses and narrows",
    filtered.status === 200 && allMatch,
    `status=${String(filtered.status)} results=${String(filteredItems.length)} allMatch=${String(allMatch)}`,
  );

  // A NULL facet is EXCLUDED. An organization has no stock state, so a stock filter must
  // not sweep the supplier directory into a product result set.
  const stockFilteredKinds = new Set(
    arrayField(
      dataOf(await callApi("GET", "/store/search?stockState=in_stock&limit=20")),
      "items",
    ).map((item) => stringField(asRecord(item), "documentKind")),
  );
  record(
    "A25 · a stock filter excludes documents that have no stock state",
    !stockFilteredKinds.has("organization") && !stockFilteredKinds.has("provider_offering"),
    `kinds=${JSON.stringify([...stockFilteredKinds])}`,
  );

  const unknownKey = await callApi("GET", "/store/search?stockStatus=in_stock");
  record(
    "A25 · an unknown filter key is a 422, not a silently ignored field",
    unknownKey.status === 422,
    `status=${String(unknownKey.status)}`,
  );

  const badEnum = await callApi("GET", "/store/search?stockState=backordered");
  record(
    "A25 · a stock state outside deriveStockState's four is refused",
    badEnum.status === 422,
    `status=${String(badEnum.status)}`,
  );

  const nestedCategory = await db.execute<{ slug: string }>(sql`
    SELECT slug FROM commerce_category
     WHERE state = 'active' AND parent_category_id IS NOT NULL LIMIT 1`);
  const nested = nestedCategory.rows[0];
  if (!nested) {
    skip("A25 · the category read carries its ancestor trail", "no nested active category seeded");
    return;
  }

  const category = await callApi("GET", `/store/categories/${nested.slug}`);
  const ancestors = arrayField(dataOf(category), "ancestors");
  const trailIncludesSelf = ancestors.some(
    (entry) => stringField(asRecord(entry), "slug") === nested.slug,
  );
  record(
    "A25 · the category read carries its ancestor trail",
    category.status === 200 && ancestors.length > 0 && !trailIncludesSelf,
    `status=${String(category.status)} ancestors=${JSON.stringify(ancestors.map((entry) => stringField(asRecord(entry), "slug")))}`,
  );
}

// ---------------------------------------------------------------------------
// A27 — per-tier lead time reaches the buyer's ladder.
// ---------------------------------------------------------------------------

async function smokeTierLeadTime(): Promise<void> {
  const tierRow = await db.execute<{ public_slug: string }>(sql`
    SELECT p.public_slug
      FROM product_pricing_tier AS tier
      JOIN product AS p ON p.id = tier.product_id
     WHERE p.public_slug IS NOT NULL AND tier.variant_id IS NULL
     LIMIT 1`);
  const seeded = tierRow.rows[0];
  if (!seeded) {
    skip("A27 · the tier ladder carries leadTimeDays", "no product pricing tier seeded");
    return;
  }

  const detail = await callApi("GET", `/store/products/${seeded.public_slug}`);
  const tiers = arrayField(dataOf(detail), "pricingTiers");
  const everyTierDeclaresTheField = tiers.every((tier) => "leadTimeDays" in asRecord(tier));
  record(
    "A27 · the tier ladder carries leadTimeDays",
    detail.status === 200 && tiers.length > 0 && everyTierDeclaresTheField,
    `status=${String(detail.status)} tiers=${String(tiers.length)} allCarryField=${String(everyTierDeclaresTheField)}`,
  );
}

// ---------------------------------------------------------------------------
// A28 — a participant reads their dispute; a stranger gets 404, not 403.
// ---------------------------------------------------------------------------

async function smokeDisputeReads(buyer: Actor, seller: Actor): Promise<void> {
  const list = await callApi("GET", "/commerce/disputes", { actor: buyer });
  record(
    "A28 · the participant dispute list answers",
    list.status === 200 && Array.isArray(dataOf(list)["items"]),
    `status=${String(list.status)} items=${String(arrayField(dataOf(list), "items").length)}`,
  );

  const unknownKey = await callApi("GET", "/commerce/disputes?stat=open", { actor: buyer });
  record(
    "A28 · an unknown query key on the dispute list is a 422",
    unknownKey.status === 422,
    `status=${String(unknownKey.status)}`,
  );

  /*
   * The refusal is the product. A dispute id names two organizations and a commercial
   * disagreement, so an id the caller is not party to must be indistinguishable from one
   * that does not exist — 404 both times, never 403.
   */
  const invented = await callApi("GET", "/commerce/disputes/00000000-0000-0000-0000-000000000000", {
    actor: buyer,
  });
  record(
    "A28 · an unknown dispute id is 404",
    invented.status === 404,
    `status=${String(invented.status)}`,
  );

  const disputeRow = await db.execute<{ id: string; buyer_organization_id: string }>(sql`
    SELECT id, buyer_organization_id FROM commerce_dispute LIMIT 1`);
  const dispute = disputeRow.rows[0];
  if (!dispute) {
    skip("A28 · a party reads their own dispute", "no dispute seeded in this database");
    return;
  }

  const asBuyer = await callApi("GET", `/commerce/disputes/${dispute.id}`, { actor: buyer });
  const asSeller = await callApi("GET", `/commerce/disputes/${dispute.id}`, { actor: seller });
  const eitherPartyReads = asBuyer.status === 200 || asSeller.status === 200;
  record(
    "A28 · a party reads their own dispute, with its timeline",
    eitherPartyReads &&
      Array.isArray(dataOf(asBuyer.status === 200 ? asBuyer : asSeller)["timeline"]),
    `buyer=${String(asBuyer.status)} seller=${String(asSeller.status)}`,
  );
}

// ---------------------------------------------------------------------------
// A29 — the cross-order logistics queue.
// ---------------------------------------------------------------------------

async function smokeShipmentQueue(seller: Actor): Promise<void> {
  const queue = await callApi("GET", "/commerce/provider/shipments", { actor: seller });
  record(
    "A29 · the provider shipment queue answers",
    queue.status === 200 && Array.isArray(dataOf(queue)["items"]),
    `status=${String(queue.status)} items=${String(arrayField(dataOf(queue), "items").length)}`,
  );

  /*
   * The literal segment must beat `/shipments/:shipmentId`. If the parameter route won,
   * this would be a detail lookup for a shipment whose id is the string "provider" — a
   * 404 dressed as an empty queue, which is precisely the bug a route test cannot see.
   */
  record(
    "A29 · /provider/shipments is not swallowed by the shipment-detail route",
    queue.status === 200 && "page" in dataOf(queue),
    `body keys=${JSON.stringify(Object.keys(dataOf(queue)))}`,
  );

  const filtered = await callApi(
    "GET",
    "/commerce/provider/shipments?state=in_transit" +
      "&estimatedArrivalFrom=2026-01-01T00:00:00.000Z" +
      "&estimatedArrivalTo=2027-01-01T00:00:00.000Z&limit=10",
    { actor: seller },
  );
  record(
    "A29 · the state and ETA-window filters parse",
    filtered.status === 200,
    `status=${String(filtered.status)}`,
  );

  const badState = await callApi("GET", "/commerce/provider/shipments?state=lost", {
    actor: seller,
  });
  record(
    "A29 · a shipment state outside the four is refused",
    badState.status === 422,
    `status=${String(badState.status)}`,
  );

  const unknownKey = await callApi("GET", "/commerce/provider/shipments?carrier=dhl", {
    actor: seller,
  });
  record(
    "A29 · an unknown query key on the queue is a 422",
    unknownKey.status === 422,
    `status=${String(unknownKey.status)}`,
  );
}

// ---------------------------------------------------------------------------
// A30 — the upload and the door that opens it.
// ---------------------------------------------------------------------------

async function smokeTradeDocuments(buyer: Actor, seller: Actor): Promise<void> {
  const uploaded = await uploadFile(buyer, "/commerce/documents", {
    bytes: PNG_BYTES,
    fileName: "drawing rev-B.png",
    mediaType: "image/png",
  });
  const documentId = stringField(dataOf(uploaded), "encryptedDocumentId");

  /*
   * 202, not 201. The row lands `pending_scan`, and both `assertOwnedDocuments` and the
   * message path refuse anything that is not `available` — 201 would invite a client to
   * attach it immediately and collect a confusing rejection.
   */
  record(
    "A30 · an upload is accepted with 202 and lands pending_scan",
    uploaded.status === 202 &&
      documentId !== "" &&
      dataOf(uploaded)["state"] === "pending_scan",
    `status=${String(uploaded.status)} state=${String(dataOf(uploaded)["state"])}`,
  );

  // The magic-byte check is not multer's job: `fileFilter` sees only the client's claim.
  const mislabelled = await uploadFile(buyer, "/commerce/documents", {
    bytes: Buffer.from("this is definitely not a png"),
    fileName: "drawing.png",
    mediaType: "image/png",
  });
  record(
    "A30 · bytes that contradict the declared type are refused",
    mislabelled.status === 422,
    `status=${String(mislabelled.status)}`,
  );

  if (documentId === "") {
    skip("A30 · a pending_scan document cannot be downloaded", "upload did not return an id");
    return;
  }

  const beforeScan = await callApi("GET", `/commerce/documents/${documentId}`, { actor: buyer });
  record(
    "A30 · a pending_scan document is 404 even for its owner",
    beforeScan.status === 404,
    `status=${String(beforeScan.status)}`,
  );

  // Wait for the worker to drain the scan job and promote the row.
  let promoted = false;
  for (let attempt = 0; attempt < 12 && !promoted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const state = await db.execute<{ state: string }>(sql`
      SELECT state FROM commerce_encrypted_document WHERE id = ${documentId}`);
    promoted = state.rows[0]?.state === "available";
  }

  if (!promoted) {
    skip(
      "A30 · the owner downloads the bytes back",
      "the document never reached `available` — is `pnpm run dev:worker` running?",
    );
  } else {
    const downloaded = await callApi("GET", `/commerce/documents/${documentId}`, { actor: buyer });
    record(
      "A30 · the owner downloads the exact bytes back",
      downloaded.status === 200 && downloaded.rawBytes.equals(PNG_BYTES),
      `status=${String(downloaded.status)} bytes=${String(downloaded.rawBytes.length)} exact=${String(downloaded.rawBytes.equals(PNG_BYTES))}`,
    );

    // The privacy contract of the route, and it exists only in headers.
    const disposition = downloaded.headers.get("content-disposition") ?? "";
    const cacheControl = downloaded.headers.get("cache-control") ?? "";
    record(
      "A30 · the download is an uncacheable attachment",
      disposition.startsWith("attachment;") && cacheControl.includes("no-store"),
      `disposition=${disposition} cache-control=${cacheControl}`,
    );

    // The seller is party to nothing that names this document, so it does not exist to them.
    const stranger = await callApi("GET", `/commerce/documents/${documentId}`, { actor: seller });
    record(
      "A30 · an organization with no link to the document gets 404",
      stranger.status === 404,
      `status=${String(stranger.status)}`,
    );
  }

  // The RFQ field that could not be filled before this phase.
  /*
   * The point of the whole appendix entry: `documentIds` was a field that existed and
   * could not be filled, because any id a client invented came back `DOCUMENT_NOT_OWNED`.
   * This is the first request in the history of this backend that can populate it.
   */
  const rfqBody = {
    title: "Phase 15 smoke — attachment round trip",
    description: "Confirms documentIds can be filled at all.",
    visibility: "invited_only",
    responseDeadlineAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    settlementCurrency: "USD",
    documentIds: [documentId],
  };

  const rfq = await callApi("POST", "/commerce/rfqs", {
    actor: buyer,
    idempotencyPrefix: "rfq-attachment",
    body: rfqBody,
  });
  record(
    "A30 · an RFQ accepts a document id that a route actually minted",
    promoted ? rfq.status === 201 : rfq.status === 422,
    promoted
      ? `status=${String(rfq.status)} (available document accepted)`
      : `status=${String(rfq.status)} (unscanned document correctly refused)`,
  );

  /*
   * The `state = 'available'` check this phase added to `assertOwnedDocuments`. A second
   * document, left unscanned, must be refused — the RFQ is broadcast to every invited
   * provider, and shipping them a file nothing has checked is the path that must not exist.
   */
  const unscanned = await uploadFile(buyer, "/commerce/documents", {
    bytes: PNG_BYTES,
    fileName: "unscanned.png",
    mediaType: "image/png",
  });
  const unscannedId = stringField(dataOf(unscanned), "encryptedDocumentId");
  if (unscannedId === "") {
    skip("A30 · an RFQ refuses a document that has not been scanned", "second upload failed");
    return;
  }
  const refused = await callApi("POST", "/commerce/rfqs", {
    actor: buyer,
    idempotencyPrefix: "rfq-unscanned",
    body: { ...rfqBody, documentIds: [unscannedId] },
  });
  record(
    "A30 · an RFQ refuses a document that has not been scanned",
    refused.status === 422 || refused.status === 409,
    `status=${String(refused.status)}`,
  );
}

async function main(): Promise<void> {
  console.log("smoke-store-phase-15\n");

  const buyer = await signIn(BUYER_EMAIL);
  const seller = await signIn(SELLER_EMAIL);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);

  await smokeCustomizationRead();
  await smokeAnswerVotes(buyer);
  await smokeSearchDepth();
  await smokeTierLeadTime();
  await smokeDisputeReads(buyer, seller);
  await smokeShipmentQueue(seller);
  await smokeTradeDocuments(buyer, seller);

  let failures = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    const mark =
      outcome.status === "pass" ? "  ok  " : outcome.status === "skip" ? "  skip" : "  FAIL";
    console.log(`${mark}  ${outcome.label} — ${outcome.detail}`);
    if (outcome.status === "fail") failures += 1;
    if (outcome.status === "skip") skipped += 1;
  }

  const passed = outcomes.length - failures - skipped;
  console.log(
    `\n${String(passed)}/${String(outcomes.length - skipped)} checks passed` +
      (skipped > 0 ? `, ${String(skipped)} skipped for want of seeded data.` : "."),
  );
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
