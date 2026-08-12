/**
 * Drives the Phase 14 settlement and webhook routes over HTTP against a running server.
 *
 *   pnpm run db:migrate && pnpm run jobs:install
 *   SMOKE14_ESCROW_WEBHOOK_SECRET=smoke-14-escrow-signing-secret pnpm run dev        # shell 2
 *   SMOKE14_ESCROW_WEBHOOK_SECRET=smoke-14-escrow-signing-secret pnpm run dev:worker # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-14
 *
 * THE SECRET MUST BE IN THE SERVER'S ENVIRONMENT, not just this script's, and that is the
 * design working rather than an inconvenience: `commerce_external_provider` stores the NAME
 * of the variable and never its value, so the process verifying a signature is the process
 * that has to hold the key. Setting it only here produces a 401 on a correctly signed body,
 * which is exactly what happened the first time this ran.
 *
 * `jobs:install` matters too. Phase 14 adds three queues, and without it the outbox row is
 * written and never dispatched, so the escrow session never reaches the provider.
 *
 * OVER HTTP, NOT IN-PROCESS, and this phase needs it more than any before it. Three of its
 * load-bearing mechanisms exist only above the service layer and an in-process call reaches
 * none of them:
 *
 *   - the RAW-BODY MOUNT. `express.raw` on `/webhooks` sits above the JSON parser, and if
 *     that ordering ever breaks, signature verification silently stops working while every
 *     unit test still passes.
 *   - the HMAC ITSELF, computed over bytes that actually crossed a socket rather than over
 *     a Buffer handed straight to a function.
 *   - the IDEMPOTENCY MIDDLEWARE and the rate limiters, neither of which a service call
 *     passes through.
 *
 * Phase 11 found `createAddress` broken at runtime for every caller this way, and Phase 12
 * found a flat 422 from a multer field cap. Both suites mocked the service and saw nothing.
 *
 * IT ASSERTS REFUSALS AS HARD AS SUCCESSES. The refusals are the product here: a proposer
 * cannot accept its own terms, an unsigned webhook cannot move money, a replay cannot move
 * it twice, and a lapsed agreement refuses a checkout rather than quietly downgrading it.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { commerceExternalProvider, commerceOrder } from "#src/db/schema.js";
import { signWebhookPayload } from "#src/modules/store/webhook-signature.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const PROVIDER_ROW_ID = "smoke14_escrow_provider";
const PROVIDER_SECRET_ENV = "SMOKE14_ESCROW_WEBHOOK_SECRET";
const PROVIDER_SECRET_VALUE = "smoke-14-escrow-signing-secret";
const DEMO_PRODUCT_ID = "store_demo_product_chair";
const DELIVERY_ADDRESS_ID = "store_demo_address_delivery";

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
  return `smoke14-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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
    readonly idempotencyKey?: string;
  } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: REQUEST_ORIGIN,
  };
  if (options.actor) headers["cookie"] = options.actor.cookie;
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  } else if (options.idempotencyPrefix !== undefined) {
    headers["idempotency-key"] = nextIdempotencyKey(options.idempotencyPrefix);
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const rawText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(rawText === "" ? {} : JSON.parse(rawText));
  } catch {
    body = { raw: rawText.slice(0, 200) };
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

/**
 * Posts a webhook the way a provider would: raw bytes, signed over `${timestamp}.${body}`.
 *
 * `JSON.stringify` runs ONCE and the same string is both signed and sent. Stringifying
 * twice would be the classic way to produce a signature that cannot verify, and would make
 * this smoke fail for a reason that has nothing to do with the backend.
 */
