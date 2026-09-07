import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInAs, signOut } from "#src/test-support/auth-mock.js";
import { resetRateLimiters } from "#src/test-support/rate-limit-reset.js";
import { stubServerEnvironment } from "#src/test-support/server-env.js";
import { buildTestApp } from "#src/test-support/test-app.js";

/**
 * ROUTE-LEVEL tests for §7A — the compensation statement subtree, previously untested at
 * this tier (see `docs/R_AND_D_BACKEND_STRUCTURE.md` §7A). This is the single biggest gap
 * closed by this pass: the four-eyes finalize/countersign flow, the self-countersign-forbidden
 * rule, and the payment record→confirm attestation pair had zero coverage above the pure
 * schema/error-map unit tests.
 *
 * Same three properties as `proof-of-effort.routes.test.ts`:
 *   1. Signed out is 401.
 *   2. A signed-in non-member and a nonexistent project are byte-identical 404s — this
 *      module's own docs (`compensation-error-response.ts`) spell out that 404, never 403,
 *      is used for every authorization/lookup failure so a stranger cannot probe project
 *      slugs.
 *   3. The controller passes the SERVICE the ids the path/body named.
 */

stubServerEnvironment();

vi.mock("dotenv/config", () => ({}));
vi.mock("#src/db/index.js", async () => (await import("#src/test-support/database-mock.js")).databaseModuleMock());
vi.mock("#src/lib/auth.js", async () => (await import("#src/test-support/auth-mock.js")).authModuleMock());

/**
 * `requireIdentifiedUser` hits the real `db` query builder; it has its own dedicated suite
 * (`src/middleware/require-identified-user.test.ts`). Stubbed to a pass-through here so
 * this suite stays about routing/wiring, following the precedent in
 * `import-intelligence.routes.test.ts`. The routes still declare it in their middleware
 * chain, so a dropped guard is still caught by `rate-limit-coverage.test.ts`'s router walk.
 */
vi.mock("#src/middleware/require-identified-user.js", () => ({
  requireIdentifiedUser: (_req: unknown, _res: unknown, next: (error?: unknown) => void): void => {
    next();
  },
}));

const requireProjectRole = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/projects/project-membership.service.js", () => ({
  requireProjectRole: (...args: readonly unknown[]) => requireProjectRole(...args),
  PROJECT_ROLE_RANK: { founder: 4, admin: 3, maintainer: 2, contributor: 1 },
}));

const listAgreementHistory = vi.fn<(...args: readonly unknown[]) => unknown>();
const proposeCashAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
const declineCashAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
const withdrawCashAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
const acceptCashAgreement = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/compensation/compensation-agreements.service.js", () => ({
  listAgreementHistory: (...args: readonly unknown[]) => listAgreementHistory(...args),
  proposeCashAgreement: (...args: readonly unknown[]) => proposeCashAgreement(...args),
  declineCashAgreement: (...args: readonly unknown[]) => declineCashAgreement(...args),
  withdrawCashAgreement: (...args: readonly unknown[]) => withdrawCashAgreement(...args),
  acceptCashAgreement: (...args: readonly unknown[]) => acceptCashAgreement(...args),
}));

const listPeriods = vi.fn<(...args: readonly unknown[]) => unknown>();
const getPeriod = vi.fn<(...args: readonly unknown[]) => unknown>();
const finalizePeriod = vi.fn<(...args: readonly unknown[]) => unknown>();
const countersignPeriod = vi.fn<(...args: readonly unknown[]) => unknown>();
const supersedePeriod = vi.fn<(...args: readonly unknown[]) => unknown>();
const buildPeriodExport = vi.fn<(...args: readonly unknown[]) => unknown>();
const verifyStatementChain = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/compensation/compensation-periods.service.js", () => ({
  listPeriods: (...args: readonly unknown[]) => listPeriods(...args),
  getPeriod: (...args: readonly unknown[]) => getPeriod(...args),
  finalizePeriod: (...args: readonly unknown[]) => finalizePeriod(...args),
  countersignPeriod: (...args: readonly unknown[]) => countersignPeriod(...args),
  supersedePeriod: (...args: readonly unknown[]) => supersedePeriod(...args),
  buildPeriodExport: (...args: readonly unknown[]) => buildPeriodExport(...args),
  verifyStatementChain: (...args: readonly unknown[]) => verifyStatementChain(...args),
}));

