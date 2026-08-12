/**
 * Drives the Phase 25 seller-earnings surface over HTTP against a running server.
 *
 *   pnpm run db:migrate
 *   pnpm run dev            # shell 2
 *   pnpm run dev:worker     # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-25
 *
 * ## THE ONE ASSERTION THIS FILE EXISTS FOR
 *
 * `settlement_released_memo` is posted by BOTH the `external_escrow` rail and the
 * `direct_processor` rail — the latter as `settlement_funding_memo → settlement_released_memo`
 * with no custody hop. So an earnings read that groups journal lines by account kind alone
 * counts every processor payment TWICE: once as `observed.processorSettled` and again as
 * `observed.escrowReleased`. The seller's revenue silently doubles, every figure stays
 * internally consistent, and nothing throws.
 *
 * No unit test can catch it, because the double count only appears once a real settlement has
 * posted real journal lines against a real rail. `loadEscrowMovements` filters on
 * `settlementRail = 'external_escrow'` to prevent it, and the check below is what proves the
 * filter is still there.
 *
 * ## The second thing it exists for
 *
 * The `direct_offline` rail — the default — records nothing at all, and its attestation table
 * had no writer until this phase. The offline half of this script drives a quote-originated
 * order end to end (RFQ → invite → open → quote → revision → submit → accept), which is the
 * only path in this backend that produces one.
 *
 * IT NEEDS THE WORKER. `createPaymentIntent` answers 202 and the order reaches `confirmed` only
 * once `applyPaymentSettlement` has posted and committed, which rides the outbox. Without
 * `pnpm run dev:worker` the processor half fails with the outbox's own `last_error`, or with
 * nothing at all in it — the shape A41 hid behind for two phases.
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
/**
 * THE OFFLINE HALF USES THE PROVIDER ORG, NOT THE SELLER ORG, and the reason is a real
 * constraint rather than a convenience. Invitations are refused unless the invited organization
 * is an eligible provider for a service kind the RFQ actually asks for, and the demo seed's one
 * service offering — sea freight — belongs to `store_demo_org_provider`. The seller org sells
 * chairs and is eligible for nothing, so inviting it answers "One or more providers are not
 * eligible for invitation."
 *
 * Nothing is weakened by this. `commerce_order.counterparty_organization_id` is the same column
 * either way, and `getSellerEarnings` scopes on it — a freight provider reading its own takings
 * is the same read a goods seller makes.
 */
const PROVIDER_EMAIL = "store-demo-provider@example.invalid";
const PROVIDER_ORGANIZATION_ID = "store_demo_org_provider";

const DEMO_PRODUCT_ID = "store_demo_product_chair";
const DELIVERY_ADDRESS_ID = "store_demo_address_delivery";

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

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" ? value : 0;
}