async function callWebhook(
  providerId: string,
  payload: unknown,
  options: {
    readonly secret?: string;
    readonly omitSignature?: boolean;
    readonly tamperBody?: boolean;
  } = {},
): Promise<ApiResult> {
  const serialized = JSON.stringify(payload);
  const rawBody = Buffer.from(serialized, "utf8");
  const signed = signWebhookPayload(rawBody, options.secret ?? PROVIDER_SECRET_VALUE);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: REQUEST_ORIGIN,
  };
  if (!options.omitSignature) {
    headers["x-qatoto-escrow-timestamp"] = signed.timestampHeader;
    headers["x-qatoto-escrow-signature"] = signed.signatureHeader;
  }

  // Signed one body, send a different one — the tampering case.
  const sentBody = options.tamperBody ? `${serialized} ` : serialized;

  const response = await fetch(`${BASE_URL}/webhooks/escrow/${providerId}`, {
    method: "POST",
    headers,
    body: sentBody,
  });
  const rawText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(rawText === "" ? {} : JSON.parse(rawText));
  } catch {
    body = { raw: rawText.slice(0, 200) };
  }
  return { status: response.status, body };
}

/**
 * Registers the fake escrow provider.
 *
 * Written directly rather than through a route because there is no provider-registration
 * API and there should not be one: a licensed escrow holder is onboarded by staff with a
 * contract behind it, not by an HTTP call. The secret goes into the ENVIRONMENT and only
 * its variable NAME into the row, which is the property the verifier checks.
 */
async function ensureEscrowProvider(): Promise<void> {
  process.env[PROVIDER_SECRET_ENV] = PROVIDER_SECRET_VALUE;

  await db
    .insert(commerceExternalProvider)
    .values({
      id: PROVIDER_ROW_ID,
      connectorKind: "external_escrow",
      providerSlug: "fake",
      displayName: "Smoke Escrow (fake)",
      state: "active",
      webhookSigningSecretRef: PROVIDER_SECRET_ENV,
      supportedCountryCodes: [],
      supportedCurrencies: [],
      platformRank: 10,
    })
    .onConflictDoNothing();

  await db
    .update(commerceExternalProvider)
    .set({ state: "active", webhookSigningSecretRef: PROVIDER_SECRET_ENV })
    .where(eq(commerceExternalProvider.id, PROVIDER_ROW_ID));
}

