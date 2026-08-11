/**
 * Drives the Phase 21 buyer surface over HTTP against a running server.
 *
 *   pnpm run db:migrate && pnpm run jobs:install
 *   pnpm run dev            # shell 2
 *   pnpm run dev:worker     # shell 3
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-21
 *
 * THE ONE ASSERTION THIS FILE EXISTS FOR is the first check: a user who signed up seconds ago,
 * belongs to no organization, and has had no staff decision made about them, gets `200` from
 * `GET /commerce/cart`. Before Phase 21 that was a `403` and stayed one until a moderator acted
 * by hand — §14 marked the fix DECIDED and nothing built it.
 *
 * IT SIGNS UP A BRAND-NEW USER RATHER THAN USING THE DEMO SEED, and that is not incidental.
 * `store-demo-buyer` already has an activated organization, so every route in this file would
 * pass against it while proving nothing. Only an account with no organization can show that one
 * gets minted.
 *
 * OVER HTTP, NOT IN-PROCESS, because the whole change is a middleware. An in-process service call
 * reaches neither `requireProvisionedBuyerCommerceWorkspace` nor the session compare-and-set it
 * performs, and the session pointer is the mechanism being tested.
 *
 * IT ASSERTS THE REFUSALS AS HARD AS THE SUCCESSES. §14 named four places the trust gate stays,
 * and a phase that opened the cart by accidentally opening `checkout/confirm` would look
 * identical to a working one from the success side alone.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db, pool } from "#src/db/index.js";
import { commerceOrganization } from "#src/db/schema.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const SMOKE_PASSWORD = "store-smoke-password-2026";
const CHAIR_PRODUCT_ID = "store_demo_product_chair";

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
  readonly userId: string;
  readonly email: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function dataOf(result: ApiResult): Record<string, unknown> {
  return asRecord(result.body["data"]);
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke21-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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

/**
 * A brand-new account, and deliberately NOT one the demo seed created.
 *
 * NOTHING IS DONE TO IT AFTERWARDS — no organization is created, no membership granted, no
 * `activeOrganizationId` set. Every one of those is the thing under test.
 */
async function signUpFreshUser(label: string): Promise<Actor> {
  const email = `store-smoke-${label}-${randomBytes(6).toString("hex")}@example.invalid`;
  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REQUEST_ORIGIN },
    body: JSON.stringify({ email, password: SMOKE_PASSWORD, name: `Smoke ${label}` }),
  });
  if (!response.ok) {
    throw new Error(
      `Sign-up failed for ${email} (${String(response.status)}): ${await response.text()}`,
    );
  }

  const sessionCookie = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.startsWith("better-auth.session_token="))
    .join("; ");
  if (sessionCookie === "") throw new Error(`No session cookie returned for ${email}.`);

  const signedUp = asRecord(asRecord(JSON.parse(await response.clone().text())).user);
  const userId = typeof signedUp["id"] === "string" ? signedUp["id"] : "";
  if (userId === "") throw new Error(`Sign-up returned no user id for ${email}.`);

  return { cookie: sessionCookie, userId, email };
}

async function readWorkspaces(userId: string) {
  return db
    .select({
      id: commerceOrganization.id,
      tradeState: commerceOrganization.tradeState,
      countryCode: commerceOrganization.countryCode,
      provisioningOrigin: commerceOrganization.provisioningOrigin,
      slug: commerceOrganization.slug,
    })
    .from(commerceOrganization)
    .where(
      and(
        eq(commerceOrganization.createdByUserId, userId),
        eq(commerceOrganization.provisioningOrigin, "auto_provisioned"),
      ),
    );
}

