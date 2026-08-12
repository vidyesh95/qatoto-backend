/**
 * Drives the Phase 23 fixes over HTTP against a running server.
 *
 *   pnpm run db:migrate && pnpm run jobs:install
 *   pnpm run dev            # shell 2
 *   pnpm run dev:worker     # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-23
 *
 * THE ONE ASSERTION THIS FILE EXISTS FOR is the media-slot check. Phase 23 redefined
 * `commerce_review.media_count` to count VISIBLE media, and the six-item cap and the next
 * position were still reading it as a count of ATTACHED rows — so the first attach after a video
 * died landed on an occupied slot and `commerce_review_media_position_uidx` answered with a 500.
 * Every review-media suite in this repo mocks `#src/db/index.js`, so the unique index — the thing
 * that actually refuses — is not present in any of them. Only a real database can fail this.
 *
 * IT WRITES ONE ROW DIRECTLY, AND ONLY ONE. Hiding a media row is `revalidate-youtube-embeds`'
 * job and the job decides by asking YouTube, which a smoke cannot make answer "this video is
 * gone". The UPDATE below therefore stands in for the job, and it does exactly what
 * `setReviewMediaState` does — the state and the counter together — because a stand-in that
 * moved only one of them would set up a state the job cannot produce and prove nothing.
 *
 * THE DISPUTE AND INCOTERM CHECKS ARE ORDINARY BOUNDARY CHECKS, over HTTP because both are about
 * a guard chain: who may write a note (and what a non-party is told), and which values the parse
 * layer lets past before any service sees them.
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

const DEMO_PRODUCT_ID = "store_demo_product_chair";
const DELIVERY_ADDRESS_ID = "store_demo_address_delivery";

/** Eleven characters, the shape `commerce_review_media_youtube_ck` demands. Never resolved here. */
const FIRST_VIDEO_URL = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const SECOND_VIDEO_URL = "https://www.youtube.com/watch?v=bbbbbbbbbbb";

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

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke23-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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

  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(text === "" ? {} : JSON.parse(text));
  } catch {
    body = {};
  }
  return { status: response.status, body };
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

/** Every commerce route resolves its actor from `session.active_organization_id`. */
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
// A40 — the media slot a hidden row still occupies.
// ---------------------------------------------------------------------------

const MEDIA_LABEL = "A40 · a slot held by a hidden video is not handed to the next attach";

const SHIPPABLE_ORDER_STATES = ["confirmed", "in_fulfillment", "partially_completed"];

/**
 * Waits for the payment to settle, reporting WHY if it does not.
 *
 * `createPaymentIntent` answers `202` and leaves the order in `payment_processing`: the provider
 * call rides the outbox, and the order reaches `confirmed` only once `applyPaymentSettlement` has
 * posted and committed. Needs `pnpm run dev:worker`; nothing here executes the job.
 *
 * The outbox's `last_error` is read on the way out because that column is where a settlement
 * failure lands — silently, since a non-terminal outbox failure is not an error to the job that
 * ran it. A41 was invisible for two phases for exactly that reason.
 */
async function waitForShippableOrder(orderId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await db.execute<{ state: string }>(sql`
      SELECT state::text AS state FROM commerce_order WHERE id = ${orderId}`);
    const state = row.rows[0]?.state ?? "";
    if (SHIPPABLE_ORDER_STATES.includes(state)) return null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const failure = await db.execute<{ last_error: string | null }>(sql`
    SELECT last_error FROM commerce_payment_outbox
     WHERE order_id = ${orderId} ORDER BY created_at DESC LIMIT 1`);
  const lastError = failure.rows[0]?.last_error;
  return lastError
    ? `order ${orderId} could not be paid: ${lastError}`
    : `order ${orderId} never left payment_processing — is \`pnpm run dev:worker\` running?`;
}

/**
 * Buys the demo chair and has the seller deliver it, so a completion exists to review.
 *
 * A completion is minted by `issueCompletionsForOrder` when a shipment is marked delivered, and
 * NOTHING ELSE in this repo mints one — the seed does not, and `smoke-store-phase-14` stops at
 * confirmation. So the real path is the only path: cart → prepare → confirm → pay → ship →
 * deliver, six calls and no shortcut.
 *
 * IT COULD NOT REACH THE END UNTIL A41. An order becomes shippable only once a payment settles,
 * and settlement posted two accounts no live rail permits, so it failed in the outbox every time.
 * This function is the end-to-end proof that it does not any more: nothing else in the suite
 * exercises checkout, payment, fulfilment and review in one line.
 */
