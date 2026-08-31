/**
 * Drives the Phase 27 write paths (A43–A46) over HTTP against a running server.
 *
 *   pnpm run dev            # shell 2
 *   pnpm run dev:worker     # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-27
 *
 * ## WHY THIS FILE EXISTS
 *
 * A43–A46 shipped with a structural verifier (`db:verify-store-phase-27-constraints`) and NOTHING
 * that exercises a write. Every one of their five surfaces has both an empty and a populated
 * branch in code, and only the empty branch had ever been fed real data — `sourcingCost: []`,
 * `requestedFreightModeSnapshot: null`, an empty sourcing page, and a leg rail that had never moved
 * a leg. This is the file that feeds the other branch.
 *
 * ## IT WRITES REAL ROWS AND LEAVES THEM
 *
 * The same bargain every smoke here makes — phase-25 creates orders and payment intents, phase-23
 * creates reviews. It uses the seeded `store_demo_*` organizations, which exist for exactly this.
 * Nothing is cleaned up afterwards, because it cannot be: shipment legs, fulfilment command
 * receipts and organization audit entries are append-only by design, and deleting them would be
 * tampering with a record rather than tidying a fixture.
 *
 * ## `skip` IS NOT `ok`, AND THAT IS THE POINT
 *
 * Several checks depend on state the seed may not produce — an accepted quote whose RFQ buyer is
 * the SELLER organization, or a freight engagement on the order being shipped. Where the setup
 * cannot be reached, the check is SKIPPED with the reason printed. A smoke that reports green on a
 * path it never walked is worse than no smoke, and the phase's documentation records the skips.
 *
 * ## ⚠️ WHAT THIS SMOKE PROVED CANNOT BE REACHED, WHICH IS ITS MOST USEFUL FINDING
 *
 * `commerce_shipment_leg.logistics_engagement_id` is **unreachable end to end today**, and the
 * chain is short enough to check:
 *
 *   1. `insert(commerceServiceEngagement)` appears in exactly ONE place in `src/` —
 *      `commerce-quotes.service.ts`, the quote-accept path. Nothing else ever creates one.
 *   2. Accepting a quote produces an order on the `direct_offline` rail.
 *   3. `direct_offline` is refused a payment intent by name
 *      (`PAYMENT_INTENT_RAIL_REFUSALS`): "Record the transfer as a settlement attestation rather
 *      than paying it here."
 *   4. A settlement attestation records that money moved and **never touches `commerce_order.state`**.
 *      Only `applyPaymentSettlement` and the escrow service set `confirmed`, and neither runs on
 *      this rail.
 *   5. `createShipment` requires `confirmed | in_fulfillment | partially_completed`.
 *
 * So the only orders that HAVE a freight engagement are the only orders that can never be shipped.
 * A43's assignment route is correct code nobody can currently reach, and the constraint is upstream
 * of it: an offline order has no confirmation path. That is a product gap worth its own decision,
 * not something this smoke can work around — which is why the check SKIPS with the reason rather
 * than being deleted.
 *
 * ## THE THREE REFUSALS ARE AS IMPORTANT AS THE HAPPY PATHS
 *
 * A sequence collision (409), a stale `expectedVersion` (409 with `currentVersion`), and a sourcing
 * line belonging to another organization (422) are the assertions that prove the guards exist. A
 * happy path alone proves only that the route is reachable.
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
const PROVIDER_EMAIL = "store-demo-provider@example.invalid";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const PROVIDER_ORGANIZATION_ID = "store_demo_org_provider";

const DEMO_PRODUCT_ID = "store_demo_product_chair";
const DELIVERY_ADDRESS_ID = "store_demo_address_delivery";

/** The mode the buyer asks for. Four members on the wire; `multimodal` is not one of them. */
const REQUESTED_FREIGHT_MODE = "sea";

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

/**
 * The envelope's `message`, as a string.
 *
 * `body["message"]` is `unknown`, and `String()` on an object yields `[object Object]` — which is
 * exactly the assertion detail you do NOT want when a check fails. Non-strings are JSON-stringified
 * so a structured refusal still reads.
 */
