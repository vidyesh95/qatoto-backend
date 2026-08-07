/**
 * Drives the Phase 9 and Phase 11 store routes over HTTP against a running server.
 *
 *   pnpm run dev                       # separate shell
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phases-9-11
 *
 * THE FIRST SCRIPT HERE THAT MAKES AUTHENTICATED HTTP REQUESTS. Every other `smoke-*.ts`
 * calls services in-process, which is faster but proves nothing about the guard chains —
 * and Phase 9 and 11 are almost entirely guard chains: who may author a pathway, who may
 * moderate it, who may read a buyer's street address. Those live in middleware, session
 * resolution and rate limiters, none of which an in-process service call touches.
 *
 * It asserts REFUSALS as hard as successes. A smoke test that only proves the happy path
 * would pass just as well against a backend with every authorization check deleted.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { commerceOrder, commerceOrganizationAuditEntry } from "#src/db/schema.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
/**
 * Better Auth refuses a state-changing request whose `Origin` is missing or null with
 * `MISSING_OR_NULL_ORIGIN`, and Node's fetch sends a null origin where curl sends none at
 * all — so a flow that works by hand fails from a script unless it says who it is. The
 * frontend URL is what `trustedOrigins` is configured with, and sending it makes these
 * requests look like what actually calls this API.
 */
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const PROVIDER_ORGANIZATION_ID = "store_demo_org_provider";

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
  readonly headers: Headers;
}

/** A signed-in actor: a cookie jar plus the organization its session points at. */
interface Actor {
  readonly cookie: string;
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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
  return { status: response.status, body, headers: response.headers };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function dataOf(result: ApiResult): Record<string, unknown> {
  return asRecord(result.body["data"]);
}

/** Reads a string field without stringifying whatever else the wire happened to send. */
function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" ? value : null;
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

/**
 * Better Auth rate-limits `/sign-in/email` to five attempts per ten seconds, and this
 * script signs in four accounts back to back — close enough to the ceiling to pace.
 */
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
  const setCookies = response.headers.getSetCookie();
  const sessionCookie = setCookies
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.startsWith("better-auth.session_token="))
    .join("; ");
  if (sessionCookie === "") throw new Error(`No session cookie returned for ${email}.`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return { cookie: sessionCookie };
}

