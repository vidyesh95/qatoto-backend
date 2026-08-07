/**
 * Drives the Phase 12 seller-profile routes over HTTP against a running server (A13).
 *
 *   pnpm run dev                     # separate shell
 *   pnpm run db:seed-store-demo
 *   pnpm run db:smoke-store-phase-12
 *
 * OVER HTTP, not in-process, for the reason `smoke-store-phase-10.ts` gives and this phase
 * needs even more: the seller-profile route suite does not exist, and the unit tests mock the
 * database entirely. Every guard here — the membership role, the moderator capability, the
 * multipart magic-byte check, the idempotency key, the audit payload guard that took address
 * creation down in Phase 11 — lives somewhere an in-process service call never reaches.
 *
 * IT ASSERTS REFUSALS AS HARD AS SUCCESSES, and it asserts two ABSENCES that are the whole
 * point of A13: that `declaredProfile` and `measuredMetrics` arrive as separate objects, and
 * that no certificate document reference appears anywhere in a public body.
 */
import "dotenv/config";

import { config } from "#src/config/index.js";
import { pool } from "#src/db/index.js";

const BASE_URL = `http://localhost:${String(config.PORT)}`;
const REQUEST_ORIGIN = config.FRONTEND_URL;
const DEMO_PASSWORD = "store-demo-password-2026";

const SELLER_ORGANIZATION_ID = "store_demo_org_seller";
const BUYER_ORGANIZATION_ID = "store_demo_org_buyer";
const SELLER_ORGANIZATION_SLUG = "store-demo-furnishings";

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
  readonly rawText: string;
}

interface Actor {
  readonly cookie: string;
}

let idempotencyCounter = 0;
function nextIdempotencyKey(prefix: string): string {
  idempotencyCounter += 1;
  return `smoke12-${prefix}-${String(Date.now())}-${String(idempotencyCounter)}`;
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
  return { status: response.status, body, rawText };
}

/**
 * A real PNG at 128×128.
 *
 * NOT one pixel: `validateAndNormalizeImage` rejects anything under 64px on either side as
 * too small to be a photograph, so a 1×1 fixture tests the floor rather than the upload. It
 * is generated with sharp rather than pasted as base64 so the dimensions are stated in the
 * code that asserts them.
 */
async function factoryPhotoPngBytes(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 40, g: 60, b: 80 },
    },
  })
    .png()
    .toBuffer();
}

async function callMultipart(
  path: string,
  options: {
    readonly actor: Actor;
    readonly fields: Readonly<Record<string, string>>;
    readonly file: {
      readonly fieldName: string;
      readonly fileName: string;
      readonly mediaType: string;
      readonly bytes: Buffer;
    };
    readonly idempotencyPrefix: string;
  },
): Promise<ApiResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries(options.fields)) form.append(key, value);
  form.append(
    options.file.fieldName,
    new Blob([new Uint8Array(options.file.bytes)], {
      type: options.file.mediaType,
    }),
    options.file.fileName,
  );

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      origin: REQUEST_ORIGIN,
      cookie: options.actor.cookie,
      "idempotency-key": nextIdempotencyKey(options.idempotencyPrefix),
    },
    body: form,
  });
  const rawText = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(rawText === "" ? {} : JSON.parse(rawText));
  } catch {
    body = { raw: rawText.slice(0, 200) };
  }
  return { status: response.status, body, rawText };
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

// ---------------------------------------------------------------------------
// The declared profile.
// ---------------------------------------------------------------------------