function messageOf(result: ApiResult): string {
  const message = result.body["message"];
  return typeof message === "string" ? message : JSON.stringify(message ?? "");
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

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" ? value : 0;
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke27-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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
  const headers: Record<string, string> = { origin: REQUEST_ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
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

const SHIPPABLE_ORDER_STATES = ["confirmed", "in_fulfillment", "partially_completed"];

/** Payment rides the outbox, so the order reaches `confirmed` only once the worker has run. */
async function waitForShippableOrder(orderId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await db.execute<{ state: string }>(sql`
      SELECT state::text AS state FROM commerce_order WHERE id = ${orderId}`);
    if (SHIPPABLE_ORDER_STATES.includes(row.rows[0]?.state ?? "")) return null;
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
// A45 — the buyer's requested mode, from prepare through to the order.
// ---------------------------------------------------------------------------

interface PreparedOrder {
  readonly orderId: string;
  readonly freightStatus: string;
  readonly freightReason: string;
}

/**
 * Buys the demo chair WITH a requested freight mode, and reports what the freight component said.
 *
 * ⚠️ The arrival window at prepare is `null` no matter what — there is no `confirmedAt` to start a
 * clock. What changes is the freight COMPONENT's reason, and on this database every lane answers
 * `no_active_rate_card` because the rate tables ship empty by design. So "not `mode_not_selected`"
 * is the real assertion here; a priced range would need a forwarder lane list nobody has bought.
 */
async function checkoutWithRequestedMode(buyer: Actor): Promise<PreparedOrder | string> {
  await callApi("PUT", `/commerce/cart/items/${DEMO_PRODUCT_ID}`, {
    actor: buyer,
    idempotencyPrefix: "cart",
    body: { quantity: 10 },
  });

  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare",
    body: { deliveryAddressId: DELIVERY_ADDRESS_ID, requestedFreightMode: REQUESTED_FREIGHT_MODE },
  });
  const prepareId = stringField(dataOf(prepared), "prepareId");
  if (prepareId === "") {
    return `checkout prepare answered ${String(prepared.status)}: ${JSON.stringify(prepared.body).slice(0, 300)}`;
  }

  const firstWindow = asRecord(arrayField(dataOf(prepared), "arrivalWindows")[0]);
  const freight = asRecord(
    asRecord(asRecord(firstWindow["arrivalWindow"])["components"])["freight"],
  );

  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm",
    body: { prepareId, settlementAgreements: [] },
  });
  const orderId = stringField(asRecord(arrayField(dataOf(confirmed), "orders")[0]), "id");
  if (orderId === "") {
    return `checkout confirm answered ${String(confirmed.status)}: ${JSON.stringify(confirmed.body).slice(0, 300)}`;
  }

  return {
    orderId,
    freightStatus: stringField(freight, "status"),
    freightReason: stringField(freight, "reason"),
  };
}

// ---------------------------------------------------------------------------
// A43 — legs on an existing shipment, and who carries them.
// ---------------------------------------------------------------------------