const listPaymentsForPeriod = vi.fn<(...args: readonly unknown[]) => unknown>();
const recordPayment = vi.fn<(...args: readonly unknown[]) => unknown>();
const confirmPayment = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/compensation/compensation-payments.service.js", () => ({
  listPaymentsForPeriod: (...args: readonly unknown[]) => listPaymentsForPeriod(...args),
  recordPayment: (...args: readonly unknown[]) => recordPayment(...args),
  confirmPayment: (...args: readonly unknown[]) => confirmPayment(...args),
}));

const getGovernanceSummary = vi.fn<(...args: readonly unknown[]) => unknown>();
vi.mock("#src/modules/rnd/compensation/governance-summary.service.js", () => ({
  getGovernanceSummary: (...args: readonly unknown[]) => getGovernanceSummary(...args),
}));

/** What `requireProjectRole` returns for a member of `solar-cold-storage`. */
const MEMBER_CONTEXT = {
  success: true,
  value: {
    projectId: "project_1",
    projectSlug: "solar-cold-storage",
    projectStatus: "active",
    founderUserId: "user_founder",
    currency: "INR",
    memberId: "member_1",
    memberRole: "contributor",
  },
} as const;

/** What it returns for a stranger, an ex-member, an under-privileged member, or a typo. */
const NOT_FOUND = { success: false, error: { type: "NOT_FOUND", projectRef: "solar-cold-storage" } };

const SLUG = "solar-cold-storage";
const BASE = `/research-projects/${SLUG}`;