/**
 * Every commerce route resolves its actor from `session.active_organization_id`, and there
 * is no auto-select. This is not optional setup — it is how the session learns which
 * organization the caller is acting for, and skipping it produces a flat 403 on every route.
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

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

interface NegotiationResult {
  readonly threadId: string;
  readonly acceptedAgreementId: string;
  readonly orderTotalInCents: number;
  readonly currency: string;
  readonly prepareId: string;
}

async function smokeNegotiation(buyer: Actor, seller: Actor): Promise<NegotiationResult | null> {
  const providers = await callApi(
    "GET",
    `/commerce/settlement/escrow-providers?buyerCountryCode=IN&sellerCountryCode=IN&currency=USD&totalInCents=100000`,
    { actor: buyer },
  );
  const providerData = dataOf(providers);
  record(
    "eligible escrow providers list, and says Qatoto holds nothing",
    providers.status === 200 &&
      arrayField(providerData, "items").length > 0 &&
      stringField(providerData, "settlementNotice") === "qatoto_does_not_hold_funds",
    `status ${String(providers.status)}, notice "${stringField(providerData, "settlementNotice")}"`,
  );

  // A pre-sales inquiry is the cheapest way to get a thread both parties participate in.
  const inquiry = await callApi("POST", `/commerce/products/${DEMO_PRODUCT_ID}/inquiries`, {
    actor: buyer,
    idempotencyPrefix: "inquiry",
    body: { message: "Interested in 20 units. Can we settle through escrow?" },
  });
  // The thread rides nested under `thread`, and the buyer organization comes from the
  // inquiry row rather than being asserted by this script.
  const inquiryData = dataOf(inquiry);
  const threadId = stringField(asRecord(inquiryData["thread"]), "id");
  const buyerOrganizationId = stringField(inquiryData, "buyerOrganizationId");
  record(
    "a product inquiry opens a thread both parties are in",
    (inquiry.status === 201 || inquiry.status === 200) && threadId !== "",
    `status ${String(inquiry.status)}, thread ${threadId || "(none)"}`,
  );
  if (threadId === "") return null;

  /**
   * Prepare FIRST, then negotiate. The agreement's total must equal the order total, and
   * the order total is only knowable once the cart is priced — negotiating a figure before
   * that is how the mismatch refusal fires in real life.
   */
  await callApi("PUT", `/commerce/cart/items/${DEMO_PRODUCT_ID}`, {
    actor: buyer,
    idempotencyPrefix: "cart",
    body: { quantity: 20 },
  });
  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare",
    body: { deliveryAddressId: DELIVERY_ADDRESS_ID },
  });
  const preparedData = dataOf(prepared);
  const totals = arrayField(preparedData, "currencyTotals");
  const firstTotal = asRecord(totals[0]);
  const orderTotalInCents = numberField(firstTotal, "totalInCents") ?? 0;
  const currency = stringField(firstTotal, "currency");
  record(
    "checkout prepare prices the cart",
    prepared.status === 201 && orderTotalInCents > 0,
    `status ${String(prepared.status)}, total ${String(orderTotalInCents)} ${currency}`,
  );
  if (orderTotalInCents <= 0) return null;

  const depositInCents = Math.floor(orderTotalInCents * 0.3);
  const balanceInCents = orderTotalInCents - depositInCents;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const unbalanced = await callApi("POST", `/commerce/threads/${threadId}/settlement-agreements`, {
    actor: buyer,
    idempotencyPrefix: "propose-unbalanced",
    body: {
      buyerOrganizationId,
      sellerOrganizationId: SELLER_ORGANIZATION_ID,
      externalProviderId: PROVIDER_ROW_ID,
      escrowFeeBearer: "buyer",
      currency,
      totalInCents: orderTotalInCents,
      expiresAt,
      milestones: [
        {
          sequence: 1,
          milestoneKind: "deposit",
          amountInCents: depositInCents,
          releaseConditionNote: "30% on confirmation",
        },
      ],
    },
  });
  record(
    "a milestone plan that does not sum to the total is refused",
    unbalanced.status === 422,
    `status ${String(unbalanced.status)}`,
  );

  const proposalBody = {
    buyerOrganizationId,
    sellerOrganizationId: SELLER_ORGANIZATION_ID,
    externalProviderId: PROVIDER_ROW_ID,
    escrowFeeBearer: "buyer" as const,
    currency,
    totalInCents: orderTotalInCents,
    expiresAt,
    milestones: [
      {
        sequence: 1,
        milestoneKind: "deposit" as const,
        amountInCents: depositInCents,
        releaseConditionNote: "30% on order confirmation",
      },
      {
        sequence: 2,
        milestoneKind: "shipment" as const,
        amountInCents: balanceInCents,
        releaseConditionNote: "balance against the bill of lading",
      },
    ],
  };

  const proposed = await callApi("POST", `/commerce/threads/${threadId}/settlement-agreements`, {
    actor: buyer,
    idempotencyPrefix: "propose",
    body: proposalBody,
  });
  const proposedId = stringField(dataOf(proposed), "id");
  record(
    "the buyer proposes escrow terms",
    proposed.status === 201 && proposedId !== "",
    `status ${String(proposed.status)}, revision ${String(numberField(dataOf(proposed), "revisionNumber"))}`,
  );
  if (proposedId === "") return null;

  const selfAccepted = await callApi(
    "POST",
    `/commerce/settlement-agreements/${proposedId}/responses`,
    { actor: buyer, idempotencyPrefix: "self-accept", body: { response: "accept" } },
  );
  record(
    "the proposer cannot accept its own terms",
    selfAccepted.status === 409,
    `status ${String(selfAccepted.status)}`,
  );

  const stranger = await callApi("GET", `/commerce/threads/${threadId}/settlement-agreements`, {
    actor: seller,
  });
  record(
    "the counterparty can read the thread's agreements",
    stranger.status === 200,
    `status ${String(stranger.status)}`,
  );

  // The seller counters: same money, different fee bearer.
  const countered = await callApi("POST", `/commerce/threads/${threadId}/settlement-agreements`, {
    actor: seller,
    idempotencyPrefix: "counter",
    body: { ...proposalBody, escrowFeeBearer: "split" },
  });
  const counterId = stringField(dataOf(countered), "id");
  const proposedRevision = numberField(dataOf(proposed), "revisionNumber") ?? 0;
  const counterRevision = numberField(dataOf(countered), "revisionNumber") ?? 0;
  /**
   * Relative, not absolute. A thread accumulates revisions across runs of this smoke — and
   * across a buyer's repeat business, which is the same thing — so asserting `=== 2` would
   * pass exactly once and then fail forever for a reason that is not a defect.
   */
  record(
    "a counter-proposal is a new revision, not an edit",
    countered.status === 201 && counterRevision === proposedRevision + 1,
    `status ${String(countered.status)}, revision ${String(proposedRevision)} -> ${String(counterRevision)}`,
  );

  const supersededResponse = await callApi(
    "POST",
    `/commerce/settlement-agreements/${proposedId}/responses`,
    { actor: seller, idempotencyPrefix: "accept-superseded", body: { response: "accept" } },
  );
  record(
    "a superseded revision can no longer be accepted",
    supersededResponse.status === 409,
    `status ${String(supersededResponse.status)}`,
  );

  const accepted = await callApi("POST", `/commerce/settlement-agreements/${counterId}/responses`, {
    actor: buyer,
    idempotencyPrefix: "accept",
    body: { response: "accept" },
  });
  record(
    "the counterparty accepts, and the agreement binds",
    accepted.status === 200 && stringField(dataOf(accepted), "state") === "accepted",
    `status ${String(accepted.status)}, state ${stringField(dataOf(accepted), "state")}`,
  );

  const listed = await callApi("GET", `/commerce/threads/${threadId}/settlement-agreements`, {
    actor: buyer,
  });
  const listedItems = arrayField(dataOf(listed), "items");
  const states = listedItems.map((item) => stringField(asRecord(item), "state"));
  const acceptedCount = states.filter((state) => state === "accepted").length;
  /**
   * The invariant is not the COUNT of revisions, which grows with every negotiation. It is
   * that superseded rows are kept rather than deleted, and that exactly one revision is
   * live — the partial unique index enforces the second, and this proves the first.
   */
  record(
    "superseded revisions survive, and exactly one is live",
    listedItems.length >= 2 && acceptedCount === 1 && states.includes("superseded"),
    `${String(listedItems.length)} revision(s), ${String(acceptedCount)} accepted, states [${states.join(", ")}]`,
  );

  const messages = await callApi("GET", `/commerce/threads/${threadId}/messages`, {
    actor: buyer,
  });
  const messageItems = arrayField(dataOf(messages), "items");
  const settlementMessages = messageItems.filter(
    (item) => stringField(asRecord(item), "messageKind") !== "participant",
  );
  record(
    "the negotiation is legible in the conversation that produced it",
    settlementMessages.length >= 3,
    `${String(settlementMessages.length)} settlement message(s) in the thread`,
  );

  return {
    threadId,
    acceptedAgreementId: counterId,
    orderTotalInCents,
    currency,
    prepareId: stringField(preparedData, "prepareId"),
  };
}