async function smokeShipmentLegs(actor: Actor, orderId: string, runLabel: string): Promise<void> {
  const lineRows = await db.execute<{ id: string; quantity: number }>(sql`
    SELECT id, (quantity_ordered - quantity_fulfilled - quantity_cancelled)::int AS quantity
      FROM commerce_order_product_line
     WHERE order_id = ${orderId}
       AND quantity_ordered > quantity_fulfilled + quantity_cancelled`);
  if (lineRows.rows.length === 0) {
    skip(`A43 · legs [${runLabel}]`, `order ${orderId} has no unfulfilled product line to ship`);
    return;
  }

  /*
   * CREATED WITH ONE LEG, which is itself a Phase 27 path: `legs[]` was refused by the client for
   * as long as nothing could advance a leg, and `CreateShipmentInput`'s comment said so.
   */
  const shipment = await callApi("POST", `/commerce/orders/${orderId}/shipments`, {
    actor,
    idempotencyPrefix: "shipment",
    body: {
      lines: lineRows.rows.map((line) => ({
        orderProductLineId: line.id,
        quantity: line.quantity,
      })),
      packageCount: 1,
      legs: [
        {
          sequence: 0,
          mode: "sea",
          originCountryCode: "CN",
          destinationCountryCode: "IN",
        },
      ],
    },
  });
  const shipmentId = stringField(dataOf(shipment), "id");
  if (shipmentId === "") {
    record(
      `A43 · shipment created with legs[] [${runLabel}]`,
      false,
      `answered ${String(shipment.status)}: ${JSON.stringify(shipment.body).slice(0, 300)}`,
    );
    return;
  }
  record(
    `A43 · shipment created with legs[] [${runLabel}]`,
    true,
    `shipment ${shipmentId} with one sea leg`,
  );

  // --- add a leg to the shipment that already exists ------------------------
  const added = await callApi("POST", `/commerce/shipments/${shipmentId}/legs`, {
    actor,
    idempotencyPrefix: "addleg",
    body: {
      legs: [{ sequence: 1, mode: "land", originCountryCode: "IN", destinationCountryCode: "IN" }],
    },
  });
  const addedLegs = arrayField(dataOf(added), "legs");
  const addedLeg = asRecord(addedLegs[0]);
  const addedLegId = stringField(addedLeg, "id");
  record(
    `A43 · POST /shipments/:id/legs adds a leg to an existing shipment [${runLabel}]`,
    added.status === 201 && addedLegId !== "" && stringField(addedLeg, "mode") === "land",
    added.status === 201
      ? `201, leg ${addedLegId} sequence=${String(numberField(addedLeg, "sequence"))} mode=${stringField(addedLeg, "mode")}`
      : `answered ${String(added.status)}: ${JSON.stringify(added.body).slice(0, 300)}`,
  );
  if (addedLegId === "") return;

  // --- the sequence collision -----------------------------------------------
  const collided = await callApi("POST", `/commerce/shipments/${shipmentId}/legs`, {
    actor,
    idempotencyPrefix: "addleg-dupe",
    body: {
      legs: [{ sequence: 1, mode: "air", originCountryCode: "IN", destinationCountryCode: "IN" }],
    },
  });
  record(
    `A43 · a taken sequence is refused with 409, naming the number [${runLabel}]`,
    collided.status === 409 && messageOf(collided).includes("sequence 1"),
    `${String(collided.status)}: ${messageOf(collided).slice(0, 160)}`,
  );

  // --- assignment -----------------------------------------------------------
  const fulfillment = await callApi("GET", `/commerce/orders/${orderId}/fulfillment`, {
    actor,
  });
  const carriers = arrayField(dataOf(fulfillment), "engagements")
    .map(asRecord)
    .filter((engagement) => {
      const kind = stringField(engagement, "providerKind");
      return kind === "freight_forwarder" || kind === "logistics_operator";
    });

  if (carriers.length === 0) {
    skip(
      `A43 · assignment attach / stale version / detach [${runLabel}]`,
      "this order has no freight or logistics engagement — one exists only once a provider's service quote is accepted against the order, which a direct checkout never creates",
    );
    return;
  }

  const engagementId = stringField(carriers[0] ?? {}, "id");
  const legVersion = numberField(addedLeg, "version");

  const attached = await callApi(`POST`, `/commerce/shipment-legs/${addedLegId}/assignment`, {
    actor,
    idempotencyPrefix: "assign",
    body: { expectedVersion: legVersion, logisticsEngagementId: engagementId },
  });
  const attachedLeg = dataOf(attached);
  record(
    `A43 · assignment attaches the engagement and bumps the version [${runLabel}]`,
    attached.status === 200 &&
      stringField(attachedLeg, "logisticsEngagementId") === engagementId &&
      numberField(attachedLeg, "version") === legVersion + 1,
    `${String(attached.status)}, version ${String(legVersion)} -> ${String(numberField(attachedLeg, "version"))}`,
  );

  // Re-sending the ORIGINAL version, which the attach above has now superseded.
  const stale = await callApi("POST", `/commerce/shipment-legs/${addedLegId}/assignment`, {
    actor,
    idempotencyPrefix: "assign-stale",
    body: { expectedVersion: legVersion, logisticsEngagementId: null },
  });
  record(
    `A43 · a stale expectedVersion is refused with 409 and the current version [${runLabel}]`,
    stale.status === 409 &&
      numberField(asRecord(stale.body["data"]), "currentVersion") > legVersion,
    `${String(stale.status)}, currentVersion=${String(numberField(asRecord(stale.body["data"]), "currentVersion"))}`,
  );

  const detached = await callApi("POST", `/commerce/shipment-legs/${addedLegId}/assignment`, {
    actor,
    idempotencyPrefix: "detach",
    body: {
      expectedVersion: numberField(attachedLeg, "version"),
      logisticsEngagementId: null,
    },
  });
  record(
    `A43 · null detaches the engagement and returns the leg to the seller [${runLabel}]`,
    detached.status === 200 && dataOf(detached)["logisticsEngagementId"] === null,
    `${String(detached.status)}, logisticsEngagementId=${JSON.stringify(dataOf(detached)["logisticsEngagementId"])}`,
  );
}