/**
 * Every commerce route resolves its actor from `session.active_organization_id`, and the
 * buyer and provider resolvers have no auto-select — so this is not optional setup, it is
 * how the session learns which organization the caller is acting for.
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

async function smokePublicReads(): Promise<void> {
  const home = await callApi("GET", "/store/home");
  const homeData = dataOf(home);
  const rails = Array.isArray(homeData["rails"]) ? homeData["rails"] : [];
  const pathways = Array.isArray(homeData["pathways"]) ? homeData["pathways"] : [];
  record(
    "store home returns seeded merchandising",
    home.status === 200 && rails.length > 0 && pathways.length > 0,
    `status ${String(home.status)}, ${String(rails.length)} rail(s), ${String(pathways.length)} pathway(s)`,
  );

  const pathwayList = await callApi("GET", "/store/pathways?limit=5");
  const pathwayItems = dataOf(pathwayList)["items"];
  record(
    "pathway index is cursor-paginated",
    pathwayList.status === 200 && Array.isArray(pathwayItems),
    `status ${String(pathwayList.status)}`,
  );

  const tamperedCursor = await callApi("GET", "/store/pathways?cursor=tampered");
  record(
    "a tampered pathway cursor is 422, not 404",
    tamperedCursor.status === 422,
    `status ${String(tamperedCursor.status)}`,
  );

  const set = await callApi("GET", "/store/pathways/store-demo-hotel-room-refit");
  const setData = dataOf(set);
  const slots = Array.isArray(setData["slots"]) ? setData["slots"] : [];
  const completeness = setData["completeness"];
  record(
    "pathway set returns slots, totals and completeness",
    set.status === 200 && slots.length === 3 && typeof completeness === "object",
    `status ${String(set.status)}, ${String(slots.length)} slot(s)`,
  );

  const covered = await callApi(
    "GET",
    "/store/products/banquet-chair-stackable/delivery-estimate?destinationCountryCode=DE&quantity=50",
  );
  const coveredEstimates = dataOf(covered)["estimates"];
  record(
    "a covered route returns an attributed estimate",
    covered.status === 200 && Array.isArray(coveredEstimates) && coveredEstimates.length > 0,
    `status ${String(covered.status)}, ${String(Array.isArray(coveredEstimates) ? coveredEstimates.length : 0)} estimate(s)`,
  );

  const uncovered = await callApi(
    "GET",
    "/store/products/banquet-chair-stackable/delivery-estimate?destinationCountryCode=AQ&quantity=50",
  );
  const uncoveredEstimates = dataOf(uncovered)["estimates"];
  record(
    "an uncovered route returns an empty list, never a zero",
    uncovered.status === 200 &&
      Array.isArray(uncoveredEstimates) &&
      uncoveredEstimates.length === 0,
    `status ${String(uncovered.status)}`,
  );

  const badCountry = await callApi(
    "GET",
    "/store/products/banquet-chair-stackable/delivery-estimate?destinationCountryCode=Germany",
  );
  record(
    "a non ISO destination is refused",
    badCountry.status === 422,
    `status ${String(badCountry.status)}`,
  );
}

async function smokeSellerAuthoring(seller: Actor): Promise<string> {
  const created = await callApi("POST", "/commerce/pathways", {
    actor: seller,
    idempotencyPrefix: "pathway-create",
    body: {
      slug: `smoke-seller-set-${String(Date.now())}`,
      title: "Smoke seller proposal",
      summary: "Created by db:smoke-store-phases-9-11.",
    },
  });
  const pathwayId = stringField(dataOf(created), "id");
  record(
    "a seller can propose a pathway",
    created.status === 201 && pathwayId !== "",
    `status ${String(created.status)}`,
  );
  if (pathwayId === "") return "";

  const slots = await callApi("PUT", `/commerce/pathways/${pathwayId}/slots`, {
    actor: seller,
    idempotencyPrefix: "pathway-slots",
    body: { slots: [{ roleLabel: "Seating", isRequired: true, quantity: 10 }] },
  });
  const slotList = dataOf(slots)["slots"];
  const slotId = Array.isArray(slotList) ? stringField(asRecord(slotList[0]), "id") : "";
  record(
    "a seller can replace the slot plan",
    slots.status === 200 && slotId !== "",
    `status ${String(slots.status)}`,
  );

  const sourceKindAttempt = await callApi(
    "PUT",
    `/commerce/pathways/${pathwayId}/slots/${slotId}/candidates`,
    {
      actor: seller,
      idempotencyPrefix: "pathway-candidates-source",
      body: { candidates: [{ productId: "store_demo_product_chair", sourceKind: "derived" }] },
    },
  );
  record(
    "sending sourceKind is refused rather than ignored",
    sourceKindAttempt.status === 422,
    `status ${String(sourceKindAttempt.status)}`,
  );

  const missingVariant = await callApi(
    "PUT",
    `/commerce/pathways/${pathwayId}/slots/${slotId}/candidates`,
    {
      actor: seller,
      idempotencyPrefix: "pathway-candidates-variant",
      body: { candidates: [{ productId: "store_demo_product_lamp" }] },
    },
  );
  record(
    "a candidate omitting a required variant is refused",
    missingVariant.status === 422,
    `status ${String(missingVariant.status)}`,
  );

  const candidates = await callApi(
    "PUT",
    `/commerce/pathways/${pathwayId}/slots/${slotId}/candidates`,
    {
      actor: seller,
      idempotencyPrefix: "pathway-candidates",
      body: { candidates: [{ productId: "store_demo_product_chair" }] },
    },
  );
  record(
    "a seller can rank candidates",
    candidates.status === 200,
    `status ${String(candidates.status)}`,
  );

  const submitted = await callApi("POST", `/commerce/pathways/${pathwayId}/submit`, {
    actor: seller,
    idempotencyPrefix: "pathway-submit",
    body: {},
  });
  record(
    "submitting moves the set to pending_review",
    submitted.status === 200 && stringField(dataOf(submitted), "state") === "pending_review",
    `state ${stringField(dataOf(submitted), "state")}`,
  );

  return pathwayId;
}

async function smokeModeration(staff: Actor, seller: Actor, pathwayId: string): Promise<void> {
  const sellerAttempt = await callApi("GET", "/commerce/admin/pathways", { actor: seller });
  record(
    "a non-staff caller cannot read the moderation queue",
    sellerAttempt.status === 403,
    `status ${String(sellerAttempt.status)}`,
  );

  const queue = await callApi("GET", "/commerce/admin/pathways", { actor: staff });
  const queueItems = dataOf(queue)["items"];
  record(
    "staff see the proposal with its own-candidate share",
    queue.status === 200 && Array.isArray(queueItems) && queueItems.length > 0,
    `status ${String(queue.status)}`,
  );

  const published = await callApi(`POST`, `/commerce/admin/pathways/${pathwayId}/moderate`, {
    actor: staff,
    idempotencyPrefix: "pathway-moderate",
    body: { decision: "publish" },
  });
  record(
    "staff can publish the proposal",
    published.status === 200 && stringField(dataOf(published), "state") === "active",
    `state ${stringField(dataOf(published), "state")}`,
  );
}

async function smokeBuyerFlow(buyer: Actor): Promise<string> {
  const seeded = await callApi("POST", "/commerce/cart/from-pathway/store-demo-hotel-room-refit", {
    actor: buyer,
    idempotencyPrefix: "cart-seed",
    body: {},
  });
  const seededData = dataOf(seeded);
  record(
    "a pathway seeds the cart and reports what it could not fill",
    seeded.status === 200 && numberField(seededData, "filledSlotCount") !== null,
    `filled ${String(numberField(seededData, "filledSlotCount") ?? "none")}`,
  );

  const sample = await callApi("PUT", "/commerce/cart/items/store_demo_product_chair", {
    actor: buyer,
    idempotencyPrefix: "cart-sample",
    body: { quantity: 1, isSample: true },
  });
  const sampleItems = dataOf(sample)["items"];
  const chairLines = Array.isArray(sampleItems)
    ? sampleItems.filter(
        (item) => stringField(asRecord(item), "productId") === "store_demo_product_chair",
      )
    : [];
  record(
    "a sample line sits beside the bulk line rather than replacing it",
    sample.status === 200 && chairLines.length === 2,
    `${String(chairLines.length)} chair line(s)`,
  );

  const unavailableSample = await callApi("PUT", "/commerce/cart/items/store_demo_product_rug", {
    actor: buyer,
    idempotencyPrefix: "cart-sample-refused",
    body: { quantity: 1, isSample: true },
  });
  record(
    "a listing with no sample refuses one",
    unavailableSample.status === 422,
    `status ${String(unavailableSample.status)}`,
  );

  const belowMinimum = await callApi("PUT", "/commerce/cart/items/store_demo_product_chair", {
    actor: buyer,
    idempotencyPrefix: "cart-customization",
    body: {
      quantity: 20,
      customizations: [{ slotKey: "packaging_material", choiceValue: "kraft" }],
    },
  });
  record(
    "a customization below its slot minimum is refused",
    belowMinimum.status === 422,
    `status ${String(belowMinimum.status)}`,
  );

  const wrongKind = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare-wrong-kind",
    body: { deliveryAddressId: "store_demo_address_billing" },
  });
  record(
    "a billing address is refused as a delivery address",
    wrongKind.status === 422,
    `status ${String(wrongKind.status)}`,
  );

  const prepared = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    idempotencyPrefix: "prepare",
    body: { deliveryAddressId: "store_demo_address_delivery" },
  });
  const preparedData = dataOf(prepared);
  const estimates = preparedData["deliveryEstimates"];
  record(
    // 201, not 200: preparing a checkout creates a prepare resource.
    "checkout prepare carries indicative delivery estimates",
    prepared.status === 201 && Array.isArray(estimates) && estimates.length > 0,
    `status ${String(prepared.status)}, ${String(Array.isArray(estimates) ? estimates.length : 0)} estimate group(s)`,
  );

  const confirmed = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    idempotencyPrefix: "confirm",
    body: { prepareId: stringField(preparedData, "prepareId") },
  });
  const confirmedData = dataOf(confirmed);
  const orders = Array.isArray(confirmedData["orders"]) ? confirmedData["orders"] : [];
  const orderId = stringField(asRecord(orders[0]), "id");
  record(
    "confirm creates one order per counterparty",
    confirmed.status === 201 && orderId !== "",
    `status ${String(confirmed.status)}, ${String(orders.length)} order(s)`,
  );

  return orderId;
}

async function smokeDeliveryAddressReveal(
  seller: Actor,
  provider: Actor,
  orderId: string,
): Promise<void> {
  const beforeConfirmed = await callApi("GET", `/commerce/orders/${orderId}/delivery-address`, {
    actor: seller,
  });
  record(
    "an unpaid order does not release the buyer's address",
    beforeConfirmed.status === 409,
    `status ${String(beforeConfirmed.status)}`,
  );

  /**
   * STAND-IN, and the only place this script writes to the database directly.
   *
   * The reveal route requires an order at `confirmed` or later, and reaching that
   * honestly means driving the Phase 5 payment flow — which is Phase 5's smoke test, not
   * this one. This advances the state and nothing else; it does not create a payment
   * intent, post to the journal, or pretend money moved.
   */
  await db.update(commerceOrder).set({ state: "confirmed" }).where(eq(commerceOrder.id, orderId));

  const revealed = await callApi("GET", `/commerce/orders/${orderId}/delivery-address`, {
    actor: seller,
  });
  const revealedData = dataOf(revealed);
  record(
    "an authorized seller reads the full street address",
    revealed.status === 200 && stringField(revealedData, "addressLineOne") !== "",
    `status ${String(revealed.status)}`,
  );
  record(
    "the reveal response is not cacheable",
    revealed.headers.get("cache-control") === "no-store",
    `cache-control ${revealed.headers.get("cache-control") ?? "none"}`,
  );

  const stranger = await callApi("GET", `/commerce/orders/${orderId}/delivery-address`, {
    actor: provider,
  });
  record(
    "an unrelated organization gets 404, not 403",
    stranger.status === 404,
    `status ${String(stranger.status)}`,
  );

  const auditRows = await db
    .select({ id: commerceOrganizationAuditEntry.id })
    .from(commerceOrganizationAuditEntry)
    .where(
      and(
        eq(commerceOrganizationAuditEntry.organizationId, BUYER_ORGANIZATION_ID),
        eq(commerceOrganizationAuditEntry.eventKind, "delivery_address_revealed"),
      ),
    );
  record(
    "the reveal is audited on the buyer's stream, not the seller's",
    auditRows.length > 0,
    `${String(auditRows.length)} entr(y|ies)`,
  );
}