describe("compensation routes", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    signInAs();
    await resetRateLimiters();
  });

  describe("authentication and membership", () => {
    const getRoutes = [
      `${BASE}/compensation-agreements`,
      `${BASE}/compensation-periods`,
      `${BASE}/compensation-periods/period_1`,
      `${BASE}/compensation-periods/period_1/verify`,
    ] as const;

    it.each(getRoutes)("answers 401 for a signed-out caller on %s", async (path) => {
      signOut();

      const response = await request(app).get(path);

      expect(response.status).toBe(401);
      expect(requireProjectRole).not.toHaveBeenCalled();
    });

    it.each(getRoutes)("answers 404 for a signed-in non-member on %s", async (path) => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);

      const response = await request(app).get(path);

      expect(response.status).toBe(404);
    });

    it("gives a non-member and an absent project byte-identical refusals", async () => {
      requireProjectRole.mockResolvedValue(NOT_FOUND);
      const nonMember = await request(app).get(`${BASE}/compensation-agreements`);

      requireProjectRole.mockResolvedValue({
        success: false,
        error: { type: "NOT_FOUND", projectRef: "no-such-project" },
      });
      const absent = await request(app).get("/research-projects/no-such-project/compensation-agreements");

      expect(nonMember.status).toBe(absent.status);
      expect(nonMember.body).toEqual(absent.body);
    });

    it("answers 401 for a signed-out caller proposing an agreement", async () => {
      signOut();

      const response = await request(app).post(`${BASE}/members/user_2/compensation-agreement`).send({
        engagementKind: "employee",
        monthlyAmountInCents: "500000",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        rationaleNote: "Full-time onboarding.",
      });

      expect(response.status).toBe(401);
      expect(proposeCashAgreement).not.toHaveBeenCalled();
    });
  });

  describe("GET …/compensation-agreements", () => {
    it("passes the resolved project id and parsed member filter to the service", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listAgreementHistory.mockResolvedValue({ success: true, value: [] });

      const response = await request(app).get(`${BASE}/compensation-agreements?memberId=user_2`);

      expect(response.status).toBe(200);
      expect(listAgreementHistory).toHaveBeenCalledWith("project_1", "user_2");
    });

    it("rejects an unknown query key with 422", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get(`${BASE}/compensation-agreements?projectId=other`);

      expect(response.status).toBe(422);
      expect(listAgreementHistory).not.toHaveBeenCalled();
    });
  });

  describe("POST …/members/:memberUserId/compensation-agreement", () => {
    const path = `${BASE}/members/user_2/compensation-agreement`;
    const validBody = {
      engagementKind: "employee",
      monthlyAmountInCents: "500000",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      rationaleNote: "Full-time onboarding.",
    };

    it("requires the founder role — a contributor gets the service's 403", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      proposeCashAgreement.mockResolvedValue({
        success: false,
        error: { type: "NOT_THE_AGREEMENT_SUBJECT" },
      });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(403);
    });

    it("creates the agreement and passes the typed body through", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      proposeCashAgreement.mockResolvedValue({ success: true, value: { id: "agreement_1" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(proposeCashAgreement).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "user_2",
        "user_test_caller",
        "contributor",
        expect.objectContaining({
          engagementKind: "employee",
          monthlyAmountInCents: 500000n,
          hourlyRateCentsPerHour: null,
          rationaleNote: "Full-time onboarding.",
        }),
      );
    });

    it("rejects a body with both a monthly amount and an hourly rate", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ ...validBody, hourlyRateCentsPerHour: "5000" });

      expect(response.status).toBe(422);
      expect(proposeCashAgreement).not.toHaveBeenCalled();
    });

    it("rejects an unknown body field", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ ...validBody, currencyCode: "USD" });

      expect(response.status).toBe(422);
      expect(proposeCashAgreement).not.toHaveBeenCalled();
    });
  });

  describe("POST …/compensation-agreements/:agreementId/accept", () => {
    const path = `${BASE}/compensation-agreements/agreement_1/accept`;

    it("accepts on behalf of the resolved caller", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      acceptCashAgreement.mockResolvedValue({ success: true, value: { status: "accepted" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(acceptCashAgreement).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "agreement_1",
        "user_test_caller",
        "contributor",
      );
    });

    it("maps NOT_THE_AGREEMENT_SUBJECT to 403", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      acceptCashAgreement.mockResolvedValue({
        success: false,
        error: { type: "NOT_THE_AGREEMENT_SUBJECT" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("maps AGREEMENT_ALREADY_ACCEPTED to 409", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      acceptCashAgreement.mockResolvedValue({
        success: false,
        error: { type: "AGREEMENT_ALREADY_ACCEPTED" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/compensation-agreements/:agreementId/decline", () => {
    const path = `${BASE}/compensation-agreements/agreement_1/decline`;

    it("declines with an optional note", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      declineCashAgreement.mockResolvedValue({ success: true, value: { status: "declined" } });

      const response = await request(app).post(path).send({ note: "Rate too low." });

      expect(response.status).toBe(200);
      expect(declineCashAgreement).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "agreement_1",
        "user_test_caller",
        "contributor",
        "Rate too low.",
      );
    });

    it("accepts a bodyless decline", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      declineCashAgreement.mockResolvedValue({ success: true, value: { status: "declined" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(declineCashAgreement).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "agreement_1",
        "user_test_caller",
        "contributor",
        undefined,
      );
    });
  });

  describe("POST …/compensation-agreements/:agreementId/withdraw", () => {
    const path = `${BASE}/compensation-agreements/agreement_1/withdraw`;

    it("requires a reasonNote", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(withdrawCashAgreement).not.toHaveBeenCalled();
    });

    it("withdraws and passes the reason through", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      withdrawCashAgreement.mockResolvedValue({ success: true, value: { status: "withdrawn" } });

      const response = await request(app).post(path).send({ reasonNote: "Role no longer needed." });

      expect(response.status).toBe(200);
      expect(withdrawCashAgreement).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "agreement_1",
        "user_test_caller",
        "contributor",
        "Role no longer needed.",
      );
    });
  });

  describe("GET …/compensation-periods and …/compensation-periods/:periodId", () => {
    it("lists periods with the parsed filter", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      listPeriods.mockResolvedValue([]);

      const response = await request(app).get(`${BASE}/compensation-periods?status=open&limit=10`);

      expect(response.status).toBe(200);
      expect(listPeriods).toHaveBeenCalledWith("project_1", {
        status: "open",
        limit: 10,
        beforeSequenceNumber: undefined,
      });
    });

    it("loads one period along with its payments", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getPeriod.mockResolvedValue({ success: true, value: { id: "period_1", status: "open" } });
      listPaymentsForPeriod.mockResolvedValue([{ id: "payment_1" }]);

      const response = await request(app).get(`${BASE}/compensation-periods/period_1`);

      expect(response.status).toBe(200);
      expect(getPeriod).toHaveBeenCalledWith("project_1", "period_1");
      expect(response.body.data.payments).toEqual([{ id: "payment_1" }]);
    });

    it("answers 404 for a period belonging to another project", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getPeriod.mockResolvedValue({ success: false, error: { type: "PERIOD_NOT_FOUND" } });

      const response = await request(app).get(`${BASE}/compensation-periods/period_elsewhere`);

      expect(response.status).toBe(404);
    });
  });

  describe("POST …/compensation-periods/:periodId/finalize", () => {
    const path = `${BASE}/compensation-periods/period_1/finalize`;

    it("finalizes with the acknowledgement, and no amount ever leaves the client", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      finalizePeriod.mockResolvedValue({ success: true, value: { status: "finalized" } });

      const response = await request(app).post(path).send({ acknowledgement: "FINALIZE" });

      expect(response.status).toBe(200);
      expect(finalizePeriod).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "period_1",
        "FINALIZE",
        "user_test_caller",
        "contributor",
        expect.any(Date),
      );
    });

    it("rejects a body with no acknowledgement", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(finalizePeriod).not.toHaveBeenCalled();
    });

    it("maps ACKNOWLEDGEMENT_MISMATCH to 422", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      finalizePeriod.mockResolvedValue({
        success: false,
        error: { type: "ACKNOWLEDGEMENT_MISMATCH", expected: "FINALIZE" },
      });

      const response = await request(app).post(path).send({ acknowledgement: "finalize" });

      expect(response.status).toBe(422);
    });

    it("maps PERIOD_ALREADY_FINALIZED to 409", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      finalizePeriod.mockResolvedValue({
        success: false,
        error: { type: "PERIOD_ALREADY_FINALIZED" },
      });

      const response = await request(app).post(path).send({ acknowledgement: "FINALIZE" });

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/compensation-periods/:periodId/countersign — four-eyes", () => {
    const path = `${BASE}/compensation-periods/period_1/countersign`;

    /**
     * §7A.5, verbatim: the person who finalized cannot countersign, EVEN A FOUNDER. This
     * is 422, never 403 — the caller IS authorized, the request itself is the problem
     * (`compensation-error-response.ts`'s own rationale).
     */
    it("answers 422 SELF_COUNTERSIGN_FORBIDDEN when the finalizer tries to countersign their own statement", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      countersignPeriod.mockResolvedValue({
        success: false,
        error: { type: "SELF_COUNTERSIGN_FORBIDDEN" },
      });

      const response = await request(app).post(path).send({ note: "Looks right." });

      expect(response.status).toBe(422);
    });

    it("countersigns when the caller is a different, authorized signer", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      countersignPeriod.mockResolvedValue({ success: true, value: { status: "countersigned" } });

      const response = await request(app).post(path).send({ note: "Confirmed." });

      expect(response.status).toBe(200);
      expect(countersignPeriod).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "period_1",
        "user_test_caller",
        "contributor",
        "Confirmed.",
      );
    });

    it("maps COUNTERSIGNER_NOT_AUTHORIZED to 403", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      countersignPeriod.mockResolvedValue({
        success: false,
        error: { type: "COUNTERSIGNER_NOT_AUTHORIZED" },
      });

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(403);
    });
  });

  describe("POST …/compensation-periods/:periodId/supersede", () => {
    const path = `${BASE}/compensation-periods/period_1/supersede`;

    it("requires a reasonNote", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).post(path).send({});

      expect(response.status).toBe(422);
      expect(supersedePeriod).not.toHaveBeenCalled();
    });

    it("opens a replacement period and answers 201", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      supersedePeriod.mockResolvedValue({ success: true, value: { id: "period_2" } });

      const response = await request(app).post(path).send({ reasonNote: "Recomputed after a late daily-log edit." });

      expect(response.status).toBe(201);
      expect(supersedePeriod).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "period_1",
        "Recomputed after a late daily-log edit.",
        "user_test_caller",
        "contributor",
        expect.any(Date),
      );
    });
  });

  describe("GET …/compensation-periods/:periodId/export", () => {
    const path = `${BASE}/compensation-periods/period_1/export`;

    it("streams the export body with the resolved content type", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      getPeriod.mockResolvedValue({ success: true, value: { id: "period_1" } });
      buildPeriodExport.mockReturnValue({ contentType: "text/csv", body: "sequence,amount\n1,500000" });

      const response = await request(app).get(`${path}?format=csv`);

      expect(response.status).toBe(200);
      expect(buildPeriodExport).toHaveBeenCalledWith({ id: "period_1" }, "csv");
      expect(response.text).toContain("sequence,amount");
    });

    it("rejects an unknown format", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app).get(`${path}?format=xml`);

      expect(response.status).toBe(422);
      expect(getPeriod).not.toHaveBeenCalled();
    });
  });

  describe("GET …/compensation-periods/:periodId/verify", () => {
    const path = `${BASE}/compensation-periods/period_1/verify`;

    it("answers 200 for an intact chain", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      verifyStatementChain.mockResolvedValue({ success: true, value: { intact: true } });

      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(verifyStatementChain).toHaveBeenCalledWith("project_1");
    });

    /**
     * A break is 409, never a 200 with `{valid:false}` — a dashboard polling this would
     * render a green tick for any 2xx.
     */
    it("answers 409 STATEMENT_CHAIN_BROKEN for a broken chain, never a 200", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      verifyStatementChain.mockResolvedValue({
        success: false,
        error: { type: "STATEMENT_CHAIN_BROKEN", sequenceNumber: 4, reason: "hash mismatch" },
      });

      const response = await request(app).get(path);

      expect(response.status).toBe(409);
    });
  });

  describe("POST …/compensation-period-lines/:lineId/payments", () => {
    const path = `${BASE}/compensation-period-lines/line_1/payments`;
    const validBody = {
      paidAmountInCents: "500000",
      paidOnDate: "2026-02-01",
      methodKey: "bank_transfer",
      idempotencyKey: "payment_key_12345",
    };

    it("records the attestation and answers 201, never claiming the payment moved", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      recordPayment.mockResolvedValue({ success: true, value: { id: "payment_1", status: "recorded" } });

      const response = await request(app).post(path).send(validBody);

      expect(response.status).toBe(201);
      expect(recordPayment).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "line_1",
        "user_test_caller",
        "contributor",
        expect.objectContaining({
          paidAmountInCents: 500000n,
          paidOnDate: "2026-02-01",
          methodKey: "bank_transfer",
          idempotencyKey: "payment_key_12345",
        }),
      );
    });

    it("rejects a reference note that looks like a payment instrument", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      recordPayment.mockResolvedValue({
        success: false,
        error: { type: "PAYMENT_INSTRUMENT_IN_REFERENCE_NOTE" },
      });

      const response = await request(app)
        .post(path)
        .send({ ...validBody, referenceNote: "4111111111111111" });

      expect(response.status).toBe(422);
    });

    it("rejects an idempotency key shorter than the minimum", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);

      const response = await request(app)
        .post(path)
        .send({ ...validBody, idempotencyKey: "short" });

      expect(response.status).toBe(422);
      expect(recordPayment).not.toHaveBeenCalled();
    });
  });

  describe("POST …/payments/:paymentId/confirm", () => {
    const path = `${BASE}/compensation-period-lines/line_1/payments/payment_1/confirm`;

    it("confirms on behalf of the resolved caller", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      confirmPayment.mockResolvedValue({ success: true, value: { status: "confirmed" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(200);
      expect(confirmPayment).toHaveBeenCalledWith(
        MEMBER_CONTEXT.value,
        "line_1",
        "payment_1",
        "user_test_caller",
        "contributor",
      );
    });

    it("maps NOT_THE_PAID_MEMBER to 403", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      confirmPayment.mockResolvedValue({ success: false, error: { type: "NOT_THE_PAID_MEMBER" } });

      const response = await request(app).post(path);

      expect(response.status).toBe(403);
    });

    it("maps PAYMENT_ALREADY_CONFIRMED to 409", async () => {
      requireProjectRole.mockResolvedValue(MEMBER_CONTEXT);
      confirmPayment.mockResolvedValue({
        success: false,
        error: { type: "PAYMENT_ALREADY_CONFIRMED" },
      });

      const response = await request(app).post(path);

      expect(response.status).toBe(409);
    });
  });

  describe("GET /governance/summary", () => {
    it("renders for a signed-out visitor", async () => {
      signOut();
      getGovernanceSummary.mockResolvedValue({ aggregates: {}, callerOpenLines: [] });

      const response = await request(app).get("/governance/summary");

      expect(response.status).toBe(200);
      expect(getGovernanceSummary).toHaveBeenCalledWith(null, { page: 1, limit: 20 });
    });

    it("passes the signed-in caller's id through for their own open lines", async () => {
      getGovernanceSummary.mockResolvedValue({ aggregates: {}, callerOpenLines: [] });

      const response = await request(app).get("/governance/summary?page=2&limit=10");

      expect(response.status).toBe(200);
      expect(getGovernanceSummary).toHaveBeenCalledWith("user_test_caller", { page: 2, limit: 10 });
    });

    it("rejects an unknown query key", async () => {
      const response = await request(app).get("/governance/summary?userId=other");

      expect(response.status).toBe(422);
      expect(getGovernanceSummary).not.toHaveBeenCalled();
    });
  });
});