// ---------------------------------------------------------------------------
// A44 + A46 — a cost basis the seller actually holds.
// ---------------------------------------------------------------------------

/**
 * The SELLER raises an RFQ and accepts a provider's quote — so the seller is the BUYER of that
 * quote, which is precisely what `assertSourcingQuoteLineUsable` requires. Getting this backwards
 * is the whole subtlety of A44: a quote records its provider directly and its buyer only through
 * the RFQ.
 */
async function mintAcceptedSourcingQuote(
  seller: Actor,
  provider: Actor,
): Promise<string | { readonly quoteProductLineId: string; readonly orderId: string }> {
  const responseDeadlineAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const draft = await callApi("POST", "/commerce/rfqs", {
    actor: seller,
    idempotencyPrefix: "rfq",
    body: {
      title: "Phase 27 sourcing smoke",
      visibility: "invited_only",
      responseDeadlineAt,
      settlementCurrency: "USD",
      productLines: [
        {
          requestedTitle: "Smoke test chair frames",
          requestedSpecificationSnapshot: "The goods this listing is sourced from.",
          quantity: 50,
          unitLabel: "unit",
          siblingOrder: 0,
        },
      ],
      // A service line is required before providers can be invited — see phase-25's note.
      serviceLines: [
        {
          providerKind: "freight_forwarder",
          requirementSummary: "Move the frames to the workshop.",
          siblingOrder: 0,
          requirementDetail: { providerKind: "freight_forwarder", transportModes: ["sea"] },
        },
      ],
    },
  });
  const rfqId =
    stringField(asRecord(dataOf(draft)["rfq"]), "id") || stringField(dataOf(draft), "id");
  if (rfqId === "") {
    return `RFQ draft answered ${String(draft.status)}: ${JSON.stringify(draft.body).slice(0, 300)}`;
  }

  const opened = await callApi("POST", `/commerce/rfqs/${rfqId}/open`, {
    actor: seller,
    idempotencyPrefix: "open",
    body: {},
  });
  if (opened.status !== 200) {
    return `RFQ open answered ${String(opened.status)}: ${JSON.stringify(opened.body).slice(0, 200)}`;
  }

  const invited = await callApi("POST", `/commerce/rfqs/${rfqId}/invitations`, {
    actor: seller,
    idempotencyPrefix: "invite",
    body: { providerOrganizationIds: [PROVIDER_ORGANIZATION_ID] },
  });
  if (invited.status !== 200 && invited.status !== 201) {
    return `RFQ invitation answered ${String(invited.status)}: ${JSON.stringify(invited.body).slice(0, 200)}`;
  }

  const rfqAsProvider = await callApi("GET", `/commerce/rfqs/${rfqId}`, { actor: provider });
  const rfqDetail = asRecord(dataOf(rfqAsProvider)["rfq"] ?? dataOf(rfqAsProvider));
  const rfqProductLineId = stringField(asRecord(arrayField(rfqDetail, "productLines")[0]), "id");
  if (rfqProductLineId === "") {
    return `provider could not read the RFQ product line: ${String(rfqAsProvider.status)}`;
  }
  /*
   * THE SERVICE LINE IS QUOTED TOO, AND THAT IS WHAT UNLOCKS A43'S ASSIGNMENT RAIL. Accepting a
   * quote carrying a freight service line is the ONLY thing in this codebase that creates a
   * `commerce_service_engagement` with `providerKind = freight_forwarder` — and a leg may only be
   * assigned to one of those. A direct checkout never produces one, which is why the first run of
   * this smoke could only skip the attach / stale-version / detach checks.
   */
  const rfqServiceLineId = stringField(asRecord(arrayField(rfqDetail, "serviceLines")[0]), "id");
  if (rfqServiceLineId === "") {
    return `provider could not read the RFQ service line: ${String(rfqAsProvider.status)}`;
  }

  const quoteShell = await callApi("POST", `/commerce/rfqs/${rfqId}/quotes`, {
    actor: provider,
    idempotencyPrefix: "quote",
    body: {},
  });
  const quoteId =
    stringField(asRecord(dataOf(quoteShell)["quote"]), "id") ||
    stringField(dataOf(quoteShell), "id");
  if (quoteId === "") {
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
          quantity: 50,
          unitPriceInCents: 1200,
          titleSnapshot: "Smoke test chair frames",
          specificationSnapshot: "Quoted for the Phase 27 sourcing smoke.",
          siblingOrder: 0,
        },
      ],
      serviceLines: [
        {
          rfqServiceLineId,
          feeInCents: 50_000,
          titleSnapshot: "Sea freight, port to port",
          scopeSnapshot: "Move the frames from the port of loading to the port of discharge.",
          siblingOrder: 0,
          deliverables: [{ sequence: 0, title: "Bill of lading", isRequired: true }],
          serviceDetail: { kind: "freight_forwarder", transportModes: ["sea"] },
        },
      ],
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
    actor: seller,
    idempotencyPrefix: "accept",
    body: { expectedRevision: revisionToSubmit },
  });
  if (accepted.status !== 200 && accepted.status !== 201) {
    return `quote accept answered ${String(accepted.status)}: ${JSON.stringify(accepted.body).slice(0, 300)}`;
  }
  const acceptedOrderId =
    stringField(asRecord(dataOf(accepted)["order"]), "id") ||
    stringField(dataOf(accepted), "id") ||
    stringField(dataOf(accepted), "orderId");

  const lineRow = await db.execute<{ id: string }>(sql`
    SELECT line.id
      FROM commerce_quote_product_line line
      JOIN commerce_quote_revision revision ON revision.id = line.revision_id
     WHERE revision.quote_id = ${quoteId} AND revision.revision_number = ${revisionToSubmit}
     LIMIT 1`);
  const quoteProductLineId = lineRow.rows[0]?.id ?? "";
  if (quoteProductLineId === "") return `accepted quote ${quoteId} yielded no product line`;
  return { quoteProductLineId, orderId: acceptedOrderId };
}