async function main(): Promise<void> {
  console.log("smoke-store-phase-21\n");

  // ── The headline. ────────────────────────────────────────────────────────────────────
  const buyer = await signUpFreshUser("buyer");

  const beforeFirstTap = await readWorkspaces(buyer.userId);
  record(
    "A37 · a fresh account starts with no organization",
    beforeFirstTap.length === 0,
    `${String(beforeFirstTap.length)} workspace(s) before the first tap`,
  );

  const cart = await callApi("GET", "/commerce/cart", { actor: buyer });
  record(
    "A37 · GET /commerce/cart answers 200 with no staff decision — THE PHASE",
    cart.status === 200,
    `status ${String(cart.status)}${cart.status === 403 ? " — auto-provisioning did not run" : ""}`,
  );

  const minted = await readWorkspaces(buyer.userId);
  const shell = minted[0];
  record(
    "A37 · exactly one shell was minted",
    minted.length === 1,
    `${String(minted.length)} auto-provisioned workspace(s)`,
  );
  record(
    "A37 · the shell is pending, private and has no country",
    shell !== undefined && shell.tradeState === "pending" && shell.countryCode === null,
    shell === undefined
      ? "no shell to inspect"
      : `tradeState=${shell.tradeState} countryCode=${String(shell.countryCode)} slug=${shell.slug}`,
  );

  // ── The cart actually works, not merely opens. ───────────────────────────────────────
  // Above the demo chair's minimum order quantity of 10, deliberately: at 2 the prepare below
  // answers `BELOW_MINIMUM_ORDER_QUANTITY`, and a check that only proves "not 403" would have
  // passed while proving nothing about whether a pending workspace can actually be priced.
  const setLine = await callApi("PUT", `/commerce/cart/items/${CHAIR_PRODUCT_ID}`, {
    actor: buyer,
    body: { quantity: 12 },
    idempotencyPrefix: "cart-line",
  });
  if (setLine.status === 404) {
    skip(
      "A37 · a pending workspace can add a cart line",
      "the demo chair product is absent — run `pnpm run db:seed-store-demo`",
    );
  } else {
    record(
      "A37 · a pending workspace can add a cart line",
      setLine.status === 200 || setLine.status === 201,
      `status ${String(setLine.status)}`,
    );
  }

  const prepare = await callApi("POST", "/commerce/checkout/prepare", {
    actor: buyer,
    body: {},
    idempotencyPrefix: "prepare",
  });
  record(
    "§14 · checkout/prepare SUCCEEDS on a pending workspace",
    prepare.status === 200 || prepare.status === 201,
    `status ${String(prepare.status)}${
      prepare.status === 403
        ? " — prepare is still gated on activation"
        : prepare.status >= 400
          ? ` — ${String(prepare.body["message"] ?? "no message")}`
          : ""
    }`,
  );

  // ── The gates §14 named. Each one is the phase failing if it opens. ──────────────────
  const confirm = await callApi("POST", "/commerce/checkout/confirm", {
    actor: buyer,
    body: { checkoutPrepareId: "prepare_does_not_exist" },
    idempotencyPrefix: "confirm",
  });
  record(
    "§14 GATE · checkout/confirm still refuses a pending workspace",
    confirm.status === 403,
    `status ${String(confirm.status)}${confirm.status !== 403 ? " — THE MONEY GATE IS OPEN" : ""}`,
  );

  const draftRfq = await callApi("POST", "/commerce/rfqs", {
    actor: buyer,
    body: {
      title: "Smoke 21 draft",
      description: "Drafting must not need activation.",
      visibility: "invited_only",
      responseDeadlineAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      settlementCurrency: "USD",
    },
    idempotencyPrefix: "rfq-draft",
  });
  record(
    "A37 · an RFQ DRAFT is allowed on a pending workspace",
    draftRfq.status === 200 || draftRfq.status === 201,
    `status ${String(draftRfq.status)}`,
  );

  const draftedRfqId = (() => {
    const value = dataOf(draftRfq)["id"];
    return typeof value === "string" ? value : "";
  })();
  if (draftedRfqId === "") {
    skip("§14 GATE · RFQ open still refuses a pending workspace", "no draft RFQ id to open");
  } else {
    const openRfq = await callApi("POST", `/commerce/rfqs/${draftedRfqId}/open`, {
      actor: buyer,
      body: {},
      idempotencyPrefix: "rfq-open",
    });
    record(
      "§14 GATE · RFQ open still refuses a pending workspace",
      openRfq.status === 403,
      `status ${String(openRfq.status)}${openRfq.status !== 403 ? " — THE BROADCAST GATE IS OPEN" : ""}`,
    );
  }

  // ── Messaging, the A14 consequence §14 recorded. ─────────────────────────────────────
  const inquiry = await callApi("POST", `/commerce/products/${CHAIR_PRODUCT_ID}/inquiries`, {
    actor: buyer,
    idempotencyPrefix: "inquiry",
  });
  if (inquiry.status === 404) {
    skip(
      "A14 · a pending workspace can open a product inquiry",
      "the demo chair product is absent — run `pnpm run db:seed-store-demo`",
    );
  } else {
    record(
      "A14 · a pending workspace can open a product inquiry",
      inquiry.status !== 403,
      `status ${String(inquiry.status)}`,
    );
  }

  // ── Completing the shell. ────────────────────────────────────────────────────────────
  if (shell === undefined) {
    skip("A37 · declaring a country retires the shell", "no shell to complete");
  } else {
    // `idempotency({ required: true })` on this route — a keyless PATCH is a 400, which is
    // the middleware working rather than the patch being refused.
    const patched = await callApi("PATCH", `/commerce/organizations/${shell.id}`, {
      actor: buyer,
      body: { countryCode: "IN" },
      idempotencyPrefix: "complete-shell",
    });
    const afterPatch = await db
      .select({
        countryCode: commerceOrganization.countryCode,
        provisioningOrigin: commerceOrganization.provisioningOrigin,
      })
      .from(commerceOrganization)
      .where(eq(commerceOrganization.id, shell.id))
      .limit(1);
    const completed = afterPatch[0];
    record(
      "A37 · declaring a country retires the shell to self_declared",
      patched.status === 200 &&
        completed?.countryCode === "IN" &&
        completed.provisioningOrigin === "self_declared",
      completed === undefined
        ? `PATCH status ${String(patched.status)}, row vanished`
        : `PATCH ${String(patched.status)} · countryCode=${String(completed.countryCode)} · origin=${completed.provisioningOrigin}`,
    );
  }

  // ── The race. ────────────────────────────────────────────────────────────────────────
  const racer = await signUpFreshUser("racer");
  await Promise.all([
    callApi("GET", "/commerce/cart", { actor: racer }),
    callApi("GET", "/commerce/cart", { actor: racer }),
    callApi("GET", "/commerce/cart", { actor: racer }),
  ]);
  const racedWorkspaces = await readWorkspaces(racer.userId);
  record(
    "A37 · three simultaneous first taps mint ONE workspace",
    racedWorkspaces.length === 1,
    `${String(racedWorkspaces.length)} workspace(s) — more than one means two carts for one buyer`,
  );

  // ── Report. ──────────────────────────────────────────────────────────────────────────
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