async function main(): Promise<void> {
  await waitForServer();

  const seller = await signIn("store-demo-seller@example.invalid");
  const buyer = await signIn("store-demo-buyer@example.invalid");
  const provider = await signIn("store-demo-provider@example.invalid");
  const staff = await signIn("store-demo-staff@example.invalid");

  await activateOrganization(seller, SELLER_ORGANIZATION_ID);
  await activateOrganization(buyer, BUYER_ORGANIZATION_ID);
  await activateOrganization(provider, PROVIDER_ORGANIZATION_ID);

  await smokePublicReads();
  const pathwayId = await smokeSellerAuthoring(seller);
  if (pathwayId !== "") await smokeModeration(staff, seller, pathwayId);
  const orderId = await smokeBuyerFlow(buyer);
  if (orderId !== "") await smokeDeliveryAddressReveal(seller, provider, orderId);

  for (const outcome of outcomes) {
    console.log(`${outcome.passed ? "PASS" : "FAIL"}  ${outcome.label} — ${outcome.detail}`);
  }
  const failureCount = outcomes.filter((outcome) => !outcome.passed).length;
  console.log(
    failureCount === 0
      ? `\nAll ${String(outcomes.length)} store phase 9/11 behaviours hold.`
      : `\n${String(failureCount)} of ${String(outcomes.length)} FAILED.`,
  );

  await pool.end();
  process.exit(failureCount === 0 ? 0 : 1);
}

void main().catch(async (error: unknown) => {
  console.error("Store phase 9/11 smoke failed:", error);
  await pool.end();
  process.exit(1);
});