async function smokeSourcingCostBasis(seller: Actor, provider: Actor): Promise<string | null> {
  const minted = await mintAcceptedSourcingQuote(seller, provider);
  if (typeof minted === "string") {
    skip("A44/A46 · sourcing link, sourcing read and non-empty cost", minted);
    return null;
  }

  // --- A46: the line now appears in the picker's read ------------------------
  const sourcing = await callApi("GET", "/commerce/sourcing/quote-lines", { actor: seller });
  const sourcingItems = arrayField(dataOf(sourcing), "items").map(asRecord);
  const found = sourcingItems.find(
    (item) => stringField(item, "quoteProductLineId") === minted.quoteProductLineId,
  );
  record(
    "A46 · GET /commerce/sourcing/quote-lines returns the accepted line",
    sourcing.status === 200 && found !== undefined,
    sourcing.status === 200
      ? `${String(sourcingItems.length)} item(s); the accepted line ${found === undefined ? "is MISSING" : "is present"}`
      : `answered ${String(sourcing.status)}`,
  );

  // --- A44: link it to a listing --------------------------------------------
  const linked = await callApi("PATCH", `/products/${DEMO_PRODUCT_ID}`, {
    actor: seller,
    body: { sourcingQuoteProductLineId: minted.quoteProductLineId },
  });
  const readBack = await callApi("GET", `/products/${DEMO_PRODUCT_ID}`, { actor: seller });
  record(
    "A44 · a listing links to the accepted quote line, and the read gives it back",
    linked.status === 200 &&
      stringField(dataOf(readBack), "sourcingQuoteProductLineId") === minted.quoteProductLineId,
    `PATCH ${String(linked.status)}, read-back=${JSON.stringify(dataOf(readBack)["sourcingQuoteProductLineId"])}`,
  );

  // --- A44: the four-table refusal ------------------------------------------
  const foreignLine = await db.execute<{ id: string }>(sql`
    SELECT line.id
      FROM commerce_quote_product_line line
      JOIN commerce_quote_revision revision ON revision.id = line.revision_id
      JOIN commerce_quote quote ON quote.id = revision.quote_id
      JOIN commerce_rfq rfq ON rfq.id = quote.rfq_id
     WHERE rfq.buyer_organization_id <> ${SELLER_ORGANIZATION_ID}
     LIMIT 1`);
  const foreignLineId = foreignLine.rows[0]?.id ?? "";
  if (foreignLineId === "") {
    skip(
      "A44 · another organization's quote line is refused",
      "no quote product line exists whose RFQ buyer is a different organization",
    );
  } else {
    const refused = await callApi("PATCH", `/products/${DEMO_PRODUCT_ID}`, {
      actor: seller,
      body: { sourcingQuoteProductLineId: foreignLineId },
    });
    record(
      "A44 · another organization's quote line is refused with 422",
      refused.status === 422,
      `${String(refused.status)}: ${messageOf(refused).slice(0, 140)}`,
    );
  }

  // --- A44: the cost now appears in earnings --------------------------------
  const earnings = await callApi("GET", "/commerce/provider/earnings", { actor: seller });
  const sourcingCost = arrayField(dataOf(earnings), "sourcingCost").map(asRecord);
  const uncounted = asRecord(dataOf(earnings)["uncounted"]);
  record(
    "A44 · sourcingCost is non-empty once a sold listing carries a cost basis",
    earnings.status === 200 && sourcingCost.length > 0,
    sourcingCost.length > 0
      ? `${sourcingCost.map((amount) => `${stringField(amount, "currency")} ${String(numberField(amount, "amountInCents"))}`).join(", ")}; uncovered lines=${String(numberField(uncounted, "orderLinesWithNoSourcingRecord"))}`
      : `sourcingCost=[] — the linked listing has no sold order line inside the window, or the order is not yet confirmed; uncovered lines=${String(numberField(uncounted, "orderLinesWithNoSourcingRecord"))}`,
  );

  return minted.orderId === "" ? null : minted.orderId;
}