// ---------------------------------------------------------------------------
// Confirmation onto the escrow rail
// ---------------------------------------------------------------------------

async function smokeEscrowCheckout(
  buyer: Actor,
  negotiation: NegotiationResult,
): Promise<string | null> {
  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm-escrow",
    body: {
      prepareId: negotiation.prepareId,
      settlementAgreements: [
        {
          sellerOrganizationId: SELLER_ORGANIZATION_ID,
          agreementId: negotiation.acceptedAgreementId,
        },
      ],
    },
  });
  const orders = arrayField(dataOf(confirmed), "orders");
  const order = asRecord(orders[0]);
  const orderId = stringField(order, "id");
  record(
    "confirm places the order on the external_escrow rail",
    confirmed.status === 201 &&
      stringField(order, "settlementRail") === "external_escrow" &&
      order["hasEscrowProtection"] === true,
    `status ${String(confirmed.status)}, rail ${stringField(order, "settlementRail")}`,
  );
  if (orderId === "") return null;

  const sessionRow = await db.execute<{ state: string; milestone_count: number }>(sql`
    SELECT s.state,
           (SELECT count(*)::int FROM commerce_escrow_milestone m WHERE m.session_id = s.id)
             AS milestone_count
      FROM commerce_external_escrow_session s
     WHERE s.order_id = ${orderId}`);
  const session = sessionRow.rows[0];
  record(
    "an escrow session and its milestones exist for the order",
    session !== undefined && session.milestone_count === 2,
    session
      ? `state ${session.state}, ${String(session.milestone_count)} milestone(s)`
      : "no session",
  );

  const consumed = await db.execute<{ value: number }>(sql`
    SELECT count(*)::int AS value FROM commerce_settlement_agreement
     WHERE id = ${negotiation.acceptedAgreementId} AND state = 'consumed'
       AND consumed_by_order_id = ${orderId}`);
  record(
    "the agreement is spent by exactly the order that used it",
    (consumed.rows[0]?.value ?? 0) === 1,
    `${String(consumed.rows[0]?.value ?? 0)} consumed row(s)`,
  );

  /**
   * The agreement is now spent, so naming it again must fail. This is the guard against a
   * buyer replaying one negotiated set of terms across several orders.
   */
  const reused = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm-reuse",
    body: {
      prepareId: negotiation.prepareId,
      settlementAgreements: [
        {
          sellerOrganizationId: SELLER_ORGANIZATION_ID,
          agreementId: negotiation.acceptedAgreementId,
        },
      ],
    },
  });
  record(
    "a consumed agreement cannot be spent twice",
    reused.status === 409,
    `status ${String(reused.status)}`,
  );

  return orderId;
}