async function smokeDeclaredProfile(seller: Actor, buyer: Actor): Promise<void> {
  const saved = await callApi(
    "PATCH",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/seller-profile`,
    {
      actor: seller,
      body: {
        yearFounded: 2009,
        factoryCount: 2,
        totalStaffCount: 180,
        businessType: "manufacturer_trading",
        visitPolicy: "by_appointment",
        acceptingCustomOrders: true,
        declaredResponseTimeHours: 6,
        publicSummary: "Contract furniture manufacturer, banquet and hospitality seating.",
      },
      idempotencyPrefix: "profile",
    },
  );
  record(
    "seller saves its declared profile",
    saved.status === 200 && numberField(dataOf(saved), "yearFounded") === 2009,
    `${String(saved.status)} yearFounded=${String(numberField(dataOf(saved), "yearFounded"))}`,
  );

  /**
   * THE PHASE 11 REGRESSION CLASS. If the audit payload key tripped
   * `FORBIDDEN_PAYLOAD_KEY`, `appendAuditOrThrow` would throw and this would be a 500 with
   * the row rolled back — exactly how `POST /addresses` failed silently for every caller.
   * A 200 here is the assertion that the audit append actually committed.
   */
  record(
    "the profile write did not fail on the audit payload guard",
    saved.status === 200,
    saved.status === 200
      ? "audit appended"
      : `HTTP ${String(saved.status)} — check the payload keys`,
  );

  const futureYear = await callApi(
    "PATCH",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/seller-profile`,
    {
      actor: seller,
      body: { yearFounded: 4000 },
      idempotencyPrefix: "profile-future",
    },
  );
  record(
    "a founding year in the future is refused at the boundary",
    futureYear.status === 422,
    `HTTP ${String(futureYear.status)}`,
  );

  /**
   * §11's rule: an inaccessible organization id must be indistinguishable from a
   * nonexistent one. A 403 here would confirm to a stranger that the organization exists.
   */
  const crossTenant = await callApi(
    "PATCH",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/seller-profile`,
    {
      actor: buyer,
      body: { factoryCount: 99 },
      idempotencyPrefix: "profile-cross",
    },
  );
  record(
    "another organization's member gets 404, not 403",
    crossTenant.status === 404,
    `HTTP ${String(crossTenant.status)}`,
  );

  const anonymous = await callApi(
    "PATCH",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/seller-profile`,
    { body: { factoryCount: 1 }, idempotencyPrefix: "profile-anon" },
  );
  record(
    "an anonymous caller cannot write a profile",
    anonymous.status === 401,
    `HTTP ${String(anonymous.status)}`,
  );

  /**
   * The other direction of the same rule: the buyer CAN write its own organization's
   * profile. Without this, "the buyer got a 404" above would also pass against a backend
   * that refuses every seller-profile write for everyone.
   */
  const ownOrganization = await callApi(
    "PATCH",
    `/commerce/organizations/${BUYER_ORGANIZATION_ID}/seller-profile`,
    {
      actor: buyer,
      body: { businessType: "distributor" },
      idempotencyPrefix: "profile-own",
    },
  );
  record(
    "a member writing its OWN organization's profile succeeds",
    ownOrganization.status === 200,
    `HTTP ${String(ownOrganization.status)}`,
  );

  const unknownField = await callApi(
    "PATCH",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/seller-profile`,
    {
      actor: seller,
      body: { revenueUsd: 2_400_000 },
      idempotencyPrefix: "profile-strict",
    },
  );
  record(
    "an undeclared field is refused by .strict() (A20 keeps revenue out)",
    unknownField.status === 422,
    `HTTP ${String(unknownField.status)}`,
  );
}

async function smokeReplaceCollections(seller: Actor): Promise<void> {
  const siteAccess = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/site-access`,
    {
      actor: seller,
      body: {
        rows: [
          { accessMode: "sea", facilityName: "Nhava Sheva", distanceKm: 62 },
          {
            accessMode: "air",
            facilityName: "Chhatrapati Shivaji",
            distanceKm: 38,
          },
          { accessMode: "road", facilityName: "NH-48", distanceKm: 3 },
        ],
      },
      idempotencyPrefix: "site-access",
    },
  );
  record(
    "site access replaces to three rows with contiguous positions",
    siteAccess.status === 200 && arrayField(dataOf(siteAccess), "rows").length === 3,
    `${String(siteAccess.status)} rows=${String(arrayField(dataOf(siteAccess), "rows").length)}`,
  );

  const stakeholders = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/stakeholders`,
    {
      actor: seller,
      body: {
        rows: [
          { fullName: "R. Iyer", roleTitle: "Managing Director" },
          { fullName: "S. Nair", roleTitle: "Head of Production" },
        ],
      },
      idempotencyPrefix: "stakeholders",
    },
  );
  record(
    "stakeholders replace to two rows",
    stakeholders.status === 200 && arrayField(dataOf(stakeholders), "rows").length === 2,
    `${String(stakeholders.status)} rows=${String(arrayField(dataOf(stakeholders), "rows").length)}`,
  );

  const stakeholderContact = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/stakeholders`,
    {
      actor: seller,
      body: {
        rows: [{ fullName: "R. Iyer", roleTitle: "MD", email: "r@example.invalid" }],
      },
      idempotencyPrefix: "stakeholders-contact",
    },
  );
  record(
    "a stakeholder contact detail is refused — the table has nowhere to put it",
    stakeholderContact.status === 422,
    `HTTP ${String(stakeholderContact.status)}`,
  );

  const capabilities = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/capabilities`,
    {
      actor: seller,
      body: {
        rows: [
          { capabilityKind: "oem", detail: "Buyer-branded seating" },
          { capabilityKind: "in_house_inspection" },
        ],
      },
      idempotencyPrefix: "capabilities",
    },
  );
  record(
    "capabilities replace to two rows",
    capabilities.status === 200 && arrayField(dataOf(capabilities), "rows").length === 2,
    `${String(capabilities.status)} rows=${String(arrayField(dataOf(capabilities), "rows").length)}`,
  );

  const duplicateCapability = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/capabilities`,
    {
      actor: seller,
      body: { rows: [{ capabilityKind: "oem" }, { capabilityKind: "oem" }] },
      idempotencyPrefix: "capabilities-dup",
    },
  );
  record(
    "the same capability twice is refused before the unique index sees it",
    duplicateCapability.status === 409,
    `HTTP ${String(duplicateCapability.status)}`,
  );

  // A replace to an empty list must actually clear the collection, not no-op.
  const cleared = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/site-access`,
    {
      actor: seller,
      body: { rows: [] },
      idempotencyPrefix: "site-access-clear",
    },
  );
  const restored = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/site-access`,
    {
      actor: seller,
      body: {
        rows: [{ accessMode: "sea", facilityName: "Nhava Sheva", distanceKm: 62 }],
      },
      idempotencyPrefix: "site-access-restore",
    },
  );
  record(
    "an empty replace clears the collection and a later write repopulates it",
    cleared.status === 200 &&
      arrayField(dataOf(cleared), "rows").length === 0 &&
      restored.status === 200 &&
      arrayField(dataOf(restored), "rows").length === 1,
    `cleared=${String(arrayField(dataOf(cleared), "rows").length)} restored=${String(arrayField(dataOf(restored), "rows").length)}`,
  );
}