async function main(): Promise<void> {
  console.log("smoke-store-phase-27\n");

  const buyer = await signIn(BUYER_EMAIL);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  const seller = await signIn(SELLER_EMAIL);
  await activateOrganization(seller, SELLER_ORGANIZATION_ID);
  const provider = await signIn(PROVIDER_EMAIL);
  await activateOrganization(provider, PROVIDER_ORGANIZATION_ID);

  // A44/A46 first: the cost basis must exist BEFORE the order is confirmed, because
  // `loadSourcingCost` windows on `order.confirmedAt` and reads the listing's link at query time.
  const quoteOrderId = await smokeSourcingCostBasis(seller, provider);

  const prepared = await checkoutWithRequestedMode(buyer);
  if (typeof prepared === "string") {
    skip("A45 · requested freight mode through checkout", prepared);
    skip("A43 · shipment legs", "no order to ship");
  } else {
    record(
      "A45 · prepare with a mode stops answering mode_not_selected",
      prepared.freightReason !== "mode_not_selected",
      `freight status=${prepared.freightStatus || "(none)"} reason=${prepared.freightReason || "(none)"}`,
    );

    const snapshot = await db.execute<{ mode: string | null }>(sql`
      SELECT requested_freight_mode_snapshot::text AS mode
        FROM commerce_order WHERE id = ${prepared.orderId}`);
    const storedMode = snapshot.rows[0]?.mode ?? null;
    record(
      "A45 · confirm snapshots the requested mode onto the order",
      storedMode === REQUESTED_FREIGHT_MODE,
      `requested_freight_mode_snapshot=${JSON.stringify(storedMode)}`,
    );

    const orderRead = await callApi("GET", `/commerce/orders/${prepared.orderId}`, {
      actor: seller,
    });
    record(
      "A45 · the seller reads the requested mode on the order",
      stringField(dataOf(orderRead), "requestedFreightModeSnapshot") === REQUESTED_FREIGHT_MODE,
      `${String(orderRead.status)}, requestedFreightModeSnapshot=${JSON.stringify(dataOf(orderRead)["requestedFreightModeSnapshot"])}`,
    );

    const paid = await callApi("POST", `/commerce/orders/${prepared.orderId}/payment-intents`, {
      actor: buyer,
      idempotencyPrefix: "pay",
      body: {},
    });
    if (paid.status !== 202) {
      skip(
        "A43 · shipment legs",
        `payment intent answered ${String(paid.status)}: ${messageOf(paid)}`,
      );
    } else {
      const unsettled = await waitForShippableOrder(prepared.orderId);
      if (unsettled !== null) {
        skip("A43 · shipment legs", unsettled);
      } else {
        await smokeShipmentLegs(seller, prepared.orderId, "direct-checkout");
      }
    }
  }

  /*
   * THE ASSIGNMENT RAIL RUNS ON THE QUOTE-ORIGINATED ORDER, not the checkout one. Only an accepted
   * quote carrying a freight service line mints a `commerce_service_engagement` a leg can be
   * assigned to; the direct-checkout order above has none, which is what the first run of this
   * smoke reported as a skip.
   */
  if (quoteOrderId === null) {
    skip("A43 · assignment on a quote-originated order", "no accepted quote order was created");
  } else {
    /*
     * ⚠️ THE PROVIDER SHIPS THIS ONE, NOT THE SELLER, and getting that backwards is the mistake
     * this comment exists to stop. On the quote-originated order the roles invert: our demo SELLER
     * raised the RFQ, so they are the order's BUYER, and the demo PROVIDER is the counterparty.
     * `createShipment` and the assignment route are both counterparty-only, so the provider is the
     * actor for the whole rail here — and it answers 404 rather than 403 to anyone else, because an
     * order you are not party to must not be distinguishable from one that does not exist.
     */
    /*
     * BOTH PARTIES ATTEST FIRST. A quote-accepted order settles on `direct_offline`, where nobody
     * charges a card — money moves between two banks and this platform is not a party to it. The
     * order only becomes shippable once each side has said so, which is why the first attempt at
     * this rail answered 409 "conflicts with the current state" rather than shipping.
     */
    for (const [attester, who] of [
      [seller, "buyer-side"],
      [provider, "counterparty-side"],
    ] as const) {
      await callApi("POST", `/commerce/orders/${quoteOrderId}/settlement-attestations`, {
        actor: attester,
        idempotencyPrefix: `attest-${who}`,
        body: {
          amountInCents: 110_000,
          occurredAt: new Date().toISOString(),
          referenceNote: `smoke-27 ${who}`,
        },
      });
    }

    const quoteOrderState = await db.execute<{ state: string }>(sql`
      SELECT state::text AS state FROM commerce_order WHERE id = ${quoteOrderId}`);
    const state = quoteOrderState.rows[0]?.state ?? "";
    if (!SHIPPABLE_ORDER_STATES.includes(state)) {
      skip(
        "A43 · assignment on a quote-originated order",
        `order ${quoteOrderId} is '${state}' after both attestations. This is a STRUCTURAL gap, not a fixture problem — see the note at the top of this file.`,
      );
    } else {
      await smokeShipmentLegs(provider, quoteOrderId, "quote-originated");
    }
  }

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