async function mintReviewableCompletion(buyer: Actor, seller: Actor): Promise<string | null> {
  /*
   * The demo chair's lowest pricing tier starts at 10, so this is the smallest checkout the
   * catalog will accept — and the smallest bite out of a fixture every other smoke shares.
   */
  await callApi("PUT", `/commerce/cart/items/${DEMO_PRODUCT_ID}`, {
    actor: buyer,
    idempotencyPrefix: "cart",
    body: { quantity: 10 },
  });
  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare",
    body: { deliveryAddressId: DELIVERY_ADDRESS_ID },
  });
  const prepareId = dataOf(prepared)["prepareId"];
  if (typeof prepareId !== "string" || prepareId === "") {
    return `checkout prepare answered ${String(prepared.status)} — run \`pnpm run db:seed-store-demo\` first`;
  }

  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm",
    body: { prepareId, settlementAgreements: [] },
  });
  const orderId = asRecord(arrayField(dataOf(confirmed), "orders")[0])["id"];
  if (typeof orderId !== "string" || orderId === "") {
    return `checkout confirm answered ${String(confirmed.status)}`;
  }

  const paid = await callApi("POST", `/commerce/orders/${orderId}/payment-intents`, {
    actor: buyer,
    idempotencyPrefix: "pay",
    body: {},
  });
  if (paid.status !== 202) {
    return `payment intent answered ${String(paid.status)}: ${JSON.stringify(paid.body["message"])}`;
  }

  const unsettled = await waitForShippableOrder(orderId);
  if (unsettled !== null) return unsettled;

  const lineRows = await db.execute<{ id: string; quantity: number }>(sql`
    SELECT id, (quantity_ordered - quantity_fulfilled - quantity_cancelled)::int AS quantity
      FROM commerce_order_product_line
     WHERE order_id = ${orderId}
       AND quantity_ordered > quantity_fulfilled + quantity_cancelled`);
  if (lineRows.rows.length === 0) return `order ${orderId} has no unfulfilled product line`;

  const shipment = await callApi("POST", `/commerce/orders/${orderId}/shipments`, {
    actor: seller,
    idempotencyPrefix: "shipment",
    body: {
      lines: lineRows.rows.map((line) => ({
        orderProductLineId: line.id,
        quantity: line.quantity,
      })),
      packageCount: 1,
    },
  });
  const shipmentId = dataOf(shipment)["id"];
  if (typeof shipmentId !== "string" || shipmentId === "") {
    return `shipment creation answered ${String(shipment.status)}: ${JSON.stringify(shipment.body["message"])}`;
  }

  const delivered = await callApi("POST", `/commerce/shipments/${shipmentId}/events`, {
    actor: seller,
    idempotencyPrefix: "delivered",
    body: { eventKind: "delivered" },
  });
  if (delivered.status !== 201 && delivered.status !== 200) {
    return `delivery event answered ${String(delivered.status)}: ${JSON.stringify(delivered.body["message"])}`;
  }
  return null;
}

/**
 * A review this buyer authored with room for two more media rows.
 *
 * Prefers an existing one, then a reviewable completion, and only then tries to buy one into
 * existence — cheapest path first, so a rerun does no work it does not need to. When all three
 * fail it answers WHY, because "skipped" without a cause is how a check quietly stops running.
 */