async function smokeIdempotency(seller: Actor): Promise<void> {
  const sharedKey = nextIdempotencyKey("idem");
  const first = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/stakeholders`,
    {
      actor: seller,
      body: { rows: [{ fullName: "T. Rao", roleTitle: "Quality Lead" }] },
      idempotencyKey: sharedKey,
    },
  );
  const replay = await callApi(
    "PUT",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/stakeholders`,
    {
      actor: seller,
      body: { rows: [{ fullName: "T. Rao", roleTitle: "Quality Lead" }] },
      idempotencyKey: sharedKey,
    },
  );
  record(
    "a replayed idempotency key returns one business result",
    first.status === 200 && replay.status === 200 && replay.rawText === first.rawText,
    `first=${String(first.status)} replay=${String(replay.status)} identical=${String(replay.rawText === first.rawText)}`,
  );
}

async function smokeCompanyMedia(seller: Actor, buyer: Actor): Promise<string | null> {
  const photoBytes = await factoryPhotoPngBytes();
  const uploaded = await callMultipart(`/commerce/organizations/${SELLER_ORGANIZATION_ID}/media`, {
    actor: seller,
    fields: { mediaKind: "factory", altText: "Assembly line" },
    file: {
      fieldName: "image",
      fileName: "factory.png",
      mediaType: "image/png",
      bytes: photoBytes,
    },
    idempotencyPrefix: "media",
  });
  const mediaId = stringField(dataOf(uploaded), "id");
  record(
    "a company photo uploads and reports server-measured dimensions",
    uploaded.status === 201 &&
      numberField(dataOf(uploaded), "widthPx") !== null &&
      numberField(dataOf(uploaded), "heightPx") !== null,
    `${String(uploaded.status)} ${String(numberField(dataOf(uploaded), "widthPx"))}x${String(numberField(dataOf(uploaded), "heightPx"))}`,
  );

  /**
   * `cloudinaryPublicId` is a storage handle kept for deletion and must not be a projected
   * FIELD.
   *
   * It is deliberately NOT asserted that the folder path is absent from the body: a
   * Cloudinary delivery URL embeds the public id by construction
   * (`.../upload/v.../qatoto/commerce-organizations/<org>/<id>.avif`), exactly as
   * `product_image.url` and review media already do. These images are public — the URL IS
   * the projection. Asserting on the path would fail forever and teach the next reader that
   * a public CDN URL is a leak. The column is private; the address it produces is not.
   */
  record(
    "the upload response does not project the cloudinary public id field",
    !uploaded.rawText.includes("cloudinaryPublicId"),
    uploaded.rawText.includes("cloudinaryPublicId") ? "LEAKED" : "absent",
  );

  const notAnImage = await callMultipart(
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/media`,
    {
      actor: seller,
      fields: { mediaKind: "factory" },
      file: {
        fieldName: "image",
        fileName: "not-an-image.png",
        // A truthful-looking mimetype over bytes that are not an image at all. The header
        // is a claim; sharp reads the actual bytes.
        mediaType: "image/png",
        bytes: Buffer.from("this is not a png", "utf8"),
      },
      idempotencyPrefix: "media-bad",
    },
  );
  record(
    "bytes that are not an image are refused despite an image/* mimetype",
    notAnImage.status === 422,
    `HTTP ${String(notAnImage.status)}`,
  );

  const crossTenantUpload = await callMultipart(
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/media`,
    {
      actor: buyer,
      fields: { mediaKind: "factory" },
      file: {
        fieldName: "image",
        fileName: "factory.png",
        mediaType: "image/png",
        bytes: photoBytes,
      },
      idempotencyPrefix: "media-cross",
    },
  );
  record(
    "another organization cannot add a company photo",
    crossTenantUpload.status === 404,
    `HTTP ${String(crossTenantUpload.status)}`,
  );

  return mediaId === "" ? null : mediaId;
}