/** The cents figure for one currency, or 0 when that currency is absent — see below. */
function centsFor(rows: readonly unknown[], currency: string): number {
  for (const row of rows) {
    const entry = asRecord(row);
    if (entry["currency"] === currency) return numberField(entry, "amountInCents");
  }
  return 0;
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke25-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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

async function readSellerEarnings(seller: Actor): Promise<Record<string, unknown>> {
  const result = await callApi("GET", "/commerce/provider/earnings", { actor: seller });
  if (result.status !== 200) {
    throw new Error(
      `GET /commerce/provider/earnings answered ${String(result.status)}: ${JSON.stringify(result.body).slice(0, 300)}`,
    );
  }
  return dataOf(result);
}

function observedOf(earnings: Record<string, unknown>): Record<string, unknown> {
  return asRecord(earnings["observed"]);
}

const PAID_ORDER_STATES = ["confirmed", "in_fulfillment", "partially_completed", "completed"];

async function waitForPaidOrder(orderId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await db.execute<{ state: string }>(sql`
      SELECT state::text AS state FROM commerce_order WHERE id = ${orderId}`);
    const state = row.rows[0]?.state ?? "";
    if (PAID_ORDER_STATES.includes(state)) return null;
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

// ---------------------------------------------------------------------------
// The processor rail: money observed, and the double-count trap.
// ---------------------------------------------------------------------------

interface ProcessorOrder {
  readonly orderId: string;
  readonly totalInCents: number;
  readonly currency: string;
}

async function buyDemoChair(buyer: Actor): Promise<ProcessorOrder | string> {
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
  const order = asRecord(arrayField(dataOf(confirmed), "orders")[0]);
  const orderId = order["id"];
  if (typeof orderId !== "string" || orderId === "") {
    return `checkout confirm answered ${String(confirmed.status)}`;
  }

  const paid = await callApi("POST", `/commerce/orders/${orderId}/payment-intents`, {
    actor: buyer,
    idempotencyPrefix: "pay",
    body: {},
  });
  if (paid.status !== 202) {
    return `payment intent answered ${String(paid.status)}: ${JSON.stringify(paid.body).slice(0, 200)}`;
  }

  const settlementFailure = await waitForPaidOrder(orderId);
  if (settlementFailure !== null) return settlementFailure;

  const currency = order["currency"];
  return {
    orderId,
    totalInCents: numberField(order, "totalInCents"),
    currency: typeof currency === "string" ? currency : "USD",
  };
}

// ---------------------------------------------------------------------------
// The offline rail: a quote-originated order, which is the only way to get one.
// ---------------------------------------------------------------------------

async function acceptQuoteIntoOfflineOrder(
  buyer: Actor,
  provider: Actor,
): Promise<{ readonly orderId: string; readonly currency: string } | string> {
  const responseDeadlineAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const draft = await callApi("POST", "/commerce/rfqs", {
    actor: buyer,
    idempotencyPrefix: "rfq",
    body: {
      title: "Phase 25 offline settlement smoke",
      visibility: "invited_only",
      responseDeadlineAt,
      settlementCurrency: "USD",
      productLines: [
        {
          requestedTitle: "Smoke test chairs",
          requestedSpecificationSnapshot: "Whatever the seller quotes; this order settles by wire.",
          quantity: 25,
          unitLabel: "unit",
          siblingOrder: 0,
        },
      ],
      /**
       * A SERVICE LINE IS REQUIRED, and finding that out is one of the things this script
       * learned the hard way: `POST /rfqs/:id/invitations` answers 422 with "RFQ must include
       * at least one service line before inviting providers", and `providerMayQuoteRfq` will
       * not match a provider to a product-only RFQ either. Warehousing is the cheapest
       * requirement detail to state truthfully.
       */
      serviceLines: [
        {
          providerKind: "freight_forwarder",
          requirementSummary: "Move the pallets from the port of loading to the buyer.",
          siblingOrder: 0,
          requirementDetail: {
            providerKind: "freight_forwarder",
            transportModes: ["sea"],
          },
        },
      ],
    },
  });
  const rfqId = asRecord(dataOf(draft)["rfq"])["id"] ?? dataOf(draft)["id"];
  if (typeof rfqId !== "string" || rfqId === "") {
    return `RFQ draft answered ${String(draft.status)}: ${JSON.stringify(draft.body).slice(0, 300)}`;
  }

  /**
   * OPEN BEFORE INVITE, and the order is not arbitrary: the invitation route refuses with
   * "Providers can only be invited to open RFQs." A draft has no bidders because it is not yet
   * a request — inviting into one would notify a provider about something the buyer has not
   * decided to ask.
   */
  const opened = await callApi("POST", `/commerce/rfqs/${rfqId}/open`, {
    actor: buyer,
    idempotencyPrefix: "open",
    body: {},
  });
  if (opened.status !== 200) {
    return `RFQ open answered ${String(opened.status)}: ${JSON.stringify(opened.body).slice(0, 200)}`;
  }

  const invited = await callApi("POST", `/commerce/rfqs/${rfqId}/invitations`, {
    actor: buyer,
    idempotencyPrefix: "invite",
    body: { providerOrganizationIds: [PROVIDER_ORGANIZATION_ID] },
  });
  if (invited.status !== 200 && invited.status !== 201) {
    return `RFQ invitation answered ${String(invited.status)}: ${JSON.stringify(invited.body).slice(0, 200)}`;
  }

  const rfqAsProvider = await callApi("GET", `/commerce/rfqs/${rfqId}`, { actor: provider });
  const rfqDetail = asRecord(dataOf(rfqAsProvider)["rfq"] ?? dataOf(rfqAsProvider));
  const rfqProductLineId = asRecord(arrayField(rfqDetail, "productLines")[0])["id"];
  if (typeof rfqProductLineId !== "string" || rfqProductLineId === "") {
    return `provider could not read the RFQ's product line: ${String(rfqAsProvider.status)} ${JSON.stringify(rfqAsProvider.body).slice(0, 300)}`;
  }

  const quoteShell = await callApi("POST", `/commerce/rfqs/${rfqId}/quotes`, {
    actor: provider,
    idempotencyPrefix: "quote",
    body: {},
  });
  const quoteId = asRecord(dataOf(quoteShell)["quote"])["id"] ?? dataOf(quoteShell)["id"];
  if (typeof quoteId !== "string" || quoteId === "") {
    return `quote shell answered ${String(quoteShell.status)}: ${JSON.stringify(quoteShell.body).slice(0, 300)}`;
  }

  const revision = await callApi("POST", `/commerce/quotes/${quoteId}/revisions`, {
    actor: provider,
    idempotencyPrefix: "revision",
    body: {
      currency: "USD",
      validityDeadlineAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      taxInCents: 0,
      serviceFeeInCents: 0,
      shippingInCents: 0,
      discountInCents: 0,
      productLines: [
        {
          rfqProductLineId,
          quantity: 25,
          unitPriceInCents: 4000,
          titleSnapshot: "Smoke test chairs",
          specificationSnapshot: "Quoted for the Phase 25 offline settlement smoke.",
          siblingOrder: 0,
        },
      ],
      serviceLines: [],
    },
  });
  if (revision.status !== 200 && revision.status !== 201) {
    return `quote revision answered ${String(revision.status)}: ${JSON.stringify(revision.body).slice(0, 300)}`;
  }
  const revisionNumber = numberField(
    asRecord(dataOf(revision)["revision"] ?? dataOf(revision)),
    "revisionNumber",
  );
  const revisionToSubmit = revisionNumber === 0 ? 1 : revisionNumber;

  const submitted = await callApi(
    "POST",
    `/commerce/quotes/${quoteId}/revisions/${String(revisionToSubmit)}/submit`,
    { actor: provider, idempotencyPrefix: "submit", body: {} },
  );
  if (submitted.status !== 200) {
    return `quote submit answered ${String(submitted.status)}: ${JSON.stringify(submitted.body).slice(0, 300)}`;
  }

  const accepted = await callApi("POST", `/commerce/quotes/${quoteId}/accept`, {
    actor: buyer,
    idempotencyPrefix: "accept",
    body: { expectedRevision: revisionToSubmit },
  });
  const acceptedOrderId =
    asRecord(dataOf(accepted)["order"])["id"] ?? dataOf(accepted)["id"] ?? dataOf(accepted)["orderId"];
  if (typeof acceptedOrderId !== "string" || acceptedOrderId === "") {
    return `quote accept answered ${String(accepted.status)}: ${JSON.stringify(accepted.body).slice(0, 300)}`;
  }

  const railRow = await db.execute<{ rail: string }>(sql`
    SELECT settlement_rail::text AS rail FROM commerce_order WHERE id = ${acceptedOrderId}`);
  const rail = railRow.rows[0]?.rail ?? "";
  if (rail !== "direct_offline") {
    return `accepted order settled on '${rail}', expected 'direct_offline'`;
  }

  return { orderId: acceptedOrderId, currency: "USD" };
}

async function main(): Promise<void> {
  const buyer = await signIn(BUYER_EMAIL);
  const seller = await signIn(SELLER_EMAIL);
  const provider = await signIn(PROVIDER_EMAIL);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);
  await activateOrganization(provider, PROVIDER_ORGANIZATION_ID);

  // -------------------------------------------------------------------------
  // 1. The route answers at all, in the shape the frontend parses.
  // -------------------------------------------------------------------------
  const baseline = await readSellerEarnings(seller);
  const baselineObserved = observedOf(baseline);
  record(
    "shape · earnings answers with the three tiers and no grand total",
    Array.isArray(baselineObserved["processorSettled"]) &&
      Array.isArray(baselineObserved["escrowReleased"]) &&
      Array.isArray(asRecord(baseline["selfReported"])["attestedReceived"]) &&
      !("totalInCents" in baseline),
    `keys: ${Object.keys(baseline).join(", ")}`,
  );

  const baselineSettled = centsFor(arrayField(baselineObserved, "processorSettled"), "USD");
  /**
   * CAPTURED, NOT ASSUMED ZERO. The demo seed already contains `external_escrow` orders with
   * released milestones, so this seller's `escrowReleased` is legitimately non-empty before
   * anything here runs. The double-count assertion is "a PROCESSOR payment did not move this
   * figure", which is a delta — asserting the absolute number is zero would fail against
   * perfectly correct data, and did on the first run of this script.
   */
  const baselineEscrowReleased = centsFor(arrayField(baselineObserved, "escrowReleased"), "USD");

  // -------------------------------------------------------------------------
  // 2. A processor payment lands in `processorSettled` — and NOWHERE ELSE.
  // -------------------------------------------------------------------------
  const processorOrder = await buyDemoChair(buyer);
  if (typeof processorOrder === "string") {
    skip("processor · a settled payment is reported as observed revenue", processorOrder);
    skip("DOUBLE COUNT · a processor order never appears as an escrow release", processorOrder);
    skip("attest · the processor rail refuses an attestation", processorOrder);
  } else {
    const afterPayment = await readSellerEarnings(seller);
    const afterObserved = observedOf(afterPayment);
    const settledNow = centsFor(arrayField(afterObserved, "processorSettled"), "USD");

    record(
      "processor · a settled payment is reported as observed revenue",
      settledNow === baselineSettled + processorOrder.totalInCents,
      `${String(baselineSettled)} + ${String(processorOrder.totalInCents)} expected, got ${String(settledNow)}`,
    );

    /**
     * THE CHECK THIS FILE EXISTS FOR. The order just paid settles `direct_processor`, and that
     * rail posts `settlement_released_memo` exactly as escrow does. If `loadEscrowMovements`
     * ever loses its `settlementRail = 'external_escrow'` filter, this order's total appears
     * here too and the seller's revenue doubles.
     */
    const escrowReleasedNow = centsFor(arrayField(afterObserved, "escrowReleased"), "USD");
    const escrowJournalRow = await db.execute<{ line_count: string }>(sql`
      SELECT count(*)::text AS line_count
        FROM commerce_journal_line
       WHERE order_id = ${processorOrder.orderId}
         AND account_kind = 'settlement_released_memo'`);
    const releasedMemoLines = Number(escrowJournalRow.rows[0]?.line_count ?? "0");
    record(
      "DOUBLE COUNT · a processor order never appears as an escrow release",
      escrowReleasedNow === baselineEscrowReleased && releasedMemoLines > 0,
      releasedMemoLines > 0
        ? `the order posted ${String(releasedMemoLines)} settlement_released_memo line(s) and escrowReleased held at ${String(baselineEscrowReleased)} → ${String(escrowReleasedNow)} — the rail filter is doing its job`
        : "the order posted NO released-memo line, so this run proved nothing — check planSettlementPostings",
    );

    const refusedAttestation = await callApi(
      "POST",
      `/commerce/orders/${processorOrder.orderId}/settlement-attestations`,
      {
        actor: seller,
        idempotencyPrefix: "attest-processor",
        body: { amountInCents: 100, occurredAt: new Date().toISOString() },
      },
    );
    record(
      "attest · the processor rail refuses an attestation",
      refusedAttestation.status === 409 &&
        asRecord(refusedAttestation.body["data"])["settlementRail"] === "direct_processor",
      `status ${String(refusedAttestation.status)}, data ${JSON.stringify(refusedAttestation.body["data"])}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. The offline rail: uncounted until attested, self-reported after.
  // -------------------------------------------------------------------------
  const offlineOrder = await acceptQuoteIntoOfflineOrder(buyer, provider);
  if (typeof offlineOrder === "string") {
    skip("offline · an unattested order is counted as a blind spot", offlineOrder);
    skip("offline · attesting moves it into self-reported", offlineOrder);
    skip("offline · a second attestation is a 409, not a retry", offlineOrder);
    skip("offline · the buyer's claim is not counted as the counterparty's revenue", offlineOrder);
  } else {
    const beforeAttestation = await readSellerEarnings(provider);
    const blindSpotBefore = numberField(
      asRecord(beforeAttestation["uncounted"]),
      "offlineOrdersWithNoAttestation",
    );
    const attestedBefore = centsFor(
      arrayField(asRecord(beforeAttestation["selfReported"]), "attestedReceived"),
      "USD",
    );
    record(
      "offline · an unattested order is counted as a blind spot",
      blindSpotBefore >= 1,
      `offlineOrdersWithNoAttestation = ${String(blindSpotBefore)}`,
    );

    /**
     * The buyer attests FIRST, deliberately. `payment_sent` must not move the counterparty's revenue:
     * a buyer's claim that they paid is not evidence the seller was paid.
     */
    const buyerAttested = await callApi(
      "POST",
      `/commerce/orders/${offlineOrder.orderId}/settlement-attestations`,
      {
        actor: buyer,
        idempotencyPrefix: "attest-buyer",
        body: {
          amountInCents: 100_000,
          occurredAt: new Date().toISOString(),
          referenceNote: "SWIFT ref smoke-25-buyer",
        },
      },
    );
    const afterBuyerClaim = await readSellerEarnings(provider);
    record(
      "offline · the buyer's claim is not counted as the counterparty's revenue",
      buyerAttested.status === 201 &&
        centsFor(
          arrayField(asRecord(afterBuyerClaim["selfReported"]), "attestedReceived"),
          "USD",
        ) === attestedBefore,
      `buyer attestation ${String(buyerAttested.status)}, counterparty attestedReceived unchanged at ${String(attestedBefore)}`,
    );

    const providerAttested = await callApi(
      "POST",
      `/commerce/orders/${offlineOrder.orderId}/settlement-attestations`,
      {
        actor: provider,
        idempotencyPrefix: "attest-seller",
        body: {
          amountInCents: 100_000,
          occurredAt: new Date().toISOString(),
          referenceNote: "SWIFT ref smoke-25-seller",
        },
      },
    );
    const afterAttestation = await readSellerEarnings(provider);
    const attestedAfter = centsFor(
      arrayField(asRecord(afterAttestation["selfReported"]), "attestedReceived"),
      "USD",
    );
    const blindSpotAfter = numberField(
      asRecord(afterAttestation["uncounted"]),
      "offlineOrdersWithNoAttestation",
    );
    record(
      "offline · attesting moves it into self-reported",
      providerAttested.status === 201 &&
        attestedAfter === attestedBefore + 100_000 &&
        blindSpotAfter === blindSpotBefore - 1,
      `status ${String(providerAttested.status)}, attested ${String(attestedBefore)} → ${String(attestedAfter)}, blind spot ${String(blindSpotBefore)} → ${String(blindSpotAfter)}`,
    );

    /** Both parties' claims come back on the write, which is what makes disagreement visible. */
    record(
      "offline · the write answers with both parties' attestations",
      arrayField(dataOf(providerAttested), "items").length === 2,
      `items: ${String(arrayField(dataOf(providerAttested), "items").length)}`,
    );

    const attestedTwice = await callApi(
      "POST",
      `/commerce/orders/${offlineOrder.orderId}/settlement-attestations`,
      {
        actor: provider,
        idempotencyPrefix: "attest-seller-again",
        /**
         * A VALID AMOUNT, deliberately. An over-total figure answers 422 from the amount check
         * before the uniqueness check is ever reached, so this would have proved the wrong
         * refusal — which is exactly what it did on the first run of this script. The point here
         * is that a well-formed SECOND claim is still refused.
         */
        body: { amountInCents: 100_000, occurredAt: new Date().toISOString() },
      },
    );
    record(
      "offline · a second attestation is a 409, not a retry",
      attestedTwice.status === 409 &&
        asRecord(attestedTwice.body["data"])["attestationKind"] === "payment_received",
      `status ${String(attestedTwice.status)}, data ${JSON.stringify(attestedTwice.body["data"])}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. The server-side order state filter the dispatch queue now uses.
  // -------------------------------------------------------------------------
  const filtered = await callApi("GET", "/commerce/provider/orders?state=confirmed", {
    actor: seller,
  });
  const filteredStates = new Set(
    arrayField(dataOf(filtered), "items").map((item) => asRecord(item)["state"]),
  );
  record(
    "orders · ?state= is applied in SQL rather than ignored",
    filtered.status === 200 && [...filteredStates].every((state) => state === "confirmed"),
    `status ${String(filtered.status)}, states returned: ${[...filteredStates].join(", ") || "none"}`,
  );

  const rejectedFilter = await callApi("GET", "/commerce/provider/orders?state=not_a_state", {
    actor: seller,
  });
  record(
    "orders · an unknown state is a 422 rather than an ignored key",
    rejectedFilter.status === 422,
    `status ${String(rejectedFilter.status)}`,
  );

  // -------------------------------------------------------------------------
  // 5. Nobody reads anybody else's books.
  // -------------------------------------------------------------------------
  const buyerEarnings = await callApi("GET", "/commerce/provider/earnings", { actor: buyer });
  const buyerObserved = observedOf(dataOf(buyerEarnings));
  record(
    "scope · the buyer's own earnings read never contains the seller's money",
    buyerEarnings.status === 200 &&
      centsFor(arrayField(buyerObserved, "processorSettled"), "USD") === 0,
    `buyer processorSettled: ${JSON.stringify(arrayField(buyerObserved, "processorSettled"))}`,
  );

  const withUnknownKey = await callApi(
    "GET",
    "/commerce/provider/earnings?organizationId=store_demo_org_seller",
    { actor: buyer },
  );
  record(
    "scope · an organizationId query key is refused, not honoured",
    withUnknownKey.status === 422,
    `status ${String(withUnknownKey.status)}`,
  );

  const badWindow = await callApi(
    "GET",
    "/commerce/provider/earnings?from=2026-06-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
    { actor: seller },
  );
  record(
    "window · from after to is a 422",
    badWindow.status === 422,
    `status ${String(badWindow.status)}`,
  );

  // -------------------------------------------------------------------------
  const failures = outcomes.filter((outcome) => outcome.status === "fail");
  const skipped = outcomes.filter((outcome) => outcome.status === "skip");
  for (const outcome of outcomes) {
    const mark = outcome.status === "pass" ? "PASS" : outcome.status === "fail" ? "FAIL" : "SKIP";
    console.log(`${mark}  ${outcome.label}\n      ${outcome.detail}`);
  }
  console.log(
    `\n${String(outcomes.length - failures.length - skipped.length)}/${String(outcomes.length)} passed, ${String(skipped.length)} skipped, ${String(failures.length)} failed.`,
  );

  await pool.end();
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