async function findOrCreateBuyerReview(
  buyer: Actor,
  seller: Actor,
): Promise<{ readonly reviewId: string | null; readonly reason?: string }> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT review.id
      FROM commerce_review AS review
     WHERE review.reviewer_organization_id = ${BUYER_ORGANIZATION_ID}
       AND review.visibility = 'visible'
       AND (SELECT count(*) FROM commerce_review_media AS media
             WHERE media.review_id = review.id) <= 4
     ORDER BY review.created_at DESC
     LIMIT 1`);
  const found = existing.rows[0]?.id;
  if (found !== undefined) return { reviewId: found };

  const reviewed = await reviewFirstAvailableCompletion(buyer);
  if (reviewed !== null) return { reviewId: reviewed };

  const blocked = await mintReviewableCompletion(buyer, seller);
  if (blocked !== null) return { reviewId: null, reason: blocked };

  const minted = await reviewFirstAvailableCompletion(buyer);
  return minted === null
    ? { reviewId: null, reason: "the delivered order produced no reviewable completion" }
    : { reviewId: minted };
}

async function reviewFirstAvailableCompletion(buyer: Actor): Promise<string | null> {
  const completions = await callApi("GET", "/commerce/completions?reviewable=true&limit=10", {
    actor: buyer,
  });
  if (completions.status !== 200) return null;

  for (const entry of arrayField(dataOf(completions), "items")) {
    const completion = asRecord(entry);
    const completionId = completion["completionId"];
    if (typeof completionId !== "string") continue;

    const created = await callApi("POST", `/commerce/completions/${completionId}/reviews`, {
      actor: buyer,
      body: { rating: 5, body: "Phase 23 smoke — media slots after an upstream hide." },
      idempotencyPrefix: "review",
    });
    const reviewId = dataOf(created)["id"];
    if (created.status === 201 && typeof reviewId === "string") return reviewId;
  }

  return null;
}

async function readReviewMediaCount(reviewId: string): Promise<number> {
  const row = await db.execute<{ value: number }>(sql`
    SELECT media_count::int AS value FROM commerce_review WHERE id = ${reviewId}`);
  return row.rows[0]?.value ?? -1;
}

async function smokeReviewMediaSlots(buyer: Actor, seller: Actor): Promise<void> {
  const located = await findOrCreateBuyerReview(buyer, seller);
  const reviewId = located.reviewId;
  if (reviewId === null) {
    skip(MEDIA_LABEL, located.reason ?? "no review this buyer could decorate");
    return;
  }

  const first = await callApi("POST", `/commerce/reviews/${reviewId}/videos`, {
    actor: buyer,
    body: { youtubeUrl: FIRST_VIDEO_URL },
    idempotencyPrefix: "video-one",
  });
  const firstMediaId = dataOf(first)["id"];
  if (first.status !== 201 || typeof firstMediaId !== "string") {
    record(MEDIA_LABEL, false, `the first attach did not succeed: status=${String(first.status)}`);
    return;
  }

  const countBeforeHide = await readReviewMediaCount(reviewId);

  /*
   * THE ONE DIRECT WRITE IN THIS FILE, and it stands in for `revalidate-youtube-embeds`, which
   * decides by asking YouTube whether the video still resolves — something a smoke cannot arrange.
   * It moves the state and the counter TOGETHER, exactly as `setReviewMediaState` does in one
   * transaction; moving only the state would build a row the job can never produce.
   */
  await db.execute(sql`
    WITH hidden AS (
      UPDATE commerce_review_media
         SET state = 'unavailable_upstream', unavailable_at = now()
       WHERE id = ${firstMediaId} AND state = 'visible'
      RETURNING review_id
    )
    UPDATE commerce_review
       SET media_count = GREATEST(media_count - 1, 0)
     WHERE id IN (SELECT review_id FROM hidden)`);

  const countAfterHide = await readReviewMediaCount(reviewId);
  record(
    "A40 · hiding a dead video decrements the visible counter",
    countAfterHide === countBeforeHide - 1,
    `media_count ${String(countBeforeHide)} → ${String(countAfterHide)}`,
  );

  const second = await callApi("POST", `/commerce/reviews/${reviewId}/videos`, {
    actor: buyer,
    body: { youtubeUrl: SECOND_VIDEO_URL },
    idempotencyPrefix: "video-two",
  });
  const secondMedia = dataOf(second);
  const secondMediaId = secondMedia["id"];
  const firstPosition = Number(dataOf(first)["position"]);
  record(
    MEDIA_LABEL,
    second.status === 201 && Number(secondMedia["position"]) === firstPosition + 1,
    `status=${String(second.status)} position=${String(secondMedia["position"])} (hidden row holds ${String(firstPosition)})`,
  );

  /*
   * The mirror bug. The hide already decremented, so a detach of the hidden row must not
   * decrement again — that is how the counter falls below the media the review still shows, and
   * `verify-store-phase-10-constraints` reports it as drift on a review nobody mis-edited.
   */
  const countBeforeDetach = await readReviewMediaCount(reviewId);
  const detachedHidden = await callApi(
    "DELETE",
    `/commerce/reviews/${reviewId}/media/${firstMediaId}`,
    { actor: buyer, idempotencyPrefix: "detach-hidden" },
  );
  const countAfterDetach = await readReviewMediaCount(reviewId);
  record(
    "A40 · detaching an already-hidden row does not decrement a second time",
    detachedHidden.status === 200 && countAfterDetach === countBeforeDetach,
    `status=${String(detachedHidden.status)} media_count ${String(countBeforeDetach)} → ${String(countAfterDetach)}`,
  );

  if (typeof secondMediaId === "string") {
    await callApi("DELETE", `/commerce/reviews/${reviewId}/media/${secondMediaId}`, {
      actor: buyer,
      idempotencyPrefix: "detach-visible",
    });
  }

  const countAtEnd = await readReviewMediaCount(reviewId);
  record(
    "A40 · the counter agrees with the visible rows once the smoke has cleaned up",
    countAtEnd ===
      (
        await db.execute<{ value: number }>(sql`
          SELECT count(*)::int AS value FROM commerce_review_media
           WHERE review_id = ${reviewId} AND state = 'visible'`)
      ).rows[0]?.value,
    `media_count=${String(countAtEnd)}`,
  );
}

// ---------------------------------------------------------------------------
// A40 — a party can speak in its own dispute.
// ---------------------------------------------------------------------------

async function smokeDisputeNotes(buyer: Actor, seller: Actor): Promise<void> {
  const disputeRows = await db.execute<{ id: string; state: string }>(sql`
    SELECT id, state::text AS state FROM commerce_dispute ORDER BY created_at DESC LIMIT 20`);

  const openDispute = disputeRows.rows.find((dispute) => dispute.state === "open");
  const decidedDispute = disputeRows.rows.find((dispute) => dispute.state !== "open");

  if (!openDispute) {
    skip("A40 · a party adds a note to its own open dispute", "no OPEN dispute in this database");
  } else {
    const note = `Phase 23 smoke note ${String(idempotencyCounter)}.`;
    const asBuyer = await callApi("POST", `/commerce/disputes/${openDispute.id}/notes`, {
      actor: buyer,
      body: { note },
      idempotencyPrefix: "note-buyer",
    });
    const asSeller = await callApi("POST", `/commerce/disputes/${openDispute.id}/notes`, {
      actor: seller,
      body: { note: `${note} (counterparty)` },
      idempotencyPrefix: "note-seller",
    });

    /*
     * EITHER party, not a named one: which demo organization is the buyer of whichever dispute
     * this database happens to hold is not this check's business. What is, is that a party can
     * write and a non-party cannot.
     */
    const partyWrote = asBuyer.status === 201 ? asBuyer : asSeller;
    const timeline = arrayField(dataOf(partyWrote), "timeline");
    record(
      "A40 · a party adds a note to its own open dispute",
      partyWrote.status === 201 &&
        timeline.some((entry) => {
          const entryNote = asRecord(entry)["note"];
          return typeof entryNote === "string" && entryNote.startsWith(note);
        }),
      `buyer=${String(asBuyer.status)} seller=${String(asSeller.status)} timeline=${String(timeline.length)}`,
    );

    const bothParties = asBuyer.status === 201 && asSeller.status === 201;
    record(
      "A40 · BOTH parties may speak, not only the one who opened it",
      bothParties,
      `buyer=${String(asBuyer.status)} seller=${String(asSeller.status)}`,
    );

    const refreshed = await callApi(`GET`, `/commerce/disputes/${openDispute.id}`, {
      actor: asBuyer.status === 201 ? buyer : seller,
    });
    record(
      "A40 · the write's answer and a refresh agree",
      refreshed.status === 200 &&
        arrayField(dataOf(refreshed), "timeline").length === timeline.length,
      `refresh=${String(arrayField(dataOf(refreshed), "timeline").length)} write=${String(timeline.length)}`,
    );
  }

  const invented = await callApi("POST", "/commerce/disputes/dsp_not_a_real_dispute/notes", {
    actor: buyer,
    body: { note: "A non-party must not be able to tell this id apart from any other." },
    idempotencyPrefix: "note-unknown",
  });
  record(
    "A40 · a dispute the caller is no party to is 404, never 403",
    invented.status === 404,
    `status=${String(invented.status)}`,
  );

  if (!decidedDispute) {
    skip("A40 · a note on a decided dispute is refused", "no closed or dismissed dispute here");
  } else {
    const late = await callApi("POST", `/commerce/disputes/${decidedDispute.id}/notes`, {
      actor: buyer,
      body: { note: "There is nothing left to argue about." },
      idempotencyPrefix: "note-late",
    });
    record(
      "A40 · a note on a decided dispute is refused",
      late.status === 409 || late.status === 404,
      `status=${String(late.status)} (409 for a party, 404 for a non-party)`,
    );
  }
}

// ---------------------------------------------------------------------------
// A40 — BANANA is no longer an Incoterm.
// ---------------------------------------------------------------------------

/**
 * Both calls name a quote that does not exist, ON PURPOSE. The body is parsed before the service
 * is reached, so the vocabulary answers first: a term outside Incoterms 2020 is `422` and never
 * reaches a revision, while a real term parses and fails later on the id — which is the only
 * distinction this check is making.
 */
function quoteRevisionBody(incoterm: string): Record<string, unknown> {
  return {
    currency: "USD",
    validityDeadlineAt: "2027-01-01T00:00:00.000Z",
    taxInCents: 0,
    serviceFeeInCents: 0,
    shippingInCents: 0,
    discountInCents: 0,
    incoterm,
    productLines: [],
    serviceLines: [],
  };
}

async function smokeIncotermVocabulary(seller: Actor): Promise<void> {
  const banana = await callApi("POST", "/commerce/quotes/qte_not_a_real_quote/revisions", {
    actor: seller,
    body: quoteRevisionBody("BANANA"),
    idempotencyPrefix: "incoterm-banana",
  });

  if (banana.status === 403) {
    skip(
      "A40 · BANANA is refused as an Incoterm",
      "the demo seller organization is not a provider — the quote routes refuse it before the body is parsed",
    );
    return;
  }

  /** One 422 shape across this API: `errors` is the flat field map, with `.strict()`'s
   * object-level refusals folded in under the reserved key `form`. */
  const refusedFields = asRecord(banana.body["errors"]);
  record(
    "A40 · BANANA is refused as an Incoterm",
    banana.status === 422 && "incoterm" in refusedFields,
    `status=${String(banana.status)} fields=${JSON.stringify(Object.keys(refusedFields))}`,
  );

  const fob = await callApi("POST", "/commerce/quotes/qte_not_a_real_quote/revisions", {
    actor: seller,
    body: quoteRevisionBody("FOB"),
    idempotencyPrefix: "incoterm-fob",
  });
  /*
   * FOB IS ALSO REFUSED, and that is not a failure of this check. The body carries no lines, so
   * the service refuses the revision itself once the parse layer has let it through — with a
   * `422` that carries a message and NO field map. What separates the two calls is which layer
   * answered: BANANA never reached the service, and `incoterm` is named in its field map.
   */
  const fobFields = asRecord(fob.body["errors"]);
  record(
    "A40 · FOB gets past the vocabulary, and is refused for something else",
    !("incoterm" in fobFields),
    `status=${String(fob.status)} message=${JSON.stringify(fob.body["message"])}`,
  );
}

async function main(): Promise<void> {
  console.log("smoke-store-phase-23\n");

  const buyer = await signIn(BUYER_EMAIL);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  const seller = await signIn(SELLER_EMAIL);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);

  await smokeReviewMediaSlots(buyer, seller);
  await smokeDisputeNotes(buyer, seller);
  await smokeIncotermVocabulary(seller);

  console.log("");
  for (const outcome of outcomes) {
    const marker =
      outcome.status === "pass" ? "  ok  " : outcome.status === "skip" ? "  skip" : "  FAIL";
    console.log(`${marker}  ${outcome.label} — ${outcome.detail}`);
  }

  const failures = outcomes.filter((outcome) => outcome.status === "fail").length;
  const passes = outcomes.filter((outcome) => outcome.status === "pass").length;
  const skipped = outcomes.filter((outcome) => outcome.status === "skip").length;
  console.log(
    `\n${String(passes)} passed, ${String(failures)} failed, ${String(skipped)} skipped.`,
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