// ---------------------------------------------------------------------------
// Certifications.
// ---------------------------------------------------------------------------

/** A minimal but structurally real PDF, so the magic-byte check sees `%PDF-`. */
function minimalPdfBytes(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n" +
      "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1",
  );
}

async function smokeCertifications(seller: Actor, buyer: Actor, staff: Actor): Promise<void> {
  const submitted = await callMultipart(
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/certifications`,
    {
      actor: seller,
      fields: {
        standardName: `ISO 9001:2015 ${String(Date.now())}`,
        issuerName: "Bureau of Standards",
        certificateNumber: `CERT-${String(Date.now())}`,
        validFrom: "2026-01-01",
        validUntil: "2029-01-01",
        scopeSummary: "Manufacture of contract seating",
      },
      file: {
        fieldName: "evidence",
        fileName: "iso-9001.pdf",
        mediaType: "application/pdf",
        bytes: minimalPdfBytes(),
      },
      idempotencyPrefix: "cert",
    },
  );
  const certificationId = stringField(dataOf(submitted), "id");
  record(
    "a certification submits and lands pending",
    submitted.status === 201 && stringField(dataOf(submitted), "state") === "pending",
    `${String(submitted.status)} state=${stringField(dataOf(submitted), "state")}`,
  );
  record(
    "the certification response references no evidence document",
    !submitted.rawText.includes("evidenceDocumentId") &&
      !submitted.rawText.includes("objectStorageKey"),
    submitted.rawText.includes("evidenceDocumentId") ? "LEAKED" : "absent",
  );

  if (certificationId === "") {
    record("certification decision flow", false, "no certification id to decide");
    return;
  }

  /**
   * A pending certification must NOT appear on the public storefront. Only a moderator's
   * approval publishes it — that is the entire difference between this table and the
   * declared capability rows beside it.
   */
  const beforeApproval = await callApi("GET", `/store/organizations/${SELLER_ORGANIZATION_SLUG}`);
  const declaredBefore = asRecord(dataOf(beforeApproval)["declaredProfile"]);
  const publishedIdsBefore = arrayField(declaredBefore, "certifications").map((entry) =>
    stringField(asRecord(entry), "id"),
  );
  /**
   * Asserted by IDENTITY, not by count. An earlier run of this script leaves approved
   * certifications behind, so "zero are published" is only true the first time — a
   * count-based check here reported a false failure on the second run and would have
   * reported a false PASS if approval had ever stopped working before any run succeeded.
   */
  record(
    "a pending certification is not published",
    !publishedIdsBefore.includes(certificationId),
    `${String(publishedIdsBefore.length)} published, this one absent=${String(!publishedIdsBefore.includes(certificationId))}`,
  );

  const sellerSelfApproval = await callApi(
    "POST",
    `/commerce/admin/certifications/${certificationId}/decision`,
    {
      actor: seller,
      body: { kind: "approve" },
      idempotencyPrefix: "cert-self",
    },
  );
  record(
    "the submitting seller cannot approve its own certification",
    sellerSelfApproval.status === 403,
    `HTTP ${String(sellerSelfApproval.status)}`,
  );

  const buyerApproval = await callApi(
    "POST",
    `/commerce/admin/certifications/${certificationId}/decision`,
    {
      actor: buyer,
      body: { kind: "approve" },
      idempotencyPrefix: "cert-buyer",
    },
  );
  record(
    "a caller without moderate_commerce cannot approve a certification",
    buyerApproval.status === 403,
    `HTTP ${String(buyerApproval.status)}`,
  );

  const approved = await callApi(
    "POST",
    `/commerce/admin/certifications/${certificationId}/decision`,
    {
      actor: staff,
      body: { kind: "approve" },
      idempotencyPrefix: "cert-approve",
    },
  );
  record(
    "a moderator approves the certification",
    approved.status === 200 && stringField(dataOf(approved), "state") === "approved",
    `${String(approved.status)} state=${stringField(dataOf(approved), "state")}`,
  );

  const decidedTwice = await callApi(
    "POST",
    `/commerce/admin/certifications/${certificationId}/decision`,
    {
      actor: staff,
      body: { kind: "approve" },
      idempotencyPrefix: "cert-again",
    },
  );
  record(
    "an already-decided certification cannot be decided again",
    decidedTwice.status === 409,
    `HTTP ${String(decidedTwice.status)}`,
  );

  const rejectWithoutReason = await callApi(
    "POST",
    `/commerce/admin/certifications/${certificationId}/decision`,
    {
      actor: staff,
      body: { kind: "reject" },
      idempotencyPrefix: "cert-noreason",
    },
  );
  record(
    "a rejection with no reason is refused at the boundary",
    rejectWithoutReason.status === 422,
    `HTTP ${String(rejectWithoutReason.status)}`,
  );

  const ownerView = await callApi(
    "GET",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/certifications`,
    { actor: seller },
  );
  record(
    "the seller sees its own certifications with review state",
    ownerView.status === 200 && arrayField(dataOf(ownerView), "items").length >= 1,
    `${String(ownerView.status)} items=${String(arrayField(dataOf(ownerView), "items").length)}`,
  );
  record(
    "even the owner's certification view hides the evidence document",
    !ownerView.rawText.includes("evidenceDocumentId") &&
      !ownerView.rawText.includes("objectStorageKey"),
    ownerView.rawText.includes("evidenceDocumentId") ? "LEAKED" : "absent",
  );

  const crossTenantView = await callApi(
    "GET",
    `/commerce/organizations/${SELLER_ORGANIZATION_ID}/certifications`,
    { actor: buyer },
  );
  record(
    "another organization cannot list certifications",
    crossTenantView.status === 404,
    `HTTP ${String(crossTenantView.status)}`,
  );
}