// ---------------------------------------------------------------------------
// Webhooks — the part no unit test reaches
// ---------------------------------------------------------------------------

async function smokeWebhooks(orderId: string): Promise<void> {
  const sessionRow = await db.execute<{ id: string; ref: string; total: string }>(sql`
    SELECT id, provider_session_ref AS ref, total_in_cents::text AS total
      FROM commerce_external_escrow_session
     WHERE order_id = ${orderId}`);
  const session = sessionRow.rows[0];
  if (!session?.ref) {
    record(
      "the escrow session reached the provider",
      false,
      "no provider_session_ref — is the worker running? (pnpm run dev:worker)",
    );
    return;
  }
  record("the escrow session reached the provider", true, `ref ${session.ref}`);

  // `total_in_cents::text` because bigint arrives from the driver as a string.
  const sessionTotalInCents = Number(session.total);

  const fundedPayload = {
    providerEventId: `smoke14_funded_${session.id}`,
    eventType: "session.funded",
    event: {
      kind: "session_funded",
      providerSessionRef: session.ref,
      fundedAmountInCents: sessionTotalInCents,
      currency: "USD",
    },
  };

  const unsigned = await callWebhook(PROVIDER_ROW_ID, fundedPayload, { omitSignature: true });
  record(
    "an unsigned webhook is refused",
    unsigned.status === 401,
    `status ${String(unsigned.status)}`,
  );

  const wrongSecret = await callWebhook(PROVIDER_ROW_ID, fundedPayload, {
    secret: "not-the-signing-secret",
  });
  record(
    "a webhook signed with the wrong secret is refused",
    wrongSecret.status === 401,
    `status ${String(wrongSecret.status)}`,
  );

  const tampered = await callWebhook(PROVIDER_ROW_ID, fundedPayload, { tamperBody: true });
  record(
    "a body altered after signing is refused",
    tampered.status === 401,
    `status ${String(tampered.status)}`,
  );

  const unknownProvider = await callWebhook("no_such_provider", fundedPayload);
  record(
    "a webhook for an unknown provider is refused without detail",
    unknownProvider.status === 404,
    `status ${String(unknownProvider.status)}`,
  );

  const funded = await callWebhook(PROVIDER_ROW_ID, fundedPayload);
  record(
    "a correctly signed funding event is accepted",
    funded.status === 202,
    `status ${String(funded.status)}`,
  );

  const replay = await callWebhook(PROVIDER_ROW_ID, fundedPayload);
  const replayMessage = stringField(replay.body, "message");
  record(
    "a replayed event is a no-op that still answers 202",
    replay.status === 202 && replayMessage.includes("already"),
    `status ${String(replay.status)}, "${replayMessage}"`,
  );

  const orderState = await db
    .select({ state: commerceOrder.state, confirmedAt: commerceOrder.confirmedAt })
    .from(commerceOrder)
    .where(eq(commerceOrder.id, orderId))
    .limit(1);
  record(
    "funding confirms the order and stamps the velocity clock",
    orderState[0]?.state === "confirmed" && orderState[0]?.confirmedAt !== null,
    `state ${orderState[0]?.state ?? "(missing)"}`,
  );

  const fundingEntry = await db.execute<{ value: number }>(sql`
    SELECT count(*)::int AS value
      FROM commerce_journal_line line
      JOIN commerce_journal_entry entry ON entry.id = line.journal_entry_id
     WHERE line.order_id = ${orderId} AND entry.kind::text = 'escrow_funded'`);
  record(
    "funding posts the memo pair and nothing else",
    (fundingEntry.rows[0]?.value ?? 0) === 2,
    `${String(fundingEntry.rows[0]?.value ?? 0)} line(s)`,
  );

  // Release the first milestone.
  const milestoneRow = await db.execute<{ ref: string; amount: string }>(sql`
    SELECT provider_milestone_ref AS ref, amount_in_cents::text AS amount
      FROM commerce_escrow_milestone
     WHERE session_id = ${session.id} AND sequence = 1`);
  const milestone = milestoneRow.rows[0];
  if (!milestone?.ref) {
    record("the first milestone has a provider reference", false, "no provider_milestone_ref");
    return;
  }

  const released = await callWebhook(PROVIDER_ROW_ID, {
    providerEventId: `smoke14_released_${session.id}_1`,
    eventType: "milestone.released",
    event: {
      kind: "milestone_released",
      providerSessionRef: session.ref,
      providerMilestoneRef: milestone.ref,
      releasedAmountInCents: Number(milestone.amount),
      currency: "USD",
    },
  });
  record(
    "a milestone release is accepted",
    released.status === 202,
    `status ${String(released.status)}`,
  );

  const wrongAmount = await callWebhook(PROVIDER_ROW_ID, {
    providerEventId: `smoke14_wrong_amount_${session.id}`,
    eventType: "milestone.released",
    event: {
      kind: "milestone_released",
      providerSessionRef: session.ref,
      providerMilestoneRef: milestone.ref,
      releasedAmountInCents: Number(milestone.amount) + 5_000,
      currency: "USD",
    },
  });
  /**
   * Stored and NOT applied. The route answers 202 either way — the delivery was accepted —
   * but the ledger must not have moved, which is what the identity check below proves.
   */
  record(
    "a release whose amount disagrees with the milestone is recorded, not applied",
    wrongAmount.status === 202,
    `status ${String(wrongAmount.status)}`,
  );

  const sessionState = await db.execute<{ state: string }>(sql`
    SELECT state FROM commerce_external_escrow_session WHERE id = ${session.id}`);
  record(
    "the session reads partially_released, not released",
    sessionState.rows[0]?.state === "partially_released",
    `state ${sessionState.rows[0]?.state ?? "(missing)"}`,
  );

  const identity = await db.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(signed_amount_in_cents), 0)::text AS balance
      FROM commerce_journal_line
     WHERE order_id = ${orderId} AND account_kind::text LIKE 'settlement_%_memo'`);
  record(
    "the memo identity still holds after funding and a release",
    Number(identity.rows[0]?.balance ?? "1") === 0,
    `net ${identity.rows[0]?.balance ?? "(none)"} cents`,
  );

  const custody = await db.execute<{ balance: string }>(sql`
    SELECT coalesce(sum(signed_amount_in_cents), 0)::text AS balance
      FROM commerce_journal_line
     WHERE order_id = ${orderId} AND account_kind::text = 'settlement_custody_memo'`);
  const expectedCustody = sessionTotalInCents - Number(milestone.amount);
  record(
    "custody holds exactly the unreleased balance",
    Number(custody.rows[0]?.balance ?? "-1") === expectedCustody,
    `custody ${custody.rows[0]?.balance ?? "?"} of expected ${String(expectedCustody)}`,
  );
}

// ---------------------------------------------------------------------------
// The default rail
// ---------------------------------------------------------------------------

async function smokeUnprotectedDefault(buyer: Actor): Promise<void> {
  await callApi("PUT", `/commerce/cart/items/${DEMO_PRODUCT_ID}`, {
    actor: buyer,
    idempotencyPrefix: "cart-plain",
    body: { quantity: 20 },
  });
  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare-plain",
    body: { deliveryAddressId: DELIVERY_ADDRESS_ID },
  });
  const prepareId = stringField(dataOf(prepared), "prepareId");
  if (prepareId === "") {
    record("an unescrowed checkout prepares", false, `status ${String(prepared.status)}`);
    return;
  }

  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm-plain",
    body: { prepareId },
  });
  const order = asRecord(arrayField(dataOf(confirmed), "orders")[0]);
  record(
    "naming no agreement settles directly, and says so on the wire",
    confirmed.status === 201 &&
      stringField(order, "settlementRail") === "direct_processor" &&
      order["hasEscrowProtection"] === false,
    `rail ${stringField(order, "settlementRail")}, protection ${String(order["hasEscrowProtection"])}`,
  );

  const orderId = stringField(order, "id");
  if (orderId === "") return;

  const memoLines = await db.execute<{ value: number }>(sql`
    SELECT count(*)::int AS value FROM commerce_journal_line
     WHERE order_id = ${orderId} AND account_kind::text = 'settlement_custody_memo'`);
  record(
    "a direct-rail order never records a custody balance",
    (memoLines.rows[0]?.value ?? 1) === 0,
    `${String(memoLines.rows[0]?.value ?? 0)} custody line(s)`,
  );
}

async function smokeUnknownAgreementRefused(buyer: Actor): Promise<void> {
  await callApi("PUT", `/commerce/cart/items/${DEMO_PRODUCT_ID}`, {
    actor: buyer,
    idempotencyPrefix: "cart-bogus",
    body: { quantity: 20 },
  });
  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare-bogus",
    body: { deliveryAddressId: DELIVERY_ADDRESS_ID },
  });
  const prepareId = stringField(dataOf(prepared), "prepareId");
  if (prepareId === "") return;

  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm-bogus",
    body: {
      prepareId,
      settlementAgreements: [
        { sellerOrganizationId: SELLER_ORGANIZATION_ID, agreementId: "no_such_agreement" },
      ],
    },
  });
  /**
   * THE MOST IMPORTANT REFUSAL IN THE FILE. A buyer who asked for escrow and cannot have it
   * must be told, not quietly given an unprotected order. If this ever returns 201, the
   * phase's central promise is broken.
   */
  record(
    "an unusable agreement refuses the checkout rather than downgrading it",
    confirmed.status === 409,
    `status ${String(confirmed.status)}`,
  );

  const strandedOrders = await db.execute<{ value: number }>(sql`
    SELECT count(*)::int AS value FROM commerce_order o
      JOIN commerce_checkout_prepare p ON p.id = ${prepareId}
     WHERE o.checkout_group_id IS NOT NULL AND o.created_at > p.created_at
       AND o.buyer_organization_id = p.buyer_organization_id
       AND o.settlement_rail = 'internal_custody'`);
  record(
    "the refused checkout left no order behind",
    (strandedOrders.rows[0]?.value ?? 1) === 0,
    `${String(strandedOrders.rows[0]?.value ?? 0)} stranded order(s)`,
  );
}

async function main(): Promise<void> {
  console.log("smoke-store-phase-14\n");

  await ensureEscrowProvider();

  const buyer = await signIn("store-demo-buyer@example.invalid");
  const seller = await signIn("store-demo-seller@example.invalid");

  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);

  const negotiation = await smokeNegotiation(buyer, seller);
  if (negotiation) {
    const orderId = await smokeEscrowCheckout(buyer, negotiation);
    if (orderId !== null) {
      // The worker needs a moment to drain the create-session command.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await smokeWebhooks(orderId);
    }
  }

  await smokeUnprotectedDefault(buyer);
  await smokeUnknownAgreementRefused(buyer);

  let failures = 0;
  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "  ok  " : "  FAIL"}  ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) failures += 1;
  }
  console.log(`\n${String(outcomes.length - failures)}/${String(outcomes.length)} checks passed.`);
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