// ---------------------------------------------------------------------------
// The public read — A13's closing rule.
// ---------------------------------------------------------------------------

async function smokePublicStorefront(): Promise<void> {
  const storefront = await callApi("GET", `/store/organizations/${SELLER_ORGANIZATION_SLUG}`);
  const data = dataOf(storefront);
  const declared = asRecord(data["declaredProfile"]);
  const measured = asRecord(data["measuredMetrics"]);

  record(
    "the storefront read succeeds",
    storefront.status === 200,
    `HTTP ${String(storefront.status)}`,
  );

  /**
   * A13'S CLOSING RULE, asserted structurally. Two objects, and the declared one carrying
   * the seller's assertions while the measured one carries the platform's.
   */
  record(
    "declaredProfile and measuredMetrics are SEPARATE objects",
    "declaredProfile" in data && "measuredMetrics" in data,
    `declaredProfile=${String("declaredProfile" in data)} measuredMetrics=${String("measuredMetrics" in data)}`,
  );
  record(
    "the seller's assertions live only under declaredProfile",
    numberField(declared, "yearFounded") === 2009 && !("yearFounded" in measured),
    `declared.yearFounded=${String(numberField(declared, "yearFounded"))} measured.yearFounded=${String("yearFounded" in measured)}`,
  );
  record(
    "the declared profile carries the company depth collections",
    arrayField(declared, "media").length >= 1 &&
      arrayField(declared, "stakeholders").length >= 1 &&
      arrayField(declared, "capabilities").length >= 1,
    `media=${String(arrayField(declared, "media").length)} stakeholders=${String(arrayField(declared, "stakeholders").length)} capabilities=${String(arrayField(declared, "capabilities").length)}`,
  );
  const publishedCertifications = arrayField(declared, "certifications");
  record(
    "an approved certification is published with its validity window",
    publishedCertifications.length >= 1 &&
      publishedCertifications.every(
        (entry) =>
          stringField(asRecord(entry), "validUntil") !== "" &&
          stringField(asRecord(entry), "issuerName") !== "",
      ),
    `${String(publishedCertifications.length)} certification(s), all with a validity window`,
  );

  /**
   * The measured object must carry a sample size for every rate. A bare rate with no
   * denominator is the "100% across three orders" failure this phase exists to avoid.
   */
  const hasSampleSizes =
    "onTimeSampleSize" in measured &&
    "reorderSampleSize" in measured &&
    "responseSampleSize" in measured;
  record(
    "every measured rate ships its sample size",
    hasSampleSizes,
    hasSampleSizes ? "all three present" : JSON.stringify(measured).slice(0, 160),
  );

  /**
   * The demo data has far fewer than the thresholds, so every rate must be null. A number
   * here means the suppression rule is not running — which is the failure mode that would
   * publish "100% on-time" for a seller with one delivery.
   */
  const suppressed =
    measured["onTimeShipmentRate"] === null &&
    measured["reorderRate"] === null &&
    measured["measuredResponseTimeHours"] === null;
  record(
    "below-threshold rates are null, not flattering numbers",
    suppressed,
    `onTime=${String(measured["onTimeShipmentRate"])} reorder=${String(measured["reorderRate"])} response=${String(measured["measuredResponseTimeHours"])}`,
  );

  /**
   * The thresholds themselves stay off the wire — a client that knew them would render a
   * countdown to a good score rather than an absence of evidence.
   */
  record(
    "the sample thresholds are not on the wire",
    !storefront.rawText.includes("minimumSample") && !storefront.rawText.includes("threshold"),
    "absent",
  );

  record(
    "no certificate document reference appears anywhere in the public body",
    !storefront.rawText.includes("evidenceDocumentId") &&
      !storefront.rawText.includes("objectStorageKey") &&
      !storefront.rawText.includes("cloudinaryPublicId"),
    "absent",
  );

  const missing = await callApi("GET", "/store/organizations/no-such-company-slug");
  record(
    "an unknown storefront slug is 404",
    missing.status === 404,
    `HTTP ${String(missing.status)}`,
  );
}

async function smokeProviderDetail(): Promise<void> {
  const provider = await callApi("GET", "/store/providers/store-demo-freight");
  const data = dataOf(provider);
  if (provider.status !== 200) {
    record(
      "the provider detail read carries the two objects",
      false,
      `HTTP ${String(provider.status)} — is the freight provider seeded and active?`,
    );
    return;
  }
  const providerCard = asRecord(data["provider"]);
  record(
    "the provider detail read carries declaredProfile and measuredMetrics",
    "declaredProfile" in data && "measuredMetrics" in data,
    `declaredProfile=${String("declaredProfile" in data)} measuredMetrics=${String("measuredMetrics" in data)}`,
  );
  /**
   * THE MISLABEL THIS PHASE FIXED. `averageResponseTimeHours` was a provider's own typed
   * integer shipped as a flat sibling of the derived `onTimeShipmentRate`. It is now named
   * for what it is, and the measured median lives under `measuredMetrics`.
   */
  record(
    "the provider card names its self-reported response time as declared",
    "declaredResponseTimeHours" in providerCard && !("averageResponseTimeHours" in providerCard),
    `declaredResponseTimeHours=${String("declaredResponseTimeHours" in providerCard)} averageResponseTimeHours=${String("averageResponseTimeHours" in providerCard)}`,
  );
}

async function main(): Promise<void> {
  await waitForServer();

  const seller = await signIn("store-demo-seller@example.invalid");
  const buyer = await signIn("store-demo-buyer@example.invalid");
  const staff = await signIn("store-demo-staff@example.invalid");

  await smokeDeclaredProfile(seller, buyer);
  await smokeReplaceCollections(seller);
  await smokeIdempotency(seller);
  await smokeCompanyMedia(seller, buyer);
  await smokeCertifications(seller, buyer, staff);
  await smokePublicStorefront();
  await smokeProviderDetail();

  let hasFailure = false;
  for (const outcome of outcomes) {
    const outcomeMark = outcome.passed ? "PASS" : "FAIL";
    console.log(`[${outcomeMark}] ${outcome.label} — ${outcome.detail}`);
    if (!outcome.passed) hasFailure = true;
  }
  console.log(
    `\n${String(outcomes.filter((outcome) => outcome.passed).length)}/${String(outcomes.length)} checks passed.`,
  );

  await pool.end();
  if (hasFailure) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
  void pool.end();
});
